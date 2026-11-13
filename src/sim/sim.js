// sim.js — the 2 Hz simulation step in plan §B3 order, shared by the browser
// loop, tests and the balance bot, plus the jail/bail time skip. Pure module.

import { CONFIG } from '../config.js';
import { stepTime } from './time.js';
import { stepPlants } from './plants.js';
import { stepHeat, hs } from './heat.js';
import { stepEconomy } from './economy.js';
import { stepSpawn } from '../entities/spawn.js';
import { stepThreats } from './threats.js';
import { recoverPlayer } from '../entities/combat.js';

const SIM_DT = 1 / CONFIG.loop.simHz;
const nowGh = (s) => s.time.day * 24 + s.time.hour;

export function stepSim(s, dtReal) {
  if (s.gameOver) return;
  s.simTicks++;
  const gh = dtReal / CONFIG.clock.secPerGh;
  stepTime(s, dtReal);
  stepPlants(s, gh);
  stepHeat(s, gh);
  stepEconomy(s, gh);
  stepSpawn(s);
  stepThreats(s, dtReal);
  const h = hs(s);
  if (s.threats.downed) { s.threats.downed = false; skipDays(s, 0); } // woke at the clinic
  if (h.pendingSkip > 0) {
    const days = h.pendingSkip;
    h.pendingSkip = 0;
    skipDays(s, days);
  }
  if (s.player.downed && !h.jailed) recoverPlayer(s);
}

/**
 * Lose `days` days (bail 1, jail 4): run the sim to the next 06:00, plus that
 * many whole days. Plants only survive with a drip kit (owned or
 * placed); gardener and ally care arrive with M6/M9.
 */
export function skipDays(state, days) {
  const h = hs(state);
  const wake = CONFIG.clock.wakeHour;
  const first = state.time.hour < wake ? state.time.day * 24 + wake : (state.time.day + 1) * 24 + wake;
  const target = first + days * 24; // the rest of today, then the lost day(s)
  const held = state.events.length;
  h.jailed = true;
  state.sleeping = false;
  while (nowGh(state) < target - 1e-6 && !state.gameOver) {
    const cared = (state.player.inv.drip || 0) > 0 || state.objects.some((o) => o.kind === 'drip');
    if (cared) for (const p of state.plants) { p.moisture = Math.max(p.moisture, 50); p.nutrients = Math.max(p.nutrients, 50); }
    stepSim(state, SIM_DT);
  }
  h.jailed = false;
  state.player.awakeHours = 0;
  // Keep notices, game over and one dawn from the skipped days.
  const kept = state.events.splice(held).filter((e) => e.type === 'notice' || e.type === 'gameOver');
  state.events.push(...kept, { type: 'skipped', days });
}
