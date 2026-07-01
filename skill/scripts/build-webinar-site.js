#!/usr/bin/env node
// Build site_data.json from frame_analysis.json + transcript.md
// - Filter: is_slide=true, is_transition=false, is_cropped=false, is_greyed=false
// - Dedupe by fuzzy title match; within each group keep frame with highest element_count
//   (tie-break: highest completeness, then earliest pts)
// - Enrich with transcript timeline entries

import fs from 'fs';
import path from 'path';

const ROOT = '/Users/uhi/Projects/Webinar-Slides-Site';
const ANALYSIS = path.join(ROOT, 'frame_analysis.json');
const TRANSCRIPT = '/Users/uhi/Downloads/Webinar 2026-06 Wie du KI zu deinem profitabelsten Mitarbeiter machst.transcript.md';

const data = JSON.parse(fs.readFileSync(ANALYSIS, 'utf8'));
const rawFrames = data.frames;

// --- Hard filter ---
const slidesRaw = rawFrames.filter(f =>
  f.is_slide === true &&
  f.is_transition === false &&
  f.is_cropped === false &&
  f.is_greyed === false &&
  !/windows|start-?menü|startmenü|desktop|player-chrome/i.test(f.slide_title || '')
);
console.error(`Nach Hard-Filter: ${slidesRaw.length} von ${rawFrames.length} Kandidaten`);

// --- Fuzzy dedup ---
function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[„""«»‚''‹›]/g, '"')
    .replace(/[^a-z0-9äöüß\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function tokenSet(s) { return new Set(normalize(s).split(' ').filter(w => w.length > 2)); }
function jaccard(A, B) {
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

// Sort by pts so time-adjacency works naturally
slidesRaw.sort((a, b) => a.pts - b.pts);

const groups = [];
for (const f of slidesRaw) {
  const ts = tokenSet(f.slide_title);
  let placed = false;
  for (const g of groups) {
    const sim = jaccard(ts, g.tokens);
    // Also allow merge if time proximity + moderate similarity
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

// Pick BEST per group: highest element_count → completeness → earliest pts
const slides = groups.map(g => {
  const best = g.items.slice().sort((a, b) =>
    ((b.element_count ?? 0) - (a.element_count ?? 0)) ||
    ((b.completeness ?? 0) - (a.completeness ?? 0)) ||
    (a.pts - b.pts)
  )[0];
  return {
    ...best,
    duplicate_count: g.items.length,
    all_pts: g.items.map(x => x.pts),
    first_pts: Math.min(...g.items.map(x => x.pts)),
    max_element_count: Math.max(...g.items.map(x => x.element_count ?? 0))
  };
}).sort((a, b) => a.first_pts - b.first_pts);

console.error(`Nach Dedup: ${slides.length} Folien (aus ${slidesRaw.length} sauberen Kandidaten)`);

// --- Parse timeline from transcript ---
const md = fs.readFileSync(TRANSCRIPT, 'utf8');
const timelineRegex = /^\*\*(\d{1,2}):(\d{2})(?:–(\d{1,2}):(\d{2}))?\*\*\s*[–-]\s*(.+)$/gm;
const timeline = [];
let m;
while ((m = timelineRegex.exec(md)) !== null) {
  const start = parseInt(m[1]) * 60 + parseInt(m[2]);
  const end = m[3] ? parseInt(m[3]) * 60 + parseInt(m[4]) : start;
  timeline.push({ start, end, text: m[5].trim() });
}
console.error(`Timeline-Einträge: ${timeline.length}`);

function fmtMMSS(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
for (const s of slides) {
  const p = s.first_pts;
  let best = null;
  for (const t of timeline) {
    const dist = Math.min(Math.abs(t.start - p), Math.abs(t.end - p));
    if (dist <= 30 && (!best || dist < best.dist)) {
      best = { ...t, dist };
    }
  }
  s.timeline_match = best;
  s.mmss = fmtMMSS(s.first_pts);
}

const matched = slides.filter(s => s.timeline_match).length;
console.error(`Timeline-Match: ${matched} / ${slides.length}`);

// --- Prepare data ---
const siteData = {
  meta: {
    title: 'Wie du KI zu deinem profitabelsten Mitarbeiter machst',
    subtitle: 'Everlast Consulting Webinar – 2026-06',
    speakers: ['Stevo Topic (Co-Founder)', 'Patrick Kolbe (CEO Consultant)'],
    company: 'Everlast Consulting GmbH',
    duration_min: 105.8,
    generated: new Date().toISOString().slice(0, 10),
    slide_count: slides.length,
    candidate_count: rawFrames.length,
    frames_dir: 'assets/frames_full'
  },
  slides: slides.map(s => ({
    file: s.file,
    pts: s.first_pts,
    mmss: s.mmss,
    title: s.slide_title,
    summary: s.slide_summary,
    completeness: s.completeness,
    element_count: s.element_count,
    duplicate_count: s.duplicate_count,
    timeline_note: s.timeline_match ? s.timeline_match.text : null
  }))
};

fs.writeFileSync(path.join(ROOT, 'site_data.json'), JSON.stringify(siteData, null, 2));
console.error(`Geschrieben: site_data.json (${slides.length} Folien)`);
