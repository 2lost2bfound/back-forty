// license.js — lose conditions, the farm-stand front, laundering, the license
// application/review/win, Washed-out and Legacy mode (plan §A14, §A15,
// My Addition 1). Pure module: no window/document, runs unmodified in Node.
//
// Money model: Cash is dirty (sales pay cash, raids seize cash); Bank is clean
// (laundered, fines are taken from it first, the license fee is paid from it).

import { CONFIG } from '../config.js';
import { hs, noteSpend } from './heat.js';
import { shopOpen } from './economy.js';
import { lineOf } from './genetics.js';

const L = CONFIG.license;
const CUP = CONFIG.cup;
const nowGh = (s) => s.time.day * 24 + s.time.hour;

export function initLicense() {
  return {
    frontOwned: false, upgraded: false, launderCap: 0,
    launderDay: -1, launderedToday: 0, totalLaundered: 0, feesPaid: 0,
    sampleOk: false, applied: null, inspecting: null, granted: null,
    lastArrestDay: -99, rejections: 0,
    brokeSince: null, rescued: false,
  };
}

export const lic = (state) => state.license || (state.license = initLicense());

/** Difficulty multiplier for threat chances and heat gains (My Addition 13). */
export const difficultyMult = (state) => (CONFIG.difficulty[state.difficulty] || CONFIG.difficulty.standard).mult;

/** Legacy mode (after the win): growing and selling no longer raise heat. */
export const legacyQuiet = (state) => !!state.legacy;

// ------------------------------------------------------------ lose -------

/** Third arrest / third overdose = game over. Idempotent. */
export function checkLose(state) {
  if (!state.gameOver && (state.player.arrests || 0) >= CONFIG.heat.raid.maxArrests) {
    state.gameOver = { reason: 'prison' };
    state.events.push({ type: 'gameOver', reason: 'prison' });
  }
  if (!state.gameOver && state.addiction && state.addiction.overdoses >= CONFIG.addiction.overdose.fatal) {
    state.gameOver = { reason: 'overdose' };
    state.events.push({ type: 'gameOver', reason: 'overdose' });
  }
}

const seedCount = (p) => (p.inv.seeds || 0) + (p.inv.seeds_blue || 0) + (p.inv.seeds_widow || 0) + (p.cuttings || []).length;

/** Is the player washed out right now: broke, with nothing to grow or sell? */
export function isBroke(state) {
  const p = state.player;
  return p.cash + (p.bank || 0) < L.washed.money && seedCount(p) === 0 &&
    state.product.length === 0 && !state.plants.some((pl) => !pl.dead);
}

/**
 * Washed out (plan §A15): broke with nothing to grow for 48 gh. The first
 * time Skeet fronts two Ditch Weed seeds (bankruptcy rescue); the second is
 * game over.
 */
function stepWashed(state) {
  const l = lic(state);
  if (!isBroke(state)) { l.brokeSince = null; return; }
  if (l.brokeSince === null) l.brokeSince = nowGh(state);
  if (nowGh(state) - l.brokeSince < L.washed.hours) return;
  l.brokeSince = null;
  if (!l.rescued) {
    l.rescued = true;
    state.player.inv.seeds = (state.player.inv.seeds || 0) + L.washed.rescueSeeds;
    state.events.push({ type: 'notice', title: 'Bankrupt', lines: [
      'You are broke with nothing growing. Skeet fronts you two Ditch Weed seeds, once.',
      'If it happens again, you are washed out for good.'] });
  } else if (!state.gameOver) {
    state.gameOver = { reason: 'washedout' };
    state.events.push({ type: 'gameOver', reason: 'washedout' });
  }
}

// ------------------------------------------------------- front + bank ----

/** Spend money: cash (dirty) first, then the bank. Dirty spending counts toward flashy heat. */
export function spendMoney(state, amount) {
  const p = state.player;
  if (p.cash + (p.bank || 0) < amount) return false;
  const cash = Math.min(p.cash, amount);
  p.cash -= cash;
  p.bank = Math.round(((p.bank || 0) - (amount - cash)) * 100) / 100;
  if (cash > 0) noteSpend(state, cash);
  return true;
}

export const canAfford = (state, amount) => state.player.cash + (state.player.bank || 0) >= amount;

/** Buy the farm-stand permit ($3,000): builds the stand on the lot's road edge. */
export function buyFront(state) {
  const l = lic(state);
  if (l.frontOwned) return { ok: false, msg: 'You already own the farm stand.' };
  if (!spendMoney(state, CONFIG.economy.prices.permit)) return { ok: false, msg: 'Not enough money.' };
  l.frontOwned = true;
  l.launderCap = L.front.cap;
  const x = L.front.x;
  state.objects.push({ id: state.nextId++, kind: 'farmstand', x, y: state.surface[x] - 1 });
  return { ok: true, msg: `The farm stand is open. It launders up to $${l.launderCap} of cash a day.` };
}

export function upgradeFront(state) {
  const l = lic(state);
  if (!l.frontOwned) return { ok: false, msg: 'You need the farm stand first.' };
  if (l.upgraded) return { ok: false, msg: 'Already upgraded.' };
  if (!spendMoney(state, L.front.upgradeCost)) return { ok: false, msg: 'Not enough money.' };
  l.upgraded = true;
  l.launderCap = L.front.upgradeCap;
  return { ok: true, msg: `The stand now launders up to $${l.launderCap} a day.` };
}

/** Cash the stand can still launder today. */
export function launderRoom(state) {
  const l = lic(state);
  if (!l.frontOwned) return 0;
  return Math.max(0, l.launderCap - (l.launderDay === state.time.day ? l.launderedToday : 0));
}

/** Launder up to `amount` of cash (default all) into the bank at the front's fee. */
export function launder(state, amount = Infinity) {
  const l = lic(state);
  if (!l.frontOwned) return { ok: false, msg: 'You need a farm-stand front to launder.' };
  if (l.launderDay !== state.time.day) { l.launderDay = state.time.day; l.launderedToday = 0; }
  const amt = Math.floor(Math.min(amount, launderRoom(state), state.player.cash));
  if (amt <= 0) return { ok: false, msg: launderRoom(state) <= 0 ? 'The stand has laundered its limit today.' : 'No cash to launder.' };
  const fee = Math.round(amt * L.front.fee);
  state.player.cash -= amt;
  state.player.bank = Math.round(((state.player.bank || 0) + amt - fee) * 100) / 100; // whole cents
  l.launderedToday += amt; l.totalLaundered += amt; l.feesPaid += fee;
  return { ok: true, amount: amt, fee, msg: `Laundered $${amt}: $${amt - fee} to the bank after a $${fee} fee.` };
}

// ---------------------------------------------------- license process ----

/** The six requirements, each {key, label, ok, detail} (plan §A14). */
export function licenseReqs(state) {
  const l = lic(state);
  const p = state.player;
  const heat = state.heat;
  return [
    { key: 'bank', label: `$${L.bankRequired} in the Bank`, ok: (p.bank || 0) >= L.bankRequired, detail: `$${Math.round(p.bank || 0)}` },
    { key: 'front', label: 'Own the farm-stand front', ok: l.frontOwned, detail: l.frontOwned ? 'owned' : 'not owned' },
    { key: 'level', label: `Grower level ${L.level}`, ok: p.level >= L.level, detail: `level ${p.level}` },
    { key: 'sample', label: `Submit a ${L.sample.grams} g sample of quality ${L.sample.quality}+`, ok: l.sampleOk, detail: l.sampleOk ? 'accepted' : 'not submitted' },
    { key: 'heat', label: `Heat ${L.heatMax} or less`, ok: heat <= L.heatMax, detail: `heat ${Math.round(heat)}` },
    { key: 'arrest', label: `No arrest in ${L.arrestFreeDays} days, no unpaid fines`,
      ok: state.time.day - l.lastArrestDay > L.arrestFreeDays && !(p.debt > 0),
      detail: p.debt > 0 ? `$${Math.round(p.debt)} unpaid` : 'clean' },
  ];
}

/** Hand the clerk a sample: takes 28 g of a dry inventory batch of quality 70+. */
export function submitSample(state) {
  const l = lic(state);
  if (l.sampleOk) return { ok: false, msg: 'Your sample is already on file.' };
  const b = state.product.find((x) => x.where === 'inv' && !x.wet && x.quality >= L.sample.quality && x.grams >= L.sample.grams);
  if (!b) return { ok: false, msg: `You need ${L.sample.grams} g of dry product at quality ${L.sample.quality}+ in your pack.` };
  b.grams -= L.sample.grams;
  if (b.grams <= 1e-6) state.product.splice(state.product.indexOf(b), 1);
  l.sampleOk = true;
  return { ok: true, msg: 'The clerk logs your sample.' };
}

/** Apply for the license at the town hall (open hours). Starts the 3-day review. */
export function applyLicense(state) {
  const l = lic(state);
  if (l.granted) return { ok: false, msg: 'You already hold the license.' };
  if (l.applied) return { ok: false, msg: 'Your application is under review.' };
  if (!shopOpen(state.time, 'townhall')) return { ok: false, msg: 'The town hall is closed.' };
  const bad = licenseReqs(state).find((r) => !r.ok);
  if (bad) return { ok: false, msg: `Not yet: ${bad.label} (${bad.detail}).` };
  const now = nowGh(state);
  l.applied = { day: state.time.day, at: now, inspectAt: (state.time.day + L.reviewDays) * 24 + L.inspectHour };
  l.inspecting = null;
  state.events.push({ type: 'notice', title: 'Application filed', lines: [
    `The review takes ${L.reviewDays} days. Keep heat at ${L.heatMax} or less, stay out of trouble and keep the money in the bank.`,
    `An inspector walks your lot on day ${state.time.day + L.reviewDays} at ${L.inspectHour}:00.`] });
  return { ok: true, msg: 'Application filed.' };
}

function reject(state, why) {
  const l = lic(state);
  l.applied = null; l.inspecting = null; l.rejections++;
  state.events.push({ type: 'notice', title: 'Application rejected', lines: [why, 'You may apply again when the requirements hold.'] });
}

/** The win: a license, run stats, and the option to continue in Legacy mode. */
function grant(state) {
  const l = lic(state);
  l.granted = { day: state.time.day };
  l.applied = null; l.inspecting = null;
  state.won = {
    day: state.time.day, gross: Math.round(state.economy.gross), level: state.player.level,
    arrests: state.player.arrests, overdoses: state.addiction ? state.addiction.overdoses : 0,
    bank: Math.round(state.player.bank || 0), laundered: Math.round(l.totalLaundered), fees: Math.round(l.feesPaid),
    heat: Math.round(state.heat),
  };
  state.events.push({ type: 'win', stats: state.won });
}

/** Continue after the win: no heat from growing or selling; thieves and Dale remain. */
export function enterLegacy(state) {
  if (!state.won) return false;
  state.legacy = true;
  return true;
}

// ------------------------------------------------------ Harvest Cup -------
// Legacy mode only (plan §A11): every 28 days the town judges the entries. A
// named strain with trait sum 320+ at stability 1.0 wins. Entering costs 28 g
// of the strain's dry bud; one entry at a time.

export const cupOf = (state) => { const l = lic(state); return l.cup || (l.cup = { entry: null, wins: 0, last: null }); };

/** The next judging day: a multiple of 28, today if it is not yet judging hour. */
export function nextCupDay(state) {
  const t = state.time;
  let d = Math.ceil(t.day / CUP.everyDays) * CUP.everyDays;
  if (d === t.day && t.hour >= CUP.judgeHour) d += CUP.everyDays;
  return d;
}

/** Dry, named, bred bud in the pack that could be entered. */
export function cupBatches(state) {
  return state.product.filter((b) => b.where === 'inv' && !b.wet && b.grams >= CUP.grams && lineOf(state, b.lineId) && lineOf(state, b.lineId).name);
}

export const cupQualifies = (b) => b.sum >= CUP.sumMin && b.stab >= CUP.stability;

export function enterCup(state, batch) {
  const c = cupOf(state);
  if (!state.legacy) return { ok: false, msg: 'The Harvest Cup is run in Legacy mode, after the license.' };
  if (c.entry) return { ok: false, msg: 'You already have an entry in this year\'s Cup.' };
  if (!shopOpen(state.time, 'townhall')) return { ok: false, msg: 'The town hall is closed.' };
  if (!cupBatches(state).includes(batch)) return { ok: false, msg: `Enter ${CUP.grams} g of dry bud from a named strain.` };
  batch.grams -= CUP.grams;
  if (batch.grams <= 1e-6) state.product.splice(state.product.indexOf(batch), 1);
  const line = lineOf(state, batch.lineId);
  c.entry = { day: nextCupDay(state), lineId: line.id, name: line.name, sum: batch.sum, stab: batch.stab, quality: batch.quality };
  return { ok: true, msg: `${line.name} is entered in the Harvest Cup (judged day ${c.entry.day}).` };
}

function judgeCup(state) {
  const c = cupOf(state);
  const e = c.entry;
  if (!e || !state.legacy || nowGh(state) < e.day * 24 + CUP.judgeHour) return;
  c.entry = null;
  c.last = { ...e, won: cupQualifies(e) };
  if (c.last.won) {
    c.wins++;
    state.events.push({ type: 'cupWin', stats: { day: state.time.day, name: e.name, sum: e.sum, quality: e.quality, wins: c.wins } });
  } else {
    const why = [];
    if (e.sum < CUP.sumMin) why.push(`trait sum ${e.sum} (needs ${CUP.sumMin})`);
    if (e.stab < CUP.stability) why.push(`stability ${Math.round(e.stab * 100)}% (needs 100%)`);
    state.events.push({ type: 'notice', title: 'Harvest Cup', lines: [`${e.name} placed, but did not win: ${why.join(' and ')}.`, `The next Cup is in ${CUP.everyDays} days.`] });
  }
}

/** 2 Hz license step (plan §B3: last in stepSim). */
export function stepLicense(state) {
  const l = lic(state);
  if (state.gameOver) return;
  const a = l.applied;
  if (a) {
    const p = state.player;
    const why = state.heat > L.heatMax ? `Heat rose above ${L.heatMax}.`
      : l.lastArrestDay >= a.day ? 'You were arrested during the review.'
      : p.debt > 0 ? 'You have unpaid fines.'
      : (p.bank || 0) < L.bankRequired ? 'The bank balance fell below the requirement.'
      : hs(state).raid ? 'Police are raiding the lot.' : null;
    if (why) reject(state, why);
    else if (!l.inspecting && nowGh(state) >= a.inspectAt) {
      l.inspecting = { until: nowGh(state) + L.inspectGh };
      state.events.push({ type: 'inspector' });
    } else if (l.inspecting && nowGh(state) >= l.inspecting.until) grant(state);
  }
  judgeCup(state);
  stepWashed(state);
  checkLose(state);
}
