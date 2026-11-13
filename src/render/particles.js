// particles.js — pooled particles (plan §B2: 150 max, rain included).
// M4: rain only. Positions live in preallocated typed arrays; the frame loop
// allocates nothing. Browser-only (draws to a 2D context).

import { CONFIG } from '../config.js';

const W = CONFIG.canvas.width;
const H = CONFIG.canvas.height;
const N = Math.min(CONFIG.weather.rainParticles, CONFIG.limits.particles);
const SPEED = 320;   // px/s fall
const DRIFT = -60;   // px/s sideways
const LEN = 6;

const xs = new Float32Array(N);
const ys = new Float32Array(N);
for (let i = 0; i < N; i++) { xs[i] = (i * 97) % W; ys[i] = (i * 53) % H; }

export function drawRain(ctx, dt) {
  ctx.fillStyle = 'rgba(170,200,235,0.6)';
  for (let i = 0; i < N; i++) {
    let y = ys[i] + SPEED * dt;
    let x = xs[i] + DRIFT * dt;
    if (y > H) { y -= H + LEN; x = (x + 211) % W; }
    if (x < 0) x += W;
    xs[i] = x;
    ys[i] = y;
    ctx.fillRect(x | 0, y | 0, 1, LEN);
  }
}
