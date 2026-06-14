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
 * Flags:
 *   --video <pfad>    Lokale Video-/Audiodatei (Pflicht wenn kein --url).
 *   --url <url>       YouTube- oder Vimeo-URL; wird via yt-dlp heruntergeladen.
 *   --lang <code>     Sprache für Whisper (default: de). "auto" = automatisch erkennen.
 *   --interval <sec>  Sekunden zwischen zwei Frames (default: 3). Höher = billiger.
 *   --model <id>      Claude-Modell für Frame-Analyse (default: claude-haiku-4-5-20251001).
 *   --no-frames       Frame-Extraktion und -Analyse überspringen (~$0.63/90 min statt ~$3.35).
 *
 * Voraussetzung für --url: yt-dlp muss installiert sein (brew install yt-dlp).
 */

import { existsSync, mkdirSync, unlinkSync, readdirSync, readFileSync, statSync } from 'fs';
import { createReadStream } from 'fs';
import { resolve, basename, join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';
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
const interval     = parseInt(getArg('--interval', '3'), 10);
const frameModel   = getArg('--model', 'claude-haiku-4-5-20251001');
const noFrames     = args.includes('--no-frames');
const wantSummary  = args.includes('--summary');
const summaryModel = getArg('--summary-model', 'claude-sonnet-4-6');

if (!videoArg && !urlArg) {
  console.error('Fehler: --video <pfad> oder --url <youtube/vimeo-url> ist erforderlich.');
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

async function compressIfNeeded(wavFile) {
  if (statSync(wavFile).size <= MAX_WHISPER_BYTES) return wavFile;
  const mp3File = wavFile.replace('.wav', '.mp3');
  await execAsync(`ffmpeg -y -i "${wavFile}" -b:a 64k "${mp3File}" 2>&1`);
  return mp3File;
}

// ── ffmpeg: Frames extrahieren ────────────────────────────────────────────────
async function extractFrames(inputFile, framesDir) {
  mkdirSync(framesDir, { recursive: true });
  await execAsync(`ffmpeg -y -i "${inputFile}" -vf "fps=1/${interval},scale=1280:-2" -q:v 4 "${framesDir}/frame_%04d.jpg" 2>&1`);
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

  for (let i = 0; i < frames.length; i += BATCH) {
    const batchNum = Math.floor(i / BATCH) + 1;
    process.stderr.write(`\rFrame-Analyse: Batch ${batchNum}/${totalBatches}…   `);

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
  return (msg.content.find(b => b.type === 'text')?.text || '').trim();
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const base        = join(tmpdir(), `tf-${Date.now()}`);
  const wavFile     = base + '.wav';
  const framesDir   = base + '_frames';
  let   audioFile   = null;
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

    // 1. Audio extrahieren (+ optional Frames parallel)
    let rawFrameLog = '';
    if (noFrames) {
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

      // 2. Frame-Analyse
      rawFrameLog = await analyseFrames(frames);
    }

    // 3. Whisper — verbose_json + Segment-Filter (Halluzinationen raus)
    process.stderr.write('Whisper Transkription…');
    audioFile = await compressIfNeeded(wavFile);
    const transcription = await withRetry(() => openai.audio.transcriptions.create({
      model: 'whisper-1',
      file:  createReadStream(audioFile),
      language: lang === 'auto' ? undefined : lang,
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    }), 'Whisper');

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

    // 4. Optional: Frame-Log verdichten + Summary erzeugen
    let visualTimeline = '';
    let summary = '';
    if (wantSummary) {
      if (rawFrameLog) {
        process.stderr.write('Frame-Log verdichten…');
        visualTimeline = await compactFrameLog(rawFrameLog);
        process.stderr.write(' ✓\n');
      }
      process.stderr.write('Summary + Action Items erzeugen…');
      summary = await generateSummary(transcriptText, visualTimeline);
      process.stderr.write(' ✓\n');
    }

    // 5. Strukturierter Markdown-Output (--summary) oder Legacy-Output
    if (wantSummary) {
      console.log(summary);
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
      console.log('\n══════════════════════════════════════════════════════');
      console.log('TRANSKRIPT');
      console.log('══════════════════════════════════════════════════════');
      console.log(transcriptText);
    }

  } finally {
    safeUnlink(wavFile);
    if (audioFile && audioFile !== wavFile) safeUnlink(audioFile);
    safeRmDir(framesDir);
    if (tempDownload) safeUnlink(tempDownload);
  }
})();
