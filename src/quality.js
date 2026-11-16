// quality.js — automatic quality step-down (plan My Addition 12). Pure: main.js
// feeds it frame times; renderer, particles and spawn read `quality`.
// If the average per-frame WORK time (JS update+draw) exceeds workAvgMs: level 1 halves
// the particle cap, 2 flattens the night tint (no soft lights), 3 caps pedestrians.
// Work time only: on the target iGPU (HSW GT1) slow frame intervals come from the
// compositor and other apps; the levels cut ~0 ms off them (measured 2026-11-15).
// It ignores a warm-up after boot/load/tab return, skips single hitches (tab
// switch, GC) and needs `badWindows` slow windows in a row, so a healthy machine
// is never stepped down by loading.

import { CONFIG } from './config.js';

const Q = CONFIG.quality;

export const quality = { mode: 'auto', level: 0, particleScale: 1, softLights: true, pedCap: CONFIG.economy.peds.cap };

/** Settings > Effects: 'auto' steps down when slow, 'high' never does, 'low' starts at the lowest level. */
export function setQualityMode(mode) {
  quality.mode = mode === 'high' || mode === 'low' ? mode : 'auto';
  applyLevel(quality.mode === 'low' ? Q.maxLevel : 0);
  warmUp();
}

export function applyLevel(level) {
  quality.level = level;
  quality.particleScale = level >= 1 ? Q.particleScale : 1;
  quality.softLights = level < 2;
  quality.pedCap = level >= 3 ? Q.pedCap : CONFIG.economy.peds.cap;
}

let workSum = 0, time = 0, frames = 0, warm = 0, bad = 0;

/** Start a fresh warm-up (boot, a new or loaded run, returning to the tab). */
export function warmUp() {
  workSum = 0; time = 0; frames = 0; bad = 0;
  warm = Q.warmupS * 1000;
}
warmUp();

/** Feed one frame: interval ms and work ms. Returns the new level when it stepped down, else null. */
export function feedFrame(ms, workMs = 0) {
  if (quality.mode !== 'auto') return null;
  if (warm > 0) { warm -= ms; return null; }
  if (ms > Q.hitchMs) return null; // one-off stall, not a slow machine
  workSum += workMs; time += ms; frames++;
  if (time < Q.windowS * 1000) return null;
  const workAvg = workSum / frames;
  workSum = 0; time = 0; frames = 0;
  bad = workAvg > Q.workAvgMs ? bad + 1 : 0;
  if (bad >= Q.badWindows && quality.level < Q.maxLevel) { bad = 0; applyLevel(quality.level + 1); return quality.level; }
  return null;
}
