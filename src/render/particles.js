// particles.js — pooled particles (plan §B2: 150 max, rain included).
// M4: rain only. Positions live in preallocated typed arrays; the frame loop
// allocates nothing. Browser-only (draws to a 2D context).

import { CONFIG } from '../config.js';
import { quality } from '../quality.js';

const W = CONFIG.canvas.width;
const H = CONFIG.canvas.height;
const MAX = CONFIG.limits.particles;
const N = Math.min(CONFIG.weather.rainParticles, MAX);
const SPEED = 320;   // px/s fall
const DRIFT = -60;   // px/s sideways
const LEN = 6;

const xs = new Float32Array(MAX);
const ys = new Float32Array(MAX);
for (let i = 0; i < MAX; i++) { xs[i] = (i * 97) % W; ys[i] = (i * 53) % H; }

/** `count` overrides the streak count (the F4 stress scene runs the full pool). */
export function drawRain(ctx, dt, count = N) {
  ctx.fillStyle = 'rgba(170,200,235,0.6)';
  const n = (Math.min(count, MAX) * quality.particleScale) | 0; // step-down halves the cap
  for (let i = 0; i < n; i++) {
    let y = ys[i] + SPEED * dt;
    let x = xs[i] + DRIFT * dt;
    if (y > H) { y -= H + LEN; x = (x + 211) % W; }
    if (x < 0) x += W;
    xs[i] = x;
    ys[i] = y;
    ctx.fillRect(x | 0, y | 0, 1, LEN);
  }
}
