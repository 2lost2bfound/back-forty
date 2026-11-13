// perf.js — rolling frame statistics for the F3 overlay and the browser harness
// (plan §B2 perf gate). Pure and allocation-free after creation: main.js calls
// record() once per frame with the WORK time (performance.now() around
// update+draw) and the frame INTERVAL (rAF delta). The stats object is updated
// in place and exposed as window.__perf in dev.
//
// Rolling fields (workAvg, workMax, intervalAvg, intervalMax) cover the last
// CONFIG.perf.frameHistory frames. The run fields (runWorkAvg, runWorkMax,
// over20, dropped, samples, seconds) accumulate since reset(), for a 60 s gate.
// "Dropped" = interval > dropFactor x the display interval, estimated as the
// 25th percentile of the recent intervals (robust to the drops themselves).

import { CONFIG } from './config.js';

export function createPerf(P = CONFIG.perf) {
  const n = P.frameHistory;
  const work = new Float32Array(n);
  const ivl = new Float32Array(n);
  const sorted = new Float32Array(n);
  let at = 0, len = 0, sinceSort = 0;
  let wSum = 0, iSum = 0;
  let runSum = 0, runMs = 0;

  const stats = {
    workAvg: 0, workMax: 0, intervalAvg: 0, intervalMax: 0,
    runWorkAvg: 0, runWorkMax: 0, over20: 0, dropped: 0,
    samples: 0, seconds: 0, displayMs: 1000 / P.targetFps,
    reset() {
      work.fill(0); ivl.fill(0);
      at = 0; len = 0; sinceSort = 0; wSum = 0; iSum = 0; runSum = 0; runMs = 0;
      stats.workAvg = stats.workMax = stats.intervalAvg = stats.intervalMax = 0;
      stats.runWorkAvg = stats.runWorkMax = stats.over20 = stats.dropped = 0;
      stats.samples = stats.seconds = 0;
    },
  };

  function estimateDisplay() {
    sorted.fill(Infinity);
    for (let i = 0; i < len; i++) sorted[i] = ivl[i];
    sorted.sort();
    const q = sorted[(len * 0.25) | 0];
    if (q > 1 && q < Infinity) stats.displayMs = q;
  }

  stats.record = (workMs, intervalMs) => {
    if (len === n) { wSum -= work[at]; iSum -= ivl[at]; } else len++;
    work[at] = workMs; ivl[at] = intervalMs;
    wSum += workMs; iSum += intervalMs;
    at = (at + 1) % n;
    let wMax = 0, iMax = 0;
    for (let i = 0; i < len; i++) { if (work[i] > wMax) wMax = work[i]; if (ivl[i] > iMax) iMax = ivl[i]; }
    stats.workAvg = wSum / len; stats.workMax = wMax;
    stats.intervalAvg = iSum / len; stats.intervalMax = iMax;

    stats.samples++;
    runSum += workMs; runMs += intervalMs;
    stats.runWorkAvg = runSum / stats.samples;
    if (workMs > stats.runWorkMax) stats.runWorkMax = workMs;
    if (workMs > P.overMs) stats.over20++;
    if (stats.samples > 2 && intervalMs > P.dropFactor * stats.displayMs) stats.dropped++; // skip the first frames
    stats.seconds = runMs / 1000;
    if (++sinceSort >= 15) { sinceSort = 0; estimateDisplay(); }
  };

  return stats;
}
