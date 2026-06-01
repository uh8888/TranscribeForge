import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import { createReadStream, existsSync, mkdirSync, unlinkSync, statSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Constants ──────────────────────────────────────────────────────────────
const PORT = 3001;
const UPLOAD_DIR = '/tmp/transcribeforge-uploads';
const MAX_WHISPER_BYTES = 25 * 1024 * 1024; // 25 MB

// ── Ensure upload directory exists ────────────────────────────────────────
if (!existsSync(UPLOAD_DIR)) {
  mkdirSync(UPLOAD_DIR, { recursive: true });
}

// ── OpenAI client ─────────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Express app ───────────────────────────────────────────────────────────
const app = express();
app.use(express.static(join(__dirname, 'public')));

// ── Multer config ─────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    const ext = file.originalname.split('.').pop();
    cb(null, `upload-${unique}.${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska',
                     'video/x-msvideo', 'application/octet-stream'];
    // also allow by extension as MIME types can vary
    const ext = file.originalname.split('.').pop().toLowerCase();
    const allowedExt = ['mp4', 'mov', 'webm', 'mkv', 'avi'];
    if (allowed.includes(file.mimetype) || allowedExt.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Nicht unterstütztes Dateiformat: ${file.mimetype}`));
    }
  },
});

// ── Helper: safe file removal ─────────────────────────────────────────────
function safeUnlink(filePath) {
  try {
    if (filePath && existsSync(filePath)) unlinkSync(filePath);
  } catch { /* ignore */ }
}

// ── Helper: extract audio with ffmpeg ────────────────────────────────────
async function extractAudio(inputFile) {
  const wavFile = inputFile.replace(/\.[^.]+$/, '.wav');
  const cmd = `ffmpeg -y -i "${inputFile}" -vn -ar 16000 -ac 1 -c:a pcm_s16le "${wavFile}" 2>&1`;
  await execAsync(cmd);
  return wavFile;
}

// ── Helper: compress wav to mp3 if > 25 MB ───────────────────────────────
async function compressIfNeeded(wavFile) {
  const stats = statSync(wavFile);
  if (stats.size <= MAX_WHISPER_BYTES) {
    return { file: wavFile, isCompressed: false };
  }
  const mp3File = wavFile.replace('.wav', '.mp3');
  const cmd = `ffmpeg -y -i "${wavFile}" -b:a 64k "${mp3File}" 2>&1`;
  await execAsync(cmd);
  return { file: mp3File, isCompressed: true };
}

// ── POST /api/transcribe ──────────────────────────────────────────────────
app.post('/api/transcribe', upload.single('video'), async (req, res) => {
  const uploadedFile = req.file?.path;
  let wavFile = null;
  let audioFile = null;

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Keine Videodatei empfangen.' });
    }

    const language = req.body.language || 'de';

    // Step 1: Extract audio
    wavFile = await extractAudio(uploadedFile);

    // Step 2: Compress if needed
    const { file: finalAudioFile } = await compressIfNeeded(wavFile);
    audioFile = finalAudioFile;

    // Step 3: Whisper transcription
    const transcription = await openai.audio.transcriptions.create({
      model: 'whisper-1',
      file: createReadStream(audioFile),
      language: language === 'auto' ? undefined : language,
    });

    res.json({ transcript: transcription.text });

  } catch (err) {
    console.error('Transcription error:', err);
    const message = err?.message || 'Unbekannter Fehler';
    res.status(500).json({ error: `Fehler bei der Transkription: ${message}` });
  } finally {
    // Clean up all temp files
    safeUnlink(uploadedFile);
    safeUnlink(wavFile);
    if (audioFile && audioFile !== wavFile) safeUnlink(audioFile);
  }
});

// ── Start server ──────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`TranscribeForge läuft auf http://localhost:${PORT}`);
});
