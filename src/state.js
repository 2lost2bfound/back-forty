// state.js — one plain JSON-serializable game state (plan §B4).
// M1 scope: newGame() only. save()/load()/migrate() arrive in M2.

import { CONFIG } from './config.js';
import { createRng } from './rng.js';
import { generateWorld } from './world/worldgen.js';
import { createPlayer } from './entities/player.js';

/**
 * Build a fresh run. The world is deterministic from the seed; the save's
 * rngState carries the PRNG so tests, the balance bot and replays are all
 * reproducible (plan §B3).
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
    tiles: world.grid,          // Uint8Array(24000); saved as RLE+base64 in M2
    surface: world.surface,     // derived data, not saved
    dirtyChunks: new Set(),     // runtime only (tile edits pending a chunk redraw)
    player,
    simTicks: 0,
    events: [],                 // sim pushes, UI/audio read once per frame (§B3)
  };
}
