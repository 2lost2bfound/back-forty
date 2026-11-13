// world.test.js — M1: worldgen, tiles, physics, player movement and digging.
// All modules under src/world/ and src/entities/player.js are pure and run
// unmodified in Node (plan §B3 rule).

import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { generateWorld } from '../src/world/worldgen.js';
import {
  T, tileAt, tileInfo, isEditableX, inBounds, setTile, getTile,
  digInfo, digTile, canPlace, chunkIndex, itemKeyFor,
} from '../src/world/tiles.js';
import {
  moveBody, boxHitsSolid, boxOverlapsId, raycastSolid,
} from '../src/world/physics.js';
import { newGame } from '../src/state.js';
import { createPlayer, stepPlayer } from '../src/entities/player.js';
import { buyItem } from '../src/sim/economy.js';

const TS = CONFIG.world.tile;
const COLS = CONFIG.world.cols;
const ROWS = CONFIG.world.rows;
const Z = CONFIG.world.zones;
const PH = CONFIG.physics;

function fakeState(grid) {
  return { tiles: grid, dirtyChunks: new Set(), events: [] };
}

function freshState(seed = 1337) {
  return newGame(seed);
}

function emptyInput() {
  return {
    left: false, right: false, up: false, down: false,
    sprint: false, jumpPressed: false,
    digHeld: false, placePressed: false,
    aimX: 0, aimY: 0, select: 0,
  };
}

/** Teleport the player to a world position and zero velocities. */
function placeAt(state, x, y) {
  const p = state.player;
  p.x = x; p.y = y; p.vx = 0; p.vy = 0;
  p.onGround = false; p.onLadder = false;
  return p;
}

/** Player cell-centre aim for the cell the player is standing in/near. */
function aimAtCell(inp, cx, cy) {
  inp.aimX = (cx + 0.5) * TS;
  inp.aimY = (cy + 0.5) * TS;
}

// ------------------------------------------------------------ worldgen ----

test('worldgen is deterministic for a seed', () => {
  const a = generateWorld(1337);
  const b = generateWorld(1337);
  assert.deepEqual([...a.grid], [...b.grid]);
  assert.deepEqual(a.surface, b.surface);
});

test('worldgen differs across seeds', () => {
  const a = generateWorld(1);
  const b = generateWorld(2);
  assert.notDeepEqual([...a.grid], [...b.grid]);
});

test('worldgen terrain invariants', () => {
  const { grid, surface } = generateWorld(1337);
  const buildingXs = new Set();
  for (const b of CONFIG.world.buildings) {
    for (let x = b.x - 1; x < b.x + b.w + 1; x++) buildingXs.add(x);
  }
  for (let x = 0; x < COLS; x++) {
    const s = surface[x];
    assert.ok(s >= CONFIG.world.surfaceRow - 1 && s <= CONFIG.world.surfaceRow + 1,
      `surface out of range at x=${x}: ${s}`);
    if (!buildingXs.has(x)) {
      assert.equal(tileAt(grid, x, s - 3), T.AIR, `sky at x=${x}`);
    }
    const top = tileAt(grid, x, s);
    if (x >= Z.roadX0 && x < Z.roadX1) assert.equal(top, T.ROAD);
    else assert.equal(top, T.GRASS);
    // dirt under the surface, then stone, then bedrock
    assert.equal(tileAt(grid, x, s + 2), T.DIRT);
    assert.equal(tileAt(grid, x, CONFIG.world.stoneRow), T.STONE);
    for (const y of [CONFIG.world.bedrockRow, ROWS - 1]) {
      assert.equal(tileAt(grid, x, y), T.BEDROCK, `not bedrock at ${x},${y}`);
    }
  }
});

test('shack and town buildings are stamped and walkable-in', () => {
  const { grid } = generateWorld(1337);
  const shack = CONFIG.world.buildings[0]; // x 48, w 10, h 6
  // roof is wood across the full width
  for (let x = shack.x; x < shack.x + shack.w; x++) {
    assert.equal(tileAt(grid, x, surfaceRowOf(grid, x) - shack.h), T.WOOD, `roof at ${x}`);
  }
  // door gap: air in the right wall, two tiles above the ground
  const doorX = shack.x + shack.w - 1;
  const gy = groundRow(grid, doorX);
  assert.equal(tileAt(grid, doorX, gy - 1), T.AIR);
  assert.equal(tileAt(grid, doorX, gy - 2), T.AIR);
  // interior is background wall (non-solid), so the player can stand inside
  const insideX = shack.x + 2;
  const igy = groundRow(grid, insideX);
  assert.equal(tileAt(grid, insideX, igy - 1), T.BGWALL);
  assert.ok(!isSolid(tileAt(grid, insideX, igy - 1)));
  // town building walls use town-solid
  const hw = CONFIG.world.buildings[2]; // hardware at 236
  assert.equal(tileAt(grid, hw.x, groundRow(grid, hw.x) - 3), T.TOWN); // above the door gap
});

function surfaceRowOf(grid, x) {
  for (let y = 0; y < ROWS; y++) {
    const id = tileAt(grid, x, y);
    if (id !== T.AIR && id !== T.BGWALL && id !== T.WOOD && id !== T.TOWN && id !== T.CONCRETE) return y;
  }
  throw new Error('no surface found');
}

function groundRow(grid, x) {
  return surfaceRowOf(grid, x);
}

function isSolid(id) {
  return !!tileInfo(id).solid;
}

// ------------------------------------------------------------- tiles ------

test('editability is limited to the lot columns', () => {
  assert.ok(!isEditableX(0));
  assert.ok(!isEditableX(39));
  assert.ok(isEditableX(40));
  assert.ok(isEditableX(139));
  assert.ok(!isEditableX(140));
  assert.ok(!isEditableX(399));
});

test('dig rules: dirt 0.4s with drop, stone needs pickaxe and drops nothing', () => {
  const state = freshState();
  // dig a dirt cell in the lot
  const dx = 60, dy = CONFIG.world.surfaceRow + 1;
  const d = digInfo(state, dx, dy);
  assert.ok(d);
  assert.equal(d.digTime, CONFIG.dig.times[1]);
  assert.equal(d.drop, T.DIRT);
  assert.equal(digTile(state, dx, dy), T.DIRT);
  assert.equal(getTile(state, dx, dy), T.AIR);

  // stone: pickaxe required
  const sx = 60, sy = CONFIG.world.stoneRow;
  const st = digInfo(state, sx, sy);
  assert.equal(st.tool, 'pickaxe');
  assert.equal(st.drop, 0);
  assert.equal(st.digTime, CONFIG.dig.times[3]);

  // bedrock and town-solid are not diggable at all
  assert.equal(digInfo(state, 60, CONFIG.world.bedrockRow), null);
  assert.equal(digInfo(state, 300, CONFIG.world.surfaceRow + 1), null); // town zone
});

test('digging and setTile mark chunks dirty', () => {
  const state = freshState();
  const cx = 100, cy = CONFIG.world.surfaceRow + 1;
  const idx = chunkIndex(cx, cy);
  digTile(state, cx, cy);
  assert.ok(state.dirtyChunks.has(idx));
  state.dirtyChunks.clear();
  setTile(state, cx, cy, T.WOOD);
  assert.ok(state.dirtyChunks.has(idx));
  assert.equal(getTile(state, cx, cy), T.WOOD);
});

test('placement rules: air/bgwall cells in the lot only', () => {
  const state = freshState();
  const ax = 60;
  const ay = state.surface[ax] - 1; // air above the surface
  assert.ok(canPlace(state, ax, ay, T.WOOD));
  assert.ok(canPlace(state, ax, ay, T.DIRT));
  assert.ok(canPlace(state, ax, ay, T.LADDER));
  assert.ok(!canPlace(state, ax, ay, T.STONE));     // not a placeable item
  assert.ok(!canPlace(state, ax, state.surface[ax], T.WOOD)); // the grass cell is solid
  assert.ok(!canPlace(state, 200, ay, T.WOOD));     // outside the lot
  // background wall cells (shack interior) accept placement
  const insideX = 50;
  const igy = groundRow(state.tiles, insideX) - 1;
  assert.equal(getTile(state, insideX, igy), T.BGWALL);
  assert.ok(canPlace(state, insideX, igy, T.LADDER));
});

test('itemKeyFor maps placeable tiles to inventory keys', () => {
  assert.equal(itemKeyFor(T.DIRT), 'dirt');
  assert.equal(itemKeyFor(T.WOOD), 'wood');
  assert.equal(itemKeyFor(T.LADDER), 'ladder');
  assert.equal(itemKeyFor(T.STONE), null);
});

// ------------------------------------------------------------ physics ----

test('a body falls, lands and rests on the ground', () => {
  const state = freshState();
  const grid = state.tiles;
  const body = { x: 300 * TS, y: 0, w: 12, h: 22, vx: 0, vy: 0, onGround: false, dropThrough: false };
  for (let i = 0; i < 240; i++) {
    body.vy = Math.min(body.vy + PH.gravity * (1 / 60), PH.maxFallSpeed);
    moveBody(grid, body, 1 / 60);
  }
  assert.ok(body.onGround, 'should be on the ground');
  const groundTop = surfaceRowOf(grid, Math.floor(body.x / TS)) * TS;
  assert.ok(Math.abs(body.y + body.h - groundTop) < 0.5,
    `rests on ground: bottom=${body.y + body.h} top=${groundTop}`);
  assert.equal(body.vy, 0);
});

test('a wall stops horizontal movement', () => {
  const grid = generateWorld(1337).grid;
  // build a stone wall at x=250, rows 10..20
  for (let y = 10; y <= 20; y++) grid[y * COLS + 250] = T.STONE;
  const body = { x: 245 * TS, y: 18 * TS, w: 12, h: 22, vx: PH.walkSpeed, vy: 0, onGround: false, dropThrough: false };
  for (let i = 0; i < 120; i++) moveBody(grid, body, 1 / 60);
  assert.ok(body.x + body.w <= 250 * TS + 0.1, `stopped at wall: x=${body.x}`);
  assert.equal(body.vx, 0);
});

test('automatic step-up climbs a single ledge', () => {
  const grid = generateWorld(1337).grid;
  // flat stone floor at row 31 (top at 496 px) with a clear corridor above,
  // and a single 1-tile ledge at x=260 on row 30
  for (let x = 240; x < 280; x++) {
    for (let y = 28; y <= 30; y++) grid[y * COLS + x] = T.AIR;
    for (let y = 31; y < ROWS; y++) grid[y * COLS + x] = T.STONE;
  }
  grid[30 * COLS + 260] = T.STONE;
  const body = { x: 250 * TS, y: 31 * TS - 22, w: 12, h: 22, vx: 0, vy: 0, onGround: false, dropThrough: false };
  body.onGround = true;
  body.vx = PH.walkSpeed;
  for (let i = 0; i < 180; i++) {
    body.vy = Math.min(body.vy + PH.gravity * (1 / 60), PH.maxFallSpeed);
    moveBody(grid, body, 1 / 60, { stepUp: true });
  }
  assert.ok(body.x > 262 * TS, `crossed the ledge: x=${body.x}`);
  assert.ok(body.onGround);
  // after the ledge the floor drops back one tile
  assert.ok(Math.abs(body.y + body.h - 31 * TS) < 0.5,
    `resting on the floor: bottom=${body.y + body.h}`);
});

test('a jump from the ground clears about 3 tiles', () => {
  const state = freshState();
  placeAt(state, 300 * TS, CONFIG.world.surfaceRow * TS - state.player.h);
  for (let i = 0; i < 2; i++) stepPlayer(state, emptyInput(), 1 / 60); // settle
  const startY = state.player.y;
  let minY = startY;
  for (let i = 0; i < 90; i++) {
    const inp = emptyInput();
    inp.jumpPressed = i === 0;
    stepPlayer(state, inp, 1 / 60);
    if (state.player.y < minY) minY = state.player.y;
  }
  const rise = startY - minY;
  assert.ok(rise >= 44, `rose ${rise}px, expected >= 44 (3 tiles = 48)`);
  assert.ok(rise <= 56, `rose ${rise}px, expected <= 56`);
});

test('platforms are one-way: catch from above, drop through with S', () => {
  const state = freshState();
  const grid = state.tiles;
  const px = 300; // open town ground; the scene is built in the sky rows
  // stone floor at row 18, one-way platform at row 14
  for (let x = px - 2; x <= px + 2; x++) {
    grid[14 * COLS + x] = T.PLATFORM;
    grid[18 * COLS + x] = T.STONE;
  }
  const body = { x: px * TS, y: 12 * TS, w: 12, h: 22, vx: 0, vy: 0, onGround: false, dropThrough: false };
  for (let i = 0; i < 120; i++) {
    body.vy = Math.min(body.vy + PH.gravity * (1 / 60), PH.maxFallSpeed);
    moveBody(grid, body, 1 / 60);
  }
  assert.equal(Math.round(body.y + body.h), 14 * TS, 'landed on the platform');

  // now drop through
  body.dropThrough = true;
  body.onGround = false;
  for (let i = 0; i < 120; i++) {
    body.vy = Math.min(body.vy + PH.gravity * (1 / 60), PH.maxFallSpeed);
    moveBody(grid, body, 1 / 60);
  }
  assert.ok(body.y + body.h > 15 * TS, 'fell through to the floor');
});

test('ladders are climbable and pass-through', () => {
  const state = freshState();
  const grid = state.tiles;
  const lx = 300;
  for (let y = 20; y <= 29; y++) grid[y * COLS + lx] = T.LADDER;
  assert.ok(!boxHitsSolid(grid, lx * TS, 25 * TS, 12, 22));
  assert.ok(boxOverlapsId(grid, { x: lx * TS, y: 25 * TS, w: 12, h: 22 }, T.LADDER));

  const p = placeAt(state, lx * TS + 2, 29 * TS - 22);
  const startY = p.y;
  let y = startY;
  for (let i = 0; i < 60; i++) {
    const inp = emptyInput();
    inp.up = true;
    stepPlayer(state, inp, 1 / 60);
    y = p.y;
    assert.ok(p.onLadder || p.y < startY, 'on the ladder while climbing');
  }
  assert.ok(startY - y > 40, `climbed ${startY - y}px in 1s`);
  // no gravity pull while holding still on a ladder
  const held = y;
  for (let i = 0; i < 30; i++) stepPlayer(state, emptyInput(), 1 / 60);
  assert.ok(Math.abs(p.y - held) < 2, 'hovers while holding still');
});

test('raycastSolid finds the first solid tile along a segment', () => {
  const grid = generateWorld(1337).grid;
  const s = CONFIG.world.surfaceRow;
  // straight down from the sky hits the surface
  const hit = raycastSolid(grid, 300 * TS, 0, 300 * TS, 30 * TS);
  assert.ok(hit);
  assert.equal(hit.ty, s);
  assert.equal(hit.tx, 300);
  // parallel to the surface in the sky hits nothing
  assert.equal(raycastSolid(grid, 220 * TS, 0, 390 * TS, 0), null);
});

// ------------------------------------------------------------- player ----

test('player walks at 90 and sprints at 140 px/s on flat ground', () => {
  const state = freshState();
  const tx = 260; // open town ground between the park and the bar
  const p = placeAt(state, tx * TS, CONFIG.world.surfaceRow * TS - CONFIG.player.h);
  const startX = p.x;
  for (let i = 0; i < 60; i++) {
    const inp = emptyInput();
    inp.right = true;
    stepPlayer(state, inp, 1 / 60);
  }
  const walkDist = p.x - startX;
  assert.ok(Math.abs(walkDist - PH.walkSpeed) < 4,
    `walked ${walkDist.toFixed(1)}px in 1s, expected ~${PH.walkSpeed}`);

  // sprint (starting fresh so stamina is full)
  const p2 = placeAt(state, tx * TS, CONFIG.world.surfaceRow * TS - CONFIG.player.h);
  const startX2 = p2.x;
  for (let i = 0; i < 60; i++) {
    const inp = emptyInput();
    inp.right = true;
    inp.sprint = true;
    stepPlayer(state, inp, 1 / 60);
  }
  const sprintDist = p2.x - startX2;
  assert.ok(Math.abs(sprintDist - PH.sprintSpeed) < 4,
    `sprinted ${sprintDist.toFixed(1)}px in 1s, expected ~${PH.sprintSpeed}`);
  assert.ok(p2.stamina < CONFIG.player.staminaMax, 'sprinting drained stamina');
});

test('stamina regenerates while not sprinting', () => {
  const state = freshState();
  const p = state.player;
  p.stamina = 10;
  placeAt(state, 230 * TS, CONFIG.world.surfaceRow * TS - CONFIG.player.h);
  for (let i = 0; i < 600; i++) stepPlayer(state, emptyInput(), 1 / 60); // 10 s
  assert.equal(p.stamina, CONFIG.player.staminaMax);
});

test('digging completes after the dig time and returns dirt to the stack', () => {
  const state = freshState();
  const tx = 58, dx = 60;
  placeAt(state, tx * TS, state.surface[tx] * TS - CONFIG.player.h);
  const dy = state.surface[dx] + 1; // the diggable cell just below the surface
  const p = state.player;
  const before = p.inv.dirt;
  const steps = Math.ceil(CONFIG.dig.times[1] / (1 / 60)) + 2;
  for (let i = 0; i < steps; i++) {
    const inp = emptyInput();
    inp.digHeld = true;
    aimAtCell(inp, dx, dy);
    stepPlayer(state, inp, 1 / 60);
  }
  assert.equal(getTile(state, dx, dy), T.AIR, 'tile was dug');
  assert.equal(p.inv.dirt, before + 1, 'dirt went to the stack');
  assert.equal(p.dig.cx, -1, 'dig target cleared');
});

test('dig progress resets when the target changes and needs the full time', () => {
  const state = freshState();
  const p = state.player;
  placeAt(state, 58 * TS, CONFIG.world.surfaceRow * TS - CONFIG.player.h);
  const dy = CONFIG.world.surfaceRow + 2; // dirt below the grass
  // half-dig cell A
  for (let i = 0; i < 12; i++) {
    const inp = emptyInput();
    inp.digHeld = true;
    aimAtCell(inp, 60, dy);
    stepPlayer(state, inp, 1 / 60);
  }
  assert.ok(p.dig.progress > 0);
  // switch to cell B: progress restarts
  for (let i = 0; i < 12; i++) {
    const inp = emptyInput();
    inp.digHeld = true;
    aimAtCell(inp, 61, dy);
    stepPlayer(state, inp, 1 / 60);
  }
  assert.equal(p.dig.cx, 61);
  assert.ok(p.dig.progress < CONFIG.dig.times[1] * 0.75, 'progress restarted');
  assert.equal(getTile(state, 61, dy), T.DIRT, 'not finished yet');
});

test('stone cannot be dug without the pickaxe', () => {
  const state = freshState();
  const p = state.player;
  p.inv.pickaxe = false;
  // put a stone cell within reach of the player
  const sx = 60, sy = CONFIG.world.surfaceRow + 1;
  setTile(state, sx, sy, T.STONE);
  placeAt(state, 58 * TS, CONFIG.world.surfaceRow * TS - CONFIG.player.h);
  for (let i = 0; i < 120; i++) {
    const inp = emptyInput();
    inp.digHeld = true;
    aimAtCell(inp, sx, sy);
    stepPlayer(state, inp, 1 / 60);
  }
  assert.equal(getTile(state, sx, sy), T.STONE, 'stone untouched');
  assert.equal(p.dig.cx, -1, 'no active dig target');
});

test('digging is impossible outside the lot', () => {
  const state = freshState();
  placeAt(state, 145 * TS, CONFIG.world.surfaceRow * TS - CONFIG.player.h);
  const p = state.player;
  const dy = CONFIG.world.surfaceRow + 1;
  for (let i = 0; i < 60; i++) {
    const inp = emptyInput();
    inp.digHeld = true;
    aimAtCell(inp, 146, dy);
    stepPlayer(state, inp, 1 / 60);
  }
  assert.equal(getTile(state, 146, dy), T.DIRT, 'road-zone dirt untouched');
  assert.equal(p.dig.cx, -1);
});

test('placing consumes the inventory and sets the tile; dig beats nothing else', () => {
  const state = freshState();
  const tx = 60;
  placeAt(state, tx * TS, state.surface[tx] * TS - CONFIG.player.h);
  const p = state.player;
  p.selected = T.WOOD;
  const cx = 62, cy = state.surface[62] - 1; // air cell within reach
  const inp = emptyInput();
  inp.placePressed = true;
  aimAtCell(inp, cx, cy);
  stepPlayer(state, inp, 1 / 60);
  assert.equal(getTile(state, cx, cy), T.WOOD);
  assert.equal(p.inv.wood, CONFIG.player.start.wood - 1);

  // one-shot: the same step count without a new press places nothing more
  const inp2 = emptyInput();
  inp2.digHeld = false;
  aimAtCell(inp2, cx + 1, cy);
  stepPlayer(state, inp2, 1 / 60);
  assert.equal(getTile(state, cx + 1, cy), T.AIR);
});

test('placing a solid tile into the player box is refused', () => {
  const state = freshState();
  const tx = 60;
  placeAt(state, tx * TS, state.surface[tx] * TS - CONFIG.player.h);
  const p = state.player;
  p.selected = T.DIRT;
  // the cell the player stands in (below the feet line, inside the box)
  const cx = Math.floor((p.x + p.w / 2) / TS);
  const cy = Math.floor((p.y + p.h / 2) / TS);
  const inp = emptyInput();
  inp.placePressed = true;
  aimAtCell(inp, cx, cy);
  stepPlayer(state, inp, 1 / 60);
  assert.equal(getTile(state, cx, cy), T.AIR, 'nothing was placed inside the player');
});

test('selection keys change the selected tile', () => {
  const state = freshState();
  const p = state.player;
  const inp = emptyInput();
  inp.select = T.LADDER;
  stepPlayer(state, inp, 1 / 60);
  assert.equal(p.selected, T.LADDER);
  const inp2 = emptyInput();
  stepPlayer(state, inp2, 1 / 60);
  assert.equal(p.selected, T.LADDER, 'selection sticks');
});

test('the player cannot walk off the world edges', () => {
  const state = freshState();
  const p = placeAt(state, 5, CONFIG.world.surfaceRow * TS - CONFIG.player.h);
  for (let i = 0; i < 120; i++) {
    const inp = emptyInput();
    inp.left = true;
    stepPlayer(state, inp, 1 / 60);
  }
  assert.ok(p.x >= 0);
  assert.equal(p.x, 0);
});

// -------------------------------------------------------------- state ----

test('newGame is deterministic and well-formed', () => {
  const a = freshState(2026);
  const b = freshState(2026);
  assert.deepEqual([...a.tiles], [...b.tiles]);
  assert.equal(a.seed, b.seed);
  assert.equal(a.rngState, b.rngState);
  assert.equal(a.tiles.length, COLS * ROWS);
  assert.equal(a.version, CONFIG.version);
  const p = a.player;
  assert.equal(p.inv.dirt, CONFIG.player.start.dirt);
  assert.equal(p.inv.wood, CONFIG.player.start.wood);
  assert.equal(p.inv.ladder, CONFIG.player.start.ladder);
  // spawns standing on the surface at the configured spawn column
  const spawnTile = CONFIG.world.spawnTileX;
  assert.ok(Math.abs(p.x - (spawnTile * TS + (TS - CONFIG.player.w) / 2)) < 1);
  assert.equal(Math.round(p.y + p.h), a.surface[spawnTile] * TS);
});

// ------------------------------------------------ reachability / physics ----

/** Hold one direction (no jump, no dig) until the player reaches targetX px. */
function walkTo(state, targetX, dir, maxFrames = 6000) {
  const inp = emptyInput();
  inp[dir > 0 ? 'right' : 'left'] = true;
  const p = state.player;
  for (let i = 0; i < maxFrames; i++) {
    stepPlayer(state, inp, 1 / 60);
    if (dir > 0 ? p.x >= targetX : p.x <= targetX) return true;
  }
  return false;
}
const doorPx = (key) => { const b = CONFIG.world.buildings.find((x) => x.key === key); return (b.x + b.w - 1) * TS; };

test('the player walks spawn -> yard pots and back holding only left/right', () => {
  const state = freshState();
  const spawnX = state.player.x;
  const yardPx = 47 * TS; // east-most pot
  assert.ok(walkTo(state, yardPx, -1), `stuck at x=${state.player.x}`);
  assert.ok(walkTo(state, spawnX, 1), `could not return, x=${state.player.x}`);
});

test('the road is walkable from spawn to the town hall door (no jump, no dig)', () => {
  const state = freshState();
  assert.ok(walkTo(state, doorPx('townhall'), 1), `stuck at x=${state.player.x}`);
  assert.ok(walkTo(state, 0.5 * CONFIG.world.spawnTileX * TS, -1, 9000), `no way back, x=${state.player.x}`);
});

test('every building has a walkable door gap in both side walls', () => {
  const { grid } = generateWorld(1337);
  for (const b of CONFIG.world.buildings) {
    const gy = groundRow(grid, b.x + 1);
    for (const x of [b.x, b.x + b.w - 1]) {
      assert.equal(tileAt(grid, x, gy - 1), T.AIR, `${b.key} x=${x} lower`);
      assert.equal(tileAt(grid, x, gy - 2), T.AIR, `${b.key} x=${x} upper`);
    }
  }
});

test('shop purchase works at the hardware store door during open hours', () => {
  const state = freshState();
  state.time.hour = 10;
  assert.ok(walkTo(state, doorPx('hardware'), 1), 'reached the door');
  const cash = state.player.cash;
  stepPlayer(state, emptyInput(), 1 / 60);
  const inp = emptyInput();
  inp.interactPressed = true;
  stepPlayer(state, inp, 1 / 60);
  assert.ok(state.events.some((e) => e.type === 'openShop' && e.shop === 'hardware'), 'E opens the shop');
  const r = buyItem(state, 'pot', 'hardware');
  assert.ok(r.ok, r.msg);
  assert.ok(state.player.cash < cash);
});

test('jumping into a wall slides down: gravity applies while pressing in', () => {
  for (const dir of [1, -1]) {
    const state = freshState();
    const grid = state.tiles;
    const gx = 300, gy = surfaceRowOf(grid, gx);
    for (let y = gy - 12; y < gy; y++) grid[y * COLS + gx + 3] = T.STONE; // tall wall
    for (let y = gy - 12; y < gy; y++) grid[y * COLS + gx - 3] = T.STONE;
    const p = placeAt(state, gx * TS + 2, gy * TS - state.player.h);
    p.x = dir > 0 ? (gx + 3) * TS - p.w - 0.5 : (gx - 2) * TS + 0.5;
    const inp = emptyInput();
    inp[dir > 0 ? 'right' : 'left'] = true;
    let maxY = Infinity, airFrames = 0, landed = false;
    for (let i = 0; i < 200; i++) {
      inp.jumpPressed = i === 5;
      stepPlayer(state, inp, 1 / 60);
      if (i > 5 && !p.onGround) { airFrames++; maxY = Math.min(maxY, p.y); }
      if (i > 10 && p.onGround) { landed = true; break; }
    }
    assert.ok(landed, `dir ${dir}: landed (air frames ${airFrames})`);
    assert.ok(airFrames < 50, `dir ${dir}: no mid-air hang (${airFrames})`);
  }
});
