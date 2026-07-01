#!/usr/bin/env node
// Cluster consecutive frames by dHash-similarity into stable runs (candidate slides)
// and transitions (skipped).
//
// Input:  /tmp/frame_hashes.json  [{idx,pts,file,hash}]
// Output: /tmp/frame_candidates.json
//   {
//     clusters:  [{ start_idx, end_idx, start_pts, end_pts, duration, size, mid_idx, last_idx }],
//     candidates:[{ idx, pts, file, cluster_size, cluster_duration }]  // one per stable cluster
//   }
//
// Algorithm:
//   1. Walk hashes in order.
//   2. New cluster starts when Hamming(cur, cluster_ref) > SIM_THRESHOLD.
//   3. cluster_ref = MEDIAN hash of cluster (approx: last stable frame). We use last frame's hash
//      but refresh only when the sliding delta stays small — this makes clusters tolerant to
//      slow bullet-build animation.
//   4. Stable cluster = duration >= MIN_STABLE_SEC (default 3s).
//   5. Candidate frame = LAST frame of cluster (highest completeness for animated builds).

import fs from 'fs';

const HASH_IN = '/tmp/frame_hashes.json';
const OUT = '/tmp/frame_candidates.json';

const SIM_THRESHOLD = 10;   // Hamming distance > 10 (of 64 bits) = "different slide". Empirical.
const MIN_STABLE_SEC = 3;   // shortest accepted cluster
const MAX_TRANSIENT_SEC = 2; // clusters shorter than this are considered pure transitions

const hashes = JSON.parse(fs.readFileSync(HASH_IN, 'utf8'));

function hamming(hexA, hexB) {
  const a = BigInt('0x' + hexA);
  const b = BigInt('0x' + hexB);
  let x = a ^ b;
  let cnt = 0;
  while (x) { cnt += Number(x & 1n); x >>= 1n; }
  return cnt;
}

// Build clusters
const clusters = [];
let cur = { start: 0, hashes: [hashes[0].hash], ref: hashes[0].hash };
for (let i = 1; i < hashes.length; i++) {
  const d = hamming(hashes[i].hash, cur.ref);
  if (d > SIM_THRESHOLD) {
    // close current
    clusters.push({ start: cur.start, end: i - 1 });
    cur = { start: i, hashes: [hashes[i].hash], ref: hashes[i].hash };
  } else {
    cur.hashes.push(hashes[i].hash);
    // adapt ref slowly: after 3 similar frames, treat middle frame as the new ref
    // (helps with slow bullet-in animation)
    if (cur.hashes.length === 3) cur.ref = cur.hashes[1];
    if (cur.hashes.length === 8) cur.ref = cur.hashes[3];
  }
}
clusters.push({ start: cur.start, end: hashes.length - 1 });

// Enrich clusters
for (const c of clusters) {
  c.start_pts = hashes[c.start].pts;
  c.end_pts = hashes[c.end].pts;
  c.duration = c.end_pts - c.start_pts + 1;
  c.size = c.end - c.start + 1;
  c.mid_idx = Math.floor((c.start + c.end) / 2);
  c.last_idx = c.end;
}

const stable = clusters.filter(c => c.duration >= MIN_STABLE_SEC);
const transient = clusters.filter(c => c.duration < MIN_STABLE_SEC);

console.error(`Total clusters: ${clusters.length}`);
console.error(`  Stable (>=${MIN_STABLE_SEC}s): ${stable.length}`);
console.error(`  Transient (<${MIN_STABLE_SEC}s): ${transient.length}   [treated as transitions]`);

// Candidate frame per stable cluster = LAST frame (fully built for animated bullets),
// but back off by 1s if end abuts a transient cluster (safer).
function candidateIdx(c, allClusters) {
  const cIdx = allClusters.indexOf(c);
  const next = allClusters[cIdx + 1];
  let idx = c.end;
  if (next && next.duration < MIN_STABLE_SEC) {
    // last frame is right before a transition — back off 1 frame to be safe
    if (idx - 1 >= c.start) idx = idx - 1;
  }
  return idx;
}

const candidates = stable.map(c => {
  const idx = candidateIdx(c, clusters);
  const h = hashes[idx];
  return {
    idx: h.idx,
    pts: h.pts,
    file: h.file,
    cluster_size: c.size,
    cluster_duration: c.duration,
    cluster_start_pts: c.start_pts,
    cluster_end_pts: c.end_pts
  };
});

// Log samples
console.error(`\nSample candidates:`);
for (let i = 0; i < Math.min(5, candidates.length); i++) {
  const c = candidates[i];
  console.error(`  ${c.file}  pts=${c.pts}s  cluster=${c.cluster_duration}s`);
}
console.error(`...`);
for (let i = Math.max(0, candidates.length - 3); i < candidates.length; i++) {
  const c = candidates[i];
  console.error(`  ${c.file}  pts=${c.pts}s  cluster=${c.cluster_duration}s`);
}

fs.writeFileSync(OUT, JSON.stringify({
  meta: {
    total_frames: hashes.length,
    total_clusters: clusters.length,
    stable_clusters: stable.length,
    transient_clusters: transient.length,
    sim_threshold: SIM_THRESHOLD,
    min_stable_sec: MIN_STABLE_SEC
  },
  clusters,
  candidates
}, null, 2));
console.error(`\nGeschrieben: ${OUT}`);
console.error(`Kandidaten für Vision-Klassifikation: ${candidates.length}`);
