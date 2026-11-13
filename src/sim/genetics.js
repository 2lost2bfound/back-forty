// genetics.js — genome ops (plan §A4 Genome, §B9 src/sim/genetics.js).
// Pure module: no window/document, runs unmodified in Node (plan §B3 rule).
//
// Seed variance (M2) and clone drift (M7) live here;
// crossing + stability arrive in M11 and reuse this one genome model (plan §A17).

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

export function cloneGenome(mother, strainKey, care, rng) {
  const base = baseGenome(strainKey);
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
