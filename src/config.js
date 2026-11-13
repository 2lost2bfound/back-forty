// config.js — EVERY tunable number in plan.md lives here, grouped by system.
// Never inline a number in game code; add it here instead.
// Milestone M0: engine constants, loop budgets, perf limits, stress-scene numbers.

export const CONFIG = {
  version: 1,

  dev: {
    // Default seed for the PRNG in dev builds (tests and the balance bot
    // create their own seeds; the save carries the run's rngState).
    seed: 1337,
  },

  canvas: {
    width: 800,            // internal resolution, never resized
    height: 450,
    cssScale: 2,           // CSS-scaled to 1600x900
  },

  loop: {
    physicsHz: 60,         // fixed movement step
    simHz: 2,              // simulation tick (1 tick = 1/60 game hour)
    maxFrameDt: 0.1,       // clamp: tab was hidden
    maxPhysicsStepsPerFrame: 5,   // spiral-of-death guard
    maxSimStepsPerFrame: 10,
  },

  // Hard limits from plan §B2, enforced in code at every milestone.
  limits: {
    entities: 40,          // active simulated+drawn NPCs/player/dog
    plants: 60,            // static sprites, sim at 2 Hz
    bullets: 32,           // pooled
    particles: 150,        // pooled, includes rain
    softLights: 12,
    drawImagePerFrame: 400,
    pathNodes: 4000,
    saveBytes: 200 * 1024,
  },

  perf: {
    targetFps: 60,
    frameBudgetMs: 16.6,
    jsBudgetAvgMs: 6,      // JS time per frame, average
    jsBudgetWorstMs: 10,   // JS time per frame, worst
    gateAvgMs: 12,         // F4 stress-gate limit (plan §B2)
    gateWorstMs: 20,
    overlayHz: 4,          // perf overlay update rate (DOM, dirty-checked)
    frameHistory: 120,     // samples for avg/max frame ms
  },

  // F4 stress scene (plan §B2 perf gate; dev builds only).
  stress: {
    rectangles: 2000,      // moving test rectangles that must hold 60 fps
    speedMin: 40,          // px/s, random per rectangle
    speedMax: 140,
    colors: [
      '#e6194b', '#3cb44b', '#ffe119', '#4363d8',
      '#f58231', '#911eb4', '#46f0f0', '#f032e6',
    ],
    rectSize: 6,           // px, square
  },

  // M0 test pattern (renderer debug backdrop until real tiles exist in M1).
  testPattern: {
    size: 64,              // px, one tile of the repeating pattern
    scrollPxPerSimTick: 2, // drifts so the 2 Hz sim tick is visible
  },
};
