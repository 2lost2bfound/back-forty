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
    interactTiles: 2,          // E-interaction reach, in tiles
    tiredAfterGh: 30,          // awake more than 30 gh = Tired (plan §A3)
    tiredTendingMult: 1.2,     // tending 20% slower until you sleep
    // Starting kit: 4 seeds + the tools (plan §A3: 4 starting pots are placed
    // by worldgen; the watering can is assumed equipment, not sold anywhere).
    start: {
      dirt: 50, wood: 40, ladder: 10, pickaxe: true,
      seeds: 4, can: 1,
    },
    // Hotbar slots 1-8. Tile ids are raw numbers here (config.js must not
    // import tiles.js): 1 dirt, 5 wood, 8 ladder (plan §B5).
    hotbar: [
      { kind: 'item', key: 'can' },
      { kind: 'item', key: 'nutrients' },
      { kind: 'item', key: 'phkit' },
      { kind: 'item', key: 'pot' },
      { kind: 'item', key: 'rack' },
      { kind: 'tile', id: 1 },
      { kind: 'tile', id: 5 },
      { kind: 'tile', id: 8 },
    ],
  },

  // Clock (plan §A3, §B3): 12 real minutes = 24 game hours (1 gh = 30 s).
  // The game day rolls over at 06:00 (dawn: autosave, weather roll, M4 heat).
  clock: {
    secPerGh: 30,
    startDay: 1,
    startHour: 6,
    sunStart: 6,           // outdoor light window 06:00-20:00
    sunEnd: 20,
    wakeHour: 6,           // sleep runs until 06:00
    nightAlpha: 0.75,      // flat night tint at midnight (M2; lights arrive M4)
    duskHours: 2,          // 20:00-22:00 ramp up, 04:00-06:00 ramp down
  },

  // Sleep fast-forward (My Addition 7; alerts wired in M5).
  sleep: { speed: 20 },

  // Weather roll at 06:00 (plan §A3). M2 rolls the field only; rain and
  // heatwave effects on plants arrive with M4.
  weather: { rainChance: 0.2, heatwaveChance: 0.1 },

  // Grower mastery constants (plan §A10). mastery.js itself is M7; the harvest
  // formula already references the player level, so the per-level deltas live
  // here now. Level stays 1 throughout M2.
  mastery: {
    yieldPerLevel: 0.03,   // +3% yield per level above 1
    qualityPerLevel: 2,    // +2 quality per level above 1
    tendingPerLevel: 0.04, // -4% tending time per level above 1
  },

  // Strains (plan §A4). Shop seeds roll ±seedVariance per trait at purchase;
  // the starting seeds are the exact base strain so an ideally tended plant
  // hits the M2 test window (38-41 g, quality 38-42) for every seed.
  strains: {
    ditch: { name: 'Ditch Weed', Y: 25, P: 40, R: 80, S: 80, price: 20 },
  },
  genetics: { seedVariance: 3 },

  // Grow sim numbers (plan §A4).
  plants: {
    startMoisture: 50,     // fresh soil in a pot
    startNutrients: 50,
    freshSoilPh: 6.4,      // new soil starts at 6.4
    // Per-stage rates, per game hour (share-of-progress stage bounds below).
    moistureLoss: { seedling: 2.5, vegetative: 3.5, flowering: 4.5, ripe: 3.0, overripe: 3.0, rotten: 0 },
    nutrientUse:  { seedling: 0.5, vegetative: 1.5, flowering: 2.5, ripe: 0,   overripe: 0,   rotten: 0 },
    outdoorDayMoistureMult: 1.3,   // daytime sun (M4 adds lamp/rain terms)
    soilMoistureMult: { cheap: 1.0, potting: 0.85, living: 0.85 },
    soilPhBuffer:     { cheap: 1.0, potting: 0.6,  living: 0.3 },
    soilYieldMult:    { cheap: 1.0, potting: 1.0,  living: 1.05 },
    // Watering: one pour = +35; the can holds 8 pours; refill is a 1 s action.
    pourMoisture: 35, canCapacity: 8, refillSeconds: 1,
    tapPourPh: 0.1,        // tap water pushes pH up per pour
    barrelPourPh: 0,       // rain-barrel water is pH neutral
    barrelStartCharges: 40,// barrel pours available until rain refills it (M4)
    phPassiveDrift: 0.01,  // +0.01 per gh before the soil buffer
    nutrientDose: 30,      // one dose = +30 nutrients...
    nutrientDosePh: -0.2,  // ...and -0.2 pH
    phDose: 0.3,           // pH kit: ±0.3 per dose (Up or Down)
    // Ranges: ideal keeps health; outside stress bands damage starts.
    moistureIdeal:  { lo: 40, hi: 70 },
    moistureStress: { lo: 25, hi: 85 },
    phIdeal: { lo: 6.0, hi: 6.8 },
    phMild:  { lo: 5.5, hi: 7.3 },   // outside ideal but inside mild = lockout
    nutrientIdeal:  { lo: 40, hi: 80 },
    nutrientStress: { lo: 20, hi: 90 },
    // Stress damage per gh per stressor, before the resilience multiplier.
    stressDamage: { moisture: 3, phMild: 1, phSevere: 3, nutrientLow: 1.5, nutrientHigh: 2.5 },
    healthRegen: 1,        // +1 health per gh with zero stressors
    dieAtZeroMoistureGh: 6,// at moisture 0 for 6 gh straight the plant dies
    // Stages: progress shares and the ripe/overripe wall-clock windows.
    stageProgress: { veg: 0.15, flower: 0.5 },
    ripeWindowGh: 24, overripeWindowGh: 24,
    overripeQDropPerGh: 0.02, overripeQMin: 0.52,
    earlyHarvest: { from: 0.8, yield: 0.7, quality: 0.8 },
    // Yield/quality formula constants (plan §A4 Harvest).
    yieldBase: 20, yieldPerY: 0.8,
    healthYieldLo: 0.3, healthYieldSpan: 0.7,   // 0.3 + 0.7 * avgHealth/100
    growDaysBase: 9, growDaysPerS: 0.05, litHoursPerDay: 14,
    // Drying: 24 gh on a rack; wet sells at half price; rack holds 4 batches.
    dryHours: 24, rackCapacity: 4, wetPriceMult: 0.5,
    // Tending action times in seconds (plan §A4), before mastery/tired.
    actionSeconds: { water: 0.6, feed: 0.8, ph: 0.8, plant: 1, harvest: 2, refill: 1 },
  },

  // Economy (plan §A7). M2 scope: cash only, Skeet at a fixed price, the
  // hardware shop with seeds/pots/soil/nutrients/pH kit/meters/rack.
  economy: {
    startCash: 300,
    priceBase: 4, pricePerQuality: 0.1,   // $/g = 4 + 0.10 * quality
    skeet: { x: 265, open: 12, close: 22 },   // park, 12:00-22:00
    hardware: { building: 'hardware', open: 8, close: 18 }, // 08:00-18:00
    prices: {
      seeds: 20, pot: 10, soil_potting: 15, soil_living: 40,
      nutrients: 20, phkit: 10,
      moisture_meter: 30, ph_meter: 60, loupe: 25, rack: 50,
    },
    doses: { nutrients: 10, phkit: 10 },  // a bottle/kit contains this many doses
  },

  // Inventory items (display names for HUD/hotbar/menus).
  itemNames: {
    can: 'Watering can', seeds: 'Ditch Weed seeds', pot: 'Pot',
    soil_potting: 'Potting soil', soil_living: 'Living soil',
    nutrients: 'Nutrients', phkit: 'pH kit',
    moisture_meter: 'Moisture meter', ph_meter: 'pH meter', loupe: 'Loupe',
    rack: 'Drying rack', dirt: 'Dirt', wood: 'Wood', ladder: 'Ladder',
    pickaxe: 'Pickaxe',
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
    // Alt overlay (My Addition 6): moisture/pH/nutrient bars over every plant.
    alt: {
      moisture: '#4a9de0',
      ph: '#7ac74f',
      nutrients: '#e0c04a',
      stress: '#e6194b',
      barW: 14, barH: 2, barGap: 3,
    },
  },

  // HUD/menus (plan §B7: DOM over the canvas, 4 Hz dirty-checked updates).
  ui: {
    updateHz: 4,
    toastMax: 4,
    toastSeconds: 3.5,
  },
};
