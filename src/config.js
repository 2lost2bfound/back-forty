// config.js — EVERY tunable number in plan.md lives here, grouped by system.
// Never inline a number in game code; add it here instead.
// Milestone M1: engine constants, loop budgets, perf limits, world, physics,
// player, digging and render numbers.

export const CONFIG = {
  version: 1,

  dev: {
    // Default seed for the PRNG in dev builds (tests and the balance bot
    // create their own seeds; the save carries the run's rngState).
    seed: 1337,
  },

  canvas: {
    width: 800,            // internal resolution, never resized
    height: 450,
    cssScale: 2,           // CSS-scaled to 1600x900
  },

  loop: {
    physicsHz: 60,         // fixed movement step
    simHz: 2,              // simulation tick (1 tick = 1/60 game hour)
    maxFrameDt: 0.1,       // clamp: tab was hidden
    maxPhysicsStepsPerFrame: 5,   // spiral-of-death guard
    maxSimStepsPerFrame: 10,
  },

  // Hard limits from plan §B2, enforced in code at every milestone.
  limits: {
    entities: 40,          // active simulated+drawn NPCs/player/dog
    plants: 60,            // static sprites, sim at 2 Hz
    bullets: 32,           // pooled
    particles: 150,        // pooled, includes rain
    softLights: 12,
    drawImagePerFrame: 400,
    pathNodes: 4000,
    saveBytes: 200 * 1024,
  },

  perf: {
    targetFps: 60,
    frameBudgetMs: 16.6,
    jsBudgetAvgMs: 6,      // JS time per frame, average
    jsBudgetWorstMs: 10,   // JS time per frame, worst
    gateAvgMs: 12,         // F4 stress-gate limit (plan §B2)
    gateWorstMs: 20,
    overlayHz: 4,          // perf overlay update rate (DOM, dirty-checked)
    frameHistory: 120,     // samples for avg/max frame ms
  },

  // F4 stress scene (plan §B2 perf gate; dev builds only).
  stress: {
    rectangles: 2000,      // moving test rectangles that must hold 60 fps
    speedMin: 40,          // px/s, random per rectangle
    speedMax: 140,
    colors: [
      '#e6194b', '#3cb44b', '#ffe119', '#4363d8',
      '#f58231', '#911eb4', '#46f0f0', '#f032e6',
    ],
    rectSize: 6,           // px, square
  },

  // World layout (plan §B5, §A3). One authored world, no procedural generation.
  world: {
    tile: 16,              // px per tile
    cols: 400,
    rows: 60,              // 6400 x 960 px, one Uint8Array(24000)
    surfaceRow: 20,        // nominal surface (±1 variation in woods + lot)
    stoneRow: 34,          // stone from here down
    bedrockRow: 58,        // bedrock rows 58-59
    variationSegment: 8,   // surface height may step once per this many tiles
    variationChance: { woods: 1, lot: 0.3 }, // per-segment chance the height steps at all
    // Zones (plan §A3): only the lot is editable.
    zones: { lotX0: 40, lotX1: 140, roadX0: 140, roadX1: 220, townX0: 220 },
    // Buildings stamped from tile templates: x, total width and height in
    // tiles, wall tile char. Positions are the plan §A3 x anchors.
    buildings: [
      { key: 'shack',     x: 48,  w: 10, h: 6, wall: 'wood' },
      { key: 'walts',     x: 166, w: 12, h: 7, wall: 'wood' },
      { key: 'hardware',  x: 236, w: 16, h: 7, wall: 'town' },
      { key: 'bar',       x: 286, w: 12, h: 6, wall: 'town' },
      { key: 'clinic',    x: 312, w: 12, h: 6, wall: 'concrete' },
      { key: 'pawn',      x: 332, w: 10, h: 6, wall: 'town' },
      { key: 'alley',     x: 348, w: 8,  h: 5, wall: 'town' },
      { key: 'townhall',  x: 366, w: 16, h: 8, wall: 'town' },
      { key: 'motel',     x: 386, w: 14, h: 6, wall: 'concrete' },
    ],
    spawnTileX: 61,        // on the surface, just right of the shack door
  },

  // Digging rules (plan §B5). Keys are tile ids; unlisted tiles are not
  // diggable (bedrock, road, town-solid, background wall).
  dig: {
    times: {
      1: 0.4,              // dirt
      2: 0.4,              // grass (digs like dirt, returns dirt)
      3: 1.5,              // stone (pickaxe required, returns nothing)
      5: 0.4,              // wood (player-placed: returns itself)
      6: 0.15,             // platform
      7: 0.8,              // concrete
      8: 0.1,              // ladder
    },
  },

  // Physics (plan §B5): AABB vs tiles, no slopes, no falling dirt.
  physics: {
    gravity: 900,          // px/s^2
    jumpVel: 300,          // px/s; clears 3 tiles (300^2 / (2*900) = 50 px)
    maxFallSpeed: 480,
    walkSpeed: 90,         // px/s (plan §A3)
    sprintSpeed: 140,      // px/s
    climbSpeed: 80,        // px/s on ladders
    subStepPx: 8,          // max movement per collision sub-step
    eps: 0.01,             // separation gap from tile faces
  },

  // Player (plan §B5 box, §A9 stamina table).
  player: {
    w: 12,                 // px, hitbox
    h: 22,
    staminaMax: 100,
    sprintStaminaDrain: 10,    // per second sprinting
    staminaRegen: 15,          // per second not sprinting
    sprintMinStamina: 5,       // exhausted until back above this
    dropThroughS: 0.25,        // S-press window for dropping through platforms
    digReachTiles: 5,          // max distance from player centre to the target cell
    // Starting kit for the M1 sandbox (real starting inventory arrives with
    // shops in M2/M3; tools are always owned from M1 on for dev convenience).
    start: { dirt: 50, wood: 40, ladder: 10, pickaxe: true },
  },

  // Rendering (plan §B7).
  render: {
    chunkTiles: 16,        // 16x16 tiles = 256x256 px chunks, 25x4 = 100 canvases
    chunkCols: 25,         // ceil(400 / 16)
    chunkRows: 4,
    maxChunkRedrawsPerFrame: 2,
    cameraLagS: 0.15,      // follow lag (plan §B7)
    atlasSize: 512,
    skyTop: '#6fb0dd',     // fixed noon gradient for M1 (clock arrives in M2)
    skyBottom: '#cfe8f7',
    hills: {
      w: 1600,             // pre-rendered 1600x200, scrolled at 0.3x
      h: 200,
      scroll: 0.3,
      layers: [            // back to front: sine hill bands
        { color: '#7f9fb4', base: 60,  amp: 18, freq: 0.008,  phase: 0.0 },
        { color: '#5f8a6e', base: 110, amp: 26, freq: 0.005,  phase: 2.1 },
        { color: '#3f6a4e', base: 160, amp: 34, freq: 0.0032, phase: 4.4 },
      ],
    },
  },
};
