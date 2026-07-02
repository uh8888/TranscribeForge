#!/usr/bin/env node
/**
 * Combined Webinar-Slides-Pipeline (extract → cluster → analyze → build → render).
 *
 * Usage:
 *   node build-webinar-slides.js \
 *     --video /path/to/video.mp4 \
 *     --out /app/webinare/<slug> \
 *     --title "Site-Titel" \
 *     --transcript /tmp/transcript.md \
 *     [--template /app/skill/scripts/webinar-template] \
 *     [--model claude-haiku-4-5-20251001] \
 *     [--concurrency 8]
 *
 * Emits JSON progress lines on stdout:
 *   {"phase":"frames","pct":42,"label":"…"}
 *   {"phase":"cluster","pct":100,"label":"…"}
 *   {"phase":"analyze","pct":60,"label":"…"}
 *   {"phase":"build","pct":100,"label":"…"}
 *   {"phase":"render","pct":100,"label":"…"}
 *   {"phase":"done","result":{...}}
 *   {"phase":"error","message":"…"}
 *
 * Everything else (debug/info) goes to stderr and is logged by the server.
 */

import Anthropic from '@anthropic-ai/sdk';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── args ───────────────────────────────────────────────────────────────────
function argv(name, dflt) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx < 0 || idx + 1 >= process.argv.length) return dflt;
  return process.argv[idx + 1];
}
const VIDEO      = argv('video');
const OUT_DIR    = argv('out');
const TITLE      = argv('title', 'Webinar');
const TRANSCRIPT = argv('transcript');
const TEMPLATE   = argv('template', path.join(path.dirname(new URL(import.meta.url).pathname), 'webinar-template'));
const MODEL      = argv('model', 'claude-haiku-4-5-20251001');
const CONCURRENCY = parseInt(argv('concurrency', '8'), 10);
const FPS = 1;
const SIM_THRESHOLD = 10;
const MIN_STABLE_SEC = 3;

if (!VIDEO || !OUT_DIR || !TRANSCRIPT) {
  emit({ phase: 'error', message: 'Missing --video / --out / --transcript' });
  process.exit(1);
}
if (!fs.existsSync(VIDEO)) {
  emit({ phase: 'error', message: `Video not found: ${VIDEO}` });
  process.exit(1);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function log(...args) {
  console.error('[webinar]', ...args);
}

// ── prep dirs ─────────────────────────────────────────────────────────────
fs.mkdirSync(OUT_DIR, { recursive: true });
const FRAMES_OUT = path.join(OUT_DIR, 'assets', 'frames');
const FONTS_OUT  = path.join(OUT_DIR, 'assets', 'fonts');
fs.mkdirSync(FRAMES_OUT, { recursive: true });
fs.mkdirSync(FONTS_OUT,  { recursive: true });

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'webinar-'));
const FRAMES_FULL = path.join(TMP, 'frames_full');
fs.mkdirSync(FRAMES_FULL, { recursive: true });
const RAW_GRAY = path.join(TMP, 'frames_9x8.gray');

// ── PHASE 1: extract frames + dHash ───────────────────────────────────────
emit({ phase: 'frames', pct: 5, label: 'FFmpeg: 1 fps Frames extrahieren…' });
{
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', VIDEO,
    '-vf', `fps=${FPS}`, '-q:v', '4',
    path.join(FRAMES_FULL, 'frame_%05d.jpg')];
  const r = spawnSync('ffmpeg', args, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) { emit({ phase: 'error', message: 'ffmpeg full pass failed' }); process.exit(1); }
}
const files = fs.readdirSync(FRAMES_FULL).filter(f => f.endsWith('.jpg')).sort();
log(`Extracted ${files.length} full frames`);
emit({ phase: 'frames', pct: 60, label: `${files.length} Frames extrahiert, dHash…` });

{
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', VIDEO,
    '-vf', `fps=${FPS},scale=9:8,format=gray`,
    '-f', 'rawvideo', '-pix_fmt', 'gray', RAW_GRAY];
  const r = spawnSync('ffmpeg', args, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) { emit({ phase: 'error', message: 'ffmpeg gray pass failed' }); process.exit(1); }
}
const raw = fs.readFileSync(RAW_GRAY);
const FRAME_BYTES = 9 * 8;
const rawCount = Math.floor(raw.length / FRAME_BYTES);
const hashes = [];
const N = Math.min(files.length, rawCount);
for (let i = 0; i < N; i++) {
  const off = i * FRAME_BYTES;
  let hi = 0n, lo = 0n;
  let bit = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const left = raw[off + y*9 + x];
      const right = raw[off + y*9 + x + 1];
      const b = left < right ? 1 : 0;
      if (bit < 32) lo |= BigInt(b) << BigInt(bit);
      else          hi |= BigInt(b) << BigInt(bit - 32);
      bit++;
    }
  }
  const hex = ((hi << 32n) | lo).toString(16).padStart(16, '0');
  hashes.push({ idx: i, pts: i, file: files[i], hash: hex });
}
emit({ phase: 'frames', pct: 100, label: `${hashes.length} dHashes berechnet` });

// ── PHASE 2: cluster into stable runs ────────────────────────────────────
emit({ phase: 'cluster', pct: 10, label: 'Cluster nach dHash-Ähnlichkeit…' });
function hamming(hexA, hexB) {
  const a = BigInt('0x' + hexA), b = BigInt('0x' + hexB);
  let x = a ^ b, cnt = 0;
  while (x) { cnt += Number(x & 1n); x >>= 1n; }
  return cnt;
}
const clusters = [];
if (hashes.length > 0) {
  let cur = { start: 0, hashes: [hashes[0].hash], ref: hashes[0].hash };
  for (let i = 1; i < hashes.length; i++) {
    const d = hamming(hashes[i].hash, cur.ref);
    if (d > SIM_THRESHOLD) {
      clusters.push({ start: cur.start, end: i - 1 });
      cur = { start: i, hashes: [hashes[i].hash], ref: hashes[i].hash };
    } else {
      cur.hashes.push(hashes[i].hash);
      if (cur.hashes.length === 3) cur.ref = cur.hashes[1];
      if (cur.hashes.length === 8) cur.ref = cur.hashes[3];
    }
  }
  clusters.push({ start: cur.start, end: hashes.length - 1 });
}
for (const c of clusters) {
  c.start_pts = hashes[c.start].pts;
  c.end_pts = hashes[c.end].pts;
  c.duration = c.end_pts - c.start_pts + 1;
  c.size = c.end - c.start + 1;
}
const stable = clusters.filter(c => c.duration >= MIN_STABLE_SEC);
const candidates = stable.map(c => {
  const cIdx = clusters.indexOf(c);
  const next = clusters[cIdx + 1];
  let idx = c.end;
  if (next && next.duration < MIN_STABLE_SEC && idx - 1 >= c.start) idx -= 1;
  const h = hashes[idx];
  return { idx: h.idx, pts: h.pts, file: h.file,
    cluster_size: c.size, cluster_duration: c.duration,
    cluster_start_pts: c.start_pts, cluster_end_pts: c.end_pts };
});
log(`Clusters: ${clusters.length}, stable: ${stable.length}, candidates: ${candidates.length}`);
emit({ phase: 'cluster', pct: 100, label: `${candidates.length} Slide-Kandidaten` });

// ── PHASE 3: Vision-classify candidates via Anthropic ────────────────────
emit({ phase: 'analyze', pct: 5, label: `Vision-Analyse ${candidates.length} Kandidaten…` });
if (!process.env.ANTHROPIC_API_KEY) {
  emit({ phase: 'error', message: 'ANTHROPIC_API_KEY nicht gesetzt.' });
  process.exit(1);
}
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const SYSTEM = `Du klassifizierst einen einzelnen Frame aus einer deutschen Webinar-Aufzeichnung. Der Frame stammt aus einem Screen-Capture, das Präsentationsfolien zeigt. Antworte AUSSCHLIESSLICH mit einem gültigen JSON-Objekt (keine Codefences, kein zusätzlicher Text) mit exakt diesen Feldern:

{
  "is_slide": boolean,
  "is_transition": boolean,
  "is_cropped": boolean,
  "is_greyed": boolean,
  "is_fully_built": boolean,
  "element_count": number,
  "completeness": number,
  "slide_title": string,
  "slide_summary": string,
  "readable_at_1280": boolean
}

Wichtige Regeln:
- is_transition, is_cropped, is_greyed sind DISQUALIFIZIERER — sei streng, im Zweifel true.
- Zähle bei element_count wirklich die sichtbaren Bullet-Punkte / Grafik-Kacheln. Reine Titel-Folie = 1.
- Keine Halluzinationen. Wenn du unsicher bist, schreibe knappe Fakten.
- Bewerte, ob der wichtigste Text auf dieser Folie bei einer Ausgabegröße von 1280×720 Pixel und JPEG-Qualität 82 noch bequem lesbar ist. readable_at_1280=true wenn nur Headline/große Aufzählungen; readable_at_1280=false wenn kleiner Fließtext, dichte Tabellen, feine Diagrammbeschriftungen oder Screenshots mit Feinstruktur. Im Zweifel bei textlastigen Folien: readable_at_1280=false.`;

async function analyze(item) {
  const imgPath = path.join(FRAMES_FULL, item.file);
  const b64 = fs.readFileSync(imgPath).toString('base64');
  try {
    const r = await anthropic.messages.create({
      model: MODEL, max_tokens: 500, system: SYSTEM,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
        { type: 'text', text: 'Analysiere diesen Webinar-Frame und antworte im geforderten JSON-Format.' }
      ]}]
    });
    const raw = r.content[0].text.trim();
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]); else throw new Error('parse');
    }
    // Fallback wenn Vision-Modell readable_at_1280 nicht geliefert hat → als lesbar behandeln (kein HQ nötig)
    if (typeof parsed.readable_at_1280 !== 'boolean') parsed.readable_at_1280 = true;
    return { ...item, ...parsed, tokens_in: r.usage.input_tokens, tokens_out: r.usage.output_tokens };
  } catch (e) {
    return { ...item, error: e.message };
  }
}
const analyzed = new Array(candidates.length);
let done = 0, next = 0;
async function worker() {
  while (next < candidates.length) {
    const i = next++;
    analyzed[i] = await analyze(candidates[i]);
    done++;
    if (done % 3 === 0 || done === candidates.length) {
      emit({ phase: 'analyze', pct: Math.floor(done / candidates.length * 100),
             label: `${done}/${candidates.length} klassifiziert` });
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
const totalIn = analyzed.reduce((s,r)=>s+(r.tokens_in||0),0);
const totalOut = analyzed.reduce((s,r)=>s+(r.tokens_out||0),0);
const costEK = totalIn/1_000_000 + totalOut*5/1_000_000;
log(`Vision done. Tokens in=${totalIn} out=${totalOut} EK=$${costEK.toFixed(4)}`);
emit({ phase: 'analyze', pct: 100, label: `Vision fertig (EK $${costEK.toFixed(4)})` });

// ── PHASE 4: dedup + build site_data ─────────────────────────────────────
emit({ phase: 'build', pct: 20, label: 'Dedup + Site-Data bauen…' });
const slidesRaw = analyzed.filter(f =>
  f.is_slide === true && f.is_transition === false &&
  f.is_cropped === false && f.is_greyed === false &&
  !/windows|start-?menü|startmenü|desktop|player-chrome/i.test(f.slide_title || '')
);
function normalize(s) {
  return (s || '').toLowerCase()
    .replace(/[„""«»‚''‹›]/g, '"')
    .replace(/[^a-z0-9äöüß\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function tokenSet(s) { return new Set(normalize(s).split(' ').filter(w => w.length > 2)); }
function jaccard(A, B) {
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}
slidesRaw.sort((a, b) => a.pts - b.pts);
const groups = [];
for (const f of slidesRaw) {
  const ts = tokenSet(f.slide_title);
  let placed = false;
  for (const g of groups) {
    const sim = jaccard(ts, g.tokens);
    const timeClose = g.items.some(it => Math.abs(it.pts - f.pts) < 15);
    if (sim >= 0.5 || (timeClose && sim >= 0.3)) {
      g.items.push(f);
      for (const t of ts) g.tokens.add(t);
      placed = true;
      break;
    }
  }
  if (!placed) groups.push({ tokens: new Set(ts), items: [f] });
}
const slides = groups.map(g => {
  const best = g.items.slice().sort((a, b) =>
    ((b.element_count ?? 0) - (a.element_count ?? 0)) ||
    ((b.completeness ?? 0) - (a.completeness ?? 0)) ||
    (a.pts - b.pts)
  )[0];
  return {
    ...best, duplicate_count: g.items.length,
    all_pts: g.items.map(x => x.pts),
    first_pts: Math.min(...g.items.map(x => x.pts)),
    max_element_count: Math.max(...g.items.map(x => x.element_count ?? 0))
  };
}).sort((a, b) => a.first_pts - b.first_pts);
log(`Slides after dedup: ${slides.length}`);

// timeline aus transcript.md parsen (falls Visual-Timeline vorhanden)
let mdText = '';
try { mdText = fs.readFileSync(TRANSCRIPT, 'utf8'); } catch {}
const timelineRegex = /^\*\*(\d{1,2}):(\d{2})(?:–(\d{1,2}):(\d{2}))?\*\*\s*[–-]\s*(.+)$/gm;
const timeline = [];
let tm;
while ((tm = timelineRegex.exec(mdText)) !== null) {
  const start = parseInt(tm[1]) * 60 + parseInt(tm[2]);
  const end = tm[3] ? parseInt(tm[3]) * 60 + parseInt(tm[4]) : start;
  timeline.push({ start, end, text: tm[5].trim() });
}
function fmtMMSS(sec) {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
for (const s of slides) {
  const p = s.first_pts;
  let best = null;
  for (const t of timeline) {
    const dist = Math.min(Math.abs(t.start - p), Math.abs(t.end - p));
    if (dist <= 30 && (!best || dist < best.dist)) best = { ...t, dist };
  }
  s.timeline_match = best;
  s.mmss = fmtMMSS(s.first_pts);
}
emit({ phase: 'build', pct: 100, label: `${slides.length} finale Folien` });

// ── PHASE 5: kopiere Frames (komprimiert) + Fonts + styles → OUT_DIR ─────
emit({ phase: 'render', pct: 5, label: 'Frames komprimieren + Assets kopieren…' });

// Probe native Video-Auflösung → nur wenn lange Kante ≥ 1600 lohnt sich ein HQ-Frame
let videoLongEdge = 0;
try {
  const p = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', VIDEO], { encoding: 'utf8' });
  if (p.status === 0) {
    const [w, h] = p.stdout.trim().split(',').map(n => parseInt(n, 10));
    if (w && h) videoLongEdge = Math.max(w, h);
  }
} catch {}
const HQ_ENABLED = videoLongEdge >= 1600;
log(`Video long edge=${videoLongEdge}, HQ frames enabled=${HQ_ENABLED}`);

// finalen Frame-Satz: nur die Slides, kompaktes ffmpeg-Recompress auf 1280×720 JPEG q82
const keepFiles = slides.map(s => s.file);
for (const f of keepFiles) {
  const src = path.join(FRAMES_FULL, f);
  const dst = path.join(FRAMES_OUT, f);
  // -q:v 4 in ffmpeg mjpeg ≈ JPEG-Q82 (Skala 1..31, 2=beste, 31=schlechteste); Q82 entspricht ~4
  const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
    '-i', src, '-vf', 'scale=1280:-2', '-q:v', '4', dst],
    { stdio: ['ignore', 'ignore', 'inherit'] });
  if (r.status !== 0) log(`compress failed for ${f}`);
}

// HQ-Frames für alle Slides mit readable_at_1280===false
let hqCount = 0;
const HQ_DIR = path.join(OUT_DIR, 'assets', 'frames_hq');
if (HQ_ENABLED) {
  fs.mkdirSync(HQ_DIR, { recursive: true });
  for (const s of slides) {
    if (s.readable_at_1280 !== false) continue;
    const src = path.join(FRAMES_FULL, s.file);
    const dst = path.join(HQ_DIR, s.file);
    // native Auflösung, max 2560 lange Kante, JPEG-Q92 → mjpeg -q:v 2
    const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
      '-i', src,
      '-vf', "scale='if(gt(iw,ih),min(iw,2560),-2)':'if(gt(iw,ih),-2,min(ih,2560))'",
      '-q:v', '2', dst],
      { stdio: ['ignore', 'ignore', 'inherit'] });
    if (r.status === 0) {
      s.hq_available = true;
      hqCount++;
    } else {
      s.hq_available = false;
      log(`HQ extract failed for ${s.file}`);
    }
  }
} else {
  for (const s of slides) s.hq_available = false;
}
log(`HQ frames generated: ${hqCount}/${slides.length}`);

// styles.css
fs.copyFileSync(path.join(TEMPLATE, 'styles.css'), path.join(OUT_DIR, 'styles.css'));
// fonts
for (const fn of fs.readdirSync(path.join(TEMPLATE, 'fonts'))) {
  fs.copyFileSync(path.join(TEMPLATE, 'fonts', fn), path.join(FONTS_OUT, fn));
}
// vendor (Panzoom, lokal — DSGVO-konform, keine CDN)
const VENDOR_OUT = path.join(OUT_DIR, 'assets', 'vendor');
const VENDOR_SRC = path.join(TEMPLATE, 'vendor');
if (fs.existsSync(VENDOR_SRC)) {
  fs.mkdirSync(VENDOR_OUT, { recursive: true });
  for (const fn of fs.readdirSync(VENDOR_SRC)) {
    fs.copyFileSync(path.join(VENDOR_SRC, fn), path.join(VENDOR_OUT, fn));
  }
}
emit({ phase: 'render', pct: 60, label: `HTML rendern (${hqCount} HQ-Frames)…` });

// ── PHASE 5b: render index.html ──────────────────────────────────────────
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const md2html = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+?)`/g, '<code>$1</code>');

function extractSection(md, headingRegex, endHeadingRegex = /^##\s/m) {
  const m = md.match(headingRegex);
  if (!m) return '';
  const start = m.index + m[0].length;
  const rest = md.slice(start);
  const em = rest.match(endHeadingRegex);
  const end = em ? em.index : rest.length;
  return rest.slice(0, end).replace(/^\s+|\s+$/g, '').replace(/\n?---\s*$/g, '').trim();
}
const execSummary     = extractSection(mdText, /^##\s+Executive Summary\s*$/m);
const actionItemsBlock = extractSection(mdText, /^##\s+Action Items\s*$/m);
const eckdatenBlock    = extractSection(mdText, /^##\s+Eckdaten\s*$/m);
const themenBlock      = extractSection(mdText, /^##\s+Besprochene Themen\s*$/m);
const volltranskript   = extractSection(mdText, /^##\s+Volltranskript\s*$/m);
const visualTimeline   = extractSection(mdText, /^##\s+Visual Timeline\s*$/m);

function parseActionColumns(block) {
  const cols = [];
  const parts = block.split(/^###\s+/m).filter(Boolean);
  for (const p of parts) {
    const lines = p.split('\n');
    const title = lines[0].trim();
    const items = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      const m = line.match(/^-\s*\[\s*\]\s*(.+)$/);
      if (m) items.push(m[1]);
    }
    cols.push({ title, items });
  }
  return cols;
}
const actionCols = parseActionColumns(actionItemsBlock);
function parseEckdaten(block) {
  const rows = [];
  const lines = block.split('\n');
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    if (/^\|\s*-+\s*\|/.test(line)) continue;
    if (/^\|\s*Punkt\s*\|/.test(line)) continue;
    const cells = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cells.length >= 2) rows.push({ key: cells[0], value: cells[1] });
  }
  return rows;
}
const eckdaten = parseEckdaten(eckdatenBlock);
function renderThemen(block) {
  const lines = block.split('\n');
  let html = '';
  let currentTitle = null, currentItems = [];
  const flush = () => {
    if (currentTitle) {
      html += `<div class="topic-card"><h4>${esc(currentTitle)}</h4><ul>`;
      for (const it of currentItems) html += `<li>${esc(it)}</li>`;
      html += `</ul></div>`;
    }
  };
  for (const line of lines) {
    const topMatch = line.match(/^-\s+\*\*(.+?)\*\*\s*$/);
    if (topMatch) { flush(); currentTitle = topMatch[1]; currentItems = []; continue; }
    const subMatch = line.match(/^\s{2,}-\s+(.+)$/);
    if (subMatch && currentTitle) currentItems.push(subMatch[1].replace(/\*\*/g, ''));
  }
  flush();
  return html;
}
const themenHtml = renderThemen(themenBlock);
function renderTimeline(block) {
  const items = [];
  const re = /^\*\*(\d{1,2}:\d{2}(?:–\d{1,2}:\d{2})?)\*\*\s*[–-]\s*(.+)$/gm;
  let m;
  while ((m = re.exec(block)) !== null) items.push({ ts: m[1], text: m[2].trim() });
  return items.map(i => `<div class="tl-row"><span class="tl-ts">${esc(i.ts)}</span><span class="tl-txt">${esc(i.text)}</span></div>`).join('');
}
const timelineHtml = renderTimeline(visualTimeline);

const slideCards = slides.map((s, idx) => `
  <article class="slide-card${s.hq_available ? ' has-hq' : ''}" data-idx="${idx}" tabindex="0" role="button" aria-label="Slide ${s.mmss} ${esc(s.slide_title)} öffnen">
    <div class="slide-img-wrap">
      <img src="assets/frames/${esc(s.file)}" alt="${esc(s.slide_title)}" loading="lazy" />
      <span class="ts-badge">${esc(s.mmss)}</span>
      ${s.duplicate_count > 1 ? `<span class="dup-badge" title="Aus ${s.duplicate_count} ähnlichen Frames zusammengefasst">×${s.duplicate_count}</span>` : ''}
      ${s.hq_available ? `<span class="hq-badge" title="Hochaufgelöste Version zum Zoomen verfügbar">HD zoom</span>` : ''}
    </div>
    <div class="slide-body">
      <h3>${esc(s.slide_title)}</h3>
      <p>${esc(s.slide_summary || '(keine Info)')}</p>
      ${s.timeline_match ? `<p class="tl-note"><span class="tl-note-label">Transkript-Notiz:</span> ${esc(s.timeline_match.text)}</p>` : `<p class="tl-note muted">Keine passende Transkript-Notiz gefunden.</p>`}
    </div>
  </article>
`).join('\n');
function renderVollTranskript(text) {
  const clean = (text || '').trim();
  if (!clean) return '<p class="muted">(kein Volltranskript verfügbar)</p>';
  const sents = clean.split(/(?<=[.!?])\s+/);
  const groups = [];
  for (let i = 0; i < sents.length; i += 4) groups.push(sents.slice(i, i+4).join(' '));
  return groups.map(g => `<p>${esc(g)}</p>`).join('');
}
const volltranskriptHtml = renderVollTranskript(volltranskript);

const slidesForJs = slides.map(s => ({
  file: s.file, mmss: s.mmss,
  title: s.slide_title, summary: s.slide_summary,
  timeline_note: s.timeline_match ? s.timeline_match.text : null,
  duplicate_count: s.duplicate_count,
  hq_available: !!s.hq_available
}));

const generated = new Date().toISOString().slice(0, 10);
const html = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(TITLE)} — Webinar-Analyse</title>
<link rel="stylesheet" href="styles.css" />
</head>
<body>

<header class="site-header">
  <div class="header-inner">
    <div class="header-title">
      <h1>${esc(TITLE)}</h1>
      <p class="subtitle">Generiert ${esc(generated)} · ${slides.length} Folien</p>
    </div>
    <nav class="site-nav">
      ${execSummary       ? '<a href="#overview">Overview</a>' : ''}
      ${actionCols.length ? '<a href="#action">Action Items</a>' : ''}
      ${eckdaten.length   ? '<a href="#eckdaten">Eckdaten</a>' : ''}
      ${themenHtml        ? '<a href="#themen">Themen</a>' : ''}
      <a href="#slides">Slides</a>
      ${volltranskript    ? '<a href="#transkript">Transkript</a>' : ''}
    </nav>
  </div>
</header>

<main class="container">

  ${execSummary ? `
  <section id="overview" class="section">
    <div class="section-head">
      <span class="section-eyebrow">Überblick</span>
      <h2>Executive Summary</h2>
    </div>
    <div class="card summary-card"><p>${md2html(execSummary)}</p></div>
  </section>` : ''}

  ${actionCols.length ? `
  <section id="action" class="section">
    <div class="section-head">
      <span class="section-eyebrow">Was zu tun ist</span>
      <h2>Action Items</h2>
    </div>
    <div class="action-grid">
      ${actionCols.map(c => `
        <div class="card action-card">
          <h3>${esc(c.title)}</h3>
          <ul class="checklist">
            ${c.items.map(it => `<li><span class="check-box" aria-hidden="true"></span><span>${md2html(it)}</span></li>`).join('')}
          </ul>
        </div>`).join('')}
    </div>
  </section>` : ''}

  ${eckdaten.length ? `
  <section id="eckdaten" class="section">
    <div class="section-head">
      <span class="section-eyebrow">Zahlen &amp; Fakten</span>
      <h2>Eckdaten</h2>
    </div>
    <div class="eckdaten-grid">
      ${eckdaten.map(r => `
        <div class="card metric-card">
          <div class="metric-key">${md2html(r.key)}</div>
          <div class="metric-value">${md2html(r.value)}</div>
        </div>`).join('')}
    </div>
  </section>` : ''}

  ${themenHtml ? `
  <section id="themen" class="section">
    <div class="section-head">
      <span class="section-eyebrow">Inhaltliche Bausteine</span>
      <h2>Besprochene Themen</h2>
    </div>
    <div class="topics-grid">${themenHtml}</div>
  </section>` : ''}

  <section id="slides" class="section">
    <div class="section-head">
      <span class="section-eyebrow">Visueller Verlauf</span>
      <h2>Slides <span class="section-count">${slides.length} Folien</span></h2>
      <p class="section-lede">Aus dem Video extrahiert (FFmpeg 1 fps → dHash-Stabilitäts-Clustering → Claude Haiku Vision-Klassifikation). Übergangs-, abgeschnittene und ausgegraute Frames wurden verworfen. Klick öffnet Detailansicht.</p>
    </div>
    <div class="slides-grid">${slideCards}</div>
  </section>

  ${volltranskript || visualTimeline ? `
  <section id="transkript" class="section">
    <div class="section-head">
      <span class="section-eyebrow">Alles im Wortlaut</span>
      <h2>Volltranskript &amp; Visual Timeline</h2>
    </div>
    ${visualTimeline ? `<details class="collapsible">
      <summary>Visual Timeline aufklappen</summary>
      <div class="timeline-list">${timelineHtml}</div>
    </details>` : ''}
    ${volltranskript ? `<details class="collapsible">
      <summary>Volltranskript aufklappen (~${Math.round(volltranskript.length/1000)}k Zeichen)</summary>
      <div class="transcript-body">${volltranskriptHtml}</div>
    </details>` : ''}
  </section>` : ''}

  <footer class="site-footer">
    <p>Generiert ${esc(generated)} · ${slides.length} Slides aus ${analyzed.length} Vision-Kandidaten</p>
    <p class="muted">Keine externen Requests. Fonts, Bilder und Skript liegen lokal. DSGVO-konform.</p>
  </footer>

</main>

<div class="lightbox" id="lightbox" hidden>
  <button class="lb-close" aria-label="Schließen">×</button>
  <button class="lb-prev" aria-label="Vorherige Slide">‹</button>
  <button class="lb-next" aria-label="Nächste Slide">›</button>
  <div class="lb-content">
    <div class="lb-img-wrap">
      <div class="lb-pan" id="lbPan">
        <img class="lb-img" alt="" />
      </div>
      <div class="lb-zoom-controls" hidden>
        <button class="lb-zoom-out" aria-label="Herauszoomen" type="button">−</button>
        <button class="lb-zoom-reset" aria-label="Zoom zurücksetzen" type="button">100%</button>
        <button class="lb-zoom-in" aria-label="Hineinzoomen" type="button">+</button>
      </div>
    </div>
    <div class="lb-meta">
      <span class="lb-ts"></span>
      <h3 class="lb-title"></h3>
      <p class="lb-summary"></p>
      <p class="lb-note"></p>
      <p class="lb-hq-hint muted" hidden>HD-Zoom: Mausrad, Doppelklick oder Buttons.</p>
    </div>
  </div>
</div>

<script src="assets/vendor/panzoom.min.js"></script>
<script>
const SLIDES = ${JSON.stringify(slidesForJs)};
const lb = document.getElementById('lightbox');
const lbPan = document.getElementById('lbPan');
const lbImg = lb.querySelector('.lb-img');
const lbTs = lb.querySelector('.lb-ts');
const lbTitle = lb.querySelector('.lb-title');
const lbSummary = lb.querySelector('.lb-summary');
const lbNote = lb.querySelector('.lb-note');
const lbHqHint = lb.querySelector('.lb-hq-hint');
const lbZoomControls = lb.querySelector('.lb-zoom-controls');
let currentIdx = 0;
let panzoomInstance = null;

function destroyPanzoom() {
  if (panzoomInstance) {
    try { panzoomInstance.destroy(); } catch (_) {}
    panzoomInstance = null;
  }
  lbPan.classList.remove('is-zoomable');
  lbImg.style.transform = '';
}

function openLightbox(idx) {
  currentIdx = idx;
  const s = SLIDES[idx];
  if (!s) return;
  destroyPanzoom();
  const useHq = !!s.hq_available;
  lbImg.src = useHq ? ('assets/frames_hq/' + s.file) : ('assets/frames/' + s.file);
  lbImg.alt = s.title || '';
  lbTs.textContent = s.mmss + (s.duplicate_count > 1 ? '  ·  aus ' + s.duplicate_count + ' Frames zusammengefasst' : '');
  lbTitle.textContent = s.title || '';
  lbSummary.textContent = s.summary || '(keine Info)';
  if (s.timeline_note) {
    lbNote.innerHTML = '<span class="lb-note-label">Transkript-Notiz:</span> ' + s.timeline_note.replace(/</g,'&lt;');
    lbNote.classList.remove('muted');
  } else {
    lbNote.textContent = 'Keine passende Transkript-Notiz.';
    lbNote.classList.add('muted');
  }
  lb.hidden = false;
  document.body.style.overflow = 'hidden';
  if (useHq && typeof Panzoom === 'function') {
    lbPan.classList.add('is-zoomable');
    lbZoomControls.hidden = false;
    lbHqHint.hidden = false;
    // Panzoom nach Image-Load initialisieren (verhindert Offset-Bugs)
    const initPz = () => {
      panzoomInstance = Panzoom(lbImg, {
        maxScale: 6,
        minScale: 1,
        contain: 'outside',
        cursor: 'zoom-in',
        canvas: true
      });
      lbPan.addEventListener('wheel', panzoomInstance.zoomWithWheel, { passive: false });
    };
    if (lbImg.complete) initPz();
    else lbImg.addEventListener('load', initPz, { once: true });
  } else {
    lbZoomControls.hidden = true;
    lbHqHint.hidden = true;
  }
}

function closeLightbox() {
  destroyPanzoom();
  lb.hidden = true;
  lbImg.src = '';
  document.body.style.overflow = '';
}
function nav(delta) { openLightbox((currentIdx + delta + SLIDES.length) % SLIDES.length); }
document.querySelectorAll('.slide-card').forEach(el => {
  el.addEventListener('click', () => openLightbox(parseInt(el.dataset.idx, 10)));
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLightbox(parseInt(el.dataset.idx, 10)); }
  });
});
lb.querySelector('.lb-close').addEventListener('click', closeLightbox);
lb.querySelector('.lb-prev').addEventListener('click', () => nav(-1));
lb.querySelector('.lb-next').addEventListener('click', () => nav(1));
lb.addEventListener('click', e => { if (e.target === lb) closeLightbox(); });
lb.querySelector('.lb-zoom-in').addEventListener('click', () => panzoomInstance && panzoomInstance.zoomIn());
lb.querySelector('.lb-zoom-out').addEventListener('click', () => panzoomInstance && panzoomInstance.zoomOut());
lb.querySelector('.lb-zoom-reset').addEventListener('click', () => panzoomInstance && panzoomInstance.reset());
document.addEventListener('keydown', e => {
  if (lb.hidden) return;
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === 'ArrowLeft') nav(-1);
  else if (e.key === 'ArrowRight') nav(1);
});
</script>

</body>
</html>
`;
fs.writeFileSync(path.join(OUT_DIR, 'index.html'), html);

// site_data.json for debug/rebuild
fs.writeFileSync(path.join(OUT_DIR, 'site_data.json'), JSON.stringify({
  meta: { title: TITLE, generated, slide_count: slides.length,
          candidate_count: analyzed.length, tokens_in: totalIn,
          tokens_out: totalOut, cost_ek: costEK },
  slides
}, null, 2));

// cleanup tmp
try {
  for (const f of fs.readdirSync(FRAMES_FULL)) fs.unlinkSync(path.join(FRAMES_FULL, f));
  fs.rmdirSync(FRAMES_FULL);
  fs.unlinkSync(RAW_GRAY);
  fs.rmdirSync(TMP);
} catch {}

emit({ phase: 'render', pct: 100, label: 'Site fertig' });
emit({ phase: 'done', result: {
  slide_count: slides.length,
  candidate_count: analyzed.length,
  cost_ek: costEK,
  out_dir: OUT_DIR
}});
