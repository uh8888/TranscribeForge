#!/usr/bin/env node
/**
 * transcribeForge CLI — direkter Modus (kein HTTP-Server)
 * Verarbeitet lokale Videodateien sowie YouTube- und Vimeo-URLs.
 *
 * Aufruf (lokale Datei):
 *   node transcribe.js --video "/pfad/zur/datei.mp4" [--lang de] [--interval 3] [--model claude-haiku-4-5-20251001] [--no-frames]
 *
 * Aufruf (YouTube / Vimeo):
 *   node transcribe.js --url "https://youtube.com/watch?v=..." [--lang de] [--no-frames]
 *
 * Webinar-Modus (Slides-Website aus Video generieren + auf VPS deployen):
 *   node transcribe.js --video "/pfad/vortrag.mp4" --lang de --interval 1 \
 *     --webinar --title "Mein Webinar" --slug "mein-webinar"
 *
 * Flags:
 *   --video <pfad>    Lokale Video-/Audiodatei (Pflicht wenn kein --url).
 *   --url <url>       YouTube- oder Vimeo-URL; wird via yt-dlp heruntergeladen.
 *   --lang <code>     Sprache für Whisper (default: de). "auto" = automatisch erkennen.
 *   --interval <sec>  Sekunden zwischen zwei Frames (default: 2). Höher = billiger.
 *   --model <id>      Claude-Modell für Frame-Analyse (default: claude-haiku-4-5-20251001).
 *   --no-frames       Frame-Extraktion und -Analyse überspringen (~$0.63/90 min statt ~$3.35).
 *   --diarize         Single-Stream-Sprecher-Diarisation via pyannote (default: aus).
 *                     Erfordert HF_TOKEN + python/.venv mit pyannote.audio (siehe README).
 *   --speakers <list> Komma-getrennte Namen für SPEAKER_00, SPEAKER_01, … in
 *                     Reihenfolge des ersten Auftretens (z.B. "Uwe,Bastian").
 *   --min-speakers N  Pyannote-Hyperparameter (optional).
 *   --max-speakers N  Pyannote-Hyperparameter (optional).
 *   --webinar         Aktiviert Webinar-Site-Modus (Backend-Pipeline). Upload
 *                     zum Server, dort läuft Frame-Cluster → Vision → Slides-Site.
 *   --title "<str>"   Site-Titel für Webinar (Pflicht wenn --webinar; sonst
 *                     interaktive Rückfrage im TTY-Modus).
 *   --slug "<str>"    URL-Slug (a-z0-9-). Sanitize erfolgt clientseitig.
 *   --no-deploy       Site NICHT unter /webinare/<slug>/ veröffentlichen
 *                     (Default: deployen).
 *
 * Voraussetzung für --url: yt-dlp muss installiert sein (brew install yt-dlp).
 */

import { existsSync, mkdirSync, unlinkSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { createReadStream } from 'fs';
import { resolve, basename, dirname, join } from 'path';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';
import { createInterface } from 'readline';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

const execAsync = promisify(exec);
const ENV_FILE   = '/Users/uhi/Projects/TranscribeForge/.env';
const MAX_WHISPER_BYTES = 25 * 1024 * 1024;

// ── Load .env ─────────────────────────────────────────────────────────────────
if (existsSync(ENV_FILE)) {
  readFileSync(ENV_FILE, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  });
}

// ── Parse args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(flag, def = null) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
}

const videoArg     = getArg('--video');
const urlArg       = getArg('--url');
const lang         = getArg('--lang', 'de');
const interval     = parseInt(getArg('--interval', '2'), 10);
const frameModel   = getArg('--model', 'claude-haiku-4-5-20251001');
const noFrames     = args.includes('--no-frames');
const wantSummary  = args.includes('--summary');
const summaryModel = getArg('--summary-model', 'claude-sonnet-4-6');

// ── Diarisation-Optionen (additiv, Default OFF) ──────────────────────────────
const wantDiarize     = args.includes('--diarize');
const speakersRaw     = getArg('--speakers', '');
const speakerNames    = speakersRaw
  ? speakersRaw.split(',').map(s => s.trim()).filter(Boolean)
  : [];
const diarMinSpeakers = getArg('--min-speakers', null);
const diarMaxSpeakers = getArg('--max-speakers', null);
const DIARIZE_SCRIPT  = '/Users/uhi/Projects/TranscribeForge/python/diarize.py';
const DIARIZE_VENV    = '/Users/uhi/Projects/TranscribeForge/python/.venv/bin/python3';

// ── Webinar-Modus ────────────────────────────────────────────────────────────
// Aktiviert eine Backend-Pipeline (Server-seitig): Video-Upload → Whisper +
// Frames + Webinar-Slides-Site (Cluster → Vision → Render) → Deploy unter
// /webinare/<slug>/. Alle vier neuen Flags werden als Multipart-Felder an
// POST https://transcribeforge.hiltmann.cloud/api/transcribe gesendet.
const wantWebinar     = args.includes('--webinar');
let   webinarTitle    = getArg('--title', '');
let   webinarSlug     = getArg('--slug', '');
const webinarNoDeploy = args.includes('--no-deploy');
const WEBINAR_API     = process.env.TF_API_URL
  || 'https://transcribeforge.hiltmann.cloud/api/transcribe';
const WEBINAR_PROGRESS_BASE = process.env.TF_API_PROGRESS_BASE
  || 'https://transcribeforge.hiltmann.cloud/api/progress';

// Muss identisch zu server.js::sanitizeSlug bleiben.
function sanitizeSlug(raw) {
  return (raw || '').toString()
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

if (!videoArg && !urlArg) {
  console.error('Fehler: --video <pfad> oder --url <youtube/vimeo-url> ist erforderlich.');
  process.exit(1);
}

// Webinar-Modus + URL-Download: aktuell nicht unterstützt (Backend braucht
// direkte Datei). Klarer Fehler statt stiller Fehlschlag.
if (wantWebinar && urlArg) {
  console.error('Fehler: --webinar + --url ist aktuell nicht unterstützt. Video lokal herunterladen und mit --video übergeben.');
  process.exit(1);
}

const openai    = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatTime(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = (sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function safeUnlink(p) {
  try { if (p && existsSync(p)) unlinkSync(p); } catch {}
}

// ── Progress (live in Status-Datei der Quick Action schreiben) ────────────────
const STATUS_FILE   = process.env.TF_STATUS_FILE   || '';
const STATUS_LABEL  = process.env.TF_STATUS_LABEL  || '';
const STATUS_FOLDER = process.env.TF_STATUS_FOLDER || '';
const METRICS_FILE  = process.env.TF_METRICS_FILE  || '';
// Wrapper-PID muss in jeder Status-File-Zeile erhalten bleiben, sonst kann der
// Stop-Button des Progress-Windows den Wrapper nicht per kill -TERM erreichen.
// Bash-Wrapper exportiert TF_STATUS_WRAPPER_PID=$$ vor dem Node-Aufruf.
const STATUS_WRAPPER_PID = process.env.TF_STATUS_WRAPPER_PID || '';
// Frame-Cache: bei Whisper-/Summary-Fehler bleibt die teure Frame-Analyse erhalten,
// damit ein Re-Run nicht alle Haiku-Tokens noch einmal zahlt.
const FRAMES_CACHE  = process.env.TF_FRAMES_CACHE  || '';

function setProgress(percent, phase, detail = '', opts = {}) {
  if (!STATUS_FILE) return;
  try {
    const lines = [
      'status=running',
      `label=${STATUS_LABEL}`,
      `phase=${phase}`,
      `detail=${detail}`,
      `step=${Math.max(0, Math.min(100, Math.round(percent)))}`,
      'total=100',
    ];
    if (STATUS_FOLDER) lines.push(`folder=${STATUS_FOLDER}`);
    if (STATUS_WRAPPER_PID) lines.push(`wrapper_pid=${STATUS_WRAPPER_PID}`);
    // Indeterminate-Phasen (Whisper-/Summary-API-Call): kein echter Fortschritt,
    // Progress-App animiert dann den Balken und hängt „läuft seit XX s…" an.
    if (opts.indeterminate) lines.push('phase_indeterminate=1');
    if (opts.startedAt) lines.push(`phase_started_at=${opts.startedAt}`);
    writeFileSync(STATUS_FILE, lines.join('\n') + '\n');
  } catch {}
}

// ETA-Formatierer: 95 → "ca. 1:35 Min", 12 → "ca. 12 s", 720 → "ca. 12 Min"
function formatEta(seconds) {
  if (!seconds || seconds < 0 || !isFinite(seconds)) return '';
  const s = Math.round(seconds);
  if (s < 60) return `ca. ${s} s`;
  if (s < 600) return `ca. ${Math.floor(s/60)}:${(s%60).toString().padStart(2,'0')} Min`;
  return `ca. ${Math.round(s/60)} Min`;
}

// "5 von ca. 18 Min" — Format für Live-Progress-Detail
function etaElapsedOf(elapsedSec, totalEtaSec) {
  const e = Math.max(0, Math.floor(elapsedSec / 60));
  const t = Math.max(e, Math.round(totalEtaSec / 60));
  return `${e} von ca. ${t} Min`;
}

function costSoFarUsd() {
  return costs.whisper + costs.frames + costs.compact + costs.summary;
}

// Globale ETA-Schätzung — wird in analyseFrames anhand der gemessenen Rate
// fortlaufend angepasst, damit Whisper-/Summary-Phasen weiterhin eine sinnvolle
// Gesamtschätzung anzeigen.
let scriptT0 = Date.now();
let etaTotalSec = 0;

function progressDetail(model) {
  const elapsed = (Date.now() - scriptT0) / 1000;
  const etaStr = etaTotalSec > 0 ? ` · ETA: ${etaElapsedOf(elapsed, etaTotalSec)}` : '';
  return `Modell: ${model}${etaStr} · Bisher: ~$${costSoFarUsd().toFixed(2)}`;
}

// ── Kosten-Tracking ───────────────────────────────────────────────────────────
// USD pro Million Tokens (Anthropic, Stand 06/2026 — bei Änderung aktualisieren).
// Whisper: USD pro Audio-Minute.
const PRICING = {
  'claude-haiku-4-5-20251001': { input: 1.00,  output: 5.00  },
  'claude-haiku-4-5':          { input: 1.00,  output: 5.00  },
  'claude-sonnet-4-6':         { input: 3.00,  output: 15.00 },
  'claude-sonnet-4-7':         { input: 3.00,  output: 15.00 },
  'claude-opus-4-7':           { input: 15.00, output: 75.00 },
  'whisper-1':                 { perMinute: 0.006 },
};

const costs = { whisper: 0, frames: 0, compact: 0, summary: 0,
                audio_min: 0, frames_in: 0, frames_out: 0,
                summary_in: 0, summary_out: 0 };

function addClaudeCost(model, usage, bucket) {
  if (!usage) return;
  const p = PRICING[model] || { input: 3.00, output: 15.00 };
  const inUsd  = (usage.input_tokens  || 0) / 1_000_000 * p.input;
  const outUsd = (usage.output_tokens || 0) / 1_000_000 * p.output;
  costs[bucket] += inUsd + outUsd;
  if (bucket === 'frames')  { costs.frames_in  += usage.input_tokens||0; costs.frames_out  += usage.output_tokens||0; }
  if (bucket === 'compact' || bucket === 'summary') {
    costs.summary_in  += usage.input_tokens||0;
    costs.summary_out += usage.output_tokens||0;
  }
}

// Retry-Wrapper für Netzwerk-Fehler (ECONNRESET, Timeouts, 5xx).
async function withRetry(fn, label, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      const code = e?.cause?.code || e?.code;
      const status = e?.status;
      const transient = code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ENOTFOUND'
        || code === 'EPIPE' || code === 'EAI_AGAIN'
        || (status >= 500 && status < 600) || status === 429;
      if (!transient || i === attempts - 1) throw e;
      const wait = Math.min(30_000, 1500 * Math.pow(2, i));
      process.stderr.write(`\n  ${label}: Retry ${i + 1}/${attempts - 1} nach ${Math.round(wait / 1000)}s (${code || status || e.message})\n`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

function safeRmDir(dir) {
  try {
    if (!dir || !existsSync(dir)) return;
    readdirSync(dir).forEach(f => safeUnlink(join(dir, f)));
    import('fs').then(({ rmdirSync }) => { try { rmdirSync(dir); } catch {} });
  } catch {}
}

// ── ffmpeg: Audio extrahieren ─────────────────────────────────────────────────
async function extractAudio(inputFile, outWav) {
  await execAsync(`ffmpeg -y -i "${inputFile}" -vn -ar 16000 -ac 1 -c:a pcm_s16le "${outWav}" 2>&1`);
}

// Bereitet Whisper-Eingaben vor: komprimiert auf 64 kbps mono MP3 und splittet
// in 30-Min-Chunks, falls die komprimierte Datei das Whisper-25-MB-Limit
// überschreiten würde. Gibt eine Liste {file, offsetSec} zurück.
async function prepareWhisperChunks(wavFile) {
  const mp3File = wavFile.replace('.wav', '.mp3');
  process.stderr.write('Audio → 64 kbps MP3…');
  await execAsync(`ffmpeg -y -i "${wavFile}" -ac 1 -b:a 64k "${mp3File}" 2>&1`);
  const mp3Size = statSync(mp3File).size;
  process.stderr.write(` ${(mp3Size/1024/1024).toFixed(1)} MB`);

  if (mp3Size <= MAX_WHISPER_BYTES) {
    process.stderr.write(' ✓ (1 Chunk)\n');
    return [{ file: mp3File, offsetSec: 0 }];
  }

  // Splitten: 30-Min-Chunks (1800 s × 8 KB/s = 14,4 MB pro Chunk bei 64 kbps)
  const CHUNK_SEC = 1800;
  const durationSec = statSync(wavFile).size / 32000;
  const numChunks = Math.ceil(durationSec / CHUNK_SEC);
  process.stderr.write(` → splitten in ${numChunks} Chunks à ${CHUNK_SEC/60} min\n`);

  const dir = dirname(mp3File);
  const base = basename(mp3File, '.mp3');
  const pattern = join(dir, `${base}_chunk_%03d.mp3`);
  await execAsync(`ffmpeg -y -i "${mp3File}" -f segment -segment_time ${CHUNK_SEC} -c copy "${pattern}" 2>&1`);
  safeUnlink(mp3File);

  const chunkFiles = readdirSync(dir)
    .filter(f => f.startsWith(`${base}_chunk_`) && f.endsWith('.mp3'))
    .sort()
    .map((f, i) => ({ file: join(dir, f), offsetSec: i * CHUNK_SEC }));
  process.stderr.write(`  ${chunkFiles.length} Chunks erzeugt\n`);
  return chunkFiles;
}

// Whisper parallel über alle Chunks, Segmente mit Offset mergen.
async function transcribeChunks(chunks) {
  const results = await Promise.all(chunks.map((c, i) =>
    withRetry(() => openai.audio.transcriptions.create({
      model: 'whisper-1',
      file: createReadStream(c.file),
      language: lang === 'auto' ? undefined : lang,
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    }), `Whisper-Chunk ${i + 1}/${chunks.length}`)
  ));

  // Offsets aus den tatsächlichen Chunk-Durations aufaddieren (ffmpeg -c copy
  // schneidet auf Keyframes — Chunk-Längen weichen leicht von CHUNK_SEC ab).
  const segments = [];
  let totalDuration = 0;
  let runningOffset = 0;
  const textParts = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const chunkDur = r.duration || 0;
    totalDuration += chunkDur;
    textParts.push(r.text || '');
    (r.segments || []).forEach(s => segments.push({
      ...s,
      start: (s.start || 0) + runningOffset,
      end:   (s.end   || 0) + runningOffset,
    }));
    runningOffset += chunkDur;
  }
  return { segments, duration: totalDuration, text: textParts.join(' ') };
}

// ── pyannote-Diarisation (Single-Stream) ─────────────────────────────────────
// Ruft python/diarize.py als Subprozess auf. Bewusst defensiv: bei JEDEM
// Fehler wird `null` zurückgegeben, der Caller läuft mit normalem Whisper-
// Output ohne Sprecher-Labels weiter (kein Crash).
async function runDiarization(audioFile) {
  return new Promise(resolve => {
    const pyBin = existsSync(DIARIZE_VENV) ? DIARIZE_VENV : 'python3';
    const cliArgs = [DIARIZE_SCRIPT, '--audio', audioFile];
    if (diarMinSpeakers) cliArgs.push('--min-speakers', String(diarMinSpeakers));
    if (diarMaxSpeakers) cliArgs.push('--max-speakers', String(diarMaxSpeakers));

    if (!existsSync(DIARIZE_SCRIPT)) {
      process.stderr.write(`Diarisation übersprungen: ${DIARIZE_SCRIPT} fehlt.\n`);
      return resolve(null);
    }

    let stdout = '';
    let stderr = '';
    const child = spawn(pyBin, cliArgs, {
      env: { ...process.env },
    });
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => {
      process.stderr.write(`Diarisation übersprungen (spawn-Fehler): ${err.message}\n`);
      resolve(null);
    });
    child.on('close', code => {
      const trimmed = stdout.trim();
      if (!trimmed) {
        process.stderr.write(`Diarisation übersprungen (kein Output, exit=${code}): ${stderr.slice(-400)}\n`);
        return resolve(null);
      }
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.error) {
          process.stderr.write(`Diarisation übersprungen: ${parsed.error}\n${parsed.hint ? `Hinweis: ${parsed.hint}\n` : ''}`);
          return resolve(null);
        }
        if (!Array.isArray(parsed.turns) || parsed.turns.length === 0) {
          process.stderr.write(`Diarisation übersprungen: leere Turn-Liste.\n`);
          return resolve(null);
        }
        resolve(parsed);
      } catch (e) {
        process.stderr.write(`Diarisation übersprungen (JSON-Parse-Fehler): ${e.message}\n`);
        resolve(null);
      }
    });
  });
}

// Mappt SPEAKER_00/01/… auf Klarnamen aus --speakers <a,b,c> in Reihenfolge
// des ersten Auftretens. SPEAKER_XX ohne Mapping bleibt als Label erhalten.
function buildSpeakerLabelMap(turns, names) {
  const map = new Map();
  if (!names || names.length === 0) return map;
  let nameIdx = 0;
  for (const t of turns) {
    if (!map.has(t.speaker) && nameIdx < names.length) {
      map.set(t.speaker, names[nameIdx++]);
    }
  }
  return map;
}

// Größter zeitlicher Overlap zwischen Whisper-Segment und Diarisation-Turns.
function pickDominantSpeaker(segStart, segEnd, turns) {
  let bestSpeaker = null;
  let bestOverlap = 0;
  for (const t of turns) {
    const overlap = Math.max(0, Math.min(segEnd, t.end) - Math.max(segStart, t.start));
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestSpeaker = t.speaker;
    }
  }
  return bestSpeaker;
}

// Baut den fertigen Speaker-Transkript-Block "[MM:SS – Name]: text".
// Verschmilzt konsekutive Segmente desselben Sprechers zu einem Absatz.
function buildSpeakerTranscript(segments, turns, labelMap) {
  const labeled = segments.map(seg => {
    const start = seg.start || 0;
    const end   = seg.end   || start;
    const rawSp = pickDominantSpeaker(start, end, turns) || 'SPEAKER_??';
    const name  = labelMap.get(rawSp) || rawSp;
    return { start, end, name, text: (seg.text || '').trim() };
  }).filter(s => s.text);

  // konsekutive Segmente desselben Sprechers mergen
  const merged = [];
  for (const s of labeled) {
    const last = merged[merged.length - 1];
    if (last && last.name === s.name) {
      last.text += ' ' + s.text;
      last.end = s.end;
    } else {
      merged.push({ ...s });
    }
  }
  return merged.map(m => `[${formatTime(Math.floor(m.start))} – ${m.name}]: ${m.text}`).join('\n\n');
}

// ── ffmpeg: Frames extrahieren ────────────────────────────────────────────────
async function extractFrames(inputFile, framesDir) {
  mkdirSync(framesDir, { recursive: true });
  await execAsync(`ffmpeg -y -i "${inputFile}" -vf "fps=1/${interval},scale=1024:-2" -q:v 4 "${framesDir}/frame_%04d.jpg" 2>&1`);
  return readdirSync(framesDir)
    .filter(f => f.endsWith('.jpg'))
    .sort()
    .map((f, i) => ({ file: join(framesDir, f), timestampSec: i * interval }));
}

// ── Claude: Frame-Analyse in Batches ─────────────────────────────────────────
async function analyseFrames(frames) {
  const BATCH = 5;
  const results = [];
  const totalBatches = Math.ceil(frames.length / BATCH);
  // Initiale Rate (Haiku, 5 Bilder/Batch): ~12 s — wird ab Batch 2 durch Messung ersetzt.
  const INITIAL_RATE_SEC = 12;
  const framesT0 = Date.now();
  // Erste Gesamtschätzung: Frame-Zeit + 90 s Puffer für Whisper + Summary.
  if (etaTotalSec === 0) {
    etaTotalSec = (totalBatches * INITIAL_RATE_SEC) + 90;
  }

  for (let i = 0; i < frames.length; i += BATCH) {
    const batchNum = Math.floor(i / BATCH) + 1;
    process.stderr.write(`\rFrame-Analyse: Batch ${batchNum}/${totalBatches}…   `);

    const framesElapsed = (Date.now() - framesT0) / 1000;
    const doneBatches = batchNum - 1;
    const ratePerBatch = doneBatches > 0 ? framesElapsed / doneBatches : INITIAL_RATE_SEC;
    const framesRemaining = ratePerBatch * (totalBatches - doneBatches);
    // Total-ETA = bisheriges Skript-Elapsed + verbleibende Frame-Zeit + 90 s Puffer.
    const scriptElapsed = (Date.now() - scriptT0) / 1000;
    etaTotalSec = scriptElapsed + framesRemaining + 90;

    // 5-55 % Progress-Range für Frames
    setProgress(5 + (batchNum - 1) / totalBatches * 50,
      `Frame-Analyse (Batch ${batchNum}/${totalBatches})`,
      progressDetail(frameModel));

    const batch = frames.slice(i, i + BATCH);
    const imageContent = batch.map(f => ({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: readFileSync(f.file).toString('base64') },
    }));
    const labelContent = {
      type: 'text',
      text: batch.map((f, idx) => `Bild ${idx + 1} = ${formatTime(f.timestampSec)}`).join('\n') +
        '\n\nBeschreibe jeden Screenshot in EINEM kurzen Satz. ' +
        'Fokus: sichtbarer Text, Zahlen, UI-Zustand, neue Person/Szene, konkrete Aktionen. ' +
        'KEINE Beschreibung von Mimik, Pose, Blickrichtung wenn sich inhaltlich nichts ändert. ' +
        'Wenn ein Bild inhaltlich identisch zum vorherigen ist: nur "unverändert". ' +
        'Format: "MM:SS – [Beschreibung]"',
    };

    try {
      const msg = await withRetry(() => anthropic.messages.create({
        model: frameModel,
        max_tokens: 600,
        messages: [{ role: 'user', content: [...imageContent, labelContent] }],
      }), `Frame-Batch ${batchNum}`);
      addClaudeCost(frameModel, msg.usage, 'frames');
      results.push((msg.content.find(b => b.type === 'text')?.text || '').trim());
    } catch (e) {
      results.push(batch.map(f => `${formatTime(f.timestampSec)} – (Fehler: ${e.message})`).join('\n'));
    }

    if (i + BATCH < frames.length) await new Promise(r => setTimeout(r, 300));
  }
  process.stderr.write('\n');
  return results.join('\n');
}

// ── Claude: Frame-Log verdichten ──────────────────────────────────────────────
async function compactFrameLog(rawFrameLog) {
  if (!rawFrameLog) return '';
  const msg = await withRetry(() => anthropic.messages.create({
    model: summaryModel,
    max_tokens: 4000,
    messages: [{
      role: 'user',
      content: `Hier chronologische Frame-Beschreibungen eines Videos (alle ${interval} Sekunden ein Screenshot).

Viele Frames zeigen dieselbe Szene ohne inhaltliche Veränderung. Verdichte zu einer kompakten Visual Timeline, die NUR Veränderungen festhält.

Format:
**MM:SS–MM:SS** – Stabile Szene in einem Satz
**MM:SS** – Konkrete Veränderung (Folie wechselt, neue UI-Ansicht, neuer Sprecher, sichtbarer Text/Zahlen)

Regeln:
- Fasse identische/sehr ähnliche aufeinanderfolgende Frames zu Zeit-Ranges zusammen
- WICHTIG — Video-Call/Konferenz mit wechselnden Sprecher-Kacheln: solange die Konferenz-Konstellation gleich bleibt (dieselben 2-N Personen wechseln sich in der Hauptkachel ab), ist das EINE stabile Szene. Schreibe EINE Range-Zeile wie "**MM:SS–MM:SS** – Zoom-Call zwischen [Name1] (Setting 1) und [Name2] (Setting 2), aktiver Sprecher wechselt mehrfach". Listing-Aufzählung jedes einzelnen "Schnitt zu …" ist verboten.
- NEUEN Eintrag nur wenn echte inhaltliche Veränderung: neue Person betritt/verlässt Call, Screenshare beginnt/endet, Folienwechsel, neue UI, sichtbarer Text/Zahlen/Beträge, Cut zu komplett neuer Location/Szenerie
- Sichtbaren Text 1:1 erfassen (Überschriften, Buttons, Zahlen, Beträge, Namen, Untertitel-Einblendungen)
- Weglassen: Mimik-/Pose-Variationen, Sprecher-Wechsel in stabiler Konferenz, "Person blickt nach unten", "Hand am Kinn", "leicht anderer Gesichtsausdruck"
- Wenn das ganze Video nur ein Talking Head ohne Folien ist: EINE Zeile reicht
- Ziel: kompakt genug, dass ein Leser in 10 Sekunden den visuellen Verlauf erfasst — nicht jeden Frame protokollieren

Frame-Beschreibungen:
${rawFrameLog}`,
    }],
  }), 'compactFrameLog');
  addClaudeCost(summaryModel, msg.usage, 'compact');
  return (msg.content.find(b => b.type === 'text')?.text || '').trim();
}

// ── Claude: Executive Summary + Action Items ──────────────────────────────────
async function generateSummary(transcript, visualTimeline) {
  const msg = await withRetry(() => anthropic.messages.create({
    model: summaryModel,
    max_tokens: 4000,
    messages: [{
      role: 'user',
      content: `Du analysierst einen Video-Mitschnitt (Meeting, Beratungsgespräch, Vortrag, Tutorial o.ä.).

VOLLTRANSKRIPT:
${transcript}

VISUAL TIMELINE (Screenshot-Veränderungen — kann leer sein):
${visualTimeline || '(keine Frame-Analyse vorhanden)'}

ARBEITSGRUNDSÄTZE:
- Übernimm Zahlen, Beträge, Daten, Termine, Personennamen, Firmennamen 1:1 wörtlich aus dem Transkript.
- Wenn nur eine Seite des Gesprächs hörbar ist (Single-Audio bei Zoom o.ä.): rekonstruiere das Gegenüber aus dem Kontext und benenne das explizit am Anfang in einer "> Hinweis:"-Zeile.
- Erfinde keine Namen, Beträge oder Termine. Wenn unsicher: "(unklar)" notieren.
- Auch implizite Aufgaben als Action Items erfassen ("Ich kläre nochmal mit Norbert" → klare Aufgabe).

ERSTELLE EIN STRUKTURIERTES BRIEFING in Markdown — Sections-Titel exakt wie unten (sie werden weiterverarbeitet):

## Executive Summary

Ein dichter Absatz (4-6 Sätze): Wer spricht mit wem, worum geht es, was wurde erreicht/entschieden, welche zentralen Zahlen/Eckpunkte. Konkret, keine Floskeln.

## Action Items

Gruppiere thematisch mit ### Unter-Überschriften, abhängig vom Inhalt — z. B.:
- ### Angebot & Vertragliches
- ### Klärungen mit [Name/Stelle]
- ### Follow-ups an [Name]
- ### Delegation an [Name]
- ### Nachverfolgen / [Gegenüber] soll liefern

Pro Gruppe Checkbox-Liste:
- [ ] Konkrete Aufgabe mit Kontext (Zahlen, Termine, Verantwortlicher fett)

Wenn das Video ein reines Tutorial/Solo-Vortrag ohne echte Aktionen ist: schreibe nur "_Keine konkreten Action Items im Video erkennbar._" und keine Gruppen.

## Eckdaten

Wenn das Gespräch quantitative Eckpunkte enthält (Pakete, Preise, Konditionen, Termine, Strukturen): Markdown-Tabelle:

| Punkt | Wert |
|---|---|
| ... | ... |

Wenn nicht zutreffend (z. B. reines Tutorial ohne Zahlen): Sektion komplett weglassen (nicht als leere Sektion!).

## Besprochene Themen

Bullet-Liste der Hauptthemen, jeweils mit den wichtigsten 1:1-Zahlen/-Fakten/-Namen. Verschachtelt wo sinnvoll. Hier dürfen Zahlen und Beträge ein zweites Mal auftauchen, damit sich die Detail-Sektion eigenständig liest.

## Entscheidungen

Klartext-Liste der getroffenen Entscheidungen ("**Punkt X**: Klartext"). Falls keine: "_Keine expliziten Entscheidungen getroffen._"

REGELN:
- Sections-Titel exakt wie oben.
- Sektion weglassen ist besser als leer/erfunden.
- NICHT das Volltranskript wiederholen — das wird separat darunter angehängt.
- NICHT die Visual Timeline wiederholen — die wird separat darunter angehängt.`,
    }],
  }), 'generateSummary');
  addClaudeCost(summaryModel, msg.usage, 'summary');
  return (msg.content.find(b => b.type === 'text')?.text || '').trim();
}

// ── Webinar-Modus: interaktive Rückfrage + Backend-Upload ─────────────────────
// TTY-Erkennung: Skill-Aufruf über Claude Code hat kein interaktives stdin.
// In dem Fall MUSS Claude die fehlenden Args (Title/Slug) selbst nachfragen,
// bevor der Script-Call rausgeht. Wir brechen mit klarer Meldung ab.
function isInteractive() {
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

function ask(question, def = '') {
  return new Promise(res => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question}${def ? ` [${def}]` : ''}: `, ans => {
      rl.close();
      res((ans || '').trim() || def);
    });
  });
}

async function resolveWebinarArgs(videoPath) {
  const baseName = basename(videoPath).replace(/\.[^.]+$/, '');
  const suggestedSlug  = sanitizeSlug(baseName);
  const suggestedTitle = baseName.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();

  const missingTitle = !webinarTitle;
  const missingSlug  = !webinarSlug;

  if (!missingTitle && !missingSlug) {
    webinarSlug = sanitizeSlug(webinarSlug);
    if (!webinarSlug) {
      console.error('Fehler: --slug ergibt nach Sanitize einen leeren String. Bitte a-z0-9- verwenden.');
      process.exit(1);
    }
    return;
  }

  if (!isInteractive()) {
    // Skill-/Automation-Kontext: keine Prompts. Claude soll die Frage stellen.
    const missing = [
      missingTitle ? '--title "<Site-Titel>"' : null,
      missingSlug  ? `--slug "<url-slug>"  (Vorschlag: "${suggestedSlug}")` : null,
    ].filter(Boolean).join(', ');
    console.error(
      `Fehler: --webinar erfordert ${missing}.\n` +
      `Vorschlag Title: "${suggestedTitle}"\n` +
      `Vorschlag Slug:  "${suggestedSlug}"\n` +
      `Beispiel:\n  --webinar --title "${suggestedTitle}" --slug "${suggestedSlug}"`
    );
    process.exit(1);
  }

  process.stderr.write('\n── Webinar-Modus: fehlende Angaben ──\n');
  if (missingTitle) webinarTitle = await ask('Site-Titel', suggestedTitle);
  if (missingSlug)  webinarSlug  = await ask('URL-Slug (a-z0-9-)', suggestedSlug);
  webinarSlug = sanitizeSlug(webinarSlug);
  if (!webinarTitle || !webinarSlug) {
    console.error('Fehler: Titel und Slug dürfen nicht leer sein.');
    process.exit(1);
  }
  process.stderr.write(`→ Title: "${webinarTitle}"\n→ Slug:  "${webinarSlug}"\n\n`);
}

async function runWebinarBackend(videoPath) {
  const stats = statSync(videoPath);
  const sizeMb = (stats.size / 1024 / 1024).toFixed(1);
  const deploy = !webinarNoDeploy;

  process.stderr.write(
    `Webinar-Modus (Backend): ${basename(videoPath)} (${sizeMb} MB)\n` +
    `  Title:  ${webinarTitle}\n` +
    `  Slug:   ${webinarSlug}\n` +
    `  Deploy: ${deploy ? 'ja' : 'nein'}\n` +
    `  API:    ${WEBINAR_API}\n`
  );

  const jobId = `cli-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const form = new FormData();
  const buf = readFileSync(videoPath);
  form.append('video', new Blob([buf], { type: 'video/mp4' }), basename(videoPath));
  form.append('language',      lang);
  form.append('frameInterval', String(interval));
  form.append('frameModel',    frameModel);
  form.append('webinar',       '1');
  form.append('webinar_title', webinarTitle);
  form.append('webinar_slug',  webinarSlug);
  form.append('webinar_deploy', deploy ? '1' : '0');

  process.stderr.write(`Upload läuft (jobId=${jobId})…`);
  const upT0 = Date.now();
  const uploadRes = await fetch(WEBINAR_API, {
    method: 'POST',
    headers: { 'x-job-id': jobId },
    body: form,
  });
  if (!uploadRes.ok) {
    const errText = await uploadRes.text().catch(() => '');
    console.error(`\nFehler beim Upload: HTTP ${uploadRes.status} — ${errText.slice(0, 400)}`);
    process.exit(1);
  }
  process.stderr.write(` ✓ (${Math.round((Date.now() - upT0) / 1000)}s)\n`);

  // Progress-Polling. Backend feuert Steps 1–8:
  //   1 Audio & Frames · 2 Whisper · 3 Frame-Analyse · 4 (skip) ·
  //   5 Frames Webinar · 6 Cluster+Vision · 7 Build+Render · 8 Fertig
  const stepLabel = {
    1: 'Audio & Frames extrahieren',
    2: 'Whisper Transkription',
    3: 'Frame-Analyse',
    4: 'Fertig (kein Webinar)',
    5: 'Webinar · Frames extrahieren',
    6: 'Webinar · Cluster + Vision',
    7: 'Webinar · Build + Render',
    8: 'Webinar · Deploy',
  };
  let lastLine = '';
  let result = null;
  for (;;) {
    await new Promise(r => setTimeout(r, 2000));
    let progRes;
    try {
      progRes = await fetch(`${WEBINAR_PROGRESS_BASE}/${jobId}`);
    } catch (e) {
      process.stderr.write(`\nProgress-Polling-Fehler: ${e.message} — retry…`);
      continue;
    }
    if (!progRes.ok) continue;
    const p = await progRes.json();
    if (p.status === 'error') {
      console.error(`\nBackend-Fehler: ${p.error || 'unbekannt'}`);
      process.exit(1);
    }
    const label = stepLabel[p.step] || p.label || `Step ${p.step}`;
    const line = `[${p.step || 0}/8] ${label} · ${p.pct || 0}% ${p.label ? '('+p.label+')' : ''}`;
    if (line !== lastLine) {
      process.stderr.write(`\r${line.padEnd(90)}`);
      lastLine = line;
    }
    if (p.status === 'done') {
      process.stderr.write('\n');
      result = p.result;
      break;
    }
  }

  const w = result?.webinar;
  if (!w) {
    console.error('Fehler: Backend hat kein webinar-Result geliefert.');
    process.exit(1);
  }
  if (w.error) {
    console.error(`Webinar-Pipeline-Fehler: ${w.error}`);
    process.exit(1);
  }

  // Ergebnis: Transkript + Webinar-URL
  console.log('\n══════════════════════════════════════════════════════');
  console.log('TRANSKRIPT');
  console.log('══════════════════════════════════════════════════════');
  console.log(result.transcript || '(leer)');

  if (result.frameAnalysis) {
    console.log('\n══════════════════════════════════════════════════════');
    console.log('FRAME-ANALYSE');
    console.log('══════════════════════════════════════════════════════');
    console.log(result.frameAnalysis);
  }

  console.log('\n════════════════════════════════════════');
  console.log('WEBINAR-SITE');
  console.log('════════════════════════════════════════');
  console.log(`URL:    ${w.publicUrl || '(nicht deployed — --no-deploy war gesetzt)'}`);
  console.log(`Slug:   ${w.slug}`);
  console.log(`OutDir: ${w.outDir}`);
  console.log(`Status: ${w.deployed ? 'deployed' : 'built (nicht deployed)'}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  // Webinar-Modus zweigt komplett auf die Backend-Pipeline ab (Server macht
  // Whisper + Frames + Slides-Site in einem Rutsch). Lokale Pipeline bleibt
  // für alle bisherigen Aufrufe unverändert.
  if (wantWebinar) {
    if (!videoArg) {
      console.error('Fehler: --webinar erfordert --video <pfad> (URLs werden nicht unterstützt).');
      process.exit(1);
    }
    const videoPath = resolve(videoArg);
    if (!existsSync(videoPath)) {
      console.error(`Fehler: Datei nicht gefunden: ${videoPath}`);
      process.exit(1);
    }
    await resolveWebinarArgs(videoPath);
    await runWebinarBackend(videoPath);
    return;
  }

  const base        = join(tmpdir(), `tf-${Date.now()}`);
  const wavFile     = base + '.wav';
  const framesDir   = base + '_frames';
  let   audioFiles  = [];
  let   tempDownload = null;

  try {
    // ── yt-dlp Download (wenn --url angegeben) ────────────────────────────────
    let videoPath;
    if (urlArg) {
      tempDownload = base + '-dl.mp4';
      process.stderr.write(`Lade herunter: ${urlArg}\n`);
      const cmd = `yt-dlp --no-playlist --no-warnings --cookies-from-browser chrome ` +
        `-f "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best" ` +
        `--merge-output-format mp4 -o "${tempDownload}" "${urlArg}"`;
      await execAsync(cmd, { timeout: 600_000 });
      process.stderr.write('Download ✓\n');
      videoPath = tempDownload;
    } else {
      videoPath = resolve(videoArg);
      if (!existsSync(videoPath)) { console.error(`Fehler: Datei nicht gefunden: ${videoPath}`); process.exit(1); }
    }

    const modeLabel = noFrames ? 'audio-only' : `interval=${interval}s | model=${frameModel}`;
    process.stderr.write(`Video: ${basename(videoPath)} | lang=${lang} | ${modeLabel}${wantSummary ? ` | summary=${summaryModel}` : ''}\n`);

    scriptT0 = Date.now();

    // Frame-Cache prüfen: ist eine frühere Frame-Analyse vorhanden und jünger als das Video?
    let cachedFrameLog = '';
    if (FRAMES_CACHE && !noFrames && existsSync(FRAMES_CACHE)) {
      try {
        const cacheMtime = statSync(FRAMES_CACHE).mtimeMs;
        const videoMtime = statSync(videoPath).mtimeMs;
        const cacheContent = readFileSync(FRAMES_CACHE, 'utf8');
        if (cacheMtime >= videoMtime && cacheContent.trim().length > 0) {
          cachedFrameLog = cacheContent;
          process.stderr.write(`Frame-Cache gefunden (${(cacheContent.length/1024).toFixed(1)} KB) — Frame-Analyse wird übersprungen\n`);
        }
      } catch {}
    }

    setProgress(2, 'Audio & Frames extrahieren', 'ffmpeg läuft (~10–30 s)…');
    // 1. Audio extrahieren (+ optional Frames parallel, falls kein Cache)
    let rawFrameLog = cachedFrameLog;
    if (noFrames || cachedFrameLog) {
      process.stderr.write('Audio extrahieren…');
      await extractAudio(videoPath, wavFile);
      process.stderr.write(' ✓\n');
    } else {
      process.stderr.write('Audio & Frames extrahieren…');
      const [, frames] = await Promise.all([
        extractAudio(videoPath, wavFile),
        extractFrames(videoPath, framesDir),
      ]);
      process.stderr.write(` ✓ (${frames.length} Frames)\n`);

      // 2. Frame-Analyse (Progress 5-55 %)
      rawFrameLog = await analyseFrames(frames);
      // Sofort persistieren, damit ein späterer Whisper-/Summary-Fehler die
      // teure Frame-Analyse nicht killt.
      if (FRAMES_CACHE && rawFrameLog) {
        try { writeFileSync(FRAMES_CACHE, rawFrameLog); } catch {}
      }
    }

    // 3. Whisper — Audio vorbereiten (MP3 64k, ggf. in 30-Min-Chunks splitten),
    //    Chunks parallel transkribieren, Segment-Offsets korrigieren, Filter.
    setProgress(60, 'Whisper Transkription', progressDetail(`whisper-1 (${lang})`),
      { indeterminate: true, startedAt: Math.floor(Date.now() / 1000) });
    const whisperChunks = await prepareWhisperChunks(wavFile);
    audioFiles = whisperChunks.map(c => c.file);
    process.stderr.write(`Whisper Transkription (${whisperChunks.length} Chunk${whisperChunks.length > 1 ? 's' : ''})…`);
    const transcription = await transcribeChunks(whisperChunks);
    if (transcription.duration) {
      costs.audio_min = transcription.duration / 60;
      costs.whisper = costs.audio_min * PRICING['whisper-1'].perMinute;
    }

    const HALLUCINATIONS = /amara\.org|untertitel von|untertitel der|\[musik\]|\[applaus\]|\[stille\]/i;
    const cleaned = (transcription.segments || []).filter(seg => {
      const text = (seg.text || '').trim();
      if (!text) return false;
      if ((seg.no_speech_prob ?? 0) > 0.8) return false;
      if (HALLUCINATIONS.test(text)) return false;
      return true;
    });
    // Konsekutive Duplikate (3× gleicher Text in Folge → Halluzination bei Stille)
    const deduped = [];
    for (const seg of cleaned) {
      const norm = seg.text.trim().toLowerCase();
      const recent = deduped.slice(-2).map(s => s.text.trim().toLowerCase());
      if (recent.length === 2 && recent.every(t => t === norm)) continue;
      deduped.push(seg);
    }
    const transcriptText = deduped.length
      ? deduped.map(s => s.text.trim()).join(' ')
      : (transcription.text || '');
    process.stderr.write(` ✓ (${deduped.length} Segmente)\n`);

    // 3b. Optional: pyannote-Diarisation auf demselben Audio.
    //     Bei Fehlern → diarTranscript bleibt leer und Original-Pfad greift.
    let diarTranscript = '';
    let diarMeta = null;
    if (wantDiarize) {
      setProgress(70, 'Sprecher-Diarisation (pyannote)',
        `Modell: speaker-diarization-3.1${speakerNames.length ? ` · Map: ${speakerNames.join(',')}` : ''}`,
        { indeterminate: true, startedAt: Math.floor(Date.now() / 1000) });
      // Erstes Whisper-Chunk-MP3 wird als Diarisations-Input genutzt; bei
      // mehreren Chunks fällt die Logik zurück auf die WAV-Originaldatei,
      // damit der Speaker-Index über das gesamte Audio konsistent bleibt.
      const diarSource = (whisperChunks.length === 1 && existsSync(whisperChunks[0].file))
        ? whisperChunks[0].file
        : wavFile;
      process.stderr.write('Sprecher-Diarisation (pyannote)…');
      diarMeta = await runDiarization(diarSource);
      if (diarMeta && deduped.length) {
        const labelMap = buildSpeakerLabelMap(diarMeta.turns, speakerNames);
        diarTranscript = buildSpeakerTranscript(deduped, diarMeta.turns, labelMap);
        process.stderr.write(` ✓ (${diarMeta.num_speakers} Sprecher, ${diarMeta.turns.length} Turns)\n`);
      } else if (diarMeta) {
        process.stderr.write(' ✓ (Diarisation ok, aber keine Whisper-Segmente zum Mergen)\n');
      } else {
        process.stderr.write(' (übersprungen — siehe Hinweise oben)\n');
      }
    }

    // 4. Optional: Frame-Log verdichten + Summary erzeugen
    let visualTimeline = '';
    let summary = '';
    if (wantSummary) {
      if (rawFrameLog) {
        process.stderr.write('Frame-Log verdichten…');
        setProgress(75, 'Visual Timeline verdichten', progressDetail(summaryModel),
          { indeterminate: true, startedAt: Math.floor(Date.now() / 1000) });
        visualTimeline = await compactFrameLog(rawFrameLog);
        process.stderr.write(' ✓\n');
      }
      process.stderr.write('Summary + Action Items erzeugen…');
      setProgress(85, 'Summary + Action Items', progressDetail(summaryModel),
        { indeterminate: true, startedAt: Math.floor(Date.now() / 1000) });
      summary = await generateSummary(transcriptText, visualTimeline);
      process.stderr.write(' ✓\n');
    }
    setProgress(95, 'Ergebnis schreiben', '');

    // 5. Strukturierter Markdown-Output (--summary) oder Legacy-Output
    //    Bei aktivem --diarize wird das Speaker-Transkript bevorzugt, das
    //    Plaintext-Transkript zusätzlich darunter erhalten (rückwärtskompat.).
    if (wantSummary) {
      console.log(summary);
      if (diarTranscript) {
        console.log('\n## Sprecher-Transkript\n');
        console.log(diarTranscript);
      }
      console.log('\n## Volltranskript\n');
      console.log(transcriptText);
      if (visualTimeline) {
        console.log('\n## Visual Timeline\n');
        console.log(visualTimeline);
      }
    } else {
      if (rawFrameLog) {
        console.log('\n══════════════════════════════════════════════════════');
        console.log('FRAME-ANALYSE');
        console.log('══════════════════════════════════════════════════════');
        console.log(rawFrameLog);
      }
      if (diarTranscript) {
        console.log('\n══════════════════════════════════════════════════════');
        console.log('SPRECHER-TRANSKRIPT');
        console.log('══════════════════════════════════════════════════════');
        console.log(diarTranscript);
      }
      console.log('\n══════════════════════════════════════════════════════');
      console.log('TRANSKRIPT');
      console.log('══════════════════════════════════════════════════════');
      console.log(transcriptText);
    }

    // 6. Metrics-Datei für Quick-Action-Wrapper (Token-Kosten in MD-Header)
    const totalUsd = costs.whisper + costs.frames + costs.compact + costs.summary;
    if (METRICS_FILE) {
      try {
        writeFileSync(METRICS_FILE, JSON.stringify({
          total_usd: totalUsd,
          whisper_usd: costs.whisper,
          frames_usd: costs.frames,
          compact_usd: costs.compact,
          summary_usd: costs.summary,
          audio_minutes: costs.audio_min,
          frame_model: frameModel,
          summary_model: summaryModel,
          frames_tokens_in: costs.frames_in,
          frames_tokens_out: costs.frames_out,
          summary_tokens_in: costs.summary_in,
          summary_tokens_out: costs.summary_out,
        }, null, 2));
      } catch (e) {
        process.stderr.write(`Metrics-Datei konnte nicht geschrieben werden: ${e.message}\n`);
      }
    }
    process.stderr.write(`Kosten: $${totalUsd.toFixed(4)} (Whisper $${costs.whisper.toFixed(4)} · Frames $${costs.frames.toFixed(4)} · Summary $${(costs.compact + costs.summary).toFixed(4)})\n`);
    setProgress(99, 'Fertig', `Kosten: $${totalUsd.toFixed(2)}`);

  } finally {
    safeUnlink(wavFile);
    audioFiles.filter(f => f && f !== wavFile).forEach(safeUnlink);
    safeRmDir(framesDir);
    if (tempDownload) safeUnlink(tempDownload);
  }
})();
