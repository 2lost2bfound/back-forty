// rooms.js — flood-fill room detection and visibility (plan §A5, My Addition 2).
// Pure module. A "room" is a connected set of non-solid cells. A hatch object
// is a hidden door: it blocks the cops' flood fill (the player walks through).
// A region that reaches open sky is "open": raids search it fully. Anything
// else is a hidden room: found only by the hatch roll.

import { CONFIG } from '../config.js';
import { tileAt, tileInfo, inBounds } from './tiles.js';
import { T } from './tiles.js';

const COLS = CONFIG.world.cols;
const MAX_CELLS = 8000; // shortcut: a bigger region is treated as open

const passable = (state, x, y) => inBounds(x, y) && !tileInfo(tileAt(state.tiles, x, y)).solid;

/** Cells holding a hatch (a hidden door: it closes the shaft it sits in). */
function hatchSet(state) {
  const set = new Set();
  for (const o of state.objects) if (o.kind === 'hatch') set.add(o.y * COLS + o.x);
  return set;
}

/** Open sky above (x,y): every cell above is air or background wall, no hatch. */
export function columnOpen(state, x, y, hatches = hatchSet(state)) {
  for (let yy = y - 1; yy >= 0; yy--) {
    const id = tileAt(state.tiles, x, yy);
    if ((id !== T.AIR && id !== T.BGWALL) || hatches.has(yy * COLS + x)) return false;
  }
  return true;
}

/** A plant is visible from the road: above ground and not under any cover. */
export function visibleFromRoad(state, pot) {
  return pot.y < state.surface[pot.x] && columnOpen(state, pot.x, pot.y);
}

/**
 * Region of (x,y) with hatches closed. Returns { open, id, cells } where id is
 * the smallest cell index of a closed region (stable per room).
 */
export function roomOf(state, x, y) {
  const hatches = hatchSet(state);
  const seen = new Set();
  const queue = [[x, y]];
  seen.add(y * COLS + x);
  let min = y * COLS + x;
  for (let i = 0; i < queue.length; i++) {
    const [cx, cy] = queue[i];
    if (columnOpen(state, cx, cy, hatches) || queue.length > MAX_CELLS) return { open: true, id: -1, cells: queue.length };
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx;
      const ny = cy + dy;
      const k = ny * COLS + nx;
      if (seen.has(k) || hatches.has(k) || !passable(state, nx, ny)) continue;
      seen.add(k);
      if (k < min) min = k;
      queue.push([nx, ny]);
    }
  }
  return { open: false, id: min, cells: queue.length };
}

/** Buried: all four neighbours are solid (a stash covered with dirt). */
export function isBuried(state, x, y) {
  return !passable(state, x + 1, y) && !passable(state, x - 1, y) &&
    !passable(state, x, y + 1) && !passable(state, x, y - 1);
}
