import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import { createReadStream, existsSync, mkdirSync, unlinkSync, statSync, readdirSync, readFileSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Constants ──────────────────────────────────────────────────────────────
const PORT = 3001;
const UPLOAD_DIR = '/tmp/transcribeforge-uploads';
const MAX_WHISPER_BYTES = 25 * 1024 * 1024;

if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });

const openai    = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const app = express();
app.use(express.static(join(__dirname, 'public')));

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    cb(null, `upload-${unique}.${file.originalname.split('.').pop()}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = file.originalname.split('.').pop().toLowerCase();
    cb(null, ['mp4','mov','webm','mkv','avi'].includes(ext));
  },
});

function safeUnlink(p) {
  try { if (p && existsSync(p)) unlinkSync(p); } catch {}
}

function safeRmDir(dir) {
  try {
    if (!dir || !existsSync(dir)) return;
    readdirSync(dir).forEach(f => safeUnlink(join(dir, f)));
    import('fs').then(({ rmdirSync }) => { try { rmdirSync(dir); } catch {} });
  } catch {}
}

async function extractAudio(inputFile) {
  const wavFile = inputFile.replace(/\.[^.]+$/, '.wav');
  await execAsync(`ffmpeg -y -i "${inputFile}" -vn -ar 16000 -ac 1 -c:a pcm_s16le "${wavFile}" 2>&1`);
  return wavFile;
}

async function compressIfNeeded(wavFile) {
  if (statSync(wavFile).size <= MAX_WHISPER_BYTES) return { file: wavFile };
  const mp3File = wavFile.replace('.wav', '.mp3');
  await execAsync(`ffmpeg -y -i "${wavFile}" -b:a 64k "${mp3File}" 2>&1`);
  return { file: mp3File };
}

async function extractFrames(inputFile, framesDir, intervalSec = 3) {
  mkdirSync(framesDir, { recursive: true });
  await execAsync(`ffmpeg -y -i "${inputFile}" -vf "fps=1/${intervalSec},scale=1280:-2" -q:v 4 "${framesDir}/frame_%04d.jpg" 2>&1`);
  return readdirSync(framesDir)
    .filter(f => f.endsWith('.jpg'))
    .sort()
    .map((f, i) => ({ file: join(framesDir, f), timestampSec: i * intervalSec }));
}

function formatTime(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = (sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

// Analyse all frames in batches via Claude Haiku vision
async function analyseFrames(frames, model = 'claude-haiku-4-5-20251001') {
  const BATCH = 5;
  const results = [];

  for (let i = 0; i < frames.length; i += BATCH) {
    const batch = frames.slice(i, i + BATCH);
    const imageContent = batch.map(f => ({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: readFileSync(f.file).toString('base64'),
      },
    }));

    const labelContent = {
      type: 'text',
      text: batch.map((f, idx) => `Bild ${idx + 1} = ${formatTime(f.timestampSec)}`).join('\n') +
        '\n\nBeschreibe jeden Screenshot in 1-2 Sätzen: Was ist zu sehen? ' +
        'Halte alle relevanten Informationen fest — sichtbarer Text, Zahlen, Grafiken, UI-Zustand, Aktionen, Personen, Objekte. ' +
        'Format: "MM:SS – [Beschreibung]"',
    };

    try {
      const msg = await anthropic.messages.create({
        model,
        max_tokens: 600,
        messages: [{ role: 'user', content: [...imageContent, labelContent] }],
      });
      const text = msg.content.find(b => b.type === 'text')?.text || '';
      results.push(text.trim());
    } catch (e) {
      results.push(batch.map(f => `${formatTime(f.timestampSec)} – (Fehler: ${e.message})`).join('\n'));
    }

    if (i + BATCH < frames.length) await new Promise(r => setTimeout(r, 300));
  }

  return results.join('\n');
}

// ── POST /api/transcribe ──────────────────────────────────────────────────
app.post('/api/transcribe', upload.single('video'), async (req, res) => {
  const uploadedFile = req.file?.path;
  let wavFile   = null;
  let audioFile = null;
  const framesDir = uploadedFile ? uploadedFile + '_frames' : null;

  try {
    if (!req.file) return res.status(400).json({ error: 'Keine Videodatei empfangen.' });

    const language    = req.body.language || 'de';
    const intervalSec = Math.max(1, Math.min(60, parseInt(req.body.frameInterval) || 3));
    const frameModel  = ['claude-haiku-4-5-20251001','claude-sonnet-4-6','claude-opus-4-7']
                          .includes(req.body.frameModel) ? req.body.frameModel : 'claude-haiku-4-5-20251001';

    // Step 1: Audio + frames parallel
    const [wavResult, frames] = await Promise.all([
      extractAudio(uploadedFile),
      extractFrames(uploadedFile, framesDir, intervalSec),
    ]);
    wavFile = wavResult;

    // Step 2: Compress + Whisper + Frame-Analyse parallel
    const { file: finalAudio } = await compressIfNeeded(wavFile);
    audioFile = finalAudio;

    const [transcription, frameAnalysis] = await Promise.all([
      openai.audio.transcriptions.create({
        model: 'whisper-1',
        file: createReadStream(audioFile),
        language: language === 'auto' ? undefined : language,
      }),
      analyseFrames(frames, frameModel),
    ]);

    res.json({
      transcript: transcription.text,
      frameCount: frames.length,
      frameAnalysis,
    });

  } catch (err) {
    console.error('Transcription error:', err);
    res.status(500).json({ error: `Fehler: ${err?.message || 'Unbekannt'}` });
  } finally {
    safeUnlink(uploadedFile);
    safeUnlink(wavFile);
    if (audioFile && audioFile !== wavFile) safeUnlink(audioFile);
    safeRmDir(framesDir);
  }
});

app.listen(PORT, () => console.log(`TranscribeForge läuft auf http://localhost:${PORT}`));
