#!/usr/bin/env node
// Extract frames at fixed interval + build dHash fingerprints for stability clustering.
// Output:
//   assets/frames_full/frame_00001.jpg  ... (full 1920x1080 JPEG, quality 80)
//   /tmp/frame_hashes.json               [{ idx, pts, hash }]
//
// Strategy: 1 fps extract. For each full frame, also produce a 9x8 grayscale raw pixel dump
// (72 bytes) via a second FFmpeg pass on the same PTS grid — used to compute dHash.
//
// Alternatively (chosen): run ONE FFmpeg pass with `-filter_complex split`, producing full JPEGs
// AND downscaled greyscale rawvideo — but that is complex. Simpler: two separate passes, both
// deterministic with -vf fps=1 so indices align.

import { spawnSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const VIDEO = '/Users/uhi/Downloads/Webinar 2026-06 Wie du KI zu deinem profitabelsten Mitarbeiter machst.mp4';
const OUT_DIR = '/Users/uhi/Projects/Webinar-Slides-Site/assets/frames_full';
const HASH_OUT = '/tmp/frame_hashes.json';
const PTS_OUT = '/tmp/frame_pts_full.txt';

const FPS = 1;   // extract 1 frame per second → ~6349 frames for 105 min

fs.mkdirSync(OUT_DIR, { recursive: true });
// clear previous extraction
for (const f of fs.readdirSync(OUT_DIR)) fs.unlinkSync(path.join(OUT_DIR, f));

// --- Pass 1: full JPEGs
console.error(`[1/3] Extract full frames @ ${FPS}fps → ${OUT_DIR}`);
{
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', VIDEO,
    '-vf', `fps=${FPS}`,
    '-q:v', '4',
    path.join(OUT_DIR, 'frame_%05d.jpg')
  ];
  const r = spawnSync('ffmpeg', args, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) { console.error('ffmpeg full pass failed'); process.exit(1); }
}

const files = fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.jpg')).sort();
console.error(`  → ${files.length} JPEGs`);

// PTS reconstruction: FFmpeg with -vf fps=1 outputs frames at t = 0, 1, 2, ... seconds (of output),
// but PTS in the source video actually corresponds to (index-0.5)/FPS or (index-1)/FPS depending
// on offset. Simpler + accurate: use ffprobe or trust our FPS grid.
// With `-vf fps=1`, the k-th output frame (1-based) samples the source at t = (k-1) sec.
const pts = files.map((_, i) => i);   // integer seconds
fs.writeFileSync(PTS_OUT, pts.join('\n') + '\n');

// --- Pass 2: greyscale 9x8 raw pixels (rawvideo) into one file, sequential frames
// Each frame = 72 bytes.
console.error(`[2/3] Extract 9x8 greyscale for dHash`);
const rawPath = '/tmp/frames_9x8.gray';
{
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', VIDEO,
    '-vf', `fps=${FPS},scale=9:8,format=gray`,
    '-f', 'rawvideo',
    '-pix_fmt', 'gray',
    rawPath
  ];
  const r = spawnSync('ffmpeg', args, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) { console.error('ffmpeg gray pass failed'); process.exit(1); }
}
const raw = fs.readFileSync(rawPath);
const frameBytes = 9 * 8;
const frameCountRaw = Math.floor(raw.length / frameBytes);
console.error(`  → raw frames: ${frameCountRaw} (expected ~${files.length})`);

// --- Pass 3: compute dHash per frame
// dHash 8x8: compare each of 8 rows of 8 pixels (from 9x8 image) → 64 bits BigInt
console.error(`[3/3] Computing dHashes`);
const hashes = [];
const N = Math.min(files.length, frameCountRaw);
for (let i = 0; i < N; i++) {
  const off = i * frameBytes;
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
  // pack as hex (low, then high — order doesn't matter for hamming)
  const hex = ((hi << 32n) | lo).toString(16).padStart(16, '0');
  hashes.push({ idx: i, pts: pts[i], file: files[i], hash: hex });
}

fs.writeFileSync(HASH_OUT, JSON.stringify(hashes));
console.error(`Geschrieben: ${HASH_OUT}   (${hashes.length} hashes)`);
console.error(`Geschrieben: ${PTS_OUT}`);
