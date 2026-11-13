// plants.js — grow sim: growth, moisture, pH, nutrients, light, stress,
// harvest (plan §A4). Pure module: no window/document, runs unmodified in
// Node for tests and the balance bot (plan §B3 rule).
//
// M2 scope: pot-grown plants lit by the outdoor sun. Lamps, indoor "no light"
// stress, rooms/visibility, pests and sabotage all arrive later (M4/M6) —
// the hooks they need (hasSun, lightFactor, infested/poisonedHours fields)
// already exist here so those milestones extend instead of rewrite.
//
// Lifetime bookkeeping (plan §A4 "Health, care, stress"):
//   avgHealth = lifetime mean health, integrated as healthSum += health*gh
//   care      = fraction of lifetime ticks with zero stressors, integrated
// Integrating with the tick's own dt (instead of counting ticks) keeps the
// result identical for any dt, including the balance bot's big steps.

import { CONFIG } from '../config.js';
import { T, tileAt } from '../world/tiles.js';
import { baseGenome } from './genetics.js';
import { isLitHour, isRaining } from './time.js';

const P = CONFIG.plants;
const L = CONFIG.lamps;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ----------------------------------------------------------- stages -------

/** Stage string for a plant (plan §A4 growth stages table). */
export function stageOf(plant) {
  if (plant.dead) return 'dead';
  if (plant.progress >= 1) {
    if (plant.overHours < P.ripeWindowGh) return 'ripe';
    if (plant.overHours < P.ripeWindowGh + P.overripeWindowGh) return 'overripe';
    return 'rotten';
  }
  if (plant.progress >= P.stageProgress.flower) return 'flowering';
  if (plant.progress >= P.stageProgress.veg) return 'vegetative';
  return 'seedling';
}

/** Total lit hours this genome needs: (9 - 0.05*S) days x 14 lit hours. */
export function totalLitHours(genome) {
  return (P.growDaysBase - P.growDaysPerS * genome.S) * P.litHoursPerDay;
}

/** Stress damage multiplier from Resilience: 1.5 - R/100 (plan §A4). */
export function resilienceMult(genome) {
  return 1.5 - genome.R / 100;
}

/**
 * Can this pot's column see the sky? Anything non-air above the pot (a roof,
 * dug ceiling, wood tile) shades the plant — it is indoors for light purposes.
 * Rooms-based visibility (road view, raid search) arrives with M4.
 */
export function hasSun(state, pot) {
  for (let y = pot.y - 1; y >= 0; y--) {
    const id = tileAt(state.tiles, pot.x, y);
    if (id !== T.AIR && id !== T.BGWALL) return false;
  }
  return true;
}

/** Is this lamp's timer running at `hour`? (starts at onHour, runs 14 or 18 h) */
export function lampOn(lamp, hour) {
  const len = (lamp.hours || L.hoursNormal) * 60;
  const m = Math.round(hour * 60); // whole game-minutes: float drift never flips a tick
  return ((m - L.onHour * 60) % 1440 + 1440) % 1440 < len;
}

/**
 * Lamp coverage at `hour`: Map potId -> best light factor. A lamp lights the
 * nearest N pots within its radius (plan §A4); overlaps take the best lamp.
 */
export function lampCoverage(state, hour) {
  const cov = new Map();
  const pots = state.objects.filter((o) => o.kind === 'pot');
  for (const lamp of state.objects) {
    if (lamp.kind !== 'lamp' || !lampOn(lamp, hour)) continue;
    const def = L.types[lamp.lamp];
    const near = pots
      .map((pot) => ({ pot, d: Math.hypot(pot.x - lamp.x, pot.y - lamp.y) }))
      .filter((e) => e.d <= def.radius)
      .sort((a, b) => a.d - b.d)
      .slice(0, def.pots);
    for (const { pot } of near) cov.set(pot.id, Math.max(cov.get(pot.id) || 0, def.factor));
  }
  return cov;
}

/** Light factor right now for a pot: sun 1.0 in the window, else its best lamp. */
export function lightFactor(state, pot) {
  if (isLitHour(state.time.hour) && hasSun(state, pot)) return 1;
  return lampCoverage(state, state.time.hour).get(pot.id) || 0;
}

/**
 * Light over one whole sim tick: evaluated at the tick's START hour, so the
 * last in-window tick (covering [19.983, 20.000)) still counts. That makes the
 * window contribute exactly 14.0 game hours per day (plan §A3) and an S=80
 * genome ripen after 5 full days, as the M2 test window asserts. (Evaluating
 * at the post-advance hour loses that tick to float rounding of the clock.)
 */
export function tickLight(state, pot, gh) {
  return isLitHour(state.time.hour - gh) && hasSun(state, pot);
}

/** pH nutrient lockout factor: severe 0, mild 0.5, ideal 1 (plan §A4). */
export function phUptake(plant) {
  if (plant.ph < P.phMild.lo || plant.ph > P.phMild.hi) return 0;   // severe
  if (plant.ph < P.phIdeal.lo || plant.ph > P.phIdeal.hi) return 0.5; // mild
  return 1;
}

// -------------------------------------------------------- plant object ----

/** Create a plant in an empty pot. Genome defaults to the exact base strain
 *  (the starter seeds); purchased seeds pass a rolled genome in. */
export function createPlant(state, pot, strainKey, genome) {
  if (state.plants.length >= CONFIG.limits.plants) return null;
  const strain = CONFIG.strains[strainKey];
  const plant = {
    id: state.nextId++,
    potId: pot.id,
    strainKey,
    strainName: strain.name,
    genome: genome || baseGenome(strainKey),
    lineId: null,          // M7 (clone lines)
    generation: 0,         // M7
    sex: null,             // M11 (shop seeds never male)
    progress: 0,           // 0..1 share of total lit hours
    overHours: 0,          // gh since 100% (ripe/overripe/rotten clock)
    moisture: P.startMoisture,
    ph: pot.soilPh,        // the soil's pH carries over on replanting
    nutrients: P.startNutrients,
    health: 100,
    healthSum: 0,          // ∫health dt
    careTicks: 0,          // ∫dt with zero stressors
    ticks: 0,              // lifetime gh
    dryHours: 0,           // consecutive gh at moisture 0
    darkGh: 0,             // consecutive gh an indoor plant had no light
    infested: false,       // M6 sabotage
    poisonedHours: 0,      // M6 poisoned water
    dead: false,
  };
  state.plants.push(plant);
  return plant;
}

/** Plant a seed into an empty pot (uses a purchased genome if one is queued). */
export function plantSeed(state, pot, strainKey) {
  if (pot.plantId) return null;
  const bag = state.player.seedBag;
  const genome = bag.length > 0 ? bag.shift() : null;
  const plant = createPlant(state, pot, strainKey, genome);
  if (plant) pot.plantId = plant.id;
  return plant;
}

export function potOf(state, plant) {
  return state.objects.find((o) => o.id === plant.potId) || null;
}

export function plantByPot(state, pot) {
  if (!pot || !pot.plantId) return null;
  return state.plants.find((p) => p.id === pot.plantId) || null;
}

// ------------------------------------------------------------- stress -----

/** Active stressor keys (plan §A4 damage table; pests/no-light later). */
export function stressorsOf(plant) {
  const s = [];
  if (plant.moisture < P.moistureStress.lo || plant.moisture > P.moistureStress.hi) s.push('moisture');
  if (plant.ph < P.phIdeal.lo || plant.ph > P.phIdeal.hi) {
    s.push(plant.ph < P.phMild.lo || plant.ph > P.phMild.hi ? 'phSevere' : 'phMild');
  }
  if ((plant.darkGh || 0) >= P.darkStressGh) s.push('noLight');
  if (plant.nutrients < P.nutrientStress.lo) s.push('nutrientLow');
  else if (plant.nutrients > P.nutrientStress.hi) s.push('nutrientHigh');
  return s;
}

export function avgHealthOf(plant) {
  return plant.ticks > 0 ? plant.healthSum / plant.ticks : plant.health;
}

export function careOf(plant) {
  return plant.ticks > 0 ? plant.careTicks / plant.ticks : 1;
}

function killPlant(state, plant, cause) {
  plant.dead = true;
  plant.health = 0;
  state.events.push({
    type: 'plantDied', plantId: plant.id, potId: plant.potId,
    strainName: plant.strainName, cause,
  });
}

// --------------------------------------------------------------- tick -----

/** Advance every plant by gh game hours. Call once per sim step. */
export function stepPlants(state, gh) {
  const raining = isRaining(state);
  const heatwave = state.time.weather === 'heatwave';
  let cov = null; // lamp coverage at the tick's start hour, built on first need
  for (const plant of state.plants) {
    if (plant.dead) continue;
    const pot = potOf(state, plant);
    if (!pot) { killPlant(state, plant, 'its pot vanished'); continue; }

    const stage = stageOf(plant);
    const soil = pot.soil || 'cheap';
    const sun = tickLight(state, pot, gh);
    const outdoor = hasSun(state, pot);
    if (!cov) cov = lampCoverage(state, ((state.time.hour - gh) % 24 + 24) % 24);
    const lf = sun ? 1 : (cov.get(pot.id) || 0);
    if (outdoor || lf > 0) plant.darkGh = 0;
    else plant.darkGh = (plant.darkGh || 0) + gh;

    // Moisture: stage loss x soil x outdoor-daytime modifier; rain waters
    // outdoor plants, a heatwave dries them faster (plan §A3).
    let mLoss = P.moistureLoss[stage] * P.soilMoistureMult[soil];
    if (sun) mLoss *= P.outdoorDayMoistureMult;
    if (sun && heatwave) mLoss *= CONFIG.weather.heatwaveMoistureMult;
    plant.moisture = Math.max(0, plant.moisture - mLoss * gh);
    if (raining && outdoor) plant.moisture = Math.min(100, plant.moisture + CONFIG.weather.rainMoistureGh * gh);
    if (plant.moisture <= 0) {
      plant.dryHours += gh;
      if (plant.dryHours >= P.dieAtZeroMoistureGh) {
        killPlant(state, plant, 'dried out');
        continue;
      }
    } else {
      plant.dryHours = 0;
    }

    // Nutrients drain by stage; pH drifts up with the soil buffer.
    plant.nutrients = Math.max(0, plant.nutrients - P.nutrientUse[stage] * gh);
    plant.ph = clamp(plant.ph + P.phPassiveDrift * P.soilPhBuffer[soil] * gh, 4, 8);

    // Stress damage x resilience, or regeneration with zero stressors.
    const stressors = stressorsOf(plant);
    if (stressors.length > 0) {
      let dmg = 0;
      for (const k of stressors) dmg += P.stressDamage[k];
      plant.health -= dmg * resilienceMult(plant.genome) * gh;
      if (plant.health <= 0) { killPlant(state, plant, 'stress'); continue; }
    } else {
      plant.health = Math.min(100, plant.health + P.healthRegen * gh);
    }

    // Lifetime bookkeeping (mean health, care fraction).
    plant.healthSum += plant.health * gh;
    if (stressors.length === 0) plant.careTicks += gh;
    plant.ticks += gh;

    // Growth: progress only accrues in light; the ripe clock is wall-clock gh.
    if (plant.progress >= 1) {
      plant.overHours += gh;
    } else if (lf > 0) {
      const uptake = phUptake(plant);
      if (uptake > 0) {
        const hf = 0.5 + 0.5 * plant.health / 100;
        plant.progress += lf * hf * uptake * gh / totalLitHours(plant.genome);
        if (plant.progress >= 1 - 1e-9) { plant.progress = 1; plant.overHours = 0; }
      }
    }
  }
}

// -------------------------------------------------------------- tending ---

/** One watering-can pour: +35 moisture plus the source water's pH. */
export function waterPour(state, plant, pourPh) {
  plant.moisture = Math.min(100, plant.moisture + P.pourMoisture);
  plant.ph = clamp(plant.ph + pourPh, 4, 8);
}

/** One nutrient dose: +30 nutrients, -0.2 pH. */
export function feedDose(state, plant) {
  plant.nutrients = Math.min(100, plant.nutrients + P.nutrientDose);
  plant.ph = clamp(plant.ph + P.nutrientDosePh, 4, 8);
}

/** One pH kit dose: dir -1 = pH Down, +1 = pH Up; ±0.3. */
export function phAdjust(state, plant, dir) {
  plant.ph = clamp(plant.ph + dir * P.phDose, 4, 8);
}

/** Harvestable from 80% progress (early) through the windows, not rotten/dead. */
export function canHarvest(plant) {
  if (plant.dead) return false;
  const stage = stageOf(plant);
  return plant.progress >= P.earlyHarvest.from && stage !== 'rotten';
}

/**
 * Harvest: dry grams and quality per plan §A4, plus the report-card
 * breakdown pushed as a 'harvest' event (My Addition 5). Wet product goes to
 * the inventory; racks dry it (24 gh). Removes the plant; the pot keeps its
 * soil and the soil's current pH.
 */
export function harvestPlant(state, plant) {
  const pot = potOf(state, plant);
  const stage = stageOf(plant);
  const g = plant.genome;

  const base = P.yieldBase + P.yieldPerY * g.Y;
  const healthMult = P.healthYieldLo + P.healthYieldSpan * avgHealthOf(plant) / 100;
  let timingY = 1, timingQ = 1, timingName = 'ripe window';
  if (stage === 'overripe') {
    timingQ = Math.max(P.overripeQMin,
      1 - P.overripeQDropPerGh * (plant.overHours - P.ripeWindowGh));
    timingName = 'overripe';
  } else if (stage === 'rotten') {
    timingY = 0; timingQ = 0; timingName = 'rotten';
  } else if (stage !== 'ripe') {
    timingY = P.earlyHarvest.yield;
    timingQ = P.earlyHarvest.quality;
    timingName = 'early';
  }
  const L = state.player.level || 1;
  const masteryMult = 1 + CONFIG.mastery.yieldPerLevel * (L - 1);
  const soilMult = P.soilYieldMult[pot ? pot.soil : 'cheap'] || 1;

  const grams = base * healthMult * timingY * masteryMult * soilMult; // seeded x1 (no males in v1)
  const careMult = 0.5 + 0.5 * careOf(plant);
  const quality = clamp(g.P * careMult * timingQ + CONFIG.mastery.qualityPerLevel * (L - 1), 0, 100);

  const fmt = (v) => v.toFixed(2);
  const batch = grams > 0 ? {
    id: state.nextId++,
    strainName: plant.strainName,
    quality: Math.round(quality * 10) / 10,
    grams,
    wet: true,
    dryHoursLeft: P.dryHours,
    where: 'inv',
    rackId: null,
  } : null;

  if (pot) pot.soilPh = plant.ph; // the soil keeps its pH for the next run
  const idx = state.plants.indexOf(plant);
  if (idx >= 0) state.plants.splice(idx, 1);

  state.events.push({
    type: 'harvest',
    strainName: plant.strainName,
    grams, quality,
    timingName,
    lines: batch ? [
      `${fmt(base)} g base (Yield ${g.Y})`,
      `x ${fmt(healthMult)} health (avg ${Math.round(avgHealthOf(plant))})`,
      `x ${fmt(timingY)} timing (${timingName})`,
      `x ${fmt(masteryMult)} mastery (Grower L${L})`,
      `x ${fmt(soilMult)} soil`,
      `= ${grams.toFixed(1)} g wet`,
      `Quality: ${g.P} potency x ${fmt(careMult)} care x ${fmt(timingQ)} timing = ${quality.toFixed(1)}`,
    ] : ['The plant was rotten. Nothing usable came out.'],
  });
  return batch;
}

/** Estimated lit hours still needed to reach 100% (loupe / plant panel). */
export function litHoursToRipe(state, plant, pot) {
  if (plant.dead || plant.progress >= 1) return 0;
  const lf = lightFactor(state, pot);
  if (lf <= 0) return null; // in darkness: unknowable right now
  const uptake = phUptake(plant);
  if (uptake <= 0) return null;
  const hf = 0.5 + 0.5 * plant.health / 100;
  return (1 - plant.progress) * totalLitHours(plant.genome) / (lf * hf * uptake);
}
