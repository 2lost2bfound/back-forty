// main.js — boot, fixed-step loop, perf overlay (plan §B9).
// Loop shape follows plan §B3: clamped dt, 60 Hz fixed physics, 2 Hz sim tick.
// The frame loop allocates nothing: the stress pool is a preallocated
// Float32Array and the overlay writes to an existing DOM node.

import { CONFIG } from './config.js';
import { createRng } from './rng.js';
import { initInput } from './ui/input.js';
import { createRenderer } from './render/renderer.js';

// ---------------------------------------------------------------- boot ----

const canvas = document.getElementById('game');
const renderer = createRenderer(canvas);
const input = initInput(canvas);

const perfEl = document.getElementById('perf');
const PHYS_DT = 1 / CONFIG.loop.physicsHz; // 1/60 s
const SIM_DT = 1 / CONFIG.loop.simHz;      // 0.5 s = 1/60 game hour

// Preallocated stress-rectangle pool: [x, y, vx, vy] per rectangle.
const stress = CONFIG.stress;
const stressRects = new Float32Array(stress.rectangles * 4);
const stressRng = createRng(CONFIG.dev.seed ^ 0x9e3779b9);
for (let i = 0; i < stress.rectangles; i++) {
  const j = i * 4;
  stressRects[j] = stressRng.range(0, CONFIG.canvas.width);
  stressRects[j + 1] = stressRng.range(0, CONFIG.canvas.height);
  stressRects[j + 2] = stressRng.range(stress.speedMin, stress.speedMax) *
    (stressRng.chance(0.5) ? 1 : -1);
  stressRects[j + 3] = stressRng.range(stress.speedMin, stress.speedMax) *
    (stressRng.chance(0.5) ? 1 : -1);
}

// Game state — grows into the full save object (plan §B4) in later milestones.
const state = {
  paused: false,
  simTicks: 0,
  stressOn: false,
  overlayOn: false,
};

// ------------------------------------------------------------- update ----

/** 60 Hz fixed step: movement, physics, camera. (§B3 stepPhysics) */
function stepPhysics(s, dt) {
  if (!s.stressOn) return;
  const rects = stressRects;
  const count = stress.rectangles;
  const w = CONFIG.canvas.width;
  const h = CONFIG.canvas.height;
  const size = stress.rectSize;
  for (let i = 0; i < count; i++) {
    const j = i * 4;
    let x = rects[j] + rects[j + 2] * dt;
    let y = rects[j + 1] + rects[j + 3] * dt;
    if (x < 0) { x = 0; rects[j + 2] = -rects[j + 2]; }
    else if (x > w - size) { x = w - size; rects[j + 2] = -rects[j + 2]; }
    if (y < 0) { y = 0; rects[j + 3] = -rects[j + 3]; }
    else if (y > h - size) { y = h - size; rects[j + 3] = -rects[j + 3]; }
    rects[j] = x;
    rects[j + 1] = y;
  }
}

/** 2 Hz fixed step: time, weather, plants, heat, economy, ... (§B3 stepSim).
 * M0 has no systems yet; the tick counter drives the visible test pattern. */
function stepSim(s, dt) {
  s.simTicks++;
}

// -------------------------------------------------------------- frame ----

let last = performance.now();
let physAcc = 0;
let simAcc = 0;

function frame(now) {
  const rawMs = now - last; // real frame delta, before the hidden-tab clamp
  const dt = Math.min(rawMs / 1000, CONFIG.loop.maxFrameDt);
  last = now;

  if (!state.paused) {
    physAcc += dt;
    let steps = 0;
    while (physAcc >= PHYS_DT) {
      stepPhysics(state, PHYS_DT);
      physAcc -= PHYS_DT;
      if (++steps >= CONFIG.loop.maxPhysicsStepsPerFrame) { physAcc = 0; break; }
    }
    simAcc += dt;
    steps = 0;
    while (simAcc >= SIM_DT) {
      stepSim(state, SIM_DT);
      simAcc -= SIM_DT;
      if (++steps >= CONFIG.loop.maxSimStepsPerFrame) { simAcc = 0; break; }
    }
  }

  render();

  // Dev toggles: F3 perf overlay, F4 stress scene (plan §A2 / §B2).
  if (input.wasPressed('F3')) {
    state.overlayOn = !state.overlayOn;
    perfEl.style.display = state.overlayOn ? 'block' : 'none';
  }
  if (input.wasPressed('F4')) {
    state.stressOn = !state.stressOn;
  }

  input.endFrame();
  updateOverlay(now, rawMs);

  requestAnimationFrame(frame);
}

function render() {
  renderer.clear();
  renderer.drawTestPattern(state.simTicks);
  if (state.stressOn) {
    renderer.drawStressRects(stressRects, stress.rectangles);
  }
}

// ------------------------------------------------------ perf overlay ----
// F3 shows fps and frame ms plus entity/particle counts (plan §A2).
// DOM, updated at overlayHz with dirty checks — never per frame.

const hist = new Float32Array(CONFIG.perf.frameHistory);
let histLen = 0;
let histAt = 0;
let lastOverlay = performance.now();
let framesSince = 0;
let lastText = '';

function updateOverlay(now, rawMs) {
  hist[histAt] = rawMs; // frame duration in ms
  histAt = (histAt + 1) % hist.length;
  if (histLen < hist.length) histLen++;
  framesSince++;

  const interval = 1000 / CONFIG.perf.overlayHz;
  if (now - lastOverlay < interval) return;
  const span = now - lastOverlay;
  lastOverlay = now;

  let avg = 0;
  let worst = 0;
  for (let i = 0; i < histLen; i++) {
    avg += hist[i];
    if (hist[i] > worst) worst = hist[i];
  }
  avg = histLen ? avg / histLen : 0;
  const fps = Math.round((framesSince * 1000) / span);
  const entities = state.stressOn ? stress.rectangles : 0;
  const text =
    `fps ${fps}  frame ${avg.toFixed(1)}ms avg / ${worst.toFixed(1)}ms max\n` +
    `ents ${entities}  parts 0  ${state.stressOn ? 'STRESS (F4)' : ''}`;
  framesSince = 0;
  if (text !== lastText) {
    lastText = text;
    perfEl.textContent = text;
  }
}

requestAnimationFrame(frame);
