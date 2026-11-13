// genetics.js — genome ops (plan §A4 Genome, §B9 src/sim/genetics.js).
// Pure module: no window/document, runs unmodified in Node (plan §B3 rule).
//
// M2 scope: seed variance only. Clone drift and generations arrive in M7,
// crossing + stability in M11 — both reuse this one genome model (plan §A17).

import { CONFIG } from '../config.js';

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
