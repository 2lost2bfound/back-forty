// quality.js — automatic quality step-down (plan My Addition 12). Pure: main.js
// feeds it frame times; renderer, particles and spawn read `quality`.
// If the average frame time over the window exceeds the limit: level 1 halves
// the particle cap, 2 flattens the night tint (no soft lights), 3 caps pedestrians.

import { CONFIG } from './config.js';

const Q = CONFIG.quality;

export const quality = { level: 0, particleScale: 1, softLights: true, pedCap: CONFIG.economy.peds.cap };

export function applyLevel(level) {
  quality.level = level;
  quality.particleScale = level >= 1 ? Q.particleScale : 1;
  quality.softLights = level < 2;
  quality.pedCap = level >= 3 ? Q.pedCap : CONFIG.economy.peds.cap;
}

let sum = 0, time = 0, frames = 0;

/** Feed one frame (ms). Returns the new level when it stepped down, else null. */
export function feedFrame(ms) {
  sum += ms; time += ms; frames++;
  if (time < Q.windowS * 1000) return null;
  const avg = sum / frames;
  sum = 0; time = 0; frames = 0;
  if (avg > Q.avgMs && quality.level < Q.maxLevel) { applyLevel(quality.level + 1); return quality.level; }
  return null;
}
