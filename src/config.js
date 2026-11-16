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
    exposeGlobals: true,   // window.__perf / window.__dev for the browser harness
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
    gateAvgMs: 12,         // F4 stress-gate limit (plan §B2), on per-frame WORK time
    gateWorstMs: 20,
    overMs: 20,            // a frame whose work exceeds this counts in `over20`
    dropFactor: 1.5,       // dropped frame: interval > this x the display interval
    overlayHz: 4,          // perf overlay update rate (DOM, dirty-checked)
    frameHistory: 120,     // rolling-window samples for avg/max (work and interval)
  },

  // F4 stress scene (plan §B2 perf gate; dev only): the real systems at the
  // plan's load, spawned near the camera. Time is pinned to `hour` (night, long
  // lamp timers lit) and the rain draws regardless of the weather roll.
  stress: {
    entities: 40,          // inert 'stress' entities walking back and forth
    plants: 60,            // total plants alive (existing ones count)
    particles: 150,        // rain streaks (the pool's full 150)
    lights: 12,            // lamps lit inside the view
    hour: 22.5,            // pinned clock: full night, 18 h lamps on
    lampType: 'lamp_cfl',
    lampHours: 18,
    strain: 'ditch',
    spanTiles: 50,         // pots/lamps/entities spawn across this many tiles from the camera
    speedMin: 20,          // px/s entity walk speed
    speedMax: 60,
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
    h: 44,                 // 2 tiles + 12 px: needs 3 tiles of headroom (art is 48 px tall)
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
  weather: {
    rainChance: 0.2, heatwaveChance: 0.1,
    rollHour: 6,             // the roll happens at 06:00 (plan §A3)
    rainDurationGh: 6,       // rain runs 06:00-12:00 on a rain day
    rainMoistureGh: 4,       // outdoor plants +4 moisture per gh in rain
    rainBarrelPerGh: 8,      // rain refills the barrel (pours per gh)...
    barrelMax: 80,           // ...up to this many
    heatwaveMoistureMult: 1.5, // outdoor moisture loss x1.5 in the sun window
    rainNoiseMult: 0.7,      // footstep/gunshot noise radius -30% (used by M5)
    rainParticles: 80,       // rain streaks inside the 150-particle budget
  },

  // Lamps (plan §A4 Light). Pots = how many nearest pots one lamp lights,
  // radius in tiles, factor = light multiplier, heat = per day on a 14 h timer.
  lamps: {
    onHour: 6,               // timers start at 06:00 (same dawn as the sun)
    hoursNormal: 14, hoursLong: 18, longHeatMult: 2,
    types: {
      lamp_cfl: { pots: 2, radius: 2, factor: 0.7, heat: 0.10 },
      lamp_hps: { pots: 4, radius: 3, factor: 1.0, heat: 0.40 },
      lamp_led: { pots: 4, radius: 3, factor: 1.1, heat: 0.15 },
    },
  },

  // Heat (plan §A5). Heat is 0-100 with a floor it can never drop below.
  heat: {
    floorStart: 0,
    decay: { low: 3, high: 1.5 },        // per day: Cold/Warm, Hot/Burning
    layLowMult: 2,                       // a day with zero sales doubles decay
    farmStandDecay: 2,                   // extra per day with a farm-stand front (M10 sets it)
    visiblePlant: 0.3,                   // per plant visible from the road, per day
    smell: { indoor: 0.2, outdoor: 0.1, rack: 0.5 }, // flowering/drying, unfiltered, per day
    filterRadius: 6,                     // tiles; carbon filter removes smell heat
    bigGrow: [{ over: 30, heat: 3 }, { over: 12, heat: 1 }], // first match wins
    flashy: { limit: 2000, heat: 3 },    // dirty cash spent in one day
    // One-off sources other milestones call through heatEvent(state, key).
    events: {
      runnerBusted: 10, runnerSnitch: 20, patrolStop: 10,
      killCriminal: 8, killCivilian: 40, collapse: 5, rivalTip: 15, rivalTipBribed: 8, favor: -1,
      shootOfficer: 50, edibleSale: 1,
      gunshotLot: { per: 1, max: 8, suppressed: 0.25 },
      gunshotTown: { per: 4, max: 20, suppressed: 4 },
    },
    shootOfficerFloor: 25,               // heatFloor +25 permanently
    runnerDelivery: { base: 0.5, disc: 1.5 }, // 0.5 x (1.5 - Discretion/100)
    bribe: { minDay: 6, amount: 15, cost: 500, costStep: 250, cooldownDays: 5 },
    afterRaid: { found: 30, nothing: 40 },
    raid: {
      minDay: 6,                         // no raids before day 6 (plan §A3)
      rollHour: 5, warnHour: 3, tipHour: 23, tipWindowDays: 5,
      hot: { from: 50, perPoint: 0.012 },
      burning: { from: 75, base: 0.30, perPoint: 0.028 },
      lawyerChanceMult: 0.75,
      copsHot: 4, copsBurning: 6,
      arriveGh: 0.5,                     // van parks, cops walk to the lot
      hatch: { base: 0.30, heatFrom: 50, perHeat: 0.01, k9: 0.20, snitch: 0.30 },
      k9FromHeat: 75,                    // K-9 unit joins at Burning
      safeOpen: 0.5, stashFind: 0.10,
      cashSeize: 0.5, finePerPlant: 50,
      arrestPlants: 20, arrestGrams: 450,
      lawyerThresholdMult: 1.5, lawyerFineMult: 0.5,
      bail: [1500, 3000], bailDays: 1, jailDays: 4, maxArrests: 3,
    },
    patrol: {                            // town stops (plan §A5)
      hours: { from: 8, to: 20 },
      copsBurning: 2, copsOther: 1,
      speed: 20,                         // px/s along the town strip
      x0: 225, x1: 395,
      minGrams: 100, rangeTiles: 6,
      chance: [0.02, 0.06, 0.15, 0.30],  // Cold, Warm, Hot, Burning
      duffelMult: 1.5, coolGh: 6,
      fine: 200, arrestGrams: 448,
    },
    tells: {
      carPerDay: [0, 1, 3, 3],           // patrol car passes the road, by tier
      carHours: [14, 9, 18],             // pass times (first N used)
      carSpeed: 60,                      // px/s
      helicopterHour: 20.5,              // Hot and above
      unmarkedCarX: 150,                 // parked across the road (Burning)
    },
    rumor: [                             // (max chance, words)
      [0, 'Nothing is stirring tonight.'],
      [0.15, 'Could be a quiet night.'],
      [0.40, 'The deputy looked jumpy.'],
      [0.70, 'Word is they are coming soon.'],
      [1.01, 'They are coming tonight. Bet on it.'],
    ],
    peopleTalking: 'The bartender mutters: "People are talking."',
    logMax: 60,
  },

  // Grower mastery (plan §A10): XP per harvest, level table, perks, journal.
  mastery: {
    yieldPerLevel: 0.03,   // +3% yield per level above 1
    qualityPerLevel: 2,    // +2 quality per level above 1
    tendingPerLevel: 0.04, // -4% tending time per level above 1
    xpBase: 0.5,           // XP = dry grams x (xpBase + quality/100)
    levelXp: [0, 80, 200, 400, 700, 1100, 1800, 2800, 4200, 6000], // total XP for L1..L10
    // Perks by the level that grants them.
    perks: {
      3: 'Exact moisture without a meter; Blue Haze seeds',
      5: 'Exact hours-to-ripe without a loupe; Widow Kush seeds; license inspection eligible',
      6: 'Breeding unlocked',
      7: 'Clones always root',
      9: 'Ripe window 36 gh',
      10: 'Stress damage -20%',
    },
    exactMoistureLevel: 3, exactRipeLevel: 5, cloneRootLevel: 7, ripeWindowLevel: 9, stressLevel: 10,
    ripeWindowGh: 36,      // L9 perk (base 24 in plants.ripeWindowGh)
    stressDamageMult: 0.8, // L10 perk
    cloneRootChance: 0.85, // below L7
    breedingLevel: 6,      // L6 perk: breeding unlocked
    journalMax: 20,        // harvests kept in the grower's journal
  },

  // Strains (plan §A4). Shop seeds roll ±seedVariance per trait at purchase;
  // the starting seeds are the exact base strain so an ideally tended plant
  // hits the M2 test window (38-41 g, quality 38-42) for every seed.
  // `item` is the inventory key of the strain's seeds; `unlock` is the plan's
  // rule: {day} or {level} (either one), {level} only for Widow Kush.
  strains: {
    ditch: { name: 'Ditch Weed', Y: 25, P: 40, R: 80, S: 80, price: 20, item: 'seeds', maleItem: 'seeds_male_ditch' },
    blue: { name: 'Blue Haze', Y: 50, P: 60, R: 60, S: 60, item: 'seeds_blue', maleItem: 'seeds_male_blue', unlock: { day: 8, level: 3 } },
    widow: { name: 'Widow Kush', Y: 75, P: 80, R: 40, S: 20, item: 'seeds_widow', maleItem: 'seeds_male_widow', unlock: { level: 5 } },
  },
  // Clones (plan §A10 Clone generations) and seed variance.
  genetics: {
    seedVariance: 3,
    cloneUpChance: 0.6,    // +1 with 0.6 x mother's care
    cloneDownChance: 0.4,  // else -1 with 0.4 x (1 - care)
    cloneCap: 15,          // max gain over the strain's base per trait via cloning
    cloneSeconds: 1.5,     // the cut takes 1.5 s
    cloneMotherDamage: 5,  // mother loses 5 health
    cloneStartProgress: 0.15, // cutting skips the seedling stage
    traitMax: 100,
    // Breeding (plan §A11, M11).
    breeding: {
      maleChance: 0.5,        // bred seeds are 50% male (shop seeds never are)
      sacProgress: 0.55,      // males show pollen sacs from 55% progress
      loupeProgress: 0.40,    // ...but with a loupe you can tell from 40%
      pollinateTiles: 6,      // an unculled male pollinates every flowering female within 6 tiles
      accidentalYield: 0.5, accidentalQuality: 0.6, // the mistake's price
      crossYield: 0.3,        // a crossed female gives bud at x0.3...
      seedsBase: 6, seedsPerHealth: 20, // ...plus 6 + floor(health/20) seeds
      noise: 8,               // child trait = lerp(mother, father, u) + noise in +-8 x (1 - stability)
      f1Stability: 0.2, stabilityStep: 0.2, // new line 0.2; +0.2 per same-line generation
      inbreedResilience: 2,   // each same-line generation: -2 Resilience
      nameStability: 0.8, nameMax: 16,      // register a line at 0.8+; 16 characters
      pollinateSeconds: 1.5, collectSeconds: 1.5,
      // Selling the line.
      namedTrust: 3, namedBonus: 0.15, hypeMaxBonus: 0.30, // trust 3+: +15%; up to +30% at hype 100
      hypeGramsPer: 100, hypeMax: 100,                      // +1 hype per 100 g sold
      seedPackBase: 50, seedPackDivisor: 200, seedPacksPerDay: 10, // $50 x (Y+P+R+S)/200 each, 10 a day
    },
  },
  // The Harvest Cup (Legacy mode, plan §A11/§A14): judged every 28 days.
  // Edibles (M12, post-license). Prices are per unit: base x (0.5 + quality/100) x channel x named bonus.
  edibles: {
    stovePrice: 1500,
    recipes: {
      brownies:  { name: 'Brownies',       grams: 7,  cost: 20, gh: 4, units: 10, price: 12 },
      gummies:   { name: 'Gummies',        grams: 5,  cost: 15, gh: 6, units: 20, price: 5 },
      chocolate: { name: 'Chocolate bars', grams: 10, cost: 30, gh: 3, units: 8,  price: 18 },
    },
    qualityBase: 0.5, qualityDiv: 100,
    dispensary: { mult: 1.0, perDay: 40 },       // town hall, bank, no heat
    buyer: { mult: 1.25, perDay: 10, trust: 2 }, // each revealed buyer, dirty cash, heat edibleSale
    namedBonus: 0.15,                            // dispensary always; buyers at trust namedTrust (genetics.breeding)
  },
  cup: { everyDays: 28, judgeHour: 12, grams: 28, sumMin: 320, stability: 1 },

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
    stressDamage: { moisture: 3, phMild: 1, phSevere: 3, nutrientLow: 1.5, nutrientHigh: 2.5, noLight: 2, pest: 3, poisoned: 3 },
    pest: { spreadGh: 12, spreadTiles: 2 }, // mites jump to the nearest plant within 2 tiles every 12 gh
    darkStressGh: 24,      // indoor plant with no light this long takes stress
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
    actionSeconds: { water: 0.6, feed: 0.8, ph: 0.8, plant: 1, harvest: 2, refill: 1, neem: 1 },
  },

  // Economy (plan §A7). M3: five buyers, orders, trust, discovery, street
  // sales, every shop's stock and hours.
  economy: {
    startCash: 300,
    priceBase: 4, pricePerQuality: 0.1,   // $/g = 4 + 0.10 * quality
    // Shops: the building whose right wall is the door, and opening hours
    // (open > close wraps past midnight). Plan §A3 schedule.
    hardware: { building: 'hardware', label: 'Hardware store', open: 8, close: 18 },
    walt:     { building: 'walts',    label: "Walt's farm",    open: 6, close: 20 },
    pawn:     { building: 'pawn',     label: 'Pawn shop',      open: 10, close: 20 },
    clinic:   { building: 'clinic',   label: 'Clinic',         open: 8, close: 18 },
    townhall: { building: 'townhall', label: 'Town hall',      open: 9, close: 17 },
    bar:      { building: 'bar',      label: 'Bar',            open: 16, close: 2 },
    alley:    { building: 'alley',    label: 'Moss (alley)',   open: 21, close: 4 },
    alleyGunMarkup: 0.5,                  // unregistered guns cost +50%
    prices: {
      seeds: 20, seeds_blue: 60, seeds_widow: 150, pot: 10,
      seeds_male_ditch: 30, seeds_male_blue: 90, seeds_male_widow: 225, // L6: guaranteed-male seeds to start breeding
      soil_potting: 15, soil_living: 40,
      nutrients: 20, phkit: 10, pollenkit: 150,
      moisture_meter: 30, ph_meter: 60, loupe: 25, rack: 50,
      neem: 15, lamp_cfl: 80, lamp_hps: 300, lamp_led: 700, drip: 400,
      filter: 200, generator: 900, wood: 2, concrete_tile: 5, ladder: 5,
      door: 20, padlock: 50, deadbolt: 200, steeldoor: 800, dog: 300, hatch: 600, stash: 80, tripwire: 30, floodlight: 120,
      camera: 250, pickaxe: 80, cart: 150, bicycle: 200, duffel: 100,
      barrel_lock: 40, truce: 2000,
      bat: 40, pistol22: 350, pistol9: 700, shotgun: 1200, rifle: 2000,
      ammo_22: 10, ammo_9: 15, ammo_shell: 15, ammo_rifle: 16,
      scanner: 250, safe: 500, bandage: 20, suppressor: 900,
      drink: 5, rumor: 20, ask_around: 50, crank: 30, blues: 20,
      heal: 100, vet: 150, detox: 1500, taper: 100,
      lawyer: 200, permit: 3000, bribe: 500,
      whiskey: 30, beer: 6, coffee: 4, bike_parts: 30,   // ally gifts (M9)
    },
    doses: { nutrients: 10, phkit: 10, pollenkit: 4 },  // a bottle/kit contains this many doses
    // Items bought in packs: inventory units granted per purchase.
    packs: { ammo_22: 10, ammo_9: 10, ammo_shell: 5, ammo_rifle: 4 },
    // Stock per shop (menu order). `service` entries are paid for but not
    // carried (their effects arrive with the milestones that own them);
    // `unreg` marks alley guns.
    stock: {
      hardware: ['seeds', 'seeds_blue', 'seeds_widow', 'seeds_male_ditch', 'seeds_male_blue', 'seeds_male_widow', 'pot', 'soil_potting', 'soil_living', 'nutrients', 'phkit',
        'moisture_meter', 'ph_meter', 'loupe', 'rack', 'neem', 'pollenkit', 'lamp_cfl', 'lamp_hps',
        'lamp_led', 'drip', 'filter', 'generator', 'wood', 'concrete_tile',
        'ladder', 'door', 'padlock', 'deadbolt', 'steeldoor', 'hatch', 'stash', 'tripwire', 'floodlight', 'camera',
        'pickaxe', 'cart', 'bicycle', 'duffel', 'barrel_lock', 'coffee', 'bike_parts', 'stove'],
      pawn: ['bat', 'pistol22', 'pistol9', 'shotgun', 'rifle', 'ammo_22', 'ammo_9',
        'ammo_shell', 'ammo_rifle', 'scanner', 'safe', 'bandage'],
      walt: ['dog'],
      alley: ['crank', 'blues', 'pistol22', 'pistol9', 'shotgun', 'rifle', 'suppressor'],
      bar: ['drink', 'rumor', 'ask_around', 'bribe', 'truce', 'beer', 'whiskey'],
      clinic: ['heal', 'vet', 'detox', 'taper'],
      townhall: ['lawyer', 'permit'],
    },
    unregStock: ['pistol22', 'pistol9', 'shotgun', 'rifle'],
    services: ['dog', 'drink', 'rumor', 'ask_around', 'bribe', 'heal', 'vet', 'detox', 'taper', 'lawyer', 'permit', 'truce'],

    // Carry limits (plan §A5 patrol stops): grams of product on you.
    carry: { backpack: 500, duffel: 2000 },
    // Bicycle (plan §A3, My Addition 10).
    bikeSpeed: 220,

    // Trust (plan §A7). Level = number of thresholds reached.
    trust: {
      thresholds: [10, 30, 60, 100, 150],
      priceMult: [0.8, 0.9, 1.0, 1.1, 1.2, 1.3],
      full: 40, qualityBonus: 14, qualityBonusOver: 20,
      partial: 3, partialMin: 0.5, late: 0, missed: -15,
    },
    lateGraceGh: 12,
    // Missed orders (plan §A7).
    miss: {
      smallerMult: 0.75,
      streakDormantDays: 6, streakLevelDrop: 1,
      repeatCount: 3, repeatWindowDays: 10, repeatDormantDays: 10,
      skeetMaxDormantDays: 2,
      toneFee: 500,
      daleAggression: 5,
    },
    firstOrderDelayGh: 12,     // newly discovered buyer's first order
    returnDelayGh: 12,         // returning buyer's first order
    // Buyers (plan §A7 table). x is the tile the buyer stands on; open/close
    // wrap past midnight. weekdays: only on days where day % 7 is listed.
    buyers: {
      skeet:  { name: 'Skeet', where: 'park', x: 267, open: 12, close: 22,
        min: 14, max: 28, everyDays: 2, minQ: 20, mod: 1.0, deadlineGh: 24,
        start: true, firstOrderGh: 144, heat: true },
      marla:  { name: 'Marla', where: 'bar', x: 284, open: 16, close: 2,
        min: 56, max: 112, everyDays: 3, minQ: 35, mod: 1.0, deadlineGh: 24, heat: true },
      doc:    { name: 'Doc Renner', where: 'clinic back door', x: 328, open: 18, close: 21,
        min: 84, max: 168, everyDays: 4, minQ: 55, mod: 1.15, deadlineGh: 24, heat: false },
      tone:   { name: 'Big Tone', where: 'alley garage', x: 346, open: 14, close: 24,
        min: 224, max: 448, everyDays: 5, minQ: 40, mod: 0.9, deadlineGh: 48, heat: true, dale: true },
      vivian: { name: 'Vivian', where: 'motel', x: 386, open: 20, close: 3,
        min: 448, max: 900, everyDays: 7, minQ: 60, mod: 1.0, deadlineGh: 48, heat: true, dale: true,
        weekdays: [5, 6, 0] },
    },
    // Referral: `from` gives you `to` at trust level `level` (0 heat).
    referrals: [
      { from: 'skeet', level: 2, to: 'marla' },
      { from: 'marla', level: 3, to: 'doc' },
      { from: 'marla', level: 4, to: 'tone' },
      { from: 'tone',  level: 3, to: 'vivian' },
    ],
    // Heat per sale by trust level 0-1 / 2-3 / 4-5 (plan §A5).
    saleHeat: [2, 2, 1, 1, 0.5, 0.5],
    heatTiers: [25, 50, 75],               // Cold / Warm / Hot / Burning
    heatMax: 100,
    // Discovery.
    barDrinksToTalk: 3,                    // 3 drinks and a chat reveals Marla
    askAround: { cost: 50, heat: 4, minGh: 24, maxGh: 48 },
    // Street sales (plan §A7): per-pedestrian interest, size, price, heat.
    street: { interest: 0.2, minG: 3.5, maxG: 14, mod: 1.0, heat: 3,
      undercover: [0.02, 0.05, 0.10, 0.20], undercoverHeat: 12 },
    ledgerMax: 100,
    // Pedestrians (npc.js / spawn.js): town zone, hours, cap, walk speed.
    peds: { x0: 225, x1: 395, cap: 8, speed: 25, spawnChance: 0.15,
      open: 7, close: 22, reach: 2 },
  },

  // Weapons (plan §A9). melee weapons have reach (px) and stamina cost per swing;
  // guns have mag, range (tiles), ammo item key and noise radius (tiles).
  weapons: {
    order: ['fists', 'bat', 'pistol22', 'pistol9', 'shotgun', 'rifle'],
    fists:    { melee: true, dmg: 5,  rate: 2.5, reach: 22, knock: 0,  stamina: 12 },
    bat:      { melee: true, dmg: 18, rate: 2,   reach: 28, knock: 40, stamina: 12 },
    pistol22: { dmg: 14, rate: 3,   mag: 10, range: 18, ammo: 'ammo_22',    noise: 25, pellets: 1, pistol: true },
    pistol9:  { dmg: 22, rate: 3,   mag: 12, range: 22, ammo: 'ammo_9',     noise: 35, pellets: 1, pistol: true },
    shotgun:  { dmg: 9,  rate: 1,   mag: 5,  range: 9,  ammo: 'ammo_shell', noise: 50, pellets: 6, pelletSpread: 12, perShell: true },
    rifle:    { dmg: 60, rate: 0.7, mag: 4,  range: 40, ammo: 'ammo_rifle', noise: 60, pellets: 1 },
  },

  // Combat rules (plan §A9, §B6).
  combat: {
    playerHp: 100,
    bulletSpeed: 600,        // px/s
    spreadStand: 2, spreadMove: 6, withdrawalMult: 2, drunkMult: 1.3, // degrees
    reloadSeconds: 1.5, reloadPerShell: 0.5,
    suppressorDiv: 3,        // noise radius divisor (pistols only)
    bandage: { hp: 30, seconds: 5 },
    koSeconds: 20,           // a knocked-out enemy crawls off after this long
    crouchHeadDrop: 10,      // px the head drops while crouched
    crouchFireGraceS: 1,     // firing breaks cover for this long
    bodyW: 12, bodyH: 44,    // human hitbox (matches the player)
    pedW: 8, pedH: 14,
    shotLandTiles: 2,        // a landing shot this near a thief may scare it
    incidentGapGh: 0.5,      // shots closer than this belong to one incident
    dispatch: { heat: 50, shots: 6, delayGh: 3, cops: 2, stayGh: 6, offsetTiles: 6 }, // 90 s = 3 gh
    downed: { cashLoss: 0.3, bill: 300, wakeHp: 50, haulMult: 2 },
    officerAimPx: 24,        // aiming this close to a cop triggers the warning
    cop: { hp: 100, dmg: 15, accuracy: 0.7, rate: 1, rangeTiles: 14 },
    weaponsFine: 1000,       // registered gun found in a raid
  },

  // Threats: event director, thieves, security (plan §A3, §A6, §A9).
  threats: {
    director: { minNight: { thief: 4, raid: 6, rival: 8 }, keep: 6 },
    breakIn: {
      rollHour: 1,
      valuePerPct: 200,      // +1% per $200 of product on site
      perRipePlant: 1, perStreetSale: 3, streetSaleDays: 3, generator: 10,
      min: 0, max: 60,
      cut: { lock: 5, floodlight: 5, floodlightMax: 2, camera: 5, dog: 15, guard: 20 },
    },
    thief: {
      hp: 60, speed: 100, knife: 15, knifeRate: 1, knifeReach: 20,
      pistolDay: 20, pistolChance: 0.3, pistolDmg: 12, pistolAcc: 0.5, pistolRate: 1, pistolRangeTiles: 12,
      twoDay: 20, twoChance: 0.3,
      fleeHpFrac: 0.5, fleeBitten: 0.6, fleeShot: 0.5,
      haulGrams: 200, uprootCount: 2, uprootSeconds: 5, grabSeconds: 3,
      hatchFind: 0.25,
      spawnX0: 4, spawnX1: 34, escapeX: 2,   // tiles: where they appear / count as gone
      doorOffsetTiles: 1,                    // stands this far outside the door
      lockSeconds: { none: 0, padlock: 15, deadbolt: 40, steeldoor: 90 },
    },
    locks: ['padlock', 'deadbolt', 'steeldoor'],   // worst to best
    wordOfMouth: { cut: 10, nights: 5 },           // KO'd thief spreads the word
    feud: { nights: 3, thieves: 2 },
    biker: { hp: 80, nights: 0 },                  // refused collection fee: tonight's 01:00
    camera: { max: 4, coneTiles: 8, shackTiles: 10 },
    floodlight: { radiusTiles: 8 },
    tripwire: { },
    dog: {
      hp: 50, bite: 10, speed: 110, barkTiles: 12, biteReach: 18, homeTiles: 3,
      food: 10, hungryDays: 2, thiefBiteStagger: 0.6,
    },
    fugitive: { hour: 6 },
    // Rival: Dale Pruitt (plan §A6). Aggression 0-100; the nightly roll at 23:00.
    rival: {
      start: 10, max: 100, rollHour: 23, chancePerPoint: 0.5, maxChance: 50, // percent
      dailyAfterDay: 10, trust3Bump: 2, defectBump: 10, beatSaboteur: -20, beatGoons: -20,
      tribute: { cost: 300, drop: 10, everyDays: 7 },
      truce: { cost: 2000, minAggression: 60, setTo: 10, frozenDays: 10 },
      mix: { poison: 0.4, tip: 0.3 },     // the rest is the pest jar
      saboteur: { hp: 50, speed: 100, seenTiles: 8, poisonSeconds: 10, pestSeconds: 4, barrelLockSeconds: 20 },
      poison: { pours: 8, ph: 1.0, stressGh: 6 },
      goon: {
        from: 70, chance: 0.25, count: 2, hp: 80, dmg: 12, acc: 0.55, rate: 1, speed: 90,
        rangeTiles: 12, smashSeconds: 3, maxPots: 6, backOffSquads: 3, backOffDays: 10,
      },
    },
  },

  // Crew (plan §A8): six candidates, four seats, wages at 20:00, loyalty.
  crew: {
    max: 4, candidates: 6, boardVisible: 2, boardRotateDays: 3, revealDays: 3, payHour: 20,
    names: ['Dusty', 'Lou', 'Marcy', 'Pete', 'Rosa', 'Cal', 'Nell', 'Tuck', 'Ines', 'Walt Jr.', 'Bo', 'Fern'],
    statMin: 10, statMax: 90, adjectiveSplit: 50,
    adjectives: { rel: ['flaky', 'dependable'], disc: ['chatty', 'careful'], greed: ['modest', 'hungry'], nerve: ['jumpy', 'cool'] },
    startLoyalty: 50, wage: { runner: 60, guard: 120, gardener: 90 }, runnerCut: 0.05, dockWageMult: 0.8,
    loyalty: { paid: 2, bonus: 5, unpaid: -15, withdrawal: -10, raid: -5, crewBusted: -8, threatened: -20, dock: -10, bail: 10 },
    bonus: { cost: 100, everyDays: 3 },
    runner: {
      speed: 90, bustBase: 1, bustHeatDiv: 10, bustDisc: 150, heavyG: 200, heavyMult: 1.5, snitchBelow: 40,
      lateDiv: 4, robG: 300, robChance: 0.05, hurtDays: 2, bail: 800, jailDays: 5, jailLoyalty: -30, goneBelow: 20,
      skimMin: 0.05, skimMax: 0.15, threatenDays: 10, threatenQuit: 0.2,
    },
    quit: { below: 20, chance: 0.25, sellout: 0.3, breakIn: 15, breakInNights: 5, daleBump: 10 },
    guard: { hp: 100, dmg: 12, acc: 0.7, rate: 1, rangeTiles: 9, aggroTiles: 16, speed: 70, hurtDays: 2, markers: [44, 70] },
    gardener: {
      plants: 20, careCap: 0.85, actionsPerGh: 20,
      moistureBelow: 45, nutrientsBelow: 45, phMargin: 0.1,
    },
  },

  // Inventory items (display names for HUD/hotbar/menus).
  itemNames: {
    can: 'Watering can', seeds: 'Ditch Weed seeds', seeds_blue: 'Blue Haze seeds', seeds_widow: 'Widow Kush seeds', pot: 'Pot',
    seeds_male_ditch: 'Ditch Weed male seeds', seeds_male_blue: 'Blue Haze male seeds', seeds_male_widow: 'Widow Kush male seeds',
    soil_potting: 'Potting soil', soil_living: 'Living soil',
    nutrients: 'Nutrients', phkit: 'pH kit', pollenkit: 'Pollen kit', pollen: 'Pollen',
    moisture_meter: 'Moisture meter', ph_meter: 'pH meter', loupe: 'Loupe',
    rack: 'Drying rack', dirt: 'Dirt', wood: 'Wood', ladder: 'Ladder',
    pickaxe: 'Pickaxe',
    neem: 'Neem oil', lamp_cfl: 'CFL lamp', lamp_hps: 'HPS lamp', lamp_led: 'LED lamp',
    drip: 'Drip kit', filter: 'Carbon filter', generator: 'Generator',
    concrete_tile: 'Concrete tile', door: 'Door', padlock: 'Padlock', deadbolt: 'Deadbolt',
    steeldoor: 'Steel door', dog: 'Guard dog', fists: 'Fists',
    hatch: 'Hidden hatch', stash: 'Stash box', tripwire: 'Tripwire',
    floodlight: 'Floodlight', camera: 'Camera', cart: 'Hand cart', bicycle: 'Bicycle',
    duffel: 'Duffel bag', barrel_lock: 'Barrel lock',
    bat: 'Baseball bat', pistol22: '.22 pistol', pistol9: '9 mm pistol',
    shotgun: 'Pump shotgun', rifle: 'Hunting rifle', ammo_22: '.22 rounds',
    ammo_9: '9 mm rounds', ammo_shell: 'Shotgun shells', ammo_rifle: 'Rifle rounds',
    scanner: 'Police scanner', safe: 'Safe', bandage: 'Bandage', suppressor: 'Suppressor',
    crank: 'Crank', blues: 'Blues', drink: 'Drink', rumor: 'Rumor', bribe: 'Bribe the deputy', ask_around: 'Ask around for buyers',
    heal: 'Full heal', vet: 'Vet', detox: 'Detox', taper: 'Taper kit (1 day)',
    lawyer: 'Lawyer retainer (1 day)', permit: 'Farm-stand permit', truce: 'Truce with Dale',
    stove: 'Kitchen stove', whiskey: 'Whiskey', beer: 'Beer', coffee: 'Coffee', bike_parts: 'Bicycle parts', flowers: 'Flowers', package: 'Package',
  },

  // Addiction (plan §A12). Three substances plus smoking your own product.
  // gain = dependence per use; buffGh/crashGh in game hours; tolerance
  // shortens a buff by D/200. Stage thresholds and withdrawal windows in gh.
  addiction: {
    substances: {
      crank: { gain: 8, buffGh: 8, crashGh: 4, tendMult: 0.6, crashTendMult: 1.3, moveMult: 1.25, crashMoveMult: 0.8, hard: true },
      blues: { gain: 6, buffGh: 6, heal: 20, damageMult: 0.7, hard: true },
      booze: { gain: 2, buffGh: 3, friendshipMult: 1.5, spreadMult: 1.3, hard: false },
    },
    weed: { buffGh: 4, grams: 1, tendMult: 1.1, penaltyMult: 0.75 }, // own product: no dependence
    dMax: 100, tolerancePerD: 200,
    dealer: { markupPer: 20, markupStep: 0.1, markupMax: 0.5 },      // +10% per 20 D, up to +50%
    hookedAt: 30, addictedAt: 60,
    windowGh: { hooked: 24, addicted: 12 },                          // a dose needed this often
    fallPerDay: { casual: 2, coldTurkey: 8, taper: 12 },
    // Per tier: tending time x, fumble chance, max stamina loss, max HP loss.
    // withdrawal tiers apply while in withdrawal; baseline = Addicted but dosed.
    hookedWithdrawal: { tend: 1.5, fumble: 0.10, stamina: 0.25, hp: 0, hpBlues: 0 },
    addictedWithdrawal: { tend: 2.0, fumble: 0.25, stamina: 0.50, hp: 20, hpBlues: 30 },
    baseline: { tend: 1.0, fumble: 0.05, stamina: 0.20, hp: 20, hpBlues: 30 },
    fumbleExtraPour: 1,                     // a double pour adds one more pour (+70 total)
    permHpPerDay: 1, permHpFloor: 60, permHpRegainAfterDays: 5,
    compulsion: {
      afterWithdrawalGh: 6, mossTiles: 10, mossChance: 0.5, cravingChance: 0.3,
      sponsorMult: 0.5, checkGh: 1, controlLossS: 2,
    },
    overdose: { windowGh: 6, from: 3, chance: 0.25, step: 0.25, bill: 400, heat: 5, hpLoss: 5, fatal: 3 },
    taper: { stamina: 0.15, coverGh: 24, rebuyWithinGh: 12 },
    detox: { setTo: 15, days: 3 },
    recovery: { days: 14, relapseSnap: 0.75, cleanSnap: 0.5, cravingGh: 2, cravingTendMult: 1.25 },
    desaturate: 'saturate(0.35)',           // CSS filter on the canvas while in withdrawal
  },

  // Friends and allies (plan §A13). Friendship is 0-100 points, 20 per heart.
  // Seconds are real sim seconds (1 gh = 30 s); times in gh unless named days.
  allies: {
    ptsPerHeart: 20, maxPts: 100, max: 2,          // max allies on the lot at once
    callMinHearts: 2, callBase: 6, callSecondsPerHeart: 20, nightExtraS: 20, // (6 - hearts) x 20 s, +20 s at night
    cooldownDays: 2, autoHearts: 4, autoKinds: ['camera', 'dog'], coverHearts: 4, coverCareCap: 0.7, // 4+ hearts respond / cover
    spawnOffsetTiles: 2,                           // they arrive this far inside the lot's road edge
    followTiles: 10, aggroTiles: 30, retreatFrac: 0.25, fightEndS: 8, idleLeaveS: 60, reach: 20,
    witnessTiles: 10,                              // an ally this close sees you use a hard drug
    gains: {
      favor: 12, favorHeat: -1, loved: 8, liked: 5, neutral: 1, disliked: -3, drink: 3,
      fought: 10, paidBill: 15, unpaidBill: -20, bail: 15, leftInJail: -40,
      hardDrug: -3, killedOthers: -10, noContact: -2, loanLend: 15, loanRefuse: -15,
    },
    noContactDays: 5,                              // -2 per day after this many days
    drinkPrice: 5,
    favors: {
      everyDays: 3, kinds: ['fetch', 'deliver', 'walk', 'fence'], fenceWood: 6, reachTiles: 3,
      fetch: { walt: 'ammo_rifle', benny: 'pot', june: 'neem', rosa: 'bandage' },
    },
    gift: { wood: 10, budGrams: 5, budQuality: 60 },
    estrange: { from: 60, below: 20, winBack: 20 },
    downed: { windowS: 60, reviveS: 5, reviveHp: 30, killChance: 0.10, hospitalDays: 3, bill: 400, reviveReachTiles: 2, playerWaitS: 30 },
    arrest: { chance: 0.5, bail: 600, days: 6, windowGh: 24 },
    grief: { days: 3, tendMult: 1.1 },
    loan: { afterDay: 15, amount: 1000, repayDays: 10, repayChance: 0.7 },
    perks: { warnHearts: 3, discountHearts: 3, discount: 0.15, taperHearts: 3, taperMult: 0.5, sponsorHearts: 3,
      hideHearts: 5, hidePots: 4, hideGh: 12 },
    hostileAct: {                                  // the one hostile thing an estranged ally does
      walt: { heat: 15 },
      benny: { breakInDays: 5 },                   // reuses the crew sell-out break-in bonus (+15%), and the hatch is found 100% next time
      june: { banDays: 5, priceMult: 1.2, priceDays: 10 },
      rosa: { refuseDays: 10 },
    },
    flowers: { x: 262, perDay: 1 },                // park pickup tile
    defs: {
      walt: { name: 'Walt', hp: 90, weapon: 'rifle', dmg: 40, acc: 0.8, rate: 0.7, rangeTiles: 24, speed: 70, armed: true,
        spot: { x: 182, open: 6, close: 20 }, home: 200, deliverTo: 256,
        loved: ['whiskey'], liked: ['wood'], disliked: ['crank', 'blues'] },
      benny: { name: 'Benny', hp: 130, weapon: 'bat', dmg: 18, acc: 0.9, rate: 2, rangeTiles: 1.75, speed: 120, armed: false, melee: true,
        spot: { x: 232, open: 9, close: 18 }, home: 228, deliverTo: 182,
        loved: ['beer'], liked: ['bike_parts'], disliked: [] },
      june: { name: 'June', hp: 70, weapon: 'shotgun', dmg: 54, acc: 0.6, rate: 1, rangeTiles: 9, speed: 90, armed: true,
        spot: { x: 256, open: 8, close: 18 }, home: 270, deliverTo: 309,
        loved: ['bud'], liked: ['coffee'], disliked: [] },
      rosa: { name: 'Rosa', hp: 60, weapon: null, speed: 90, armed: false, heals: true, healHps: 5, healTiles: 3,
        spot: { x: 309, open: 8, close: 18 }, home: 300, deliverTo: 232,
        loved: ['flowers'], liked: ['coffee'], disliked: ['blues'] },
    },
  },

  // Headless balance bot policy (tools/balance.js, My Addition 11).
  balance: {
    days: 45,
    policyEvery: 10,       // run the policy every N sim ticks (speed)
    waterAt: 40, feedAt: 40, phMargin: 0.1,  // act when this close to the ideal edge
    reserve: 60,           // cash the bot never spends on expansion...
    upkeepPerPlant: 12,    // ...plus this per plant (nutrients, pH kits)
    shopHour: 9,           // daily replant/expand shopping
    firstNewPotX: 60,      // tile where new pots and racks are placed
    townFrom: 7, townTo: 22,
    partialWithinGh: 8,    // deliver half an order when the deadline is this close
    streetPerDay: 10, streetKeep: 20, streetReserveMult: 1.2,
    // Heat-aware policy (M4): hide the grow underground, stay quiet.
    streetEarlyDays: 16, streetEarlyHeat: 30, // early on, street sales run up to this heat (raids need 50)
    streetMaxHeat: 20,       // street sales only below this heat
    sellHeatCap: 46,         // no sales to heat-carrying buyers at or above this heat (raids start at 50)
    bribeAfterGross: 1000,   // ...once the run has grossed this much
    bribeReserve: 600,       // cash kept for the deputy once raids are possible
    stashAfterGross: 1000,   // buy the buried stash box once the run has grossed this much
    stashAt: 22, fetchAt: 7, launderHour: 21, // bury cash/product at night, dig up after the raid hour, launder in the evening
    tributeAfterGross: 5000, tributeAt: 20, // pay Dale's weekly tribute once the run is worth his attention
    quietSellHeat: 15,       // while quiet, sell to heat-carrying buyers only below this heat
    preQuietBank: 42000,     // from this bank balance bribe at 17+ heat so the application can go in the day the bank is full
    quietBribeMargin: 4,     // while quiet, bribe when heat exceeds the license limit by this much
    bribeAt: 36,             // bribe the deputy at/above this heat (after day 6)
    outdoorCap: 12,          // plants grown outdoors before the room exists
    roomCost: 1100,          // cash needed to dig the room (hatch + first lamps + filter)
    roomX0: 60, roomWidth: 44, roomTop: 6, roomRows: 3, // tiles below the surface
    securityAfterGross: 2500, // the bot buys locks/dog/floodlights once it has grossed this much
    dogReserve: 300,         // cash kept back after buying the dog
    shaftX: 58,              // the shaft (and its hatch) sits just outside the shack
    sweepSeeds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], sweepDays: 70, carelessDays: 25,
    licenseFrom: 30, licenseTo: 50, needLicense: 6, carelessRaidBy: 20, // M10 gate (plan §D4)
    carelessStreetPerDay: 25, // the careless bot approaches everyone it meets
    carelessCap: 30,         // the careless policy grows this many outdoor pots in plain view
    frontReserve: 400,       // cash kept after buying the front / upgrade
    frontAfterGroups: 7, frontByDay: 28, // ...once the room has this many lamp groups, or by this day
    frontAfterGross: 1500,   // buy the farm-stand front once the run has grossed this much
    upgradeAfterLaundered: 2500, // upgrade the stand once this much has been laundered
    cutStock: 8, cutsPerMother: 2, motherHealth: 70, // clones: keep up to cutStock cuttings, from healthy mothers
    expandKeep: 1100,        // ...plus the next lamp group's cost while the room is still growing
    launderKeep: 500,        // working cash kept back from the stand
    maxGroups: 7,            // 4 pots + 1 HPS lamp per group (28 plants, under the 30 line)
    generatorAtGroups: 3,    // buy the generator (no lamp heat) from this many groups
    filterEveryGroups: 2,    // one carbon filter per this many groups
  },

  // Rendering (plan §B7).
  render: {
    chunkTiles: 16,        // 16x16 tiles = 256x256 px chunks, 25x4 = 100 canvases
    chunkCols: 25,         // ceil(400 / 16)
    chunkRows: 4,
    maxChunkRedrawsPerFrame: 2,
    cameraLagS: 0.15,      // follow lag (plan §B7)
    atlasSize: 512,
    // Darkness layer (M4): quarter-res, lamps punched out.
    lighting: { scale: 4, undergroundTint: 'rgba(6,8,16,0.55)', playerGlowTiles: 3, lampRadiusTiles: 4 },
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

  // Audio (plan §B8/§C2): 100% synthesized. Each SFX is a parameter object:
  // wave (sine|square|saw|tri), start/end Hz, length (s, under 0.5), attack (s),
  // noise (0-1 share of white noise), vol, optional mod = amplitude wobble Hz.
  audio: {
    master: 0.7, sfxVol: 0.8, musicVol: 0.35, maxVoices: 6,
    sampleRate: 22050,
    footstepPx: 22,        // one footstep per this much walking
    falloffPx: 500,        // SFX fade out (and pan) with distance from the camera centre
    storageKey: 'backforty.audio',
    // Config wave names -> OscillatorNode.type (the music beds use real oscillators;
    // the SFX path renders its own buffers and takes the config names directly).
    oscTypes: { sine: 'sine', square: 'square', saw: 'sawtooth', tri: 'triangle' },
    sfx: {
      footstep:  { wave: 'tri',    f0: 90,   f1: 50,   len: 0.08, attack: 0.002, noise: 0.5,  vol: 0.25 },
      jump:      { wave: 'sine',   f0: 200,  f1: 420,  len: 0.14, attack: 0.005, noise: 0,    vol: 0.3 },
      dig:       { wave: 'tri',    f0: 120,  f1: 60,   len: 0.15, attack: 0.002, noise: 0.7,  vol: 0.4 },
      place:     { wave: 'square', f0: 220,  f1: 140,  len: 0.1,  attack: 0.002, noise: 0.2,  vol: 0.3 },
      pour:      { wave: 'sine',   f0: 600,  f1: 900,  len: 0.35, attack: 0.03,  noise: 0.8,  vol: 0.3, mod: 24 },
      feed:      { wave: 'sine',   f0: 500,  f1: 300,  len: 0.2,  attack: 0.01,  noise: 0.4,  vol: 0.3, mod: 14 },
      snip:      { wave: 'saw',    f0: 2400, f1: 1600, len: 0.07, attack: 0.001, noise: 0.5,  vol: 0.3 },
      harvest:   { wave: 'tri',    f0: 330,  f1: 520,  len: 0.3,  attack: 0.01,  noise: 0.3,  vol: 0.4 },
      cash:      { wave: 'square', f0: 1200, f1: 1800, len: 0.25, attack: 0.002, noise: 0,    vol: 0.25, mod: 18 },
      door:      { wave: 'saw',    f0: 110,  f1: 70,   len: 0.3,  attack: 0.01,  noise: 0.3,  vol: 0.35 },
      lockpick:  { wave: 'square', f0: 1800, f1: 1500, len: 0.2,  attack: 0.001, noise: 0.2,  vol: 0.25, mod: 30 },
      alarm:     { wave: 'square', f0: 900,  f1: 900,  len: 0.45, attack: 0.005, noise: 0,    vol: 0.3, mod: 8 },
      bark:      { wave: 'saw',    f0: 420,  f1: 220,  len: 0.2,  attack: 0.005, noise: 0.25, vol: 0.4 },
      bite:      { wave: 'saw',    f0: 300,  f1: 120,  len: 0.18, attack: 0.002, noise: 0.5,  vol: 0.4 },
      batSwing:  { wave: 'sine',   f0: 500,  f1: 150,  len: 0.18, attack: 0.02,  noise: 0.6,  vol: 0.3 },
      batHit:    { wave: 'tri',    f0: 180,  f1: 60,   len: 0.15, attack: 0.001, noise: 0.5,  vol: 0.5 },
      gunshot1:  { wave: 'saw',    f0: 400,  f1: 80,   len: 0.22, attack: 0.001, noise: 0.7,  vol: 0.5 },
      gunshot2:  { wave: 'saw',    f0: 250,  f1: 40,   len: 0.4,  attack: 0.001, noise: 0.85, vol: 0.6 },
      gunshot3:  { wave: 'saw',    f0: 600,  f1: 60,   len: 0.35, attack: 0.001, noise: 0.6,  vol: 0.6 },
      reload:    { wave: 'square', f0: 700,  f1: 400,  len: 0.12, attack: 0.001, noise: 0.3,  vol: 0.3 },
      hurt:      { wave: 'saw',    f0: 260,  f1: 110,  len: 0.25, attack: 0.005, noise: 0.2,  vol: 0.45 },
      phoneBuzz: { wave: 'square', f0: 180,  f1: 180,  len: 0.4,  attack: 0.005, noise: 0,    vol: 0.25, mod: 26 },
      siren:     { wave: 'sine',   f0: 600,  f1: 1100, len: 0.5,  attack: 0.05,  noise: 0,    vol: 0.3 },
      levelUp:   { wave: 'tri',    f0: 440,  f1: 880,  len: 0.45, attack: 0.01,  noise: 0,    vol: 0.4, mod: 10 },
    },
    // Music: two ambient beds (two detuned oscillators -> low-pass, a slow
    // 8-note pentatonic walk, semitones above `root`) and a pulse-bass tension layer.
    music: {
      day:   { root: 220, notes: [0, 2, 4, 7, 9, 7, 4, 2],   detuneCents: 7, cutoff: 1400, noteSec: 1.6, wave: 'sine', vol: 0.5 },
      night: { root: 110, notes: [0, 3, 5, 7, 10, 7, 5, 3],  detuneCents: 9, cutoff: 700,  noteSec: 2.2, wave: 'tri',  vol: 0.5 },
      tension: { freq: 55, beatSec: 0.5, wave: 'square', cutoff: 300, vol: 0.5 },
      fadeSec: 3, lookaheadSec: 3, tickMs: 1000,
    },
  },

  // License, laundering, end states (plan §A14, §A15, My Additions 1, 12, 13). M10.
  license: {
    bankRequired: 50000,       // clean money in the Bank
    level: 5,                  // Grower level
    sample: { quality: 70, grams: 28 },
    heatMax: 20,               // on the day you apply and through the review
    arrestFreeDays: 10,
    reviewDays: 3, inspectHour: 12, inspectGh: 2,   // inspector walks the lot 60 s (= 2 gh at 30 s/gh)
    front: { x: 136, cap: 2500, upgradeCost: 4000, upgradeCap: 5000, fee: 0.15 },
    // Washed out: cash + bank under `money` with nothing to grow for `hours`.
    washed: { money: 20, hours: 48, rescueSeeds: 2 },
  },
  // Difficulty presets (My Addition 13): multiply threat chances and heat gains.
  difficulty: {
    relaxed: { label: 'Relaxed', mult: 0.7 },
    standard: { label: 'Standard', mult: 1.0 },
    harsh: { label: 'Harsh', mult: 1.3 },
  },
  // Automatic quality step-down (My Addition 12): average frame time over the
  // window above the limit steps down one level (particles, soft lights, peds).
  quality: { workAvgMs: 12,   // avgMs: below ~48 fps (HSW GT1 runs 52-60 fps fine)
    windowS: 2, particleScale: 0.5, pedCap: 4, maxLevel: 3,
    warmupS: 5, hitchMs: 100, badWindows: 2 },  // ignore loading, single stalls and one bad window
  // First-time tips: shown once each, the first time the situation arises.
  tips: {
    start: 'Water and feed your plants, harvest when ripe, sell to Skeet in the park. Tab opens your phone.',
    store: 'Day 1: the hardware store in town opens at 08:00. Buy nutrients and a pH kit or your first plant will not last.',
    heat: 'Heat rises as you sell and grow. Hide your grow underground and lay low when it climbs.',
    raid: 'Raids seize CASH on your lot, never the bank. Launder cash through the farm stand.',
    license: 'The town hall issues the license: $50,000 in the Bank, the farm stand, Grower level 5, a quality-70 sample, and heat at 20 or less.',
    crew: 'Hire help at the bar board when you cannot tend everything.',
    thief: 'Thieves come at night. A lock, a dog and floodlights are cheap insurance.',
    addiction: 'Hard drugs help now and cost you later. You can quit at the clinic.',
    crewDay: 12, licenseGross: 8000, // tip thresholds: the crew tip from this day, the license tip at this gross
  },
  save: { slots: 3, settingsKey: 'backforty.settings' },

  // HUD/menus (plan §B7: DOM over the canvas, 4 Hz dirty-checked updates).
  ui: {
    updateHz: 4,
    toastMax: 4,
    toastSeconds: 3.5,
  },
};
