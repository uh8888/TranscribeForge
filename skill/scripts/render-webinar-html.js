#!/usr/bin/env node
// Generate index.html + styles.css from site_data.json + transcript.md
import fs from 'fs';
import path from 'path';

const ROOT = '/Users/uhi/Projects/Webinar-Slides-Site';
const TRANSCRIPT = '/Users/uhi/Downloads/Webinar 2026-06 Wie du KI zu deinem profitabelsten Mitarbeiter machst.transcript.md';

const site = JSON.parse(fs.readFileSync(path.join(ROOT, 'site_data.json'), 'utf8'));
const md = fs.readFileSync(TRANSCRIPT, 'utf8');

// Escape helpers
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Escape + minimal inline markdown: **bold** and `code`
const md2html = s => esc(s)
  .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  .replace(/`([^`]+?)`/g, '<code>$1</code>');

// --- Extract structured sections from the MD ---
function extractSection(md, headingRegex, endHeadingRegex = /^##\s/m) {
  const m = md.match(headingRegex);
  if (!m) return '';
  const start = m.index + m[0].length;
  const rest = md.slice(start);
  const em = rest.match(endHeadingRegex);
  const end = em ? em.index : rest.length;
  // trim leading/trailing whitespace + horizontal rule separators
  return rest.slice(0, end).replace(/^\s+|\s+$/g, '').replace(/\n?---\s*$/g, '').trim();
}

const execSummary = extractSection(md, /^##\s+Executive Summary\s*$/m);
const actionItemsBlock = extractSection(md, /^##\s+Action Items\s*$/m);
const eckdatenBlock = extractSection(md, /^##\s+Eckdaten\s*$/m);
const themenBlock = extractSection(md, /^##\s+Besprochene Themen\s*$/m);
const volltranskript = extractSection(md, /^##\s+Volltranskript\s*$/m);
const visualTimeline = extractSection(md, /^##\s+Visual Timeline\s*$/m);

// Action items -> three columns
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

// Eckdaten table -> pairs
function parseEckdaten(block) {
  const rows = [];
  const lines = block.split('\n');
  for (const line of lines) {
    // skip header, divider
    if (!line.startsWith('|')) continue;
    if (/^\|\s*-+\s*\|/.test(line)) continue;
    if (/^\|\s*Punkt\s*\|/.test(line)) continue;
    const cells = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cells.length >= 2) rows.push({ key: cells[0], value: cells[1] });
  }
  return rows;
}
const eckdaten = parseEckdaten(eckdatenBlock);

// Themen -> nested list (top-level bullets have sub-bullets)
function renderThemen(block) {
  // super simple: keep first-level bullets as h4, sub-bullets as list
  const lines = block.split('\n');
  let html = '';
  let currentTitle = null;
  let currentItems = [];
  const flush = () => {
    if (currentTitle) {
      html += `<div class="topic-card"><h4>${esc(currentTitle)}</h4><ul>`;
      for (const it of currentItems) html += `<li>${esc(it)}</li>`;
      html += `</ul></div>`;
    }
  };
  for (const line of lines) {
    const topMatch = line.match(/^-\s+\*\*(.+?)\*\*\s*$/);
    if (topMatch) {
      flush();
      currentTitle = topMatch[1];
      currentItems = [];
      continue;
    }
    const subMatch = line.match(/^\s{2,}-\s+(.+)$/);
    if (subMatch && currentTitle) {
      // strip surrounding ** for emphasis pieces
      const clean = subMatch[1].replace(/\*\*/g, '');
      currentItems.push(clean);
    }
  }
  flush();
  return html;
}
const themenHtml = renderThemen(themenBlock);

// Visual timeline -> simple list
function renderTimeline(block) {
  const items = [];
  const re = /^\*\*(\d{1,2}:\d{2}(?:–\d{1,2}:\d{2})?)\*\*\s*[–-]\s*(.+)$/gm;
  let m;
  while ((m = re.exec(block)) !== null) {
    items.push({ ts: m[1], text: m[2].trim() });
  }
  return items.map(i => `<div class="tl-row"><span class="tl-ts">${esc(i.ts)}</span><span class="tl-txt">${esc(i.text)}</span></div>`).join('');
}
const timelineHtml = renderTimeline(visualTimeline);

// Slide cards
const slideCards = site.slides.map((s, idx) => `
  <article class="slide-card" data-idx="${idx}" tabindex="0" role="button" aria-label="Slide ${s.mmss} ${esc(s.title)} öffnen">
    <div class="slide-img-wrap">
      <img src="assets/frames_full/${esc(s.file)}" alt="${esc(s.title)}" loading="lazy" />
      <span class="ts-badge">${esc(s.mmss)}</span>
      ${s.duplicate_count > 1 ? `<span class="dup-badge" title="Aus ${s.duplicate_count} ähnlichen Frames zusammengefasst">×${s.duplicate_count}</span>` : ''}
    </div>
    <div class="slide-body">
      <h3>${esc(s.title)}</h3>
      <p>${esc(s.summary || '(keine Info)')}</p>
      ${s.timeline_note ? `<p class="tl-note"><span class="tl-note-label">Transkript-Notiz:</span> ${esc(s.timeline_note)}</p>` : `<p class="tl-note muted">Keine passende Transkript-Notiz gefunden.</p>`}
    </div>
  </article>
`).join('\n');

// Full transcript rendering: no paragraph breaks in source, so split into ~5-sentence blocks
function renderVollTranskript(text) {
  const clean = text.trim();
  if (!clean) return '<p class="muted">(kein Volltranskript verfügbar)</p>';
  // split into sentences, group by 4
  const sents = clean.split(/(?<=[.!?])\s+/);
  const groups = [];
  for (let i = 0; i < sents.length; i += 4) groups.push(sents.slice(i, i+4).join(' '));
  return groups.map(g => `<p>${esc(g)}</p>`).join('');
}
const volltranskriptHtml = renderVollTranskript(volltranskript);

// Slides JSON for lightbox
const slidesForJs = site.slides.map(s => ({
  file: s.file,
  mmss: s.mmss,
  title: s.title,
  summary: s.summary,
  timeline_note: s.timeline_note,
  duplicate_count: s.duplicate_count
}));

const html = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(site.meta.title)} — Webinar-Analyse</title>
<link rel="stylesheet" href="styles.css" />
</head>
<body>

<header class="site-header">
  <div class="header-inner">
    <div class="header-title">
      <h1>${esc(site.meta.title)}</h1>
      <p class="subtitle">${esc(site.meta.subtitle)} · ${esc(site.meta.speakers.join(' · '))} · ${site.meta.duration_min} min</p>
    </div>
    <nav class="site-nav">
      <a href="#overview">Overview</a>
      <a href="#action">Action Items</a>
      <a href="#eckdaten">Eckdaten</a>
      <a href="#themen">Themen</a>
      <a href="#slides">Slides</a>
      <a href="#transkript">Transkript</a>
    </nav>
  </div>
</header>

<main class="container">

  <section id="overview" class="section">
    <div class="section-head">
      <span class="section-eyebrow">Überblick</span>
      <h2>Executive Summary</h2>
    </div>
    <div class="card summary-card">
      <p>${md2html(execSummary)}</p>
    </div>
  </section>

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
        </div>
      `).join('')}
    </div>
  </section>

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
        </div>
      `).join('')}
    </div>
  </section>

  <section id="themen" class="section">
    <div class="section-head">
      <span class="section-eyebrow">Inhaltliche Bausteine</span>
      <h2>Besprochene Themen</h2>
    </div>
    <div class="topics-grid">
      ${themenHtml}
    </div>
  </section>

  <section id="slides" class="section">
    <div class="section-head">
      <span class="section-eyebrow">Visueller Verlauf</span>
      <h2>Slides <span class="section-count">${site.slides.length} Folien</span></h2>
      <p class="section-lede">Aus dem Video extrahiert (FFmpeg 1 fps → dHash-Stabilitäts-Clustering → Claude Haiku Vision-Klassifikation). Übergangs-, abgeschnittene und ausgegraute Frames wurden verworfen. Klick öffnet Detailansicht.</p>
    </div>
    <div class="slides-grid">
      ${slideCards}
    </div>
  </section>

  <section id="transkript" class="section">
    <div class="section-head">
      <span class="section-eyebrow">Alles im Wortlaut</span>
      <h2>Volltranskript &amp; Visual Timeline</h2>
      <p class="section-lede">Hinweis: Das gelieferte Transkript deckt den Verlauf bis ca. 58:42 Minuten ab. Für die Q&amp;A-Runde am Ende liegt kein Textmaterial vor.</p>
    </div>
    <details class="collapsible">
      <summary>Visual Timeline aufklappen (${(visualTimeline.match(/^\\*\\*/gm) || []).length} Einträge)</summary>
      <div class="timeline-list">${timelineHtml}</div>
    </details>
    <details class="collapsible">
      <summary>Volltranskript aufklappen (~${Math.round(volltranskript.length/1000)}k Zeichen)</summary>
      <div class="transcript-body">${volltranskriptHtml}</div>
    </details>
  </section>

  <footer class="site-footer">
    <p>Generiert ${esc(site.meta.generated)} · ${site.meta.slide_count} Slides aus ${site.meta.candidate_count} Vision-Kandidaten · Design nach ContentForge-Blueprint (Sektion 8)</p>
    <p class="muted">Keine externen Requests. Fonts, Bilder und Skript liegen lokal. DSGVO-konform.</p>
  </footer>

</main>

<div class="lightbox" id="lightbox" hidden>
  <button class="lb-close" aria-label="Schließen">×</button>
  <button class="lb-prev" aria-label="Vorherige Slide">‹</button>
  <button class="lb-next" aria-label="Nächste Slide">›</button>
  <div class="lb-content">
    <img class="lb-img" alt="" />
    <div class="lb-meta">
      <span class="lb-ts"></span>
      <h3 class="lb-title"></h3>
      <p class="lb-summary"></p>
      <p class="lb-note"></p>
    </div>
  </div>
</div>

<script>
const SLIDES = ${JSON.stringify(slidesForJs)};
const lb = document.getElementById('lightbox');
const lbImg = lb.querySelector('.lb-img');
const lbTs = lb.querySelector('.lb-ts');
const lbTitle = lb.querySelector('.lb-title');
const lbSummary = lb.querySelector('.lb-summary');
const lbNote = lb.querySelector('.lb-note');
let currentIdx = 0;

function openLightbox(idx) {
  currentIdx = idx;
  const s = SLIDES[idx];
  if (!s) return;
  lbImg.src = 'assets/frames_full/' + s.file;
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
}
function closeLightbox() {
  lb.hidden = true;
  lbImg.src = '';
  document.body.style.overflow = '';
}
function nav(delta) {
  const next = (currentIdx + delta + SLIDES.length) % SLIDES.length;
  openLightbox(next);
}

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

fs.writeFileSync(path.join(ROOT, 'index.html'), html);
console.error(`index.html geschrieben (${(html.length/1024).toFixed(1)} KB)`);
