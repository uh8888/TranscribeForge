#!/usr/bin/env node
// Vision-classify candidate frames with Claude Haiku, filtering transitions/cropped/greyed frames.
// Output: /Users/uhi/Projects/Webinar-Slides-Site/frame_analysis.json
//
// Input:  /tmp/frame_candidates.json   (from cluster-webinar-frames.js)
//         /Users/uhi/Projects/Webinar-Slides-Site/assets/frames_full/  (full JPEGs)

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';

const CANDIDATES = '/tmp/frame_candidates.json';
const FRAMES_DIR = '/Users/uhi/Projects/Webinar-Slides-Site/assets/frames_full';
const OUT = '/Users/uhi/Projects/Webinar-Slides-Site/frame_analysis.json';
const MODEL = 'claude-haiku-4-5-20251001';
const CONCURRENCY = 8;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const cdata = JSON.parse(fs.readFileSync(CANDIDATES, 'utf8'));
const items = cdata.candidates;

console.error(`Vision-Klassifikation: ${items.length} Kandidaten @ ${MODEL}, Concurrency=${CONCURRENCY}`);

const SYSTEM = `Du klassifizierst einen einzelnen Frame aus einer deutschen Webinar-Aufzeichnung. Der Frame stammt aus einem Screen-Capture, das Präsentationsfolien zeigt. Antworte AUSSCHLIESSLICH mit einem gültigen JSON-Objekt (keine Codefences, kein zusätzlicher Text) mit exakt diesen Feldern:

{
  "is_slide": boolean,          // true wenn eine Präsentationsfolie zu sehen ist (nicht: Sprecher-Cam, Windows-Desktop, Startmenü, leerer Bildschirm, nur Video-Player-Chrome)
  "is_transition": boolean,     // true wenn ein Folien-Übergang läuft: z.B. Rest der vorherigen Folie am Rand sichtbar, Slide gleitet ein/aus, zwei Folien überlappen, Wechsel-Animation
  "is_cropped": boolean,        // true wenn Folieninhalt am Rand abgeschnitten ist (Text/Bild wird gerade eingeschoben und ragt aus dem sichtbaren Bereich)
  "is_greyed": boolean,         // true wenn die Folie einen Overlay-Effekt hat (ausgegraut, halbtransparent, gedimmt), typisch bei Modal-Öffnung oder Übergangs-Fade
  "is_fully_built": boolean,    // true wenn die Folie ihren finalen Bullet-/Element-Aufbau erreicht hat (alle Elemente sind ausgeklappt, nichts wird gerade animiert)
  "element_count": number,      // Anzahl inhaltlicher Elemente (Bullets, Zeilen, Grafiken, Zahlen, Aufzählungspunkte). Sprecher-Kamera oder Header zählen nicht. 0 wenn is_slide=false.
  "completeness": number,       // 0-10 Skala: wie vollständig befüllt ist die Folie? 10 = maximaler Endzustand, 0 = leer/Übergang
  "slide_title": string,        // Kurztitel/Kernbotschaft (max 60 Zeichen, deutsch). Wenn is_slide=false: kurze Beschreibung.
  "slide_summary": string       // 1 Satz auf Deutsch, was die Folie inhaltlich zeigt.
}

Wichtige Regeln:
- is_transition, is_cropped, is_greyed sind DISQUALIFIZIERER — sei streng, im Zweifel true.
- Zähle bei element_count wirklich die sichtbaren Bullet-Punkte / Grafik-Kacheln. Reine Titel-Folie = 1.
- Keine Halluzinationen. Wenn du unsicher bist, schreibe knappe Fakten.`;

async function analyze(item) {
  const imgPath = path.join(FRAMES_DIR, item.file);
  const b64 = fs.readFileSync(imgPath).toString('base64');
  try {
    const r = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 500,
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
          { type: 'text', text: 'Analysiere diesen Webinar-Frame und antworte im geforderten JSON-Format.' }
        ]
      }]
    });
    const raw = r.content[0].text.trim();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
      else throw e;
    }
    return { ...item, ...parsed, tokens_in: r.usage.input_tokens, tokens_out: r.usage.output_tokens };
  } catch (e) {
    return { ...item, error: e.message };
  }
}

const results = [];
let idx = 0;
async function worker() {
  while (idx < items.length) {
    const i = idx++;
    const res = await analyze(items[i]);
    results[i] = res;
    const flags = [];
    if (res.is_transition) flags.push('TRANS');
    if (res.is_cropped) flags.push('CROP');
    if (res.is_greyed) flags.push('GREY');
    if (!res.is_slide) flags.push('NOSLIDE');
    const flagStr = flags.length ? ` [${flags.join(',')}]` : '';
    process.stderr.write(`[${i+1}/${items.length}] ${res.file}${flagStr} el=${res.element_count ?? '?'} c=${res.completeness ?? '?'} "${(res.slide_title||'').slice(0,50)}"\n`);
  }
}

const workers = Array.from({ length: CONCURRENCY }, () => worker());
await Promise.all(workers);

const totalIn = results.reduce((s,r) => s + (r.tokens_in||0), 0);
const totalOut = results.reduce((s,r) => s + (r.tokens_out||0), 0);
// Haiku 4.5: $1/M in, $5/M out
const costEK = (totalIn * 1 / 1_000_000) + (totalOut * 5 / 1_000_000);

const kept = results.filter(r => r.is_slide && !r.is_transition && !r.is_cropped && !r.is_greyed);
console.error(`\n=== VISION-ERGEBNIS ===`);
console.error(`Analysiert: ${results.length}`);
console.error(`  is_slide=true      : ${results.filter(r=>r.is_slide).length}`);
console.error(`  is_transition=true : ${results.filter(r=>r.is_transition).length}   [ausgeschlossen]`);
console.error(`  is_cropped=true    : ${results.filter(r=>r.is_cropped).length}   [ausgeschlossen]`);
console.error(`  is_greyed=true     : ${results.filter(r=>r.is_greyed).length}   [ausgeschlossen]`);
console.error(`  Errors             : ${results.filter(r=>r.error).length}`);
console.error(`Sauber übrig         : ${kept.length}`);
console.error(`\nTokens: in=${totalIn}, out=${totalOut}`);
console.error(`Kosten EK: $${costEK.toFixed(4)}  |  VK: $${(costEK*2).toFixed(4)}`);

fs.writeFileSync(OUT, JSON.stringify({
  meta: {
    model: MODEL,
    candidate_count: results.length,
    kept_count: kept.length,
    tokens_in: totalIn,
    tokens_out: totalOut,
    cost_ek: costEK
  },
  frames: results
}, null, 2));
console.error(`\nGeschrieben: ${OUT}`);
