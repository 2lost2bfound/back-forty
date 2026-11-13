// rng.js — one seeded PRNG (mulberry32) for the whole game.
// The state is a single uint32 that goes into the save (state.rngState), so
// tests, tools/balance.js and replays are all deterministic. Pure module:
// no window/document, runs unmodified in Node (plan §B3 rule).

export function createRng(seed) {
  let state = seed >>> 0;

  const rng = {
    // Serializable state (JSON.stringify picks up the accessor).
    get state() { return state; },
    set state(v) { state = v >>> 0; },

    /** Uniform float in [0, 1). */
    next() {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },

    /** Uniform integer in [0, maxExclusive). */
    int(maxExclusive) {
      return Math.floor(rng.next() * maxExclusive);
    },

    /** Uniform float in [min, max). */
    range(min, max) {
      return min + rng.next() * (max - min);
    },

    /** Uniform integer in [min, maxInclusive]. */
    intRange(min, maxInclusive) {
      return min + rng.int(maxInclusive - min + 1);
    },

    /** True with probability p (0..1). */
    chance(p) {
      return rng.next() < p;
    },

    /** Random element of an array. */
    pick(arr) {
      return arr[rng.int(arr.length)];
    },
  };

  return rng;
}
