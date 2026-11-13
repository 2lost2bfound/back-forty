# Back Forty

A 2D side-view sandbox about running an illegal cannabis grow and going legit.
Raw Canvas 2D + vanilla JavaScript ES modules — zero runtime dependencies, no
build step. See `plan.md` for the full design and build plan.

**Status: Milestone M1 — world, movement, digging.**

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
| A / D | Walk left / right (90 px/s; Shift sprints at 140 px/s, costs stamina) |
| W / Space | Jump (clears 3 tiles); climbs a ladder while touching one |
| S | Drop through a placed platform |
| Mouse move | Aim |
| Left click (hold) | Dig the aimed tile (dirt 0.4 s; stone 1.5 s, needs the pickaxe) |
| Right click | Place the selected tile |
| 1 / 2 / 3 | Select dirt / wood / ladder for placing |
| F3 | Perf overlay: fps, frame ms, entity/particle counts |
| F4 | Toggle the stress scene (2,000 moving test rectangles; the 60 fps perf gate of plan §B2) |

Digging and placing only work on your lot (tiles 40–139). Digging dirt returns
it to a stack for refilling holes; wood and ladders return themselves.

## Perf gate

Every milestone must pass: with F4 on, the F3 overlay must show average frame
time ≤ 12 ms and no frame over 20 ms across 60 s on the target machine
(2-core Celeron, Haswell GT1) in Chrome. M1 additionally targets ≤ 8 ms
average without stress (plan §B2 / M1 "Done when").

## Structure

```
index.html            canvas + #ui root, loads src/main.js as a module
style.css             HUD and menu styles
src/
  main.js             boot, fixed-step loop (60 Hz physics, 2 Hz sim), perf overlay
  config.js           every tunable number, grouped by system
  rng.js              seeded PRNG (mulberry32) + helpers
  state.js            newGame() (save/load arrives in M2)
  world/
    tiles.js          tile table, grid access, dig/place rules
    worldgen.js       the one authored world: terrain, shack, town
    physics.js        AABB vs tiles (sub-stepped), one-way platforms, raycast
  entities/
    player.js         movement, stamina, ladders, dig/place actions
  render/
    spritedata.js     pixel art as string arrays + palettes
    sprites.js        paints the 512x512 atlas at boot (tiles + player, both facings)
    renderer.js       camera, sky, hills, 100 tile chunks (2 dirty redraws/frame)
  ui/input.js         keyboard/mouse state
tests/
  rng.test.js         PRNG determinism and helper bounds
  world.test.js       M1: worldgen, tiles, physics, player movement and digging
```

Rules kept from plan §B3: nothing under `src/sim/` or `src/world/` may
reference `window`, `document`, canvas or audio — those modules (plus
`src/entities/player.js`) run unmodified in Node for tests and
`tools/balance.js` (M3). The frame loop allocates nothing; input is a reused
plain object and the stress pool is one preallocated `Float32Array`.

## Tuning

All numbers live in `src/config.js`, grouped by system. Do not inline
constants in game code.
