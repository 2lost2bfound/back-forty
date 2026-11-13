// tiles.js — tile table, grid access, dig/place rules (plan §B5).
// Pure module: no window/document, runs unmodified in Node (plan §B3 rule).
//
// Tile ids (plan §B5): 0 air, 1 dirt, 2 grass, 3 stone, 4 bedrock, 5 wood wall,
// 6 wood platform, 7 concrete, 8 ladder, 9 road, 10 town-solid, 11 background
// wall. One Uint8Array(400*60) holds the world; index = y*400 + x.
//
// Digging rules (plan §B5): dirt 0.4 s, stone 1.5 s (pickaxe required).
// Digging returns dirt tiles (stack to refill holes); player-placed building
// tiles return themselves so the M1 sandbox is lossless. Times live in
// CONFIG.dig.times; nothing is inlined here.

import { CONFIG } from '../config.js';

export const T = {
  AIR: 0,
  DIRT: 1,
  GRASS: 2,
  STONE: 3,
  BEDROCK: 4,
  WOOD: 5,
  PLATFORM: 6,
  CONCRETE: 7,
  LADDER: 8,
  ROAD: 9,
  TOWN: 10,
  BGWALL: 11,
};

// Per-tile behaviour. digTime is filled from CONFIG.dig.times below.
const BASE_INFO = {
  [T.AIR]:      { name: 'air',      solid: false },
  [T.DIRT]:     { name: 'dirt',     solid: true,  diggable: true, drop: T.DIRT },
  [T.GRASS]:    { name: 'grass',    solid: true,  diggable: true, drop: T.DIRT },
  [T.STONE]:    { name: 'stone',    solid: true,  diggable: true, tool: 'pickaxe' }, // no drop
  [T.BEDROCK]:  { name: 'bedrock',  solid: true },
  [T.WOOD]:     { name: 'wood',     solid: true,  diggable: true, drop: T.WOOD },
  [T.PLATFORM]: { name: 'platform', solid: false, platform: true, diggable: true, drop: T.PLATFORM },
  [T.CONCRETE]: { name: 'concrete', solid: true,  diggable: true, drop: T.CONCRETE },
  [T.LADDER]:   { name: 'ladder',   solid: false, climb: true,    diggable: true, drop: T.LADDER },
  [T.ROAD]:     { name: 'road',     solid: true },
  [T.TOWN]:     { name: 'town',     solid: true },
  [T.BGWALL]:   { name: 'bgwall',   solid: false },
};

// Resolve dig times from config once (ids are the config keys).
export const INFO = BASE_INFO;
for (const [idStr, spec] of Object.entries(BASE_INFO)) {
  const id = Number(idStr);
  const time = CONFIG.dig.times[id];
  if (time !== undefined) spec.digTime = time;
}

// Tile ids the player can place in M1, and the inventory key each consumes.
export const PLACE_ITEMS = {
  [T.DIRT]: 'dirt',
  [T.WOOD]: 'wood',
  [T.LADDER]: 'ladder',
};

export function itemKeyFor(id) {
  return PLACE_ITEMS[id] || null;
}

export function tileInfo(id) {
  return INFO[id] || INFO[T.AIR];
}

export function isSolidId(id) {
  return !!(INFO[id] && INFO[id].solid);
}

export function isPlatformId(id) {
  return !!(INFO[id] && INFO[id].platform);
}

export function isClimbId(id) {
  return !!(INFO[id] && INFO[id].climb);
}

export function inBounds(tx, ty) {
  return tx >= 0 && tx < CONFIG.world.cols && ty >= 0 && ty < CONFIG.world.rows;
}

/** Grid access that is safe anywhere (out of bounds reads as air). */
export function tileAt(grid, tx, ty) {
  if (tx < 0 || tx >= CONFIG.world.cols || ty < 0 || ty >= CONFIG.world.rows) return T.AIR;
  return grid[ty * CONFIG.world.cols + tx];
}

/** Only the lot is a sandbox: 40 <= x < 140 (plan §A3). */
export function isEditableX(tx) {
  return tx >= CONFIG.world.zones.lotX0 && tx < CONFIG.world.zones.lotX1;
}

export function getTile(state, tx, ty) {
  return tileAt(state.tiles, tx, ty);
}

/** Chunk index for the dirty set (chunkTiles x chunkTiles tiles per chunk). */
export function chunkIndex(tx, ty) {
  const c = CONFIG.render.chunkTiles;
  return ((ty / c) | 0) * CONFIG.render.chunkCols + ((tx / c) | 0);
}

/** Write a tile and mark its chunk dirty for the renderer (max 2 redraws/frame). */
export function setTile(state, tx, ty, id) {
  if (!inBounds(tx, ty)) return false;
  state.tiles[ty * CONFIG.world.cols + tx] = id;
  state.dirtyChunks.add(chunkIndex(tx, ty));
  return true;
}

/**
 * Can this cell be dug? Returns { digTime, tool } or null. The caller (player)
 * owns the tool check, so digInfo only reports the requirement.
 */
export function digInfo(state, tx, ty) {
  if (!inBounds(tx, ty) || !isEditableX(tx)) return null;
  const spec = INFO[tileAt(state.tiles, tx, ty)];
  if (!spec.diggable) return null;
  return { digTime: spec.digTime, tool: spec.tool || null, drop: spec.drop || 0 };
}

/** Perform a dig: set the cell to air, return the drop id (0 = nothing). */
export function digTile(state, tx, ty) {
  const d = digInfo(state, tx, ty);
  if (!d) return 0;
  setTile(state, tx, ty, T.AIR);
  return d.drop;
}

/** Can tile `id` be placed into this cell? (air or background wall, lot only) */
export function canPlace(state, tx, ty, id) {
  if (!PLACE_ITEMS[id]) return false;
  if (!inBounds(tx, ty) || !isEditableX(tx)) return false;
  const cur = tileAt(state.tiles, tx, ty);
  return cur === T.AIR || cur === T.BGWALL;
}
