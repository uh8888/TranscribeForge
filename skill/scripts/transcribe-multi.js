#!/usr/bin/env node
/**
 * transcribeForge Multi-Speaker CLI
 * Transkribiert mehrere Sprecher-Audiodateien, erstellt ein zusammengeführtes
 * Speaker-gelabeltes Transkript und optional eine KI-Zusammenfassung mit Action Items.
 *
 * Aufruf (automatisch via Ordner):
 *   node transcribe-multi.js --dir "/pfad/zum/Audio Record" [--lang de] [--no-summary]
 *
 * Aufruf (manuell mit expliziten Sprechernamen):
 *   node transcribe-multi.js \
 *     --speaker "Uwe:uwe.m4a" \
 *     --speaker "Volkan:volkan.m4a" \
 *     [--lang de] [--no-summary]
 *
 * Flags:
 *   --dir <pfad>            Ordner mit .m4a-Einzeldateien; Namen aus Dateinamen extrahiert.
 *   --speaker <spec>        "Name:datei.m4a" – manuell (wiederholbar, überschreibt --dir).
 *   --lang <code>           Whisper-Sprache (default: de). "auto" = automatisch erkennen.
 *   --no-summary            Nur Transkript, Claude-Zusammenfassung überspringen.
 *   --summary-model <id>    Claude-Modell für Zusammenfassung (default: claude-sonnet-4-6).
 *   --output <datei>        Transkript + Zusammenfassung in Textdatei speichern.
 *
 * Offset-Berechnung (automatisch):
 *   Alle Dateien werden per ffprobe gemessen. Längste Datei = Referenz (Offset 0).
 *   Kürzere Dateien → Offset = längste_Dauer − eigene_Dauer.
 *   Voraussetzung: alle Sprecher haben das Meeting zum gleichen Zeitpunkt beendet.
 *   Manueller Override möglich: --speaker "Name:datei.m4a:1080" (Offset in Sekunden).
 */

import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { createReadStream } from 'fs';
import { resolve, basename, join, extname } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

const execAsync = promisify(exec);
const ENV_FILE = '/Users/uhi/Projects/TranscribeForge/.env';
const MAX_WHISPER_BYTES = 25 * 1024 * 1024;

// ── Load .env ─────────────────────────────────────────────────────────────────
if (existsSync(ENV_FILE)) {
  readFileSync(ENV_FILE, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  });
}

const openai    = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Parse args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(flag, def = null) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
}
function getAllArgs(flag) {
  const results = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === flag) results.push(args[i + 1]);
  }
  return results;
}

const dirArg       = getArg('--dir');
const speakerArgs  = getAllArgs('--speaker');
const lang         = getArg('--lang', 'de');
const noSummary    = args.includes('--no-summary');
const summaryModel = getArg('--summary-model', 'claude-sonnet-4-6');
const outputFile   = getArg('--output');

// ── Speaker name from Zoom filename ──────────────────────────────────────────
// "audio-Uwe-Hiltmann-(Regi11390787021.m4a" → "Uwe Hiltmann"
// "audio-Volkan-Brandl-21390787021.m4a"     → "Volkan Brandl"
// "audio-max-31390787021.m4a"               → "Max"
function extractName(filename) {
  const base = basename(filename, extname(filename));
  const withoutPrefix = base.replace(/^audio-/i, '');
  // Alles ab dem ersten -Ziffer oder -(Sonderzeichen abschneiden
  const namePart = withoutPrefix.replace(/[-\(][^-]*\d.*$/, '');
  if (!namePart) return base;
  return namePart.split('-')
    .filter(w => w.length > 0)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

// ── Build speaker list: [{name, file, manualOffset|null}] ────────────────────
function buildSpeakers() {
  if (speakerArgs.length > 0) {
    return speakerArgs.map(spec => {
      const parts = spec.split(':');
      const name  = parts[0];
      // handle Windows paths like C:\... → rejoin with ':'
      const manualOffset = !isNaN(parts[parts.length - 1]) && parts.length > 2
        ? parseFloat(parts.pop()) : null;
      const file = resolve(parts.slice(1).join(':'));
      return { name, file, manualOffset };
    });
  }
  if (dirArg) {
    const dir = resolve(dirArg);
    return readdirSync(dir)
      .filter(f => f.toLowerCase().endsWith('.m4a'))
      .sort()
      .map(f => ({ name: extractName(f), file: join(dir, f), manualOffset: null }));
  }
  console.error('Fehler: --dir <pfad> oder mindestens ein --speaker <spec> erforderlich.');
  process.exit(1);
}

// ── ffprobe: Dateidauer in Sekunden ──────────────────────────────────────────
async function getDuration(file) {
  const { stdout } = await execAsync(
    `ffprobe -v quiet -print_format json -show_format "${file}"`
  );
  return parseFloat(JSON.parse(stdout).format.duration);
}

// ── Audio für Whisper vorbereiten (ggf. auf mp3 komprimieren) ─────────────────
// Ziel-Bitrate: 24kbps reicht für Spracherkennung, hält auch 90-min-Dateien unter 25 MB.
async function prepareAudio(file) {
  if (statSync(file).size <= MAX_WHISPER_BYTES) return { path: file, temp: false };
  const out = join(tmpdir(), `tf-multi-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`);
  await execAsync(`ffmpeg -y -i "${file}" -b:a 24k "${out}" 2>&1`);
  return { path: out, temp: true };
}

// ── Whisper-Transkription eines Sprechers mit Segment-Timestamps ─────────────
async function transcribeSpeaker(speaker, offset) {
  const { path, temp } = await prepareAudio(speaker.file);
  try {
    const result = await openai.audio.transcriptions.create({
      model: 'whisper-1',
      file:  createReadStream(path),
      language: lang === 'auto' ? undefined : lang,
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    });
    // 1. Segmente mit hoher Stille-Wahrscheinlichkeit entfernen (Whisper-eigenes Signal)
    // 2. Bekannte Halluzinations-Phrasen entfernen
    // 3. Konsekutive Duplikate entfernen (gleicher Text 3x in Folge = Halluzination bei Stille)
    const HALLUCINATIONS = /amara\.org|untertitel von|untertitel der|\[musik\]|\[applaus\]|\[stille\]/i;
    const cleaned = (result.segments || [])
      .filter(seg => {
        const text = seg.text.trim();
        if (!text) return false;
        if ((seg.no_speech_prob ?? 0) > 0.8) return false;
        if (HALLUCINATIONS.test(text)) return false;
        return true;
      });

    // Konsekutive Duplikate (gleicher normalisierter Text 3× in Folge) entfernen
    const deduped = [];
    for (const seg of cleaned) {
      const norm = seg.text.trim().toLowerCase();
      const recent = deduped.slice(-2).map(s => s.text.trim().toLowerCase());
      if (recent.length === 2 && recent.every(t => t === norm)) continue;
      deduped.push(seg);
    }

    return deduped.map(seg => ({
        start:   seg.start + offset,
        end:     seg.end   + offset,
        text:    seg.text.trim(),
        speaker: speaker.name,
      }));
  } finally {
    if (temp && existsSync(path)) unlinkSync(path);
  }
}

// ── Zeitformat MM:SS oder H:MM:SS ─────────────────────────────────────────────
function formatTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60).toString().padStart(2, '0');
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const speakers = buildSpeakers();
  if (speakers.length === 0) {
    console.error('Keine Sprecher-Dateien gefunden.');
    process.exit(1);
  }

  console.log(`Sprecher: ${speakers.map(s => s.name).join(', ')} | lang=${lang}`);

  // 1. Dateidauern parallel ermitteln
  process.stdout.write('Dateidauern ermitteln…');
  const durations = await Promise.all(speakers.map(s => getDuration(s.file)));
  const maxDuration = Math.max(...durations);

  const offsets = speakers.map((s, i) =>
    s.manualOffset !== null ? s.manualOffset : maxDuration - durations[i]
  );
  console.log(' ✓');

  speakers.forEach((s, i) => {
    const off = offsets[i];
    const src = s.manualOffset !== null ? ' (manuell)' : '';
    console.log(`  ${s.name}: ${(durations[i] / 60).toFixed(1)} min${off > 0 ? ` (Offset +${formatTime(off)}${src})` : ''}`);
  });

  // 2. Alle Sprecher parallel transkribieren
  console.log(`\nWhisper Transkription (${speakers.length} Dateien parallel)…`);
  const segmentArrays = await Promise.all(
    speakers.map((s, i) => transcribeSpeaker(s, offsets[i]))
  );
  speakers.forEach((s, i) => console.log(`  ✓ ${s.name} (${segmentArrays[i].length} Segmente)`));

  // 3. Segmente zusammenführen und chronologisch sortieren
  const allSegments = segmentArrays.flat().sort((a, b) => a.start - b.start);

  // 4. Transkript-Text aufbauen
  const transcriptLines = allSegments.map(
    seg => `[${formatTime(seg.start)} – ${seg.speaker}]: ${seg.text}`
  );
  const transcriptText = transcriptLines.join('\n');

  const output = [];
  output.push('══════════════════════════════════════════════════════');
  output.push('TRANSKRIPT');
  output.push('══════════════════════════════════════════════════════');
  output.push(transcriptText);

  console.log('\n' + output.join('\n'));

  // 5. Claude-Zusammenfassung (optional)
  if (!noSummary) {
    process.stdout.write('\nZusammenfassung wird erstellt…');

    const summaryPrompt = `Du bekommst ein Meeting-Transkript mit mehreren Sprechern im Format "[MM:SS – Name]: Text".
Erstelle eine strukturierte Auswertung auf Deutsch:

## Executive Summary
3–6 Sätze: Worum ging es, was wurde erreicht?

## Besprochene Themen
Stichpunktliste der Hauptthemen.

## Entscheidungen
Was wurde beschlossen? Falls keine, schreibe "Keine expliziten Entscheidungen getroffen."

## Action Items
Alle konkreten Aufgaben mit Verantwortlichem. Format:
- [ ] **[Name]**: Aufgabe

Falls kein Verantwortlicher klar ist, schreibe [Offen].

---
TRANSKRIPT:
${transcriptText}`;

    const msg = await anthropic.messages.create({
      model:      summaryModel,
      max_tokens: 2000,
      messages:   [{ role: 'user', content: summaryPrompt }],
    });
    const summary = msg.content.find(b => b.type === 'text')?.text || '';
    console.log(' ✓');

    const summaryBlock = [
      '\n══════════════════════════════════════════════════════',
      'ZUSAMMENFASSUNG & ACTION ITEMS',
      '══════════════════════════════════════════════════════',
      summary,
    ];
    console.log(summaryBlock.join('\n'));
    output.push(...summaryBlock);
  }

  // 6. Optional in Datei speichern
  if (outputFile) {
    writeFileSync(resolve(outputFile), output.join('\n'), 'utf8');
    console.log(`\nGespeichert: ${resolve(outputFile)}`);
  }
})();
