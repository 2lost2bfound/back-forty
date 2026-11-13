// nav.js — BFS pathing over standable cells (plan §B6: max 4,000 nodes per
// search). Used by raid cops to walk from the road to the shack. Pure module.

import { CONFIG } from '../config.js';
import { tileAt, tileInfo, inBounds } from './tiles.js';

const COLS = CONFIG.world.cols;
const ok = (state, x, y) => inBounds(x, y) && !tileInfo(tileAt(state.tiles, x, y)).solid;
const solid = (state, x, y) => !inBounds(x, y) || tileInfo(tileAt(state.tiles, x, y)).solid;
/** A 2-tall body fits and the floor below is solid. */
const standable = (state, x, y) => ok(state, x, y) && ok(state, x, y - 1) && solid(state, x, y + 1);

/** Path of {x,y} tile cells from -> to (inclusive), or null. */
export function findPath(state, from, to) {
  const start = from.y * COLS + from.x;
  const goal = to.y * COLS + to.x;
  const prev = new Map([[start, -1]]);
  const queue = [start];
  for (let i = 0; i < queue.length && queue.length < CONFIG.limits.pathNodes; i++) {
    const cur = queue[i];
    if (cur === goal) {
      const out = [];
      for (let k = cur; k !== -1; k = prev.get(k)) out.push({ x: k % COLS, y: (k / COLS) | 0 });
      return out.reverse();
    }
    const cx = cur % COLS;
    const cy = (cur / COLS) | 0;
    for (const dx of [-1, 1]) {
      const nx = cx + dx;
      for (const dy of [0, -1, 1, 2, 3]) { // level, step up one, drop up to three
        const ny = cy + dy;
        if (!standable(state, nx, ny)) continue;
        if (dy < 0 && !ok(state, cx, cy - 2)) continue;       // headroom to step up
        if (dy > 0 && !ok(state, nx, cy)) continue;           // clear to fall into
        const k = ny * COLS + nx;
        if (prev.has(k)) continue;
        prev.set(k, cur);
        queue.push(k);
        break;
      }
    }
  }
  return null;
}
