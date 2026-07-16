/**
 * patch-site-hq.js — chirurgischer HD-Nachlauf-Patcher.
 *
 * Nimmt einen fertigen webinare/<slug>/ Ordner + eine Liste von Slide-Dateinamen,
 * die HQ-Frames bekommen haben, und updated die drei minimalen Stellen im Site-Output:
 *   1. site_data.json → slides[i].hq_available = true
 *   2. index.html slide-cards → class + hq-badge span
 *   3. index.html SLIDES JS-const → hq_available: true
 *
 * Bewusst kein Full-Rebuild: build-webinar-slides.js braucht Video + Transcript, die wir
 * beim Nachlauf nicht mehr haben. Wenn das Template in build-webinar-slides.js zukünftig
 * geändert wird (Class-Namen, Slide-Card-Markup), muss dieser Patcher synchron gehalten
 * werden. Siehe SKILL.md Changelog v1.3.0.
 */

import fs from 'fs';
import path from 'path';

export function patchSiteHq(siteDir, hqFilenames) {
  const set = new Set(hqFilenames);
  if (set.size === 0) return { patched: 0, note: 'no filenames provided' };

  const dataPath = path.join(siteDir, 'site_data.json');
  const htmlPath = path.join(siteDir, 'index.html');
  if (!fs.existsSync(dataPath)) throw new Error(`site_data.json fehlt in ${siteDir}`);
  if (!fs.existsSync(htmlPath)) throw new Error(`index.html fehlt in ${siteDir}`);

  // ── 1. site_data.json ─────────────────────────────────────────────────────
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  let jsonPatched = 0;
  for (const s of data.slides || []) {
    if (set.has(s.file) && s.hq_available !== true) {
      s.hq_available = true;
      jsonPatched++;
    }
  }
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));

  // ── 2 + 3. index.html ─────────────────────────────────────────────────────
  let html = fs.readFileSync(htmlPath, 'utf8');

  // Für jede betroffene Datei die zugehörige Slide-Card patchen.
  // Slide-Cards enthalten `<img src="assets/frames/<file>"` als eindeutigen Anker.
  // Wir suchen ab dem <article ...class="slide-card..."> das den <img src> enthält.
  let cardPatched = 0;
  for (const file of set) {
    const imgAnchor = `assets/frames/${escapeForRegex(file)}`;
    // Article-Block finden: <article class="slide-card…" data-idx="…" …>…assets/frames/<file>…</article>
    const articleRegex = new RegExp(
      `(<article class="slide-card)([^"]*)(" data-idx="\\d+"[^>]*>[\\s\\S]*?${imgAnchor}[\\s\\S]*?</article>)`,
      'm'
    );
    html = html.replace(articleRegex, (full, pre, mid, post) => {
      // (a) class-Attribut um " has-hq" ergänzen, wenn noch nicht drin
      let newMid = mid.includes('has-hq') ? mid : (mid + ' has-hq');

      // (b) hq-badge span vor </div> des slide-img-wrap einfügen, wenn noch nicht drin
      let newPost = post;
      if (!/class="hq-badge"/.test(post.slice(0, post.indexOf('<div class="slide-body"')))) {
        // Einfügen unmittelbar vor der schließenden div des slide-img-wrap
        newPost = post.replace(
          /(<img[^>]*src="assets\/frames\/[^"]+"[^>]*\/?>[\s\S]*?)(<\/div>\s*<div class="slide-body")/,
          `$1      <span class="hq-badge" title="Hochaufgelöste Version zum Zoomen verfügbar">HD zoom</span>\n    $2`
        );
      }
      cardPatched++;
      return pre + newMid + newPost;
    });
  }

  // SLIDES JS-const patchen: `const SLIDES = [ {...}, {...} ];`
  // Extrahieren, parsen als JS-literal (via JSON.parse — die Objekt-Werte sind JSON-kompatibel), patchen, re-injizieren.
  let jsPatched = 0;
  const slidesConstRegex = /(const SLIDES = )(\[[\s\S]*?\])(;)/m;
  const m = html.match(slidesConstRegex);
  if (m) {
    let arr;
    try {
      arr = JSON.parse(m[2]);
    } catch (e) {
      throw new Error(`SLIDES JSON in index.html nicht parsbar: ${e.message}`);
    }
    for (const s of arr) {
      if (set.has(s.file) && s.hq_available !== true) {
        s.hq_available = true;
        jsPatched++;
      }
    }
    html = html.replace(slidesConstRegex, `$1${JSON.stringify(arr)}$3`);
  } else {
    throw new Error(`SLIDES const in index.html nicht gefunden`);
  }

  fs.writeFileSync(htmlPath, html);

  return {
    patched: set.size,
    site_data_updates: jsonPatched,
    card_updates: cardPatched,
    js_const_updates: jsPatched,
  };
}

function escapeForRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// CLI-Modus für lokale Tests: `node patch-site-hq.js <siteDir> <file1> <file2> ...`
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , siteDir, ...files] = process.argv;
  if (!siteDir || files.length === 0) {
    console.error('Usage: node patch-site-hq.js <siteDir> <file1.jpg> [file2.jpg ...]');
    process.exit(1);
  }
  const result = patchSiteHq(siteDir, files);
  console.log(JSON.stringify(result, null, 2));
}
