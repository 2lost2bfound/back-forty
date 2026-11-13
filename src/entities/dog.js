// dog.js — the guard dog's data and shop-side actions (plan §A6). The dog's
// AI step lives in sim/threats.js (it needs the thieves). Pure module.

import { CONFIG } from '../config.js';

const D = CONFIG.threats.dog;
const TS = CONFIG.world.tile;

/** Where the dog waits: a few tiles outside the shack door. */
export function dogHomeX() {
  const b = CONFIG.world.buildings.find((x) => x.key === 'shack');
  return (b.x + b.w - 1 + D.homeTiles) * TS;
}

export const dogHurt = (state) => !!(state.threats && state.threats.dog && state.threats.dog.hp <= 0);

/** Walt sells one dog ($300). The caller charges the money. */
export function canBuyDog(state) {
  return !(state.threats && state.threats.dog);
}

export function giveDog(state) {
  state.threats.dog = {
    x: dogHomeX(), hp: D.hp, state: 'idle', fedDay: state.time.day, hungry: 0,
  };
}

/** Vet at the clinic heals a hurt dog. */
export function healDog(state) {
  state.threats.dog.hp = D.hp;
  state.threats.dog.state = 'idle';
}
