// heat.js — the heat meter, its sources, decay, tells, raids and patrol stops
// (plan §A5). Pure module: no window/document, runs unmodified in Node.
//
// state.heat stays a plain number (the meter; M3 code and tests rely on it).
// Everything else lives in state.heatState (saved): floor, itemized daily log,
// bribe/lawyer bookkeeping, the pending raid. Runtime-only: state.cops,
// state.patrolCar, state.tells.
//
// Clock hooks (stepHeat runs every 2 Hz tick): 23:00 pre-roll + deputy tip,
// 03:00 scanner warning, 05:00 raid roll, 06:00 daily heat. The raid decision
// uses the number drawn at 23:00 so the warnings are truthful.

import { CONFIG } from '../config.js';
import { withStateRng } from '../rng.js';
import { stageOf } from './plants.js';
import { checkLose } from './license.js';
import { roomOf, isBuried, visibleFromRoad } from '../world/rooms.js';
import { findPath } from '../world/nav.js';

const H = CONFIG.heat;
const R = H.raid;
const E = CONFIG.economy;
const TS = CONFIG.world.tile;
const nowGh = (s) => s.time.day * 24 + s.time.hour;
const round2 = (v) => Math.round(v * 100) / 100;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

export function initHeatState(time) {
  return {
    floor: H.floorStart,
    log: [], lastLog: [],
    bribeCount: 0, bribeNextDay: 0, lastBribeDay: -99,
    lawyerUntil: 0,
    salesToday: 0, spentToday: 0, flashyDone: false,
    lastHour: time ? time.hour : CONFIG.clock.startHour,
    raidU: null, raid: null, snitched: false,
    jailed: false, pendingSkip: 0,
    firedAtPolice: false, lastCarSlot: -1,
    warnedOfficer: false, officerKilled: false,
  };
}

export const hs = (state) => state.heatState || (state.heatState = initHeatState(state.time));

export function heatTier(heat) {
  let t = 0;
  for (const h of E.heatTiers) if (heat >= h) t++;
  return t; // 0 Cold, 1 Warm, 2 Hot, 3 Burning
}

/** Move the meter by n (clamped to [floor, 100]) and log it for the scanner. */
export function addHeat(state, n, label) {
  const h = hs(state);
  state.heat = Math.max(h.floor, Math.min(E.heatMax, (state.heat || 0) + n));
  if (label && n) {
    h.log.push({ label, amount: round2(n) });
    if (h.log.length > H.logMax) h.log.shift();
  }
}

/** Count a sale (a day with zero sales is a "laying low" day). */
export function noteSale(state) { hs(state).salesToday++; }

/** Track dirty-cash spending: over $2,000 in a day is flashy (+3). */
export function noteSpend(state, amount) {
  const h = hs(state);
  h.spentToday += amount;
  if (!h.flashyDone && h.spentToday > H.flashy.limit) {
    h.flashyDone = true;
    addHeat(state, H.flashy.heat, 'Flashy spending');
  }
}

/**
 * One-off sources for later milestones (runners, guns, kills, rival, favors).
 * `n` is a count for per-shot sources; opts.suppressed for gunshots.
 */
export function heatEvent(state, key, n = 1, opts = {}) {
  const ev = H.events[key];
  if (ev === undefined) throw new Error(`unknown heat event ${key}`);
  if (typeof ev === 'object') {
    const per = opts.suppressed ? ev.suppressed : ev.per;
    addHeat(state, Math.min(per * n, ev.max), key);
    return;
  }
  addHeat(state, ev * n, key);
  if (key === 'shootOfficer') {
    const h = hs(state);
    h.floor = Math.min(E.heatMax, h.floor + H.shootOfficerFloor);
    h.firedAtPolice = true;
    state.heat = Math.max(state.heat, h.floor);
  }
}

/** Runner delivery: +0.5 x (1.5 - Discretion/100). */
export function runnerDeliveryHeat(state, discretion) {
  addHeat(state, H.runnerDelivery.base * (H.runnerDelivery.disc - discretion / 100), 'Runner delivery');
}

// ------------------------------------------------------------- daily -----

const near = (a, b, r) => Math.hypot(a.x - b.x, a.y - b.y) <= r;

/** Daily heat at 06:00: sources, then decay. Resets the day's log. */
export function dailyHeat(state) {
  const h = hs(state);
  h.lastLog = h.log;
  h.log = [];
  const filters = state.objects.filter((o) => o.kind === 'filter');
  const filtered = (o) => filters.some((f) => near(f, o, H.filterRadius));
  const alive = state.plants.filter((p) => !p.dead);
  let visible = 0, smellIn = 0, smellOut = 0;
  for (const plant of alive) {
    const pot = state.objects.find((o) => o.id === plant.potId);
    if (!pot) continue;
    const seen = visibleFromRoad(state, pot);
    if (seen) visible++;
    const st = stageOf(plant);
    if ((st === 'flowering' || st === 'ripe' || st === 'overripe') && !filtered(pot)) {
      if (seen) smellOut++; else smellIn++;
    }
  }
  if (visible) addHeat(state, visible * H.visiblePlant, `${visible} plant(s) visible from the road`);
  if (smellIn) addHeat(state, smellIn * H.smell.indoor, `Smell: ${smellIn} indoor plant(s)`);
  if (smellOut) addHeat(state, smellOut * H.smell.outdoor, `Smell: ${smellOut} outdoor plant(s)`);
  let racks = 0;
  for (const o of state.objects) {
    if (o.kind === 'rack' && state.product.some((b) => b.where === o.id) && !filtered(o)) racks++;
  }
  if (racks) addHeat(state, racks * H.smell.rack, `Smell: ${racks} loaded rack(s)`);
  if (!state.objects.some((o) => o.kind === 'generator')) {
    let lamps = 0;
    for (const o of state.objects) {
      if (o.kind !== 'lamp') continue;
      lamps += CONFIG.lamps.types[o.lamp].heat * (o.hours === CONFIG.lamps.hoursLong ? CONFIG.lamps.longHeatMult : 1);
    }
    if (lamps) addHeat(state, lamps, 'Grow lamps');
  }
  const big = H.bigGrow.find((b) => alive.length > b.over);
  if (big) addHeat(state, big.heat, `Big grow (${alive.length} plants)`);

  // Decay.
  const tier = heatTier(state.heat);
  let decay = tier <= 1 ? H.decay.low : H.decay.high;
  if (h.salesToday === 0) decay *= H.layLowMult;
  addHeat(state, -decay, h.salesToday === 0 ? 'Laying low (decay doubled)' : 'Passive decay');
  if (state.license && state.license.frontOwned) addHeat(state, -H.farmStandDecay, 'Farm stand front');

  h.salesToday = 0; h.spentToday = 0; h.flashyDone = false;
  state.events.push({ type: 'heatDaily', heat: state.heat });
}

// -------------------------------------------------------------- raids -----

export const lawyerActive = (state) => nowGh(state) < hs(state).lawyerUntil;

/** Raid chance for a heat value (plan §A5), lawyer-adjusted. */
export function raidChance(state, heat = state.heat) {
  let c = 0;
  if (heat >= R.burning.from) c = R.burning.base + (heat - R.burning.from) * R.burning.perPoint;
  else if (heat >= R.hot.from) c = (heat - R.hot.from) * R.hot.perPoint;
  if (lawyerActive(state)) c *= R.lawyerChanceMult;
  return Math.min(1, c);
}

/** Find chance of a hidden room (plan §A5): 30% + (heat-50)%, K-9, snitch. */
export function hatchFindChance(state, heat = state.heat) {
  const X = R.hatch;
  let c = X.base + (heat - X.heatFrom) * X.perHeat;
  if (heat >= R.k9FromHeat) c += X.k9;
  if (hs(state).snitched) c += X.snitch;
  return clamp01(c);
}

export function wakeUp(state) {
  if (state.sleeping) { state.sleeping = false; state.sleepRemain = 0; state.events.push({ type: 'wake' }); }
}

function startRaid(state) {
  const h = hs(state);
  const cops = state.heat >= R.burning.from ? R.copsBurning : R.copsHot;
  const door = CONFIG.world.buildings.find((b) => b.key === 'shack');
  const dx = door.x + door.w - 1;
  const from = { x: CONFIG.world.zones.lotX1 - 1, y: state.surface[CONFIG.world.zones.lotX1 - 1] - 1 };
  const to = { x: dx, y: state.surface[dx] - 1 };
  const path = findPath(state, from, to) || [from, to];
  h.raid = { t: 0, cops, path: path.map((c) => [c.x, c.y]) };
  wakeUp(state);
  state.events.push({ type: 'raidStart', cops });
}

const inLot = (state) => {
  const cx = (state.player.x + state.player.w / 2) / TS;
  return cx >= CONFIG.world.zones.lotX0 && cx < CONFIG.world.zones.lotX1;
};

/**
 * What a search of the lot finds. Pure given `rng`: no state changes.
 * Open rooms are always found; hidden rooms roll once each; a buried stash
 * 10%; a safe in a found room opens 50%.
 */
export function searchLot(state, rng) {
  const heat = state.heat;
  const hatch = hatchFindChance(state, heat);
  const cache = new Map();
  const roomFound = (x, y) => {
    const r = roomOf(state, x, y);
    if (r.open) return true;
    if (!cache.has(r.id)) cache.set(r.id, rng.chance(hatch));
    return cache.get(r.id);
  };
  const found = { plants: [], batches: [], containers: [], carried: false };
  for (const plant of state.plants) {
    if (plant.dead) continue;
    const pot = state.objects.find((o) => o.id === plant.potId);
    if (pot && roomFound(pot.x, pot.y)) found.plants.push(plant);
  }
  for (const o of state.objects) {
    if (o.kind === 'rack') {
      const mine = state.product.filter((b) => b.where === o.id);
      if (mine.length && roomFound(o.x, o.y)) found.batches.push(...mine);
    } else if (o.kind === 'stash' || o.kind === 'safe') {
      const hit = o.kind === 'stash' && isBuried(state, o.x, o.y)
        ? rng.chance(R.stashFind)
        : roomFound(o.x, o.y) && (o.kind === 'stash' || rng.chance(R.safeOpen));
      if (hit) {
        found.containers.push(o);
        found.batches.push(...state.product.filter((b) => b.where === o.id));
      }
    }
  }
  if (inLot(state)) {
    found.carried = true;
    found.batches.push(...state.product.filter((b) => b.where === 'inv'));
  }
  return found;
}

/** Take a fine from bank, then cash; any shortfall becomes debt (blocks the license). */
export function payFine(state, amount) {
  const p = state.player;
  let rem = amount;
  const bank = Math.min(p.bank || 0, rem); p.bank = (p.bank || 0) - bank; rem -= bank;
  const cash = Math.min(p.cash, rem); p.cash -= cash; rem -= cash;
  if (rem > 0) p.debt = (p.debt || 0) + rem;
  return { paid: amount - rem, debt: rem };
}

/** Pay off debt from cash. */
export function payDebt(state) {
  const p = state.player;
  const pay = Math.min(p.debt || 0, p.cash);
  p.cash -= pay; p.debt -= pay;
  return pay;
}

/** Arrest: bail (1 day lost) or jail (4 days); third arrest is game over. */
export function arrestPlayer(state, reason) {
  const h = hs(state);
  const p = state.player;
  p.arrests = (p.arrests || 0) + 1;
  checkLose(state);
  if (state.gameOver) return { arrests: p.arrests, gameOver: true };
  const bail = R.bail[Math.min(p.arrests, R.bail.length) - 1];
  const afford = p.cash + (p.bank || 0) >= bail;
  if (afford) payFine(state, bail);
  const days = afford ? R.bailDays : R.jailDays;
  h.pendingSkip = days;
  return { arrests: p.arrests, bail, afford, days, reason };
}

/** Apply a search result: seizure, fines, arrest, after-raid cooling. */
export function applyRaid(state, found) {
  const h = hs(state);
  const p = state.player;
  const lawyer = lawyerActive(state);
  const thr = lawyer ? R.lawyerThresholdMult : 1;
  const plants = found.plants.length;
  const grams = found.batches.reduce((n, b) => n + b.grams, 0);
  const present = inLot(state);
  const seize = R.cashSeize * (lawyer ? R.lawyerFineMult : 1);

  for (const plant of found.plants) {
    const pot = state.objects.find((o) => o.id === plant.potId);
    if (pot) pot.plantId = null;
    state.plants.splice(state.plants.indexOf(plant), 1);
  }
  for (const b of found.batches) {
    const i = state.product.indexOf(b);
    if (i >= 0) state.product.splice(i, 1);
  }
  let cashSeized = 0;
  for (const c of found.containers) {
    const take = (c.cash || 0) * seize;
    c.cash = (c.cash || 0) - take; cashSeized += take;
  }
  if (found.carried) { const take = p.cash * seize; p.cash -= take; cashSeized += take; }
  // A registered gun found beside plants adds a weapons charge (plan §A9).
  const guns = found.carried && plants > 0 && CONFIG.weapons.order.some((k) => !CONFIG.weapons[k].melee && (p.inv[k] || 0) > 0);
  const fine = (plants * R.finePerPlant + (guns ? CONFIG.combat.weaponsFine : 0)) * (lawyer ? R.lawyerFineMult : 1);
  const paid = payFine(state, fine);

  const gun = !!p.gunUnregistered;
  const arrested = plants >= R.arrestPlants * thr ||
    (present && (grams >= R.arrestGrams * thr || gun || h.firedAtPolice));
  const nothing = plants === 0 && grams === 0 && cashSeized === 0;
  addHeat(state, -(nothing ? H.afterRaid.nothing : H.afterRaid.found), 'After the raid');
  h.raid = null; h.snitched = false;

  const lines = [
    nothing ? 'They searched everything and found nothing.' : 'They tore the place apart.',
    `Plants destroyed: ${plants}. Product taken: ${grams.toFixed(0)} g. Cash seized: $${Math.round(cashSeized)}.`,
    `Fine: $${Math.round(fine)}${paid.debt > 0 ? ` ($${Math.round(paid.debt)} became debt)` : ''}.`,
  ];
  const arrest = arrested ? arrestPlayer(state, 'raid') : null;
  if (arrest && arrest.gameOver) lines.push('Third arrest. You are going away for a long time.');
  else if (arrest) lines.push(arrest.afford
    ? `ARRESTED. Bail of $${arrest.bail} paid; you lose a day.`
    : `ARRESTED. You cannot make bail: ${arrest.days} days in jail.`);
  state.events.push({ type: 'notice', title: 'Police raid', lines });
  return { plants, grams, cashSeized, fine, arrested, nothing, arrest };
}

/** Resolve the pending raid now (cops have reached the lot). */
export function resolveRaid(state) {
  const found = withStateRng(state, (rng) => searchLot(state, rng));
  return applyRaid(state, found);
}

// ------------------------------------------------------ patrol and tells --

const carriedGrams = (s) => s.product.reduce((n, b) => (b.where === 'inv' ? n + b.grams : n), 0);

function patrolStop(state, cop) {
  const carried = carriedGrams(state);
  const lawyer = lawyerActive(state);
  state.product = state.product.filter((b) => b.where !== 'inv');
  addHeat(state, H.events.patrolStop, 'Stopped by patrol with product');
  const fine = H.patrol.fine * (lawyer ? R.lawyerFineMult : 1);
  payFine(state, fine);
  const lines = [`A patrol cop searched you. ${carried.toFixed(0)} g confiscated, $${fine} fine.`];
  if (carried > H.patrol.arrestGrams * (lawyer ? R.lawyerThresholdMult : 1)) {
    const a = arrestPlayer(state, 'patrol');
    lines.push(a.gameOver ? 'Third arrest. Game over.' : a.afford
      ? `ARRESTED. Bail of $${a.bail} paid; you lose a day.` : `ARRESTED. ${a.days} days in jail.`);
  }
  state.events.push({ type: 'notice', title: 'Stopped by patrol', lines });
  cop.coolUntil = nowGh(state) + H.patrol.coolGh;
}

function upkeepCops(state) {
  const P = H.patrol;
  const t = state.time.hour;
  const tier = heatTier(state.heat);
  if (!state.cops) state.cops = [];
  if (t < P.hours.from || t >= P.hours.to) { state.cops = state.cops.filter((c) => c.responder); return; }
  const want = tier >= 3 ? P.copsBurning : P.copsOther;
  while (state.cops.filter((c) => !c.responder).length < want) {
    state.cops.push(withStateRng(state, (rng) => ({
      x: rng.range(P.x0, P.x1) * TS, dir: rng.chance(0.5) ? 1 : -1, coolUntil: 0,
    })));
  }
  if (hs(state).jailed || state.sleeping) return;
  const px = state.player.x + state.player.w / 2;
  const duffel = (state.player.inv.duffel || 0) > 0;
  for (const cop of state.cops) {
    if (nowGh(state) < cop.coolUntil || Math.abs(cop.x - px) > P.rangeTiles * TS) continue;
    if (carriedGrams(state) <= P.minGrams) continue;
    cop.coolUntil = nowGh(state) + P.coolGh;
    const chance = Math.min(1, P.chance[tier] * (duffel ? P.duffelMult : 1));
    if (withStateRng(state, (rng) => rng.chance(chance))) { patrolStop(state, cop); break; }
  }
}

const crossed = (prev, cur, at) => (prev - cur > 12 ? at > prev || at <= cur : prev < at && at <= cur);

/** World tells by tier (plan §A5): patrol car, helicopter, blinds, parked car. */
export function worldTells(state) {
  const tier = heatTier(state.heat);
  return {
    tier,
    patrolCars: H.tells.carPerDay[tier],
    helicopter: tier >= 2, blinds: tier >= 2,
    unmarkedCar: tier >= 3, stopSearch: tier >= 3,
    peopleTalking: tier >= 1,
  };
}

// --------------------------------------------------------------- step -----

/** 2 Hz heat step. */
export function stepHeat(state, gh) {
  const h = hs(state);
  const t = state.time;
  const prev = h.lastHour;
  const cur = t.hour;
  h.lastHour = cur;
  const at = (hour) => crossed(prev, cur, hour);
  const tier = heatTier(state.heat);

  if (h.raid) {
    h.raid.t += gh;
    if (h.raid.t >= R.arriveGh) resolveRaid(state);
  }
  const tonight = (day) => day >= R.minDay && !h.jailed && !state.gameOver;
  if (at(R.tipHour)) {
    h.raidU = withStateRng(state, (rng) => rng.next());
    if (tonight(t.day + 1) && t.day <= h.lastBribeDay + R.tipWindowDays && h.raidU < raidChance(state)) {
      state.events.push({ type: 'raidWarning', source: 'deputy', gh: R.rollHour + 24 - R.tipHour });
      wakeUp(state);
    }
  }
  if (at(R.warnHour) && state.player.inv.scanner > 0 && tonight(t.day) &&
    h.raidU !== null && h.raidU < raidChance(state)) {
    state.events.push({ type: 'raidWarning', source: 'scanner', gh: R.rollHour - R.warnHour });
    wakeUp(state);
  }
  if (at(R.rollHour)) {
    const u = h.raidU !== null ? h.raidU : withStateRng(state, (rng) => rng.next());
    h.raidU = null;
    if (tonight(t.day) && !h.raid && u < raidChance(state)) startRaid(state);
  }
  if (at(CONFIG.clock.wakeHour)) dailyHeat(state);

  // Tells: patrol car passes, helicopter at dusk, parked unmarked car.
  const T = H.tells;
  if (tier >= 1) {
    for (let i = 0; i < T.carPerDay[tier]; i++) {
      if (at(T.carHours[i]) && !state.patrolCar) {
        state.patrolCar = { x: CONFIG.world.zones.roadX0 * TS, dir: 1 };
      }
    }
  }
  if (tier >= 2 && at(T.helicopterHour)) state.events.push({ type: 'helicopter' });
  state.tells = worldTells(state);
  upkeepCops(state);
  checkLose(state);
}

// ---------------------------------------------------- money-side actions --

/** Bribe price now: $500, +$250 each use. */
export const bribePrice = (state) => H.bribe.cost + H.bribe.costStep * hs(state).bribeCount;

export function bribeDeputy(state) {
  const h = hs(state);
  const B = H.bribe;
  if (state.time.day < B.minDay) return { ok: false, msg: 'The deputy is not taking meetings yet.' };
  if (state.time.day < h.bribeNextDay) return { ok: false, msg: 'He took your money recently. Come back later.' };
  const price = bribePrice(state);
  if (state.player.cash < price) return { ok: false, msg: 'Not enough cash.' };
  state.player.cash -= price;
  h.bribeCount++;
  h.bribeNextDay = state.time.day + B.cooldownDays;
  h.lastBribeDay = state.time.day;
  addHeat(state, -B.amount, 'Bribed the deputy');
  noteSpend(state, price);
  return { ok: true, msg: `The deputy pockets $${price}. He will call if a raid is coming.` };
}

/** Lawyer retainer: 24 more game hours of cover (stacks). */
export function hireLawyer(state) {
  const h = hs(state);
  h.lawyerUntil = Math.max(h.lawyerUntil, nowGh(state)) + 24;
}

/** The bartender's rumor: tonight's raid chance in words. */
export function rumorText(state) {
  const c = raidChance(state);
  return H.rumor.find(([max]) => c <= max)[1];
}

/** Police scanner view: exact number, itemized day, raid chance (needs the scanner). */
export function scannerView(state) {
  if (!(state.player.inv.scanner > 0)) return null;
  return { value: state.heat, tier: heatTier(state.heat), log: hs(state).log.slice(), raidChance: raidChance(state) };
}
