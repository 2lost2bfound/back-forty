# Back Forty

A 2D side-view sandbox about running an illegal cannabis grow and going legit.
Raw Canvas 2D + vanilla JavaScript ES modules — zero runtime dependencies, no
build step. See `plan.md` for the full design and build plan.

**Status: Milestone M0 — skeleton and perf harness.**

## Run

ES modules do not load from `file://`, so serve the project root:

```sh
python3 -m http.server 8000
```

Then open `http://localhost:8000` in Chrome. The game renders at an internal
800×450 and is CSS-scaled ×2 to 1600×900 with crisp pixels.

## Test

Node is a dev tool only (no npm packages are used at runtime):

```sh
node --test tests/
```

(Also works: bare `node --test` or `node --test tests/*.test.js`. Note that on
Node ≥ 21 a bare directory argument is executed instead of searched — upstream
regression nodejs/node#64555 — which is why `tests/index.js` exists.)

## Keys (so far)

| Key | Action |
|---|---|
| F3 | Perf overlay: fps, frame ms, entity/particle counts |
| F4 | Toggle the stress scene (2,000 moving test rectangles; the 60 fps perf gate of plan §B2) |

## Perf gate

Every milestone must pass: with F4 on, the F3 overlay must show average frame
time ≤ 12 ms and no frame over 20 ms across 60 s on the target machine
(2-core Celeron, Haswell GT1) in Chrome.

## Structure

```
index.html            canvas + #ui root, loads src/main.js as a module
style.css             HUD and menu styles
src/
  main.js             boot, fixed-step loop (60 Hz physics, 2 Hz sim), perf overlay
  config.js           every tunable number, grouped by system
  rng.js              seeded PRNG (mulberry32) + helpers
  ui/input.js         keyboard/mouse state
  render/renderer.js  clear + test pattern + stress rectangles (M1 adds chunks/camera)
tests/
  rng.test.js         PRNG determinism and helper bounds
```

Rules kept from plan §B3: nothing under `src/sim/` or `src/world/` may
reference `window`, `document`, canvas or audio — those modules run
unmodified in Node for tests and `tools/balance.js` (M3). The frame loop
allocates nothing; the stress pool is one preallocated `Float32Array`.

## Tuning

All numbers live in `src/config.js`, grouped by system. Do not inline
constants in game code.
