// addiction.js — System 9 (plan §A12): crank, blues, booze and your own weed.
// Pure module: no window/document. State lives in state.addiction (saved, with
// its own PRNG stream so older systems' draws never shift). Time is absolute
// game hours (day*24 + hour). The per-substance dependence D escalates on use,
// falls daily, and the overall stage (Casual/Hooked/Addicted) is the highest.

import { CONFIG } from '../config.js';
import { createRng } from '../rng.js';
import { checkLose } from './license.js';
import { addHeat, payFine, hs } from './heat.js';

const A = CONFIG.addiction;
const TS = CONFIG.world.tile;
export const SUBSTANCES = Object.keys(A.substances);
const nowGh = (s) => s.time.day * 24 + s.time.hour;
const dayKeyOf = (t) => Math.floor((t - CONFIG.clock.wakeHour) / 24);
const lvl = (d) => (d >= A.addictedAt ? 2 : d >= A.hookedAt ? 1 : 0);
const LEVEL = ['casual', 'hooked', 'addicted'];

export function initAddiction(seed = 1) {
  const subs = {};
  for (const k of SUBSTANCES) subs[k] = { d: 0, peak: 0, lastUse: null, buffUntil: 0, crashUntil: 0, usedToday: false };
  return {
    rngState: (seed ^ 0xadd1c7) >>> 0,
    subs, weedUntil: 0, doses: [], overdoses: 0, odLoss: 0, permLoss: 0, cleanDays: 0,
    dayKey: null, hooked: false, recovery: null, clean: false,
    cravingAt: null, cravingUntil: 0, boozeCravingDay: null,
    taperUntil: 0, sponsor: false, nextCheck: 0,
  };
}

export const addOf = (state) => state.addiction || (state.addiction = initAddiction(state.seed));

function rngOf(state, fn) {
  const a = addOf(state);
  const rng = createRng(a.rngState);
  const out = fn(rng);
  a.rngState = rng.state;
  return out;
}

const toast = (state, msg) => state.events.push({ type: 'toast', msg });
const weedOn = (a, t) => t < a.weedUntil;

/** Overall picture right now: stage 0-2, withdrawal tier 0-2, penalty row, craving. */
export function derive(state) {
  const a = addOf(state);
  const t = nowGh(state);
  let stage = 0, wd = 0;
  const due = {};
  for (const k of SUBSTANCES) {
    const sub = a.subs[k];
    const st = lvl(sub.d);
    if (st > stage) stage = st;
    if (st === 0) continue;
    const at = (sub.lastUse === null ? -1e9 : sub.lastUse) + A.windowGh[LEVEL[st]];
    if (t > at) { due[k] = at; if (st > wd) wd = st; }
  }
  const taper = a.taperUntil > t;
  if (taper) { wd = 0; for (const k in due) delete due[k]; }
  let pen = null;
  if (!taper) pen = wd === 2 ? A.addictedWithdrawal : wd === 1 ? A.hookedWithdrawal : stage === 2 ? A.baseline : null;
  return { stage, wd, taper, pen, due, craving: t < a.cravingUntil, weed: weedOn(a, t), t };
}

const penScale = (d) => (d.weed ? A.weed.penaltyMult : 1);

/** Multiplier on every tending action's duration. */
export function tendMult(state) {
  const a = addOf(state);
  const d = derive(state);
  let m = d.pen ? 1 + (d.pen.tend - 1) * penScale(d) : 1;
  const c = a.subs.crank;
  if (d.t < c.buffUntil) m *= A.substances.crank.tendMult;
  else if (d.t < c.crashUntil) m *= A.substances.crank.crashTendMult;
  if (d.weed) m *= A.weed.tendMult;
  if (d.craving) m *= A.recovery.cravingTendMult;
  return m;
}

/** Crank: immune to Tired while it lasts. */
export const tiredImmune = (state) => nowGh(state) < addOf(state).subs.crank.buffUntil;

export function moveMult(state) {
  const c = addOf(state).subs.crank;
  const t = nowGh(state);
  return t < c.buffUntil ? A.substances.crank.moveMult : t < c.crashUntil ? A.substances.crank.crashMoveMult : 1;
}

/** Fraction of the stamina bar available (withdrawal, baseline, taper). */
export function staminaMult(state) {
  const d = derive(state);
  let loss = d.pen ? d.pen.stamina * penScale(d) : 0;
  if (d.taper) loss += A.taper.stamina;
  return 1 - loss;
}

/** Max HP: 100 minus permanent losses and the Addicted penalty (Blues is worse). */
export function maxHp(state) {
  const a = addOf(state);
  const d = derive(state);
  let loss = a.permLoss + a.odLoss;
  if (d.pen) loss += (a.subs.blues.d >= A.addictedAt ? d.pen.hpBlues : d.pen.hp) * penScale(d);
  return CONFIG.combat.playerHp - Math.round(loss);
}

/** Damage taken multiplier (Blues). */
export const damageMult = (state) => (nowGh(state) < addOf(state).subs.blues.buffUntil ? A.substances.blues.damageMult : 1);

/** Friendship gain multiplier (Booze); M9's allies read this. */
export const friendshipMult = (state) => (nowGh(state) < addOf(state).subs.booze.buffUntil ? A.substances.booze.friendshipMult : 1);

/** Buyers at trust 2 or less pay -10% while you are Addicted (plan §A12). */
export const buyerPenalty = (state, level) => (level <= 2 && derive(state).stage === 2 ? 0.9 : 1);

/** Does this tend action go wrong? One draw per call, always. */
export function rollFumble(state) {
  const d = derive(state);
  const p = d.pen ? d.pen.fumble * penScale(d) : 0;
  const hit = rngOf(state, (r) => r.next()) < p;
  if (hit) toast(state, 'Your hands shake and you overdo it.');
  return hit;
}

/** Dealer price for Moss: +10% per 20 D on that substance, up to +50%. */
export function dealerPrice(state, key) {
  const D = A.dealer;
  const mark = Math.min(D.markupMax, D.markupStep * Math.floor(addOf(state).subs[key].d / D.markupPer));
  return Math.round(CONFIG.economy.prices[key] * (1 + mark));
}

// ------------------------------------------------------------------ use ---

/** Take a substance. Hard drugs come from the inventory (unless `free`), weed from product. */
export function useSubstance(state, key, { free = false } = {}) {
  const a = addOf(state);
  const p = state.player;
  const t = nowGh(state);
  if (state.gameOver) return { ok: false, msg: '' };
  if (key === 'weed') {
    const b = state.product.find((x) => x.where === 'inv' && x.grams >= A.weed.grams);
    if (!b) return { ok: false, msg: 'You have no product to smoke.' };
    b.grams -= A.weed.grams;
    if (b.grams <= 0) state.product.splice(state.product.indexOf(b), 1);
    a.weedUntil = t + A.weed.buffGh;
    return { ok: true, msg: 'You smoke a little of your own. Easier now.' };
  }
  const def = A.substances[key];
  if (!def) return { ok: false, msg: 'Unknown substance.' };
  if (def.hard && !free) {
    if ((p.inv[key] || 0) <= 0) return { ok: false, msg: `You have no ${CONFIG.itemNames[key]}.` };
    p.inv[key]--;
  }
  const sub = a.subs[key];
  let d = sub.d + def.gain * (1 + sub.d / 100);
  // Relapse: history snaps D back up (plan §A12 Relapse).
  if (sub.peak >= A.hookedAt && (a.recovery || a.clean)) {
    d = Math.max(d, sub.peak * (a.recovery ? A.recovery.relapseSnap : A.recovery.cleanSnap));
    if (d >= A.hookedAt) { a.recovery = null; a.clean = false; a.cravingAt = null; }
  }
  if (key === 'booze' && a.recovery && a.boozeCravingDay !== a.dayKey) {
    a.boozeCravingDay = a.dayKey;
    a.cravingUntil = t + A.recovery.cravingGh;
  }
  sub.d = Math.min(A.dMax, d);
  sub.peak = Math.max(sub.peak, sub.d);
  sub.lastUse = t; sub.usedToday = true;
  sub.buffUntil = t + def.buffGh * (1 - sub.d / A.tolerancePerD);
  sub.crashUntil = def.crashGh ? sub.buffUntil + def.crashGh : 0;
  if (def.heal) p.hp = Math.min(maxHp(state), p.hp + def.heal);
  settle(state);
  if (def.hard) {
    state.events.push({ type: 'hardUse' }); // M9: witnessing allies lose friendship
    const O = A.overdose;
    a.doses = a.doses.filter((x) => t - x < O.windowGh);
    a.doses.push(t);
    if (a.doses.length >= O.from && rngOf(state, (r) => r.next()) < O.chance + (a.doses.length - O.from) * O.step) {
      overdose(state);
      return { ok: true, msg: 'You overdosed.' };
    }
  }
  return { ok: true, msg: `You take the ${CONFIG.itemNames[key] || key}.` };
}

function overdose(state) {
  const a = addOf(state);
  const p = state.player;
  const O = A.overdose;
  a.overdoses++;
  a.odLoss += O.hpLoss;
  a.doses = [];
  for (const k of SUBSTANCES) { a.subs[k].buffUntil = 0; a.subs[k].crashUntil = 0; }
  checkLose(state);
  if (state.gameOver) return;
  p.downed = true; p.heal = 0; p.hp = 0; p.action = null;
  payFine(state, O.bill);
  addHeat(state, O.heat, 'Overdose');
  const t = state.threats;
  t.downed = true;
  t.news.push(`You woke at the clinic after an overdose. It cost $${O.bill}, and your health will not fully come back.`);
  state.events.push({ type: 'overdose', count: a.overdoses });
}

/** Stage bookkeeping: entering Hooked arms recovery for when D falls under it. */
function settle(state) {
  const a = addOf(state);
  const t = nowGh(state);
  const top = Math.max(...SUBSTANCES.map((k) => a.subs[k].d));
  if (top >= A.hookedAt) { a.hooked = true; a.recovery = null; a.clean = false; a.cravingAt = null; }
  else if (a.hooked) {
    a.hooked = false;
    a.recovery = { start: t };
    a.cravingAt = t + rngOf(state, (r) => r.next()) * 24;
  }
}

/** A stress event (raid, break-in, crew busted, ally hurt) triggers a craving in recovery. */
export function stressEvent(state) {
  const a = addOf(state);
  if (a.recovery && !a.sponsor) a.cravingUntil = Math.max(a.cravingUntil, nowGh(state) + A.recovery.cravingGh);
}

// ------------------------------------------------------------- recovery ---

/** Clinic taper kit: $100 a day; rebuy before it lapses or it is cancelled. */
export function canTaper(state) {
  const a = addOf(state);
  return a.taperUntil - nowGh(state) <= A.taper.rebuyWithinGh;
}
export function startTaper(state) {
  const a = addOf(state);
  a.taperUntil = Math.max(a.taperUntil, nowGh(state)) + A.taper.coverGh;
  return { ok: true, msg: 'Taper kit: the cravings ease for a day.' };
}

/** Clinic detox: D to 15, three days away (plants need cover). */
export function detox(state) {
  const a = addOf(state);
  for (const k of SUBSTANCES) {
    const s = a.subs[k];
    s.d = Math.min(s.d, A.detox.setTo);
    s.buffUntil = 0; s.crashUntil = 0;
  }
  a.cravingUntil = 0;
  settle(state);
  hs(state).pendingSkip = A.detox.days;
  return { ok: true, msg: `Detox: ${A.detox.days} days pass.` };
}

function daily(state) {
  const a = addOf(state);
  const t = nowGh(state);
  const stage = derive(state).stage;
  const taper = a.taperUntil >= t;
  for (const k of SUBSTANCES) {
    const s = a.subs[k];
    if (s.d > 0) {
      const fall = taper ? A.fallPerDay.taper : s.usedToday ? 0 : s.d < A.hookedAt ? A.fallPerDay.casual : A.fallPerDay.coldTurkey;
      s.d = Math.max(0, s.d - fall);
    }
    s.usedToday = false;
  }
  if (stage === 2) {
    a.permLoss = Math.min(CONFIG.combat.playerHp - A.permHpFloor, a.permLoss + A.permHpPerDay);
    a.cleanDays = 0;
  } else if (++a.cleanDays > A.permHpRegainAfterDays) a.permLoss = Math.max(0, a.permLoss - A.permHpPerDay);
  settle(state);
  if (a.recovery && t - a.recovery.start >= A.recovery.days * 24) { a.recovery = null; a.clean = true; a.cravingAt = null; }
  if (a.recovery) a.cravingAt = t + rngOf(state, (r) => r.next()) * 24;
}

// ----------------------------------------------------------------- step ---

const mossDoor = () => {
  const b = CONFIG.world.buildings.find((x) => x.key === CONFIG.economy.alley.building);
  return b.x + b.w - 1;
};
const mossOpen = (hour) => {
  const { open, close } = CONFIG.economy.alley;
  return open <= close ? hour >= open && hour < close : hour >= open || hour < close;
};

/** The 2 Hz addiction step (plan §B3: after threats). */
export function stepAddiction(state) {
  const a = addOf(state);
  const p = state.player;
  const t = nowGh(state);
  const k = dayKeyOf(t);
  if (a.dayKey === null) a.dayKey = k;
  for (let n = 0; a.dayKey < k && n < 400; n++) { a.dayKey++; daily(state); }
  if (a.cravingAt !== null && t >= a.cravingAt) { a.cravingUntil = t + A.recovery.cravingGh; a.cravingAt = null; }
  const d = derive(state);
  p.addicted = d.stage === 2;
  p.drunk = t < a.subs.booze.buffUntil;
  hs(state).withdrawal = d.wd > 0;
  const mh = maxHp(state);
  if (p.hp > mh && !p.downed) p.hp = mh;
  if (p.downed || state.gameOver) return;

  // Compulsion (Addicted): after 6 gh of withdrawal a dose you carry is taken.
  const C = A.compulsion;
  const hard = SUBSTANCES.filter((s) => A.substances[s].hard);
  for (const s of hard) {
    if (a.subs[s].d >= A.addictedAt && d.due[s] !== undefined && t - d.due[s] >= C.afterWithdrawalGh && (p.inv[s] || 0) > 0) {
      toast(state, `You can't stop yourself. You take the ${CONFIG.itemNames[s]}.`);
      useSubstance(state, s);
      return;
    }
  }
  if (t < a.nextCheck) return;
  a.nextCheck = t + C.checkGh;
  const px = (p.x + p.w / 2) / TS;
  if (Math.abs(px - mossDoor()) > C.mossTiles || !mossOpen(state.time.hour)) return;
  let target = null, chance = 0;
  const wdSub = hard.find((s) => a.subs[s].d >= A.addictedAt && d.due[s] !== undefined);
  if (wdSub) { target = wdSub; chance = C.mossChance; }
  else if (d.craving) { target = hard.slice().sort((x, y) => a.subs[y].peak - a.subs[x].peak)[0]; chance = C.cravingChance; }
  if (!target || a.subs[target].peak < A.hookedAt) return;
  if (a.sponsor) chance *= C.sponsorMult;
  const price = dealerPrice(state, target);
  if (p.cash < price || rngOf(state, (r) => r.next()) >= chance) return;
  p.cash -= price;
  p.locS = C.controlLossS;
  toast(state, `Your feet carry you to Moss. You buy and take the ${CONFIG.itemNames[target]}.`);
  useSubstance(state, target, { free: true });
}

/** Everything the status panel and HUD show. */
export function status(state) {
  const a = addOf(state);
  const d = derive(state);
  const t = d.t;
  const subs = SUBSTANCES.map((k) => ({
    key: k, d: Math.round(a.subs[k].d), stage: LEVEL[lvl(a.subs[k].d)],
    buffLeft: Math.max(0, a.subs[k].buffUntil - t), crashLeft: Math.max(0, a.subs[k].crashUntil - t),
    withdrawing: d.due[k] !== undefined,
  }));
  return {
    stage: LEVEL[d.stage], withdrawal: d.wd > 0, taper: d.taper, craving: d.craving, weedLeft: Math.max(0, a.weedUntil - t),
    recovery: a.recovery ? Math.max(0, A.recovery.days - (t - a.recovery.start) / 24) : null, clean: a.clean,
    overdoses: a.overdoses, maxHp: maxHp(state), subs,
  };
}
