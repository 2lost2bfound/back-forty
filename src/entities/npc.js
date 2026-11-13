// npc.js — pedestrians and buyer placement (plan §A7, M3). Pure module: no
// window/document. Pedestrians are runtime-only (state.npcs, not saved); a
// buyer's position is just their config tile, drawn while buyerPresent().

import { CONFIG } from '../config.js';
import { buyerPresent, BUYER_KEYS } from '../sim/economy.js';

const TS = CONFIG.world.tile;
const PED = CONFIG.economy.peds;

/** Pedestrians walk back and forth inside the town strip (60 Hz step). */
export function stepNpcs(state, dt) {
  for (const n of state.npcs) {
    n.x += n.dir * PED.speed * dt;
    if (n.x < PED.x0 * TS) { n.x = PED.x0 * TS; n.dir = 1; }
    else if (n.x > PED.x1 * TS) { n.x = PED.x1 * TS; n.dir = -1; }
  }
}

/** Nearest pedestrian within interact reach of the player, or null. */
export function pedNear(state) {
  const p = state.player;
  const px = p.x + p.w / 2;
  let best = null;
  let bd = PED.reach * TS;
  for (const n of state.npcs) {
    const d = Math.abs(n.x - px);
    if (d <= bd) { bd = d; best = n; }
  }
  return best;
}

/** Buyers visible right now: [{key, x (tile)}]. */
export function presentBuyers(state) {
  const out = [];
  for (const key of BUYER_KEYS) {
    if (buyerPresent(state, key)) out.push({ key, x: CONFIG.economy.buyers[key].x });
  }
  return out;
}
