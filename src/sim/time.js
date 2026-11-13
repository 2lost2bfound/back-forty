// time.js — clock, day rollover, sleep fast-forward, weather roll (plan §A3).
// Pure module: no window/document, runs unmodified in Node (plan §B3 rule).
//
// 1 game hour (gh) = 30 real seconds; one sim tick (0.5 s) advances 1/60 gh.
// The game day rolls over at 06:00 (dawn): day++, autosave/weather/heat hooks
// fire via a 'dawn' event. Sleeping runs the sim at 20x until 06:00 and is
// ended by alerts in M5; the countdown here is wall-clock gh, not ticks.
//
// M2 scope: the weather field is rolled at dawn (20% rain / 10% heatwave);
// its effects on plants arrive with M4 (plan build order).

import { CONFIG } from '../config.js';
import { withStateRng } from '../rng.js';

const C = CONFIG.clock;
const W = CONFIG.weather;

/** Advance the clock by dt real seconds. Call once per sim step. */
export function stepTime(state, dt) {
  const gh = dt / C.secPerGh;
  const t = state.time;
  const prevHour = t.hour;
  t.hour += gh;

  // Sleep countdown (plan §A3: 20x until 06:00; the speed itself is applied
  // by the frame loop, which scales simAcc while state.sleeping). Wake within
  // half a tick of the target so float residue in the countdown cannot add a
  // whole extra tick.
  if (state.sleeping) {
    state.sleepRemain -= gh;
    if (state.sleepRemain <= gh / 2) {
      state.sleeping = false;
      state.sleepRemain = 0;
      state.events.push({ type: 'wake' });
    }
  } else {
    state.player.awakeHours += gh;
  }

  // Day rollover at midnight->06:00 boundary: the day increments when the
  // hour passes 24, i.e. the new "day" starts counting at 06:00. Dawn events
  // (autosave, weather roll) fire on that same rollover.
  if (t.hour >= 24) {
    t.hour -= 24;
    t.day += 1;
    state.events.push({ type: 'dawn', day: t.day });
  }

  // Weather rolls once a day at 06:00 (plan §A3); rain refills the barrel.
  if (prevHour < W.rollHour && t.hour >= W.rollHour) t.weather = rollWeather(state);
  if (isRaining(state)) {
    for (const o of state.objects) {
      if (o.kind === 'barrel') o.charges = Math.min(W.barrelMax, (o.charges || 0) + W.rainBarrelPerGh * gh);
    }
  }
}

/** Id of the night this clock reading belongs to (rolls at 06:00; the day
 *  number increments at midnight, so 23:00 and 01:00 share one key). */
export const nightKey = (time) => (time.hour >= C.wakeHour ? time.day + 1 : time.day);

/** Rain is active for rainDurationGh from the 06:00 roll on a rain day. */
export function isRaining(state) {
  const t = state.time;
  return t.weather === 'rain' && t.hour >= W.rollHour && t.hour < W.rollHour + W.rainDurationGh;
}

/** Noise radius multiplier: rain muffles footsteps and gunshots by 30%. */
export const noiseMult = (state) => (isRaining(state) ? W.rainNoiseMult : 1);

/** Weather the HUD should name right now ('clear' when rain has stopped). */
export function weatherNow(state) {
  const w = state.time.weather;
  if (w === 'rain') return isRaining(state) ? 'rain' : 'clear';
  return w;
}

/** One weather roll per day at 06:00: 20% rain, 10% heatwave (plan §A3). */
export function rollWeather(state) {
  return withStateRng(state, (rng) => {
    const r = rng.next();
    if (r < W.rainChance) return 'rain';
    if (r < W.rainChance + W.heatwaveChance) return 'heatwave';
    return 'clear';
  });
}

/** Outdoor sun window (plan §A3: day 06:00-20:00, light factor 1.0).
 *  The hour is rounded to whole game-minutes before comparing so float drift
 *  in the accumulated clock can never flip a boundary tick. */
export function isLitHour(hour) {
  const m = Math.round(hour * 60); // whole game-minutes (unit conversion)
  return m >= C.sunStart * 60 && m < C.sunEnd * 60;
}

/** Flat night tint alpha (M2; per-light punch-out arrives in M4). */
export function nightAlpha(hour) {
  const a = C.nightAlpha;
  const dusk = C.duskHours;
  if (hour < C.sunStart - dusk) return a;            // 00:00-04:00 full night
  if (hour < C.sunStart) return a * (C.sunStart - hour) / dusk; // 04-06 ramp down
  if (hour < C.sunEnd) return 0;                     // day
  if (hour < C.sunEnd + dusk) return a * (hour - C.sunEnd) / dusk; // 20-22 ramp up
  return a;                                          // 22:00-24:00 full night
}

/** Start sleeping: runs the sim at 20x until 06:00 (plan §A3). */
export function sleepStart(state) {
  if (state.sleeping) return false;
  const hour = state.time.hour;
  // Hours until the next 06:00 (sleeping exactly at 06:00 sleeps a full day).
  const remain = hour <= C.wakeHour ? C.wakeHour - hour : 24 - hour + C.wakeHour;
  state.sleeping = true;
  state.sleepRemain = remain;
  state.events.push({ type: 'sleep' });
  return true;
}

/** Is the player Tired? (awake more than 30 gh, plan §A3) */
export function isTired(state) {
  return state.player.awakeHours > CONFIG.player.tiredAfterGh;
}

/** HUD string: "Day 3 14:37". */
export function formatClock(time) {
  const h = Math.floor(time.hour);
  const m = Math.floor((time.hour - h) * 60);
  return `Day ${time.day} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
