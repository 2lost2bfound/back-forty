// spawn.js — keeps the town populated with pedestrians (plan §A7, M3).
// Runs on the 2 Hz sim tick. Pure module; uses the save's PRNG.

import { CONFIG } from '../config.js';
import { withStateRng } from '../rng.js';
import { inHours, rollInterest } from '../sim/economy.js';
import { quality } from '../quality.js';

const TS = CONFIG.world.tile;
const PED = CONFIG.economy.peds;

export function stepSpawn(state) {
  const day = inHours(state.time.hour, PED.open, PED.close);
  if (!day) { state.npcs.length = 0; return; } // town empties at night
  if (state.npcs.length > quality.pedCap) state.npcs.length = quality.pedCap; // quality step-down
  if (state.npcs.length >= quality.pedCap) return;
  const r = withStateRng(state, (rng) => (rng.chance(PED.spawnChance)
    ? { x: rng.range(PED.x0, PED.x1) * TS, dir: rng.chance(0.5) ? 1 : -1 } : null));
  if (!r) return;
  state.npcSeq = (state.npcSeq || 0) + 1;
  state.npcs.push({ id: state.npcSeq, x: r.x, dir: r.dir, interested: rollInterest(state), asked: false });
}
