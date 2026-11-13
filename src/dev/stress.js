// stress.js — the plan §B2 stress scene (F4, dev only): 40 entities, 60 plants,
// 150 rain particles, 12 lights, raining, at night, spawned into the live world
// near the camera using the real renderers and sim. Pure module (runs in Node).
//
// Plants and pots go through the real plants.js; lamps are real lamp objects the
// lighting layer punches out; entities are inert 'stress' kinds in
// state.entities (drawn by the real entity renderer, ignored by every AI).
// The clock is pinned to CONFIG.stress.hour while on. Rain particles are drawn
// by the renderer when state.stressOn (rain normally only falls 06-12).
// stopStress removes exactly what startStress added and restores the clock.

import { CONFIG } from '../config.js';
import { T, tileAt } from '../world/tiles.js';
import { createPlant } from '../sim/plants.js';

const TS = CONFIG.world.tile;
const S = CONFIG.stress;
let rec = null; // { objIds, plantIds, entIds, time }

const free = (state, x, y) => {
  const id = tileAt(state.tiles, x, y);
  return (id === T.AIR || id === T.BGWALL) && !state.objects.some((o) => o.x === x && o.y === y);
};

/** In-place removal, so nothing holding the array loses it. */
function dropWhere(arr, pred) {
  let k = 0;
  for (const v of arr) if (!pred(v)) arr[k++] = v;
  arr.length = k;
}

export const stressActive = () => rec !== null;

/** Spawn the scene around camera-left pixel `camX`. Returns counts. */
export function startStress(state, camX) {
  if (rec) return null;
  const x0 = Math.max(0, Math.min(CONFIG.world.cols - S.spanTiles, (camX / TS) | 0));
  rec = { objIds: new Set(), plantIds: new Set(), entIds: new Set(), time: { ...state.time } };
  state.stressOn = true;

  // Pots + plants on up to three stacked rows until the plant total is reached.
  for (let row = 0; row < 3 && state.plants.length < S.plants; row++) {
    for (let x = x0; x < x0 + S.spanTiles && state.plants.length < S.plants; x++) {
      const y = state.surface[x] - 1 - row * 2;
      if (!free(state, x, y)) continue;
      const pot = { id: state.nextId++, kind: 'pot', x, y, soil: 'cheap', soilPh: CONFIG.plants.freshSoilPh, plantId: null };
      const plant = createPlant(state, pot, S.strain);
      if (!plant) continue;
      pot.plantId = plant.id;
      state.objects.push(pot);
      rec.objIds.add(pot.id);
      rec.plantIds.add(plant.id);
    }
  }
  // Lamps spread across the view, hung above the plants.
  const step = Math.max(1, Math.floor(S.spanTiles / S.lights));
  for (let i = 0; i < S.lights; i++) {
    const x = x0 + 1 + i * step;
    for (let up = 6; up < 14; up++) {
      const y = state.surface[x] - up;
      if (!free(state, x, y)) continue;
      const lamp = { id: state.nextId++, kind: 'lamp', lamp: S.lampType, x, y, hours: S.lampHours };
      state.objects.push(lamp);
      rec.objIds.add(lamp.id);
      break;
    }
  }
  // Inert walkers.
  const ents = state.entities || (state.entities = []);
  for (let i = 0; i < S.entities; i++) {
    const lo = x0 * TS, hi = (x0 + S.spanTiles) * TS;
    const e = {
      id: state.nextId++, kind: 'stress', state: 'walk', hp: 100, lo, hi,
      x: lo + ((i * 37) % (hi - lo)),
      y: 0, dir: i % 2 ? 1 : -1,
      speed: S.speedMin + ((i * 13) % 10) / 10 * (S.speedMax - S.speedMin),
    };
    e.y = state.surface[(e.x / TS) | 0] * TS;
    ents.push(e);
    rec.entIds.add(e.id);
  }
  state.time.hour = S.hour;
  return { plants: rec.plantIds.size, lamps: S.lights, entities: S.entities };
}

/** Per physics step: walk the entities and hold the clock at night. */
export function stepStress(state, dt) {
  if (!rec) return;
  state.time.hour = S.hour;
  for (const e of state.entities) {
    if (e.kind !== 'stress') continue;
    e.x += e.dir * e.speed * dt;
    if (e.x < e.lo) { e.x = e.lo; e.dir = 1; } else if (e.x > e.hi) { e.x = e.hi; e.dir = -1; }
    e.y = state.surface[(e.x / TS) | 0] * TS;
  }
}

/** Remove everything the scene added and put the clock back. */
export function stopStress(state) {
  if (!rec) return;
  dropWhere(state.objects, (o) => rec.objIds.has(o.id));
  dropWhere(state.plants, (p) => rec.plantIds.has(p.id));
  dropWhere(state.entities, (e) => rec.entIds.has(e.id));
  Object.assign(state.time, rec.time);
  state.stressOn = false;
  rec = null;
}
