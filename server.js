import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import { createReadStream, existsSync, mkdirSync, unlinkSync, statSync, readdirSync, readFileSync } from 'fs';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Constants ──────────────────────────────────────────────────────────────
const PORT       = process.env.PORT || 3001;
const UPLOAD_DIR = '/tmp/transcribeforge-uploads';
const MAX_WHISPER_BYTES = 25 * 1024 * 1024;
const VALID_FRAME_MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-7'];

if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });

const openai    = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// ── Multer (file uploads) ──────────────────────────────────────────────────
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
    cb(null, ['mp4', 'mov', 'webm', 'mkv', 'avi'].includes(ext));
  },
});

// ── Helpers ────────────────────────────────────────────────────────────────
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

function formatTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60).toString().padStart(2, '0');
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
}

function parseVideoUrl(raw) {
  try {
    const u = new URL(raw.trim());
    if (/youtube\.com|youtu\.be/.test(u.hostname)) return { platform: 'youtube', url: raw.trim() };
    if (/vimeo\.com/.test(u.hostname))             return { platform: 'vimeo',   url: raw.trim() };
    return null;
  } catch { return null; }
}

function parseOpts(body) {
  return {
    language:    body.language    || 'de',
    intervalSec: Math.max(1, Math.min(60, parseInt(body.frameInterval) || 3)),
    frameModel:  VALID_FRAME_MODELS.includes(body.frameModel) ? body.frameModel : 'claude-haiku-4-5-20251001',
    noFrames:    body.noFrames === true || body.noFrames === 'true',
  };
}

// ── FFmpeg helpers ─────────────────────────────────────────────────────────
async function extractAudio(inputFile) {
  const wavFile = inputFile.replace(/\.[^.]+$/, '.wav');
  await execAsync(`ffmpeg -y -i "${inputFile}" -vn -ar 16000 -ac 1 -c:a pcm_s16le "${wavFile}" 2>&1`);
  return wavFile;
}

async function compressIfNeeded(wavFile) {
  if (statSync(wavFile).size <= MAX_WHISPER_BYTES) return wavFile;
  const mp3File = wavFile.replace('.wav', '.mp3');
  await execAsync(`ffmpeg -y -i "${wavFile}" -b:a 32k "${mp3File}" 2>&1`);
  return mp3File;
}

async function extractFrames(inputFile, framesDir, intervalSec) {
  mkdirSync(framesDir, { recursive: true });
  await execAsync(`ffmpeg -y -i "${inputFile}" -vf "fps=1/${intervalSec},scale=1280:-2" -q:v 4 "${framesDir}/frame_%04d.jpg" 2>&1`);
  return readdirSync(framesDir)
    .filter(f => f.endsWith('.jpg'))
    .sort()
    .map((f, i) => ({ file: join(framesDir, f), timestampSec: i * intervalSec }));
}

// ── YouTube OAuth helpers ──────────────────────────────────────────────────
const YT_CACHE_DIR = '/root/.cache/yt-dlp';

function ytOAuthActive() {
  try {
    return existsSync(YT_CACHE_DIR) && readdirSync(YT_CACHE_DIR).some(f => f.endsWith('.json'));
  } catch { return false; }
}

// ── yt-dlp download ────────────────────────────────────────────────────────
async function downloadWithYtDlp(url, destPath, onProgress) {
  onProgress?.('Video wird heruntergeladen…');
  let authFlag = '';
  if (ytOAuthActive()) {
    authFlag = '--username oauth --password ""';
  } else {
    const cookiesFile = '/app/youtube-cookies.txt';
    if (existsSync(cookiesFile) && statSync(cookiesFile).size > 0) {
      authFlag = `--cookies "${cookiesFile}"`;
    }
  }
  const cmd = `yt-dlp --no-playlist --no-warnings ${authFlag} ` +
    `-f "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best" ` +
    `--merge-output-format mp4 -o "${destPath}" "${url}"`;
  await execAsync(cmd, { timeout: 600_000 });
}

// ── GET /api/youtube/status ────────────────────────────────────────────────
app.get('/api/youtube/status', (_req, res) => {
  res.json({ connected: ytOAuthActive() });
});

// ── GET /api/youtube/connect  (SSE — startet OAuth Device Flow) ────────────
app.get('/api/youtube/connect', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  const proc = spawn('yt-dlp', [
    '--username', 'oauth', '--password', '',
    '--skip-download', '--no-warnings',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  ]);

  const onData = chunk => send({ type: 'output', text: chunk.toString() });
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);

  proc.on('close', code => {
    send({ type: code === 0 ? 'connected' : 'error', code });
    res.end();
  });

  req.on('close', () => proc.kill('SIGTERM'));
});

// ── Progress tracking ──────────────────────────────────────────────────────
const jobProgress = new Map();

function setP(jobId, step, pct, label) {
  if (!jobId) return;
  jobProgress.set(jobId, { step, pct: Math.round(pct), label: label || '' });
}

app.get('/api/progress/:jobId', (req, res) => {
  res.json(jobProgress.get(req.params.jobId) || { step: 0, pct: 0, label: '' });
});

// ── Core transcription pipeline ────────────────────────────────────────────
async function transcribePipeline(videoPath, opts, jobId) {
  const { language, intervalSec, frameModel, noFrames } = opts;
  let wavFile   = null;
  let audioFile = null;
  let frames    = [];
  const framesDir = `${videoPath}_frames`;

  try {
    // Step 1: Extract audio (+ frames unless noFrames)
    setP(jobId, 1, 5, noFrames ? 'Audio extrahieren…' : 'Audio & Frames extrahieren…');

    if (noFrames) {
      wavFile = await extractAudio(videoPath);
      setP(jobId, 1, 100, 'Audio extrahiert');
    } else {
      let ap = 0, fp = 0;
      const upd = () => setP(jobId, 1, (ap + fp) / 2, 'Extrahiere…');
      [wavFile, frames] = await Promise.all([
        extractAudio(videoPath).then(r   => { ap = 100; upd(); return r; }),
        extractFrames(videoPath, framesDir, intervalSec).then(r => { fp = 100; upd(); return r; }),
      ]);
      setP(jobId, 1, 100, `Extraktion fertig (${frames.length} Frames)`);
    }

    // Step 2: Whisper transcription
    setP(jobId, 2, 10, 'Whisper API…');
    const finalAudio = await compressIfNeeded(wavFile);
    audioFile = finalAudio;
    const transcription = await openai.audio.transcriptions.create({
      model:    'whisper-1',
      file:     createReadStream(audioFile),
      language: language === 'auto' ? undefined : language,
    });
    setP(jobId, 2, 100, 'Transkript fertig');

    // Step 3: Frame analysis (skipped when noFrames)
    let frameAnalysis = '';
    if (!noFrames && frames.length > 0) {
      const BATCH       = 5;
      const totalBatches = Math.max(1, Math.ceil(frames.length / BATCH));
      const batchResults = [];

      for (let i = 0; i < frames.length; i += BATCH) {
        const batchNum = Math.floor(i / BATCH);
        setP(jobId, 3, (batchNum / totalBatches) * 100, `Batch ${batchNum + 1}/${totalBatches}…`);
        const batch = frames.slice(i, i + BATCH);
        const imageContent = batch.map(f => ({
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: readFileSync(f.file).toString('base64') },
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
            model:      frameModel,
            max_tokens: 600,
            messages:   [{ role: 'user', content: [...imageContent, labelContent] }],
          });
          batchResults.push((msg.content.find(b => b.type === 'text')?.text || '').trim());
        } catch (e) {
          batchResults.push(batch.map(f => `${formatTime(f.timestampSec)} – (Fehler: ${e.message})`).join('\n'));
        }
        if (i + BATCH < frames.length) await new Promise(r => setTimeout(r, 300));
      }
      frameAnalysis = batchResults.join('\n');
    }
    setP(jobId, 3, 100, noFrames ? 'Übersprungen' : 'Bildanalyse fertig');

    // Step 4: Done
    setP(jobId, 4, 100, 'Fertig');
    setTimeout(() => jobProgress.delete(jobId), 30_000);

    return { transcript: transcription.text, frameCount: frames.length, frameAnalysis };

  } finally {
    safeUnlink(wavFile);
    if (audioFile && audioFile !== wavFile) safeUnlink(audioFile);
    safeRmDir(framesDir);
  }
}

// ── POST /api/transcribe  (Datei-Upload) ───────────────────────────────────
app.post('/api/transcribe', upload.single('video'), async (req, res) => {
  const uploadedFile = req.file?.path;
  const jobId = req.headers['x-job-id'] || null;

  try {
    if (!req.file) return res.status(400).json({ error: 'Keine Videodatei empfangen.' });
    const opts = parseOpts(req.body);
    const result = await transcribePipeline(uploadedFile, opts, jobId);
    res.json(result);
  } catch (err) {
    console.error('Transcription error:', err);
    jobProgress.delete(jobId);
    res.status(500).json({ error: `Fehler: ${err?.message || 'Unbekannt'}` });
  } finally {
    safeUnlink(uploadedFile);
  }
});

// ── POST /api/transcribe-url  (YouTube / Vimeo) ────────────────────────────
app.post('/api/transcribe-url', async (req, res) => {
  const jobId  = req.headers['x-job-id'] || null;
  const parsed = parseVideoUrl(req.body?.url || '');

  if (!parsed) {
    return res.status(400).json({ error: 'Ungültige URL — nur YouTube und Vimeo werden unterstützt.' });
  }

  const tempId   = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const destPath = join(UPLOAD_DIR, `url-${tempId}.mp4`);

  try {
    // Download phase shown in step 1
    setP(jobId, 1, 5, 'Video wird heruntergeladen…');
    await downloadWithYtDlp(parsed.url, destPath, label => setP(jobId, 1, 20, label));
    setP(jobId, 1, 35, 'Download fertig, starte Verarbeitung…');

    const opts   = parseOpts(req.body);
    const result = await transcribePipeline(destPath, opts, jobId);
    res.json({ ...result, platform: parsed.platform });
  } catch (err) {
    console.error('URL transcription error:', err);
    jobProgress.delete(jobId);
    const msg = err?.message || '';
    const stderr = err?.stderr || '';
    if (msg.includes('not found') || msg.includes('No such file') || (msg.includes('yt-dlp') && !stderr)) {
      res.status(500).json({ error: 'yt-dlp nicht gefunden. Bitte installieren: brew install yt-dlp (macOS) oder pip install yt-dlp.' });
    } else if (stderr) {
      res.status(500).json({ error: `Download-Fehler: ${stderr.trim().split('\n').pop()}` });
    } else {
      res.status(500).json({ error: `Fehler: ${msg || 'Unbekannt'}` });
    }
  } finally {
    safeUnlink(destPath);
  }
});

app.listen(PORT, () => console.log(`TranscribeForge läuft auf http://localhost:${PORT}`));
