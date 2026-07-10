import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import { createReadStream, existsSync, mkdirSync, unlinkSync, statSync, readdirSync, readFileSync, writeFileSync } from 'fs';
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

// ── CORS (Upload-Endpoints laufen auf :8443, statische Assets auf :443) ────
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowedOrigins = [
    'https://transcribeforge.hiltmann.cloud',
    'https://transcribeforge.hiltmann.cloud:8443',
    'http://localhost:3001',
  ];
  if (origin && allowedOrigins.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
  }
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, x-job-id');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// ── GET /webinare/  — Auto-Index aller deployten Webinar-Sub-Sites ─────────
// MUSS vor der static-Middleware registriert sein, sonst greift static und
// liefert 404 für das Verzeichnis-Root.
const WEBINARE_DIR = join(__dirname, 'webinare');

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function collectWebinare() {
  if (!existsSync(WEBINARE_DIR)) return [];
  const entries = [];
  for (const name of readdirSync(WEBINARE_DIR)) {
    const slugDir = join(WEBINARE_DIR, name);
    let st;
    try { st = statSync(slugDir); } catch { continue; }
    if (!st.isDirectory()) continue;
    const dataFile = join(slugDir, 'site_data.json');
    if (!existsSync(dataFile)) continue;
    let data;
    try { data = JSON.parse(readFileSync(dataFile, 'utf8')); } catch { continue; }
    const meta = data?.meta || {};
    const slides = Array.isArray(data?.slides) ? data.slides : [];
    const firstSlide = slides.find(s => s && s.file);
    entries.push({
      slug: name,
      title: meta.title || name,
      generated: meta.generated || '',
      slideCount: meta.slide_count ?? slides.length,
      thumb: firstSlide
        ? `/webinare/${encodeURIComponent(name)}/assets/frames_full/${encodeURIComponent(firstSlide.file)}`
        : null,
      mtime: st.mtimeMs,
      firstSummary: firstSlide?.slide_summary || '',
    });
  }
  entries.sort((a, b) => {
    if (a.generated && b.generated && a.generated !== b.generated) {
      return a.generated < b.generated ? 1 : -1;
    }
    return b.mtime - a.mtime;
  });
  return entries;
}

function renderWebinareIndex(entries) {
  const cards = entries.map(e => {
    const href = `/webinare/${encodeURIComponent(e.slug)}/`;
    const thumb = e.thumb
      ? `<img src="${escapeHtml(e.thumb)}" alt="Vorschau ${escapeHtml(e.title)}" loading="lazy" />`
      : `<div class="thumb-fallback">Keine Vorschau</div>`;
    const date = e.generated ? escapeHtml(e.generated) : '—';
    const slideText = e.slideCount === 1 ? '1 Slide' : `${e.slideCount} Slides`;
    return `<a class="wcard" href="${escapeHtml(href)}">
      <div class="wcard-img">${thumb}<span class="wcard-badge">${escapeHtml(slideText)}</span></div>
      <div class="wcard-body">
        <h3>${escapeHtml(e.title)}</h3>
        <p class="wcard-slug">${escapeHtml(e.slug)}</p>
        <p class="wcard-meta"><span class="wcard-date">${date}</span></p>
      </div>
    </a>`;
  }).join('\n');

  // Fonts: aus einem der Deploy-Ordner nachladen (Inter liegt in jedem <slug>/assets/fonts/).
  // Falls es (noch) keine Deploys gibt, fällt Inter auf die System-Fallbacks zurück.
  const fontSlug = entries.length ? encodeURIComponent(entries[0].slug) : null;
  const fontFace = fontSlug ? `
    @font-face { font-family: 'Inter'; src: url('/webinare/${fontSlug}/assets/fonts/Inter-Regular.woff2') format('woff2'); font-weight: 400; font-display: swap; }
    @font-face { font-family: 'Inter'; src: url('/webinare/${fontSlug}/assets/fonts/Inter-Medium.woff2') format('woff2'); font-weight: 500; font-display: swap; }
    @font-face { font-family: 'Inter'; src: url('/webinare/${fontSlug}/assets/fonts/Inter-SemiBold.woff2') format('woff2'); font-weight: 600; font-display: swap; }
    @font-face { font-family: 'Inter'; src: url('/webinare/${fontSlug}/assets/fonts/Inter-Bold.woff2') format('woff2'); font-weight: 700; font-display: swap; }
  ` : '';

  const emptyBlock = entries.length ? '' : `
    <div class="empty">
      <h2>Noch keine Webinare deployed</h2>
      <p>Sobald du im Webinar-Modus eine Analyse mit <code>--webinar-deploy</code> abschließt,
      erscheint hier automatisch eine Kachel.</p>
    </div>`;

  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<title>TranscribeForge Webinare</title>
<style>
${fontFace}
:root {
  --bg-base: #0A0A0F;
  --bg-surface: #111118;
  --bg-elevated: #1A1A24;
  --bg-hover: #22222E;
  --accent-primary: #A3E635;
  --accent-secondary: #65A30D;
  --accent-glow: rgba(163, 230, 53, 0.32);
  --text-primary: #F8F8FF;
  --text-secondary: #9CA3AF;
  --text-muted: #4B5563;
  --border-subtle: #1F2937;
  --border-default: #374151;
  --radius: 10px;
  --radius-xl: 16px;
}
* { box-sizing: border-box; }
html, body {
  margin: 0; padding: 0;
  background: var(--bg-base);
  color: var(--text-primary);
  font-family: 'Inter', system-ui, -apple-system, sans-serif;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
body {
  background:
    radial-gradient(1200px 600px at 15% -10%, rgba(163, 230, 53, 0.14), transparent 60%),
    radial-gradient(1000px 500px at 85% 0%, rgba(101, 163, 13, 0.10), transparent 60%),
    var(--bg-base);
  min-height: 100vh;
}
a { color: var(--accent-primary); text-decoration: none; }
.site-header {
  position: sticky; top: 0; z-index: 40;
  background: rgba(10, 10, 15, 0.85);
  backdrop-filter: saturate(140%) blur(16px);
  -webkit-backdrop-filter: saturate(140%) blur(16px);
  border-bottom: 1px solid var(--border-subtle);
}
.header-inner {
  max-width: 1200px; margin: 0 auto;
  padding: 14px 24px;
  display: flex; align-items: center; justify-content: space-between;
  gap: 24px; flex-wrap: wrap;
}
.header-title h1 { font-size: 1.25rem; font-weight: 600; margin: 0; letter-spacing: -0.01em; }
.header-title .subtitle { margin: 4px 0 0; color: var(--text-secondary); font-size: 0.875rem; }
.header-count {
  font-size: 0.875rem; color: var(--text-secondary);
  padding: 6px 12px; border: 1px solid var(--border-subtle);
  border-radius: 999px; background: var(--bg-surface);
}
.container { max-width: 1200px; margin: 0 auto; padding: 48px 24px 80px; }
.section-head { margin: 0 0 32px; }
.section-eyebrow {
  display: inline-block; font-size: 0.75rem;
  letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--accent-primary); font-weight: 600; margin-bottom: 8px;
}
.section-head h2 {
  font-size: 1.875rem; font-weight: 700; margin: 0;
  letter-spacing: -0.02em;
  background: linear-gradient(135deg, var(--text-primary) 0%, #C7C9D8 100%);
  -webkit-background-clip: text; background-clip: text;
  -webkit-text-fill-color: transparent;
}
.section-lede { margin: 12px 0 0; color: var(--text-secondary); max-width: 780px; }
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 20px;
}
.wcard {
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-xl);
  overflow: hidden;
  display: flex; flex-direction: column;
  transition: border-color 160ms ease, transform 160ms ease, box-shadow 160ms ease;
  color: inherit;
}
.wcard:hover, .wcard:focus-visible {
  border-color: var(--accent-primary);
  transform: translateY(-2px);
  box-shadow: 0 10px 40px -10px var(--accent-glow);
  outline: none;
}
.wcard-img {
  position: relative;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  background: var(--bg-base);
  border-bottom: 1px solid var(--border-subtle);
}
.wcard-img img { width: 100%; height: 100%; object-fit: cover; display: block; }
.thumb-fallback {
  width: 100%; height: 100%;
  display: flex; align-items: center; justify-content: center;
  color: var(--text-muted); font-size: 0.875rem;
}
.wcard-badge {
  position: absolute; top: 10px; left: 10px;
  background: rgba(10, 10, 15, 0.82);
  border: 1px solid rgba(163, 230, 53, 0.55);
  color: var(--text-primary);
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 0.75rem; font-weight: 600;
  letter-spacing: 0.03em;
  backdrop-filter: blur(8px);
}
.wcard-body {
  padding: 16px 18px 20px;
  display: flex; flex-direction: column; gap: 6px; flex: 1;
}
.wcard-body h3 {
  margin: 0; font-size: 1rem; font-weight: 600;
  color: var(--text-primary); line-height: 1.4;
}
.wcard-slug {
  margin: 0; font-size: 0.75rem;
  color: var(--text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  word-break: break-all;
}
.wcard-meta { margin: 6px 0 0; font-size: 0.75rem; color: var(--text-secondary); }
.wcard-date {
  display: inline-block;
  color: var(--accent-primary);
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.empty {
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-xl);
  padding: 48px 32px;
  text-align: center;
  color: var(--text-secondary);
}
.empty h2 { margin: 0 0 8px; color: var(--text-primary); font-size: 1.25rem; }
.empty code {
  background: var(--bg-elevated);
  padding: 2px 6px; border-radius: 4px;
  font-size: 0.875rem;
}
.site-footer {
  margin-top: 64px; padding-top: 24px;
  border-top: 1px solid var(--border-subtle);
  color: var(--text-secondary); font-size: 0.875rem;
  text-align: center;
}
@media (max-width: 768px) {
  .container { padding: 24px 16px 48px; }
  .header-inner { padding: 12px 16px; }
  .grid { grid-template-columns: 1fr; }
}
</style>
</head>
<body>
<header class="site-header">
  <div class="header-inner">
    <div class="header-title">
      <h1>TranscribeForge Webinare</h1>
      <p class="subtitle">Analysierte Webinar-Aufzeichnungen mit Whisper-Transkript und KI-Slide-Erkennung.</p>
    </div>
    <div class="header-count">${entries.length} ${entries.length === 1 ? 'Webinar' : 'Webinare'}</div>
  </div>
</header>
<main class="container">
  <div class="section-head">
    <span class="section-eyebrow">Übersicht</span>
    <h2>Deployed Sites</h2>
    <p class="section-lede">Klick auf eine Kachel öffnet die vollständige Slides-Ansicht der jeweiligen Aufzeichnung — inklusive Timeline, Screenshots und Volltranskript.</p>
  </div>
  ${emptyBlock}
  <div class="grid">
${cards}
  </div>
  <footer class="site-footer">
    <p>Generiert von TranscribeForge · Alle Assets lokal, keine externen Requests.</p>
  </footer>
</main>
</body>
</html>`;
}

// Route: trailing slash oder ohne — beide vor der static-Middleware.
app.get(['/webinare', '/webinare/'], (req, res) => {
  if (req.path === '/webinare') return res.redirect(301, '/webinare/');
  try {
    const entries = collectWebinare();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(renderWebinareIndex(entries));
  } catch (e) {
    console.error('Webinare-Index-Fehler:', e);
    res.status(500).send('Fehler beim Erstellen der Übersicht.');
  }
});

app.use('/webinare', express.static(join(__dirname, 'webinare'), { maxAge: '1d' }));

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
  const speakersRaw = (body.speakers || '').toString().trim();
  return {
    language:    body.language    || 'de',
    intervalSec: Math.max(1, Math.min(60, parseInt(body.frameInterval) || 3)),
    frameModel:  VALID_FRAME_MODELS.includes(body.frameModel) ? body.frameModel : 'claude-haiku-4-5-20251001',
    noFrames:    body.noFrames === true || body.noFrames === 'true',
    diarize:     body.diarize === true || body.diarize === 'true',
    speakers:    speakersRaw ? speakersRaw.split(',').map(s => s.trim()).filter(Boolean) : [],
    minSpeakers: body.minSpeakers ? parseInt(body.minSpeakers) : null,
    maxSpeakers: body.maxSpeakers ? parseInt(body.maxSpeakers) : null,
    webinar:       body.webinar === true || body.webinar === '1' || body.webinar === 'true',
    webinarTitle:  (body.webinar_title || '').toString().trim(),
    webinarSlug:   sanitizeSlug(body.webinar_slug || ''),
    webinarDeploy: body.webinar_deploy === true || body.webinar_deploy === '1' || body.webinar_deploy === 'true',
  };
}

function sanitizeSlug(raw) {
  return (raw || '').toString()
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// ── pyannote-Diarisation (optional, additiv) ───────────────────────────────
// Defensiver Wrapper: bei jedem Fehler → null zurück, Caller läuft mit dem
// normalen Whisper-Output weiter (kein Crash).
const DIARIZE_PY      = join(__dirname, 'python', 'diarize.py');
const DIARIZE_VENV_PY = join(__dirname, 'python', '.venv', 'bin', 'python3');

function runDiarizationServer(audioFile, { minSpeakers, maxSpeakers }) {
  return new Promise(resolve => {
    if (!existsSync(DIARIZE_PY)) return resolve(null);
    const pyBin = existsSync(DIARIZE_VENV_PY) ? DIARIZE_VENV_PY : 'python3';
    const cliArgs = [DIARIZE_PY, '--audio', audioFile];
    if (minSpeakers) cliArgs.push('--min-speakers', String(minSpeakers));
    if (maxSpeakers) cliArgs.push('--max-speakers', String(maxSpeakers));
    let stdout = '';
    let stderr = '';
    const child = spawn(pyBin, cliArgs, { env: { ...process.env } });
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const trimmed = stdout.trim();
      if (!trimmed) {
        console.warn('Diarisation übersprungen:', stderr.slice(-300));
        return resolve(null);
      }
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.error || !Array.isArray(parsed.turns) || parsed.turns.length === 0) {
          console.warn('Diarisation übersprungen:', parsed.error || 'leere Turns');
          return resolve(null);
        }
        resolve(parsed);
      } catch {
        resolve(null);
      }
    });
  });
}

function buildSpeakerTranscriptServer(segments, turns, speakerNames) {
  const labelMap = new Map();
  if (speakerNames && speakerNames.length) {
    let idx = 0;
    for (const t of turns) {
      if (!labelMap.has(t.speaker) && idx < speakerNames.length) {
        labelMap.set(t.speaker, speakerNames[idx++]);
      }
    }
  }
  const labeled = segments.map(seg => {
    const start = seg.start || 0;
    const end   = seg.end   || start;
    let best = null, bestOv = 0;
    for (const t of turns) {
      const ov = Math.max(0, Math.min(end, t.end) - Math.max(start, t.start));
      if (ov > bestOv) { bestOv = ov; best = t.speaker; }
    }
    const name = labelMap.get(best) || best || 'SPEAKER_??';
    return { start, end, name, text: (seg.text || '').trim() };
  }).filter(s => s.text);
  const merged = [];
  for (const s of labeled) {
    const last = merged[merged.length - 1];
    if (last && last.name === s.name) { last.text += ' ' + s.text; last.end = s.end; }
    else merged.push({ ...s });
  }
  return merged.map(m => `[${formatTime(Math.floor(m.start))} – ${m.name}]: ${m.text}`).join('\n\n');
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

// ── YouTube Auth ───────────────────────────────────────────────────────────
const YT_COOKIES_FILE = '/app/youtube-cookies.txt';
const YT_TOKENS_FILE  = '/app/yt-tokens.json';
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';

function ytCookiesActive() {
  try { return existsSync(YT_COOKIES_FILE) && statSync(YT_COOKIES_FILE).size > 100; }
  catch { return false; }
}

function loadYtTokens() {
  try { return JSON.parse(readFileSync(YT_TOKENS_FILE, 'utf8')); } catch { return null; }
}

function saveYtTokens(data) {
  writeFileSync(YT_TOKENS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function ytTokensActive() {
  const t = loadYtTokens();
  return !!(t?.access_token && t?.refresh_token);
}

async function getValidAccessToken() {
  if (!GOOGLE_CLIENT_ID) return null;
  const tokens = loadYtTokens();
  if (!tokens?.access_token) return null;
  if (tokens.expires_at && Date.now() > tokens.expires_at - 300_000) {
    try {
      const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
          refresh_token: tokens.refresh_token, grant_type: 'refresh_token',
        }),
      });
      const d = await r.json();
      if (d.access_token) {
        tokens.access_token = d.access_token;
        tokens.expires_at   = Date.now() + (d.expires_in || 3600) * 1000;
        saveYtTokens(tokens);
        return tokens.access_token;
      }
    } catch {}
    return null;
  }
  return tokens.access_token;
}

function convertToNetscapeCookies(raw) {
  const lines = ['# Netscape HTTP Cookie File', '# Generated by TranscribeForge', ''];
  raw.split(';').map(s => s.trim()).filter(Boolean).forEach(pair => {
    const eq = pair.indexOf('=');
    if (eq < 0) return;
    const name  = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) return;
    lines.push(['.youtube.com', 'TRUE', '/', 'TRUE', '9999999999', name, value].join('\t'));
  });
  return lines.join('\n') + '\n';
}

// ── yt-dlp download ────────────────────────────────────────────────────────
function ytDlpAuthArgs() {
  const potProvider = process.env.BGUTIL_POT_PROVIDER_URL || 'http://bgutil-provider:4416';
  const potArg = `--extractor-args "youtubepot-bgutilhttp:base_url=${potProvider}"`;
  if (ytCookiesActive()) {
    return `${potArg} --cookies "${YT_COOKIES_FILE}" --extractor-args "youtube:player_client=web,mweb"`;
  }
  return potArg;
}

async function downloadWithYtDlp(url, destPath, onProgress, formatId) {
  onProgress?.('Video wird heruntergeladen…');
  const fmt = formatId && /^[\w+./@-]+$/.test(formatId)
    ? formatId
    : 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best';
  const cmd = `yt-dlp --no-playlist --no-warnings ${ytDlpAuthArgs()} ` +
    `-f "${fmt}" --merge-output-format mp4 -o "${destPath}" "${url}"`;
  await execAsync(cmd, { timeout: 600_000 });
}

// ── POST /api/video/formats — list available formats (YouTube + Vimeo) ──────
app.post('/api/video/formats', async (req, res) => {
  const url = (req.body?.url || '').trim();
  if (!/^https?:\/\//.test(url)) return res.status(400).json({ error: 'Ungültige URL.' });
  try {
    const cmd = `yt-dlp --no-playlist --no-warnings --ignore-no-formats-error ${ytDlpAuthArgs()} --dump-single-json --skip-download "${url}"`;
    const { stdout } = await execAsync(cmd, { timeout: 60_000, maxBuffer: 50 * 1024 * 1024 });
    const info = JSON.parse(stdout);
    const formats = (info.formats || [])
      .filter(f => f.ext !== 'mhtml')
      .map(f => ({
        format_id: f.format_id,
        ext: f.ext,
        resolution: f.resolution || (f.height ? `${f.width || '?'}x${f.height}` : null),
        height: f.height || null,
        fps: f.fps || null,
        vcodec: f.vcodec,
        acodec: f.acodec,
        filesize: f.filesize || f.filesize_approx || null,
        tbr: f.tbr || null,
        format_note: f.format_note || '',
      }));
    res.json({
      title: info.title || '',
      duration: info.duration || 0,
      thumbnail: info.thumbnail || '',
      formats,
    });
  } catch (e) {
    const msg = (e.stderr || e.message || '').toString();
    res.status(500).json({ error: msg.slice(-500) });
  }
});

// ── GET /api/youtube/status ────────────────────────────────────────────────
app.get('/api/youtube/status', (_req, res) => {
  const method = ytTokensActive() ? 'oauth' : ytCookiesActive() ? 'cookies' : 'none';
  res.json({ connected: method !== 'none', method, oauthConfigured: !!GOOGLE_CLIENT_ID });
});

// ── GET /api/youtube/oauth/start  (SSE — Google Device Authorization Flow) ─
app.get('/api/youtube/oauth/start', (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(400).json({ error: 'GOOGLE_CLIENT_ID nicht konfiguriert.' });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  (async () => {
    try {
      const dr = await fetch('https://oauth2.googleapis.com/device/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: GOOGLE_CLIENT_ID,
          scope: 'https://www.googleapis.com/auth/youtube',
        }),
      });
      const dd = await dr.json();
      if (!dd.device_code) {
        send({ type: 'error', message: dd.error_description || 'Gerät konnte nicht registriert werden.' });
        return res.end();
      }

      send({ type: 'code', user_code: dd.user_code, verification_url: dd.verification_url || 'https://google.com/device' });

      const pollMs  = (dd.interval || 5) * 1000;
      const deadline = Date.now() + dd.expires_in * 1000;

      const poll = async () => {
        if (req.socket.destroyed || Date.now() > deadline) {
          send({ type: 'error', message: 'Zeitüberschreitung — bitte erneut versuchen.' });
          return res.end();
        }
        const tr = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
            device_code: dd.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          }),
        });
        const td = await tr.json();
        if (td.access_token) {
          saveYtTokens({ access_token: td.access_token, refresh_token: td.refresh_token, expires_at: Date.now() + (td.expires_in || 3600) * 1000 });
          send({ type: 'connected' });
          res.end();
        } else if (td.error === 'authorization_pending') {
          setTimeout(poll, pollMs);
        } else {
          send({ type: 'error', message: td.error_description || td.error });
          res.end();
        }
      };
      setTimeout(poll, pollMs);
    } catch (e) {
      send({ type: 'error', message: e.message });
      res.end();
    }
  })();
});

// ── DELETE /api/youtube/auth  (logout) ────────────────────────────────────
app.delete('/api/youtube/auth', (_req, res) => {
  try { if (existsSync(YT_TOKENS_FILE)) unlinkSync(YT_TOKENS_FILE); } catch {}
  try { writeFileSync(YT_COOKIES_FILE, '', 'utf8'); } catch {}
  res.json({ ok: true });
});

// ── POST /api/youtube/save-cookies ────────────────────────────────────────
app.options('/api/youtube/save-cookies', (_req, res) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }).status(204).end();
});
app.post('/api/youtube/save-cookies', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const raw = (req.body?.cookies || '').trim();
  if (!raw) return res.status(400).json({ error: 'Kein Cookie-String übergeben.' });
  try {
    const netscape = convertToNetscapeCookies(raw);
    const count = netscape.split('\n').filter(l => l && !l.startsWith('#')).length;
    if (count < 3) return res.status(400).json({ error: 'Zu wenige Cookies erkannt — vollständigen Cookie-Header einfügen.' });
    writeFileSync(YT_COOKIES_FILE, netscape, 'utf8');
    res.json({ ok: true, count });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Progress tracking ──────────────────────────────────────────────────────
const jobProgress = new Map();

function setP(jobId, step, pct, label) {
  if (!jobId) return;
  const prev = jobProgress.get(jobId) || {};
  jobProgress.set(jobId, {
    ...prev,
    step,
    pct: Math.round(pct),
    label: label || '',
    status: prev.status || 'running',
  });
}

function setJobResult(jobId, result) {
  if (!jobId) return;
  const prev = jobProgress.get(jobId) || {};
  jobProgress.set(jobId, { ...prev, status: 'done', result });
  setTimeout(() => jobProgress.delete(jobId), 5 * 60_000);
}

function setJobError(jobId, message) {
  if (!jobId) return;
  const prev = jobProgress.get(jobId) || {};
  jobProgress.set(jobId, { ...prev, status: 'error', error: message });
  setTimeout(() => jobProgress.delete(jobId), 5 * 60_000);
}

app.get('/api/progress/:jobId', (req, res) => {
  res.json(jobProgress.get(req.params.jobId) || { step: 0, pct: 0, label: '', status: 'unknown' });
});

// ── Core transcription pipeline ────────────────────────────────────────────
async function transcribePipeline(videoPath, opts, jobId) {
  const { language, intervalSec, frameModel, noFrames, diarize, speakers, minSpeakers, maxSpeakers } = opts;
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
    const whisperReq = {
      model:    'whisper-1',
      file:     createReadStream(audioFile),
      language: language === 'auto' ? undefined : language,
    };
    if (diarize) {
      // Diarisation braucht Whisper-Segmente mit Zeitstempeln.
      whisperReq.response_format = 'verbose_json';
      whisperReq.timestamp_granularities = ['segment'];
    }
    const transcription = await openai.audio.transcriptions.create(whisperReq);
    setP(jobId, 2, 100, 'Transkript fertig');

    // Step 2b: optional pyannote-Diarisation auf demselben Audio
    let speakerTranscript = '';
    let diarMeta = null;
    if (diarize) {
      setP(jobId, 2, 100, 'Sprecher-Diarisation…');
      diarMeta = await runDiarizationServer(audioFile, { minSpeakers, maxSpeakers });
      if (diarMeta && Array.isArray(transcription.segments) && transcription.segments.length) {
        speakerTranscript = buildSpeakerTranscriptServer(transcription.segments, diarMeta.turns, speakers);
      }
    }

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

    // Step 4: Webinar-Modus (optional) — Slides-Site rendern & deployen
    let webinar = null;
    if (opts.webinar) {
      try {
        webinar = await runWebinarPipeline({
          videoPath,
          jobId,
          slug: opts.webinarSlug,
          title: opts.webinarTitle,
          transcript: transcription.text,
          frameAnalysis,
          deploy: opts.webinarDeploy,
        });
      } catch (e) {
        console.error('Webinar-Pipeline-Fehler:', e);
        webinar = { error: e.message };
      }
    }

    // Step 4/8: Done
    setP(jobId, opts.webinar ? 8 : 4, 100, 'Fertig');

    return {
      transcript: transcription.text,
      frameCount: frames.length,
      frameAnalysis,
      // Additiv: nur bei aktivem --diarize gesetzt, sonst leer/null —
      // bestehende Clients ignorieren die Felder einfach.
      speakerTranscript,
      diarization: diarMeta,
      webinar,
    };

  } finally {
    safeUnlink(wavFile);
    if (audioFile && audioFile !== wavFile) safeUnlink(audioFile);
    safeRmDir(framesDir);
  }
}

// ── Webinar-Slides-Pipeline (extract → cluster → analyze → build → render) ─
const WEBINAR_SCRIPT   = join(__dirname, 'skill', 'scripts', 'build-webinar-slides.js');
const WEBINAR_TEMPLATE = join(__dirname, 'skill', 'scripts', 'webinar-template');
const WEBINAR_OUT_BASE = join(__dirname, 'webinare');

function buildWebinarTranscriptMd({ title, transcript, frameAnalysis }) {
  const lines = [];
  lines.push(`# ${title}`);
  lines.push('');
  if (frameAnalysis && frameAnalysis.trim()) {
    lines.push('## Visual Timeline');
    lines.push('');
    // frameAnalysis-Zeilen: "MM:SS – Beschreibung"
    frameAnalysis.split('\n').forEach(raw => {
      const line = raw.trim();
      const m = line.match(/^(\d{1,2}):(\d{2})\s*[–-]\s*(.+)$/);
      if (m) lines.push(`**${m[1]}:${m[2]}** – ${m[3]}`);
    });
    lines.push('');
  }
  if (transcript && transcript.trim()) {
    lines.push('## Volltranskript');
    lines.push('');
    lines.push(transcript.trim());
  }
  return lines.join('\n');
}

async function runWebinarPipeline({ videoPath, jobId, slug, title, transcript, frameAnalysis, deploy }) {
  if (!slug) throw new Error('Kein Slug angegeben.');
  const outDir = join(WEBINAR_OUT_BASE, slug);

  // transcript-md temporär schreiben
  const tmpMd = join(UPLOAD_DIR, `webinar-${slug}-${Date.now()}.md`);
  writeFileSync(tmpMd, buildWebinarTranscriptMd({
    title: title || slug,
    transcript,
    frameAnalysis,
  }), 'utf8');

  setP(jobId, 5, 5, 'Webinar: Frames extrahieren…');
  await new Promise((resolve, reject) => {
    const args = [
      WEBINAR_SCRIPT,
      '--video',      videoPath,
      '--out',        outDir,
      '--title',      title || slug,
      '--transcript', tmpMd,
      '--template',   WEBINAR_TEMPLATE,
    ];
    const child = spawn('node', args, {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let stdoutBuf = '';
    child.stdout.on('data', chunk => {
      stdoutBuf += chunk.toString();
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.phase === 'frames')  setP(jobId, 5, msg.pct, msg.label || 'Frames…');
          if (msg.phase === 'cluster') setP(jobId, 6, msg.pct, msg.label || 'Cluster…');
          if (msg.phase === 'analyze') setP(jobId, 6, Math.min(100, 50 + msg.pct / 2), msg.label || 'Vision…');
          if (msg.phase === 'build')   setP(jobId, 7, msg.pct, msg.label || 'Bauen…');
          if (msg.phase === 'render')  setP(jobId, 7, Math.min(100, 50 + msg.pct / 2), msg.label || 'Rendern…');
          if (msg.phase === 'done')    child._webinarResult = msg.result;
          if (msg.phase === 'error')   child._webinarError = msg.message;
        } catch {
          // Nicht-JSON auf stdout → ignorieren
        }
      }
    });
    child.on('error', reject);
    child.on('close', code => {
      if (child._webinarError) return reject(new Error(child._webinarError));
      if (code !== 0)          return reject(new Error(`build-webinar-slides.js exit ${code}`));
      resolve(child._webinarResult || {});
    });
  }).finally(() => safeUnlink(tmpMd));

  // Da das Volume webinare/ von aussen gemountet ist (rw), ist die Site sofort
  // unter transcribeforge.hiltmann.cloud/webinare/<slug>/ verfügbar.
  const publicUrl = deploy
    ? `https://transcribeforge.hiltmann.cloud/webinare/${slug}/`
    : null;

  setP(jobId, 8, 100, 'Site deployed');
  return {
    slug,
    outDir,
    publicUrl,
    deployed: !!deploy,
  };
}

// ── POST /api/transcribe  (Datei-Upload, async) ────────────────────────────
app.post('/api/transcribe', upload.single('video'), (req, res) => {
  const uploadedFile = req.file?.path;
  const jobId = req.headers['x-job-id'] || null;

  if (!req.file) return res.status(400).json({ error: 'Keine Videodatei empfangen.' });
  if (!jobId)    return res.status(400).json({ error: 'x-job-id Header fehlt.' });

  const opts = parseOpts(req.body);
  setP(jobId, 1, 1, 'Job angenommen…');
  res.status(202).json({ jobId, status: 'accepted' });

  transcribePipeline(uploadedFile, opts, jobId)
    .then(result => setJobResult(jobId, result))
    .catch(err => {
      console.error('Transcription error:', err);
      setJobError(jobId, err?.message || 'Unbekannt');
    })
    .finally(() => safeUnlink(uploadedFile));
});

// ── POST /api/transcribe-url  (YouTube / Vimeo, async) ─────────────────────
app.post('/api/transcribe-url', (req, res) => {
  const jobId  = req.headers['x-job-id'] || null;
  const parsed = parseVideoUrl(req.body?.url || '');

  if (!parsed) {
    return res.status(400).json({ error: 'Ungültige URL — nur YouTube und Vimeo werden unterstützt.' });
  }
  if (!jobId) return res.status(400).json({ error: 'x-job-id Header fehlt.' });

  const tempId   = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const destPath = join(UPLOAD_DIR, `url-${tempId}.mp4`);
  const opts     = parseOpts(req.body);

  setP(jobId, 1, 1, 'Job angenommen…');
  res.status(202).json({ jobId, status: 'accepted', platform: parsed.platform });

  (async () => {
    try {
      setP(jobId, 1, 5, 'Video wird heruntergeladen…');
      await downloadWithYtDlp(parsed.url, destPath, label => setP(jobId, 1, 20, label), req.body?.format);
      setP(jobId, 1, 35, 'Download fertig, starte Verarbeitung…');
      const result = await transcribePipeline(destPath, opts, jobId);
      setJobResult(jobId, { ...result, platform: parsed.platform });
    } catch (err) {
      console.error('URL transcription error:', err);
      const msg = err?.message || '';
      const stderr = err?.stderr || '';
      let display;
      if (msg.includes('not found') || msg.includes('No such file') || (msg.includes('yt-dlp') && !stderr)) {
        display = 'yt-dlp nicht gefunden. Bitte installieren: brew install yt-dlp (macOS) oder pip install yt-dlp.';
      } else if (stderr) {
        display = `Download-Fehler: ${stderr.trim().split('\n').pop()}`;
      } else {
        display = msg || 'Unbekannt';
      }
      setJobError(jobId, display);
    } finally {
      safeUnlink(destPath);
    }
  })();
});

app.listen(PORT, () => console.log(`TranscribeForge läuft auf http://localhost:${PORT}`));
