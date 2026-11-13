// genetics.js — genome ops (plan §A4 Genome, §B9 src/sim/genetics.js).
// Pure module: no window/document, runs unmodified in Node (plan §B3 rule).
//
// Seed variance (M2) and clone drift (M7) live here;
// crossing, stability and inbreeding (M11) reuse this one genome model (plan §A17).

import { CONFIG } from '../config.js';
import { createRng } from '../rng.js';

const G = CONFIG.genetics;

/** A fresh copy of a strain's base genome. */
export function baseGenome(strainKey) {
  const s = CONFIG.strains[strainKey];
  return { Y: s.Y, P: s.P, R: s.R, S: s.S };
}

/**
 * Shop seeds are feminized and vary ±G.seedVariance per trait from the strain
 * table (plan §A4). Each trait drifts independently; clamped to 0-100.
 */
export function rollSeedGenome(strainKey, rng) {
  const base = baseGenome(strainKey);
  for (const k of ['Y', 'P', 'R', 'S']) {
    base[k] = Math.max(0, Math.min(100, base[k] + rng.intRange(-G.seedVariance, G.seedVariance)));
  }
  return base;
}

// ------------------------------------------------------------ clones ------
// Clone drift (plan §A10): at the cut each trait independently gains +1 with
// probability 0.6 x care, else loses 1 with probability 0.4 x (1 - care).
// Gains are capped at the strain's base + cloneCap. Two draws per trait, always,
// so the stream advances the same whatever the outcome. Breeding (M11) extends
// this same {Y,P,R,S} genome.

const TRAITS = ['Y', 'P', 'R', 'S'];

export function cloneGenome(mother, strainKey, care, rng, baseOverride = null) {
  const base = baseOverride || baseGenome(strainKey); // bred plants cap against the genome they were born with
  const out = {};
  for (const k of TRAITS) {
    const up = rng.next() < G.cloneUpChance * care;
    const down = rng.next() < G.cloneDownChance * (1 - care);
    let v = mother[k] + (up ? 1 : down ? -1 : 0);
    v = Math.min(v, Math.max(mother[k], base[k] + G.cloneCap)); // never push above base+cap
    out[k] = Math.max(0, Math.min(G.traitMax, v));
  }
  return out;
}

/** Saved PRNG stream for clone drift (its own, so older systems' draws never shift). */
export function initGenetics(seed = 1) {
  return { rngState: (seed ^ 0x7f4a7c15) >>> 0 };
}

export function withGeneticsRng(state, fn) {
  const g = state.genetics || (state.genetics = initGenetics(state.seed));
  const rng = createRng(g.rngState);
  const out = fn(rng);
  g.rngState = rng.state;
  return out;
}

// ----------------------------------------------------------- breeding ----
// Plan §A11. A bred "line" is a registry entry on the player, keyed by the
// plants' lineId (the same id clones share), so one id serves both systems.
// Everything here draws from the genetics stream only.

const B = G.breeding;
const r2 = (v) => Math.round(v * 100) / 100;

export const breedingUnlocked = (state) => (state.player.level || 1) >= CONFIG.mastery.breedingLevel;
export const linesOf = (state) => state.player.lines || (state.player.lines = {});
export const lineOf = (state, id) => (id == null ? null : linesOf(state)[id] || null);
export const traitSum = (g) => g.Y + g.P + g.R + g.S;

/** Is this plant male? (sex is null for shop seeds and clones of females: female) */
export const isMale = (plant) => plant.sex === 'm';

/** Males show sacs from 55% progress; a loupe tells from 40%. */
export const sacsShowing = (plant) => isMale(plant) && plant.progress >= B.sacProgress;
export const sexKnown = (state, plant) =>
  isMale(plant) && plant.progress >= ((state.player.inv.loupe || 0) > 0 ? B.loupeProgress : B.sacProgress);

/** Display name of a line: the registered name, else its label. */
export const lineName = (line) => line.name || line.label;

/** Child genome per trait: lerp(mother, father, u) + noise +-8 x (1 - stability), clamped. */
export function crossGenome(mother, father, stability, inbred, rng) {
  const out = {};
  for (const k of TRAITS) {
    const u = rng.next();
    const noise = (rng.next() * 2 - 1) * B.noise * (1 - stability);
    let v = mother[k] + (father[k] - mother[k]) * u + noise;
    if (k === 'R' && inbred) v -= B.inbreedResilience;
    out[k] = Math.max(0, Math.min(G.traitMax, Math.round(v)));
  }
  return out;
}

/** Parent record of a plant (mother) or a pollen sample (father). */
const parentOf = (x) => ({
  genome: x.genome, lineId: x.lineId ?? null, stability: x.stability || 0, filial: x.filial || 0, strainKey: x.strainKey,
});

/**
 * Make the seeds of a crossed female. Two parents of the same registered line
 * stay in it (stability +0.2, -2 Resilience); anything else starts a new line
 * at 0.2 (F1). Returns the seed records (also pushed to player.bredSeeds).
 */
export function makeSeeds(state, mother, father, health) {
  const m = parentOf(mother), f = parentOf(father);
  const same = m.lineId != null && m.lineId === f.lineId && !!lineOf(state, m.lineId);
  const n = B.seedsBase + Math.floor(health / B.seedsPerHealth);
  const stability = same ? Math.min(1, r2(Math.min(m.stability, f.stability) + B.stabilityStep)) : B.f1Stability;
  const filial = same ? Math.max(m.filial, f.filial) + 1 : 1;
  let line;
  if (same) line = lineOf(state, m.lineId);
  else {
    const id = state.nextId++;
    const seq = (state.player.lineSeq = (state.player.lineSeq || 0) + 1);
    line = linesOf(state)[id] = {
      id, label: `Hybrid ${seq}`, name: null, stability: 0, filial: 0, hypeG: 0,
      founders: [mother.strainName, father.strainName],
    };
  }
  line.stability = Math.max(line.stability, stability);
  line.filial = Math.max(line.filial, filial);
  const seeds = withGeneticsRng(state, (rng) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const genome = crossGenome(m.genome, f.genome, stability, same, rng);
      out.push({ genome, lineId: line.id, stability, filial, strainKey: m.strainKey, male: rng.next() < B.maleChance });
    }
    return out;
  });
  const bag = state.player.bredSeeds || (state.player.bredSeeds = []);
  bag.push(...seeds);
  return seeds;
}

/** Register a line (stability 0.8+, 16 characters, unique). Renames everything that carries it. */
export function nameLine(state, id, raw) {
  const line = lineOf(state, id);
  const name = String(raw || '').trim();
  if (!breedingUnlocked(state)) return { ok: false, msg: 'Breeding unlocks at Grower level 6.' };
  if (!line) return { ok: false, msg: 'No such line.' };
  if (line.name) return { ok: false, msg: 'That line already has a name.' };
  if (line.stability < B.nameStability) return { ok: false, msg: `A line must reach stability ${B.nameStability * 100}% to be named.` };
  if (name.length < 1 || name.length > B.nameMax) return { ok: false, msg: `Names are 1-${B.nameMax} characters.` };
  const taken = [...Object.values(CONFIG.strains).map((s) => s.name), ...Object.values(linesOf(state)).map((l) => lineName(l))];
  if (taken.some((n) => n.toLowerCase() === name.toLowerCase())) return { ok: false, msg: 'That name is taken.' };
  line.name = name;
  for (const pl of state.plants) if (pl.lineId === id) pl.strainName = name;
  for (const b of state.product) if (b.lineId === id) b.strainName = name;
  return { ok: true, msg: `Registered: ${name}.` };
}

/** Named strains sell for more: +15% at trust 3+, rising to +30% with hype. */
export function hypeOf(line) {
  return Math.min(B.hypeMax, Math.floor((line.hypeG || 0) / B.hypeGramsPer));
}
export function namedBonus(state, batch, trustLevel) {
  const line = lineOf(state, batch.lineId);
  if (!line || !line.name || trustLevel < B.namedTrust) return 0;
  return B.namedBonus + (B.hypeMaxBonus - B.namedBonus) * hypeOf(line) / B.hypeMax;
}

/** Seed groups for the lineage view and the planting picker. */
export function seedGroups(state) {
  const groups = new Map();
  for (const s of state.player.bredSeeds || []) {
    const key = `${s.lineId}|${s.stability}`;
    const g = groups.get(key) || { key, lineId: s.lineId, stability: s.stability, filial: s.filial, count: 0, sum: 0 };
    g.count++; g.sum += traitSum(s.genome);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({ ...g, avgSum: Math.round(g.sum / g.count) }));
}
