// worldgen.js — builds the one authored world deterministically (plan §B5).
// Pure module: no window/document, runs unmodified in Node (plan §B3 rule).
//
// Shape: flat-ish surface at row 20 with ±1 seeded variation in the woods and
// lot, stone from row 34 down, bedrock rows 58-59, road band on the surface
// across the road zone, then the shack and town buildings stamped from small
// tile templates. The rng is only used for the surface variation, so two runs
// with the same seed produce byte-identical grids.
//
// M2: also stamps the lot's starting objects (plan §A3): water tap + rain
// barrel, the shack bed, 4 starting pots in the yard, and Skeet's marker at
// the park. Objects are plain data in state.objects (pots are carryable, so
// they live in the save rather than being re-derived).

import { CONFIG } from '../config.js';
import { createRng } from '../rng.js';
import { T } from './tiles.js';

// Template chars: W/C/T = wall tile (per building), B = background wall
// (interior), A = air gap (the door). A missing row/column simply isn't
// stamped.
const WALL_TILE = { wood: T.WOOD, town: T.TOWN, concrete: T.CONCRETE };

/** Building template: roof row + (h-1) wall rows; door gap in the right wall,
 * two tiles tall, at the two lowest rows (player box is 22 px < 32 px). */
function buildingTemplate(w, h, wallId) {
  const rows = [];
  rows.push(String.fromCharCode(wallId).repeat(w));
  for (let i = 1; i < h; i++) {
    const isDoorRow = i >= h - 2;
    const right = isDoorRow ? T.AIR : wallId;
    rows.push(
      String.fromCharCode(wallId) +
      String.fromCharCode(T.BGWALL).repeat(w - 2) +
      String.fromCharCode(right)
    );
  }
  return rows;
}

// Shack: 8x5 interior, wood walls, door on the right (plan §A3).
const SHACK_W = 10, SHACK_H = 6;
function shackTemplate() {
  const wall = T.WOOD;
  const bg = String.fromCharCode(T.BGWALL);
  const W = String.fromCharCode(wall);
  const A = String.fromCharCode(T.AIR);
  return [
    W.repeat(SHACK_W),
    ...Array.from({ length: SHACK_H - 3 }, () => W + bg.repeat(SHACK_W - 2) + W),
    W + bg.repeat(SHACK_W - 2) + A, // door, upper
    W + bg.repeat(SHACK_W - 2) + A, // door, lower
  ];
}

/** Char-map stamp: map is { charCode: tileId }; any other char is skipped. */
function stamp(grid, rows, x0, y0, map) {
  for (let r = 0; r < rows.length; r++) {
    const y = y0 + r;
    if (y < 0 || y >= CONFIG.world.rows) continue;
    const row = rows[r];
    for (let c = 0; c < row.length; c++) {
      const id = map[row.charCodeAt(c)];
      if (id === undefined) continue;
      const x = x0 + c;
      if (x < 0 || x >= CONFIG.world.cols) continue;
      grid[y * CONFIG.world.cols + x] = id;
    }
  }
}

export function generateWorld(seed) {
  const cfg = CONFIG.world;
  const grid = new Uint8Array(cfg.cols * cfg.rows);
  const rng = createRng((seed ^ 0x5f3759df) >>> 0);

  // 1. Surface heights: nominal row ±1, changing at most once per segment,
  //    only in the woods + lot (x < roadX0). The lot varies sparsely (the
  //    shack yard should read flat); the woods are rougher. Road and town
  //    stay flat.
  const surface = new Array(cfg.cols);
  let vari = 0;
  for (let x = 0; x < cfg.cols; x++) {
    if (x < cfg.zones.roadX0) {
      if (x % cfg.variationSegment === 0) {
        const chance = x < cfg.zones.lotX0 ? cfg.variationChance.woods : cfg.variationChance.lot;
        if (rng.chance(chance)) {
          vari = Math.max(-1, Math.min(1, vari + rng.intRange(-1, 1)));
        }
      }
      surface[x] = cfg.surfaceRow + vari;
    } else {
      surface[x] = cfg.surfaceRow;
    }
  }

  // 2. Flatten the ground under each building footprint (+1 margin) so walls
  //    never float or sink.
  for (const b of cfg.buildings) {
    const cx = Math.min(b.x + (b.w >> 1), cfg.cols - 1);
    const anchor = surface[cx];
    for (let x = Math.max(0, b.x - 2); x < Math.min(cfg.cols, b.x + b.w + 2); x++) {
      surface[x] = anchor;
    }
  }

  // 3. Terrain columns: air above, surface tile on top, dirt to stoneRow,
  //    stone to bedrockRow, bedrock to the bottom.
  for (let x = 0; x < cfg.cols; x++) {
    const s = surface[x];
    const onRoad = x >= cfg.zones.roadX0 && x < cfg.zones.roadX1;
    for (let y = 0; y < cfg.rows; y++) {
      let id = T.AIR;
      if (y === s) id = onRoad ? T.ROAD : T.GRASS;
      else if (y > s && y < cfg.stoneRow) id = T.DIRT;
      else if (y >= cfg.stoneRow && y < cfg.bedrockRow) id = T.STONE;
      else if (y >= cfg.bedrockRow) id = T.BEDROCK;
      grid[y * cfg.cols + x] = id;
    }
  }

  // 4. Buildings, base sitting on the surface tile (bottom row = surface - 1).
  const shack = shackTemplate();
  for (const b of cfg.buildings) {
    const rows = b.key === 'shack' ? shack : buildingTemplate(b.w, b.h, WALL_TILE[b.wall]);
    const y0 = surface[b.x] - rows.length; // top row
    stamp(grid, rows, b.x, y0, {
      [T.WOOD]: T.WOOD,
      [T.TOWN]: T.TOWN,
      [T.CONCRETE]: T.CONCRETE,
      [T.BGWALL]: T.BGWALL,
      [T.AIR]: T.AIR,
    });
  }

  // 5. Starting objects (plan §A3 lot contents + §A7 Skeet, starting contact).
  //    Yard west of the shack door (57): tap 41, barrel 42, pots 44-47.
  const P = CONFIG.plants;
  const objects = [];
  let nextId = 1;
  const add = (kind, x, extra) => {
    objects.push({ id: nextId++, kind, x, y: surface[x] - 1, ...extra });
  };
  add('tap', 41);
  add('barrel', 42, { charges: P.barrelStartCharges });
  add('pot', 44, { soil: 'cheap', soilPh: P.freshSoilPh, plantId: null });
  add('pot', 45, { soil: 'cheap', soilPh: P.freshSoilPh, plantId: null });
  add('pot', 46, { soil: 'cheap', soilPh: P.freshSoilPh, plantId: null });
  add('pot', 47, { soil: 'cheap', soilPh: P.freshSoilPh, plantId: null });
  add('bed', 50);                                  // shack interior
  add('skeet', CONFIG.economy.skeet.x);            // park marker (town)

  return { grid, surface, objects, nextId };
}
