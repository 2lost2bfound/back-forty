// state.js — one plain JSON-serializable game state (plan §B4).
// M2 scope: the full sim-facing state (time, plants, objects, product,
// player cash/inventory) plus save()/load()/autosave()/migrate() and the
// tiles RLE+base64 codec. Storage is injected, so the same code runs in the
// browser (localStorage) and in Node tests (a mock) — plan §B3 keeps sim and
// world DOM-free; state.js itself only touches storage through the adapter.
//
// Save triggers (plan §B4): every 06:00 dawn, on sleep, and manually from the
// pause menu. Autosaves roll across backforty.auto1..3 (the last 3 dawns).

import { CONFIG } from './config.js';
import { createRng } from './rng.js';
import { generateWorld } from './world/worldgen.js';
import { createPlayer, combatFields } from './entities/player.js';
import { initEconomy } from './sim/economy.js';
import { initHeatState } from './sim/heat.js';
import { initThreats } from './sim/threats.js';

export const SAVE_PREFIX = 'backforty';
export const slotKey = (n) => `${SAVE_PREFIX}.slot${n}`;
export const autoKey = (n) => `${SAVE_PREFIX}.auto${n}`;

/**
 * Build a fresh run. The world (tiles, surface, starting objects) is
 * deterministic from the seed; the save's rngState carries the PRNG so tests,
 * the balance bot and replays are all reproducible (plan §B3).
 */
export function newGame(seed) {
  const rng = createRng(seed);
  const world = generateWorld(seed);
  const px = CONFIG.world.spawnTileX * CONFIG.world.tile +
    (CONFIG.world.tile - CONFIG.player.w) / 2;
  const player = createPlayer(px, world.surface[CONFIG.world.spawnTileX] * CONFIG.world.tile - CONFIG.player.h);

  return {
    version: CONFIG.version,
    seed,
    rngState: rng.state,
    time: { day: CONFIG.clock.startDay, hour: CONFIG.clock.startHour, weather: 'clear' },
    sleeping: false,
    sleepRemain: 0,
    tiles: world.grid,          // Uint8Array(24000); saved as RLE+base64
    surface: world.surface,     // derived, saved as a plain array
    objects: world.objects,     // pots, tap, barrel, bed, Skeet's marker
    plants: [],
    product: [],
    player,
    economy: initEconomy({ day: CONFIG.clock.startDay, hour: CONFIG.clock.startHour }),
    heat: 0,                    // the meter (0-100); everything else is heatState
    heatState: initHeatState({ hour: CONFIG.clock.startHour }),
    threats: initThreats(seed), // director, lock, dog, feud (saved)
    entities: [],               // runtime: thieves/bikers
    bullets: [],                // runtime: the player's pooled bullets
    gameOver: null,             // { reason } once a lose condition fires
    cops: [],                   // runtime: patrol cops in town
    patrolCar: null,            // runtime: the car passing on the road
    tells: null,                // runtime: world tells for the renderer
    npcs: [],                   // pedestrians (runtime only, not saved)
    npcSeq: 0,
    nextId: world.nextId,       // shared id counter (objects, plants, batches)
    simTicks: 0,
    dirtyChunks: new Set(),     // runtime only (tile edits pending chunk redraw)
    events: [],                 // sim pushes, UI/audio read once per frame (§B3)
  };
}

// ------------------------------------------------------- objects helpers --

export function objectAt(state, tx, ty, kinds) {
  return state.objects.find((o) =>
    o.x === tx && o.y === ty && (!kinds || kinds.includes(o.kind))) || null;
}

export function addObject(state, obj) {
  obj.id = state.nextId++;
  state.objects.push(obj);
  return obj;
}

export function removeObject(state, obj) {
  const i = state.objects.indexOf(obj);
  if (i >= 0) state.objects.splice(i, 1);
}

// ------------------------------------------------------ tiles RLE codec ---

/**
 * Run-length encode a Uint8Array into base64: 3 bytes per run
 * [value, countLo, countHi]. Worst case (no runs at all) is 24000 runs =
 * 72 KB -> 96 KB base64, well under the 200 KB save budget (plan §B2).
 */
export function rleEncode(u8) {
  const bytes = [];
  let i = 0;
  while (i < u8.length) {
    const v = u8[i];
    let run = 1;
    while (i + run < u8.length && u8[i + run] === v && run < 65535) run++;
    bytes.push(v, run & 255, (run >> 8) & 255);
    i += run;
  }
  // Pure-JS base64 (no Buffer dependency: browser + Node share this).
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let j = 0; j < bytes.length; j += 3) {
    const b0 = bytes[j];
    const b1 = j + 1 < bytes.length ? bytes[j + 1] : 0;
    const b2 = j + 2 < bytes.length ? bytes[j + 2] : 0;
    out += chars[b0 >> 2];
    out += chars[((b0 & 3) << 4) | (b1 >> 4)];
    out += j + 1 < bytes.length ? chars[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += j + 2 < bytes.length ? chars[b2 & 63] : '=';
  }
  return out;
}

export function rleDecode(str) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const vals = [];
  for (const ch of str) {
    const v = chars.indexOf(ch);
    if (v >= 0) vals.push(v); // '=' padding is skipped
  }
  const bytes = [];
  let j = 0;
  while (j < vals.length) {
    const n = Math.min(4, vals.length - j);
    if (n === 4) {
      bytes.push(
        (vals[j] << 2) | (vals[j + 1] >> 4),
        ((vals[j + 1] & 15) << 4) | (vals[j + 2] >> 2),
        ((vals[j + 2] & 3) << 6) | vals[j + 3],
      );
      j += 4;
    } else if (n === 3) {
      bytes.push(
        (vals[j] << 2) | (vals[j + 1] >> 4),
        ((vals[j + 1] & 15) << 4) | (vals[j + 2] >> 2),
      );
      j += 3;
    } else if (n === 2) {
      bytes.push((vals[j] << 2) | (vals[j + 1] >> 4));
      j += 2;
    } else {
      break; // a single trailing char is invalid base64; stop
    }
  }
  // 3 bytes per run: [value, countLo, countHi]
  const u8 = new Uint8Array(bytes);
  const cells = [];
  for (let r = 0; r + 2 < u8.length; r += 3) {
    const v = u8[r];
    const count = u8[r + 1] | (u8[r + 2] << 8);
    for (let k = 0; k < count; k++) cells.push(v);
  }
  return new Uint8Array(cells);
}

// ------------------------------------------------------- serialization ----

/**
 * Serialize to a JSON string. Runtime-only fields (dirty chunk set, event
 * queue) are excluded; everything else is plain JSON data (plan §B4).
 */
export function serializeState(state) {
  return JSON.stringify({
    version: state.version,
    seed: state.seed,
    rngState: state.rngState,
    time: state.time,
    sleeping: state.sleeping,
    sleepRemain: state.sleepRemain,
    nextId: state.nextId,
    simTicks: state.simTicks,
    tilesRle: rleEncode(state.tiles),
    surface: state.surface,
    objects: state.objects,
    plants: state.plants,
    product: state.product,
    player: state.player,
    economy: state.economy,
    heat: state.heat,
    heatState: state.heatState,
    threats: state.threats,
    gameOver: state.gameOver,
  });
}

/** Rebuild a live state from JSON. Runtime fields are re-initialized. */
export function deserializeState(json) {
  let o;
  try {
    o = JSON.parse(json);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || typeof o.tilesRle !== 'string') return null;
  o = migrate(o);
  let tiles;
  try {
    tiles = rleDecode(o.tilesRle);
  } catch {
    return null;
  }
  if (tiles.length !== CONFIG.world.cols * CONFIG.world.rows) return null;
  if (o.player) {
    o.player.arrests = o.player.arrests || 0; o.player.debt = o.player.debt || 0;
    if (o.player.hp === undefined) Object.assign(o.player, combatFields());
  }
  return {
    version: CONFIG.version,
    seed: o.seed,
    rngState: o.rngState,
    time: o.time,
    sleeping: o.sleeping || false,
    sleepRemain: o.sleepRemain || 0,
    tiles,
    surface: o.surface,
    objects: (o.objects || []).filter((x) => x.kind !== 'skeet'), // M2 marker, now a buyer
    plants: o.plants || [],
    product: o.product || [],
    player: o.player,
    economy: o.economy || initEconomy(o.time),
    heat: typeof o.heat === 'number' ? o.heat : 0,
    // Saves from before M4 have no heatState: start it fresh at the saved clock.
    heatState: o.heatState || initHeatState(o.time),
    threats: o.threats || initThreats(o.seed),
    entities: [],
    bullets: [],
    gameOver: o.gameOver || null,
    cops: [],
    patrolCar: null,
    tells: null,
    npcs: [],
    npcSeq: 0,
    nextId: o.nextId || 1,
    simTicks: o.simTicks || 0,
    dirtyChunks: new Set(),
    events: [],
  };
}

/**
 * Migration chain: one function per version bump (plan §B4). v1 is the
 * current schema; the chain is empty and grows with each future version.
 */
const MIGRATIONS = {
  // 1: (old) => ({ ...old, ... }), // example for a future version 2
};

export function migrate(o) {
  let v = o.version;
  while (v !== CONFIG.version && MIGRATIONS[v]) {
    o = MIGRATIONS[v](o);
    v = o.version;
  }
  return o;
}

// -------------------------------------------------------------- storage ---

/** Browser storage adapter; safe to import in Node (guarded access). */
export const browserStorage = {
  getItem(key) {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  },
  setItem(key, value) {
    if (typeof localStorage === 'undefined') throw new Error('localStorage unavailable');
    localStorage.setItem(key, value);
  },
  removeItem(key) {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
  },
};

/**
 * Save state into a slot. Never swallows a quota failure: returns
 * {ok:false, error} so the UI can offer Export (plan §B4).
 */
export function saveGame(state, key, storage) {
  const json = serializeState(state);
  if (json.length > CONFIG.limits.saveBytes) {
    state.events.push({ type: 'toast', msg: `Save is large (${(json.length / 1024) | 0} KB)` });
  }
  try {
    storage.setItem(key, json);
    return { ok: true, bytes: json.length };
  } catch (e) {
    return { ok: false, error: String(e), json };
  }
}

/** Load a slot; returns null when missing or corrupt (never throws). */
export function loadGame(key, storage) {
  const raw = storage.getItem(key);
  if (raw === null || raw === undefined) return null;
  return deserializeState(raw);
}

export function hasSave(key, storage) {
  return storage.getItem(key) !== null;
}

/**
 * Rolling dawn autosave: auto3 <- auto2 <- auto1 <- new (last 3 dawns kept).
 * A failed shift is ignored (old data stays put); the fresh write reports.
 */
export function autosave(state, storage) {
  const a2 = storage.getItem(autoKey(2));
  const a1 = storage.getItem(autoKey(1));
  try {
    if (a2 !== null) storage.setItem(autoKey(3), a2);
    if (a1 !== null) storage.setItem(autoKey(2), a1);
  } catch { /* rotation failure keeps the older saves */ }
  return saveGame(state, autoKey(1), storage);
}
