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
import {
  baseGenome, cloneGenome, withGeneticsRng, breedingUnlocked, lineOf, lineName, isMale, sacsShowing,
  makeSeeds, traitSum, seedGroups,
} from './genetics.js';
import { addXp, recordHarvest, hasLevel, levelOf } from './mastery.js';
import { isLitHour, isRaining } from './time.js';

const P = CONFIG.plants;
const L = CONFIG.lamps;
const B = CONFIG.genetics.breeding;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ----------------------------------------------------------- stages -------

/** Stage string for a plant (plan §A4 growth stages table). */
export function stageOf(plant) {
  if (plant.dead) return 'dead';
  if (plant.progress >= 1) {
    const win = plant.ripeWindowGh || P.ripeWindowGh; // L9 perk widens it
    if (plant.overHours < win) return 'ripe';
    if (plant.overHours < win + P.overripeWindowGh) return 'overripe';
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
export function createPlant(state, pot, strainKey, genome, opts = {}) {
  if (state.plants.length >= CONFIG.limits.plants) return null;
  const strain = CONFIG.strains[strainKey];
  const line = lineOf(state, opts.lineId);
  const plant = {
    id: state.nextId++,
    potId: pot.id,
    strainKey,
    strainName: line ? lineName(line) : strain.name,
    genome: genome || baseGenome(strainKey),
    lineId: opts.lineId ?? null,        // clone line (set at the first cut)
    generation: opts.generation || 0,   // clone generation: mother's + 1
    sex: opts.sex || null,  // null = shop seed (female); 'f' | 'm' for bred seeds and their clones
    stability: opts.stability || 0, // M11: this generation's line stability (0-1)
    filial: opts.filial || 0,       // M11: F number inside the bred line
    base: opts.base || null,        // M11: genome at birth (clone drift caps against it)
    crossed: null,         // M11: pollen applied by hand {genome, lineId, ...}
    accident: false,       // M11: a male's pollen reached her (yield x0.5, quality x0.6)
    progress: opts.progress || 0,       // 0..1 share of total lit hours
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
    infested: false,       // M6 pest jar
    infestGh: 0,           // gh since the mites last spread
    poisonedHours: 0,      // M6 poisoned water
    gardened: false,       // M6: the gardener is tending it (care capped)
    dead: false,
  };
  state.plants.push(plant);
  return plant;
}

/** Plant a seed into an empty pot (uses a purchased genome if one is queued). */
export function plantSeed(state, pot, strainKey) {
  if (pot.plantId) return null;
  const bag = seedBagOf(state.player, strainKey);
  const genome = bag.length > 0 ? bag.shift() : null;
  const plant = createPlant(state, pot, strainKey, genome);
  if (plant) pot.plantId = plant.id;
  return plant;
}

/** Queue of purchased seed genomes for a strain (Ditch Weed keeps the M2 `seedBag`). */
export function seedBagOf(player, strainKey) {
  if (strainKey === 'ditch') return player.seedBag;
  const bags = player.seedBags || (player.seedBags = {});
  return bags[strainKey] || (bags[strainKey] = []);
}

/** Key of a bred-seed group (same line and stability). */
const bredKey = (sd) => `${sd.lineId}|${sd.stability}`;

/**
 * What E plants into an empty pot. An explicit pick (Q, `player.seedSel`) wins;
 * otherwise a cutting first, then bred seeds, then seeds of the rarest strain
 * you carry (Widow Kush, Blue Haze, Ditch Weed). Null if nothing.
 */
export function plantable(player) {
  const bred = player.bredSeeds || [];
  const sel = player.seedSel || 'auto';
  if (sel.startsWith('bred:') && bred.some((sd) => bredKey(sd) === sel.slice(5))) return { bred: sel.slice(5) };
  if (sel.startsWith('shop:') && (player.inv[CONFIG.strains[sel.slice(5)]?.item] || 0) > 0) return { strainKey: sel.slice(5) };
  if ((player.cuttings || []).length > 0) return { cutting: true };
  if (bred.length > 0) return { bred: bredKey(bred[0]) };
  for (const key of ['widow', 'blue', 'ditch']) {
    if ((player.inv[CONFIG.strains[key].item] || 0) > 0) return { strainKey: key };
  }
  return null;
}

/** Everything Q can cycle through: auto, each shop strain in the pack, each bred seed group. */
export function seedChoices(state) {
  const p = state.player;
  const out = [{ sel: 'auto', label: 'automatic (cutting, bred seeds, then rarest strain)' }];
  for (const key of ['widow', 'blue', 'ditch']) {
    const n = p.inv[CONFIG.strains[key].item] || 0;
    if (n > 0) out.push({ sel: `shop:${key}`, label: `${CONFIG.strains[key].name} seeds x${n}` });
  }
  for (const g of seedGroups(state)) {
    out.push({ sel: `bred:${g.key}`, label: `${lineName(lineOf(state, g.lineId))} F${g.filial} seeds x${g.count} (stability ${Math.round(g.stability * 100)}%)` });
  }
  return out;
}

/** Q: next seed type to plant. Returns the label chosen. */
export function cycleSeedSel(state) {
  const ch = seedChoices(state);
  const i = ch.findIndex((c) => c.sel === (state.player.seedSel || 'auto'));
  const next = ch[(i + 1) % ch.length];
  state.player.seedSel = next.sel;
  return next.label;
}

/** Plant one bred seed of a group (sex was rolled with the seed; it shows from 55%). */
export function plantBred(state, pot, key) {
  const bag = state.player.bredSeeds || [];
  const i = bag.findIndex((sd) => bredKey(sd) === key);
  if (i < 0 || pot.plantId) return null;
  const sd = bag.splice(i, 1)[0];
  const plant = createPlant(state, pot, sd.strainKey, sd.genome, {
    lineId: sd.lineId, sex: sd.male ? 'm' : 'f', stability: sd.stability, filial: sd.filial, base: { ...sd.genome },
  });
  if (plant) pot.plantId = plant.id; else bag.splice(i, 0, sd);
  return plant;
}

// ------------------------------------------------------------- clones -----

/** A vegetative plant can be cut (plan §A10). */
export const canCut = (plant) => !plant.dead && stageOf(plant) === 'vegetative';

/** Cut a cutting: copies the genome with drift, mother loses 5 health, line id assigned. */
export function takeCutting(state, mother) {
  if (!canCut(mother)) return null;
  const G = CONFIG.genetics;
  if (mother.lineId == null) mother.lineId = state.nextId++;
  const genome = withGeneticsRng(state, (rng) => cloneGenome(mother.genome, mother.strainKey, careOf(mother), rng, mother.base));
  mother.health = Math.max(1, mother.health - G.cloneMotherDamage);
  const cutting = {
    strainKey: mother.strainKey, genome, lineId: mother.lineId, generation: mother.generation + 1,
    sex: mother.sex, stability: mother.stability, filial: mother.filial, base: mother.base, // a clone keeps her sex and line
  };
  const cuts = state.player.cuttings || (state.player.cuttings = []);
  cuts.push(cutting);
  return cutting;
}

/** Plant the oldest cutting: always roots at L7+, else 85%. Null if it failed to root. */
export function plantCutting(state, pot) {
  const c = state.player.cuttings.shift();
  const roll = withGeneticsRng(state, (rng) => rng.next());
  if (!hasLevel(state, CONFIG.mastery.cloneRootLevel) && roll >= CONFIG.mastery.cloneRootChance) {
    state.events.push({ type: 'toast', msg: 'The cutting did not root.' });
    return null;
  }
  const plant = createPlant(state, pot, c.strainKey, c.genome, {
    progress: CONFIG.genetics.cloneStartProgress, lineId: c.lineId, generation: c.generation,
    sex: c.sex, stability: c.stability, filial: c.filial, base: c.base,
  });
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
  if (plant.infested) s.push('pest');
  if (plant.poisonedHours > 0) s.push('poisoned');
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

    plant.ripeWindowGh = levelOf(state) >= CONFIG.mastery.ripeWindowLevel ? CONFIG.mastery.ripeWindowGh : P.ripeWindowGh;
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
      for (const k of stressors) if (k !== 'pest') dmg += P.stressDamage[k];
      // Mites deal a flat 3 health/gh (plan §A6); resilience only softens stress.
      const perk = levelOf(state) >= CONFIG.mastery.stressLevel ? CONFIG.mastery.stressDamageMult : 1;
      plant.health -= (dmg * resilienceMult(plant.genome) * perk + (plant.infested ? P.stressDamage.pest : 0)) * gh;
      if (plant.health <= 0) { killPlant(state, plant, 'stress'); continue; }
    } else {
      plant.health = Math.min(100, plant.health + P.healthRegen * gh);
    }

    // Mites spread to the nearest plant within 2 tiles; poison wears off.
    if (plant.infested) {
      plant.infestGh = (plant.infestGh || 0) + gh;
      if (plant.infestGh >= P.pest.spreadGh) { plant.infestGh = 0; spreadPests(state, plant, pot); }
    }
    if (plant.poisonedHours > 0) plant.poisonedHours = Math.max(0, plant.poisonedHours - gh);

    // Lifetime bookkeeping (mean health, care fraction). While the gardener
    // tends a plant its care fraction cannot climb above his cap (plan §A8).
    plant.healthSum += plant.health * gh;
    if (stressors.length === 0) {
      plant.careTicks += plant.gardened
        ? Math.min(gh, Math.max(0, (plant.careCap || CONFIG.crew.gardener.careCap) * (plant.ticks + gh) - plant.careTicks))
        : gh;
    }
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
  stepPollination(state);
}

// --------------------------------------------------------- breeding -------

/** Is this a female still in flower that pollen can reach? */
const receptive = (plant) => !plant.dead && !isMale(plant) && stageOf(plant) === 'flowering';

/**
 * Accidental pollination (plan §A11): every flowering female within 6 tiles of
 * an unculled male showing pollen sacs is pollinated (yield x0.5, quality x0.6).
 * Deterministic: no random draws.
 */
function stepPollination(state) {
  let males = null;
  for (const pl of state.plants) if (!pl.dead && sacsShowing(pl)) (males || (males = [])).push(pl);
  if (!males) return;
  let hit = 0;
  for (const f of state.plants) {
    if (f.accident || f.crossed || !receptive(f)) continue;
    const fp = potOf(state, f);
    if (!fp) continue;
    for (const m of males) {
      const mp = potOf(state, m);
      if (mp && Math.hypot(mp.x - fp.x, mp.y - fp.y) <= B.pollinateTiles) { f.accident = true; hit++; break; }
    }
  }
  if (hit > 0) state.events.push({ type: 'toast', msg: `A male's pollen reached ${hit} plant${hit > 1 ? 's' : ''}: yield and quality will suffer. Cull males in time.` });
}

/** Collect pollen from a flowering male with a pollen kit (4 uses). */
export function collectPollen(state, male) {
  if (!breedingUnlocked(state)) return { ok: false, msg: 'Breeding unlocks at Grower level 6.' };
  if (!male || male.dead || !sacsShowing(male)) return { ok: false, msg: 'No pollen sacs yet.' };
  const inv = state.player.inv;
  if ((inv.pollenkit || 0) <= 0) return { ok: false, msg: 'You need a pollen kit (hardware store).' };
  inv.pollenkit--;
  const bag = state.player.pollen || (state.player.pollen = []);
  bag.push({
    genome: { ...male.genome }, lineId: male.lineId, stability: male.stability, filial: male.filial,
    strainKey: male.strainKey, strainName: male.strainName,
  });
  inv.pollen = bag.length;
  return { ok: true, msg: `Collected pollen from the male ${male.strainName} (${inv.pollenkit} kit uses left).` };
}

/** Apply the oldest pollen sample to a flowering female: she will give bud x0.3 and seeds. */
export function pollinateFemale(state, female) {
  if (!breedingUnlocked(state)) return { ok: false, msg: 'Breeding unlocks at Grower level 6.' };
  const bag = state.player.pollen || [];
  if (bag.length === 0) return { ok: false, msg: 'You have no pollen.' };
  if (!female || !receptive(female)) return { ok: false, msg: 'Only a flowering female can take pollen.' };
  if (female.crossed) return { ok: false, msg: 'She has already been crossed.' };
  female.crossed = bag.shift();
  female.accident = false; // a deliberate cross replaces the accident
  state.player.inv.pollen = bag.length;
  return { ok: true, msg: `Crossed ${female.strainName} x ${female.crossed.strainName}. Harvest her for seeds.` };
}

/** Can the player cross this plant right now? (pollen in the pack, flowering female) */
export const pollinatable = (state, plant) =>
  breedingUnlocked(state) && (state.player.pollen || []).length > 0 && receptive(plant) && !plant.crossed;

/** Pull out a male whose sex is known (C). */
export function cullMale(state, male) {
  const pot = potOf(state, male);
  const i = state.plants.indexOf(male);
  if (i >= 0) state.plants.splice(i, 1);
  if (pot) pot.plantId = null;
  state.events.push({ type: 'toast', msg: `Culled the male ${male.strainName}.` });
}

// -------------------------------------------------------------- tending ---

/** One watering-can pour: +35 moisture plus the source water's pH. `source`
 *  ('tap' | 'barrel') lets Dale's poisoned water bite (plan §A6). */
export function waterPour(state, plant, pourPh, source) {
  plant.moisture = Math.min(100, plant.moisture + P.pourMoisture);
  plant.ph = clamp(plant.ph + pourPh, 4, 8);
  const poison = state.threats && state.threats.rival && state.threats.rival.poison;
  if (poison && poison.source === source && poison.pours > 0) {
    const X = CONFIG.threats.rival.poison;
    plant.ph = clamp(plant.ph + X.ph, 4, 8);
    plant.poisonedHours = X.stressGh;
    if (--poison.pours <= 0) state.threats.rival.poison = null;
  }
}

/** Neem spray cures one plant (plan §A6 pest jar). */
export function neemPlant(state, plant) {
  plant.infested = false;
  plant.infestGh = 0;
}

function spreadPests(state, from, fromPot) {
  let best = null, bd = P.pest.spreadTiles;
  for (const other of state.plants) {
    if (other === from || other.dead || other.infested) continue;
    const pot = potOf(state, other);
    const d = pot && Math.hypot(pot.x - fromPot.x, pot.y - fromPot.y);
    if (pot && d <= bd) { bd = d; best = other; }
  }
  if (best) { best.infested = true; best.infestGh = 0; }
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
  if (plant.dead || isMale(plant)) return false; // males give no bud: cull or collect pollen
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
      1 - P.overripeQDropPerGh * (plant.overHours - (plant.ripeWindowGh || P.ripeWindowGh)));
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

  let grams = base * healthMult * timingY * masteryMult * soilMult; // seeded x1 (no males in v1)
  const careMult = 0.5 + 0.5 * careOf(plant);
  let quality = clamp(g.P * careMult * timingQ + CONFIG.mastery.qualityPerLevel * (L - 1), 0, 100);
  const crossed = plant.crossed, accident = plant.accident && !crossed;
  if (crossed) grams *= B.crossYield;       // seeded: bud at x0.3 plus seeds
  if (accident) { grams *= B.accidentalYield; quality *= B.accidentalQuality; }

  const fmt = (v) => v.toFixed(2);
  const batch = grams > 0 ? {
    id: state.nextId++,
    strainName: plant.strainName,
    quality: Math.round(quality * 10) / 10,
    grams,
    wet: true,
    ...(lineOf(state, plant.lineId) ? { lineId: plant.lineId, stab: plant.stability, sum: traitSum(g) } : {}),
    dryHoursLeft: P.dryHours,
    where: 'inv',
    rackId: null,
  } : null;

  const seeds = crossed ? makeSeeds(state, plant, crossed, plant.health) : null;
  if (pot) pot.soilPh = plant.ph; // the soil keeps its pH for the next run
  const idx = state.plants.indexOf(plant);
  if (idx >= 0) state.plants.splice(idx, 1);

  // Mastery: journal entry, comparison to the line's previous harvest, then XP.
  const qDone = Math.round(quality * 10) / 10;
  const prev = batch ? recordHarvest(state, {
    day: state.time.day, strainName: plant.strainName, grams, quality: qDone,
    generation: plant.generation, lineId: plant.lineId,
  }) : null;
  const vs = prev ? `${grams - prev.grams >= 0 ? '+' : ''}${(grams - prev.grams).toFixed(1)} g, ` +
    `${quality - prev.quality >= 0 ? '+' : ''}${Math.round(quality - prev.quality)} quality vs. the last of this line` : null;
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
      ...(vs ? [vs] : []),
      ...(crossed ? [`Crossed with ${crossed.strainName}: bud x${B.crossYield}`] : []),
      ...(accident ? [`A male pollinated her: yield x${B.accidentalYield}, quality x${B.accidentalQuality}`] : []),
    ] : ['The plant was rotten. Nothing usable came out.'],
    seeds: seeds ? seeds.length : 0,
  });
  if (seeds) {
    const s0 = seeds[0];
    state.events.push({ type: 'toast', msg: `${seeds.length} seeds: ${lineName(lineOf(state, s0.lineId))} F${s0.filial}, stability ${Math.round(s0.stability * 100)}%.` });
  }
  if (batch) addXp(state, grams, quality);
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
