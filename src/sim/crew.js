// crew.js — hired help (plan §A8): runners, a guard and a gardener, with
// wages at 20:00, loyalty, and everything that goes wrong (busts, skimming,
// lateness, robbery, quitting). Pure module; crew members are plain data in
// state.crew (saved). They have their own PRNG stream (state.crew.rngState)
// so hiring never reshuffles the draws of older systems.

import { CONFIG } from '../config.js';
import { createRng } from '../rng.js';
import { hs, heatEvent, runnerDeliveryHeat } from './heat.js';
import { fillOrder, buyerPresent, nowGh } from './economy.js';
import { nightKey } from './time.js';
import { tt, rivalBump, crossed } from './threats.js';
import { waterPour, feedDose, phAdjust, neemPlant, potOf, stageOf } from './plants.js';
import { damageEntity, gunNoise, groundY, isHostile } from '../entities/combat.js';
import { raycastSolid } from '../world/physics.js';
import { stressEvent } from './addiction.js';

const C = CONFIG.crew;
const RN = C.runner;
const TS = CONFIG.world.tile;
const DAY = 24;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Fresh crew block: six candidates are generated at new game. */
export function initCrew(seed = 1) {
  const rng = createRng((seed ^ 0x3c6ef372) >>> 0);
  const names = C.names.slice();
  const stat = () => rng.intRange(C.statMin, C.statMax);
  const candidates = [];
  for (let i = 1; i <= C.candidates; i++) {
    const name = names.splice(rng.int(names.length), 1)[0];
    candidates.push({ id: i, name, rel: stat(), disc: stat(), greed: stat(), nerve: stat() });
  }
  return {
    rngState: rng.state, candidates, members: [], markers: C.guard.markers.slice(),
    guard: false, lastHour: null, sawRaid: false, bailedOut: 0,
  };
}

export const crewOf = (state) => state.crew || (state.crew = initCrew(state.seed));
const rngOf = (state, fn) => {
  const c = crewOf(state);
  const rng = createRng(c.rngState);
  const out = fn(rng);
  c.rngState = rng.state;
  return out;
};
const member = (state, id) => crewOf(state).members.find((m) => m.id === id);
const toast = (state, msg) => state.events.push({ type: 'toast', msg });
const nextDawn = (state) => {
  const w = CONFIG.clock.wakeHour;
  return (state.time.hour < w ? state.time.day : state.time.day + 1) * DAY + w;
};
const loyal = (m, d) => { m.loyalty = clamp(m.loyalty + d, 0, 100); };

// ------------------------------------------------------------ hiring ----

/** The two candidates on the bar's board right now (rotates every 3 days). */
export function boardCandidates(state) {
  const pool = crewOf(state).candidates;
  if (!pool.length) return [];
  const k = Math.floor(state.time.day / C.boardRotateDays);
  const out = [];
  for (let i = 0; i < Math.min(C.boardVisible, pool.length); i++) out.push(pool[(k * C.boardVisible + i) % pool.length]);
  return out;
}

/** One adjective per stat before hiring; the numbers show after 3 days of work. */
export function describe(state, p) {
  const known = p.role !== undefined && state.time.day - p.hiredDay >= C.revealDays;
  const out = {};
  for (const k of ['rel', 'disc', 'greed', 'nerve']) out[k] = known ? p[k] : C.adjectives[k][p[k] >= C.adjectiveSplit ? 1 : 0];
  return { known, ...out };
}

export function hire(state, candId, role) {
  const c = crewOf(state);
  if (!C.wage[role]) return { ok: false, msg: 'No such job.' };
  if (c.members.length >= C.max) return { ok: false, msg: `Your crew is full (${C.max}).` };
  const cand = c.candidates.find((x) => x.id === candId);
  if (!cand) return { ok: false, msg: 'Nobody by that name.' };
  c.candidates.splice(c.candidates.indexOf(cand), 1);
  const m = {
    ...cand, role, loyalty: C.startLoyalty, hiredDay: state.time.day, status: 'active', backAt: 0, bailed: false,
    noSkimUntil: 0, docked: false, bonusAt: -1e9, owed: 0, skimmed: 0, trip: null, x: 0, y: 0, dir: 1, cd: 0, budget: 0,
    hp: C.guard.hp, deliveries: 0,
  };
  const shack = CONFIG.world.buildings.find((b) => b.key === 'shack');
  m.x = (shack.x + shack.w) * TS;
  c.members.push(m);
  return { ok: true, msg: `${m.name} is your new ${role}.`, member: m };
}

function remove(state, m) {
  dropCarried(state, m);
  const c = crewOf(state);
  c.members.splice(c.members.indexOf(m), 1);
}

export function fire(state, id) {
  const m = member(state, id);
  if (!m) return { ok: false, msg: 'No such crew member.' };
  remove(state, m);
  return { ok: true, msg: `${m.name} is gone.` };
}

export function giveBonus(state, id) {
  const m = member(state, id);
  if (!m) return { ok: false, msg: 'No such crew member.' };
  if (nowGh(state) < m.bonusAt + C.bonus.everyDays * DAY) return { ok: false, msg: 'He got a bonus recently.' };
  if (state.player.cash < C.bonus.cost) return { ok: false, msg: 'Not enough cash.' };
  state.player.cash -= C.bonus.cost;
  m.bonusAt = nowGh(state);
  loyal(m, C.loyalty.bonus);
  return { ok: true, msg: `${m.name} pockets the $${C.bonus.cost}. Loyalty up.` };
}

/** Bail a busted runner ($800): back at dawn, +10 loyalty. */
export function bailOut(state, id) {
  const m = member(state, id);
  if (!m || m.status !== 'jailed' || m.bailed) return { ok: false, msg: 'Nobody to bail out.' };
  if (state.player.cash < RN.bail) return { ok: false, msg: 'Not enough cash.' };
  state.player.cash -= RN.bail;
  m.bailed = true;
  m.backAt = nextDawn(state);
  loyal(m, C.loyalty.bail);
  return { ok: true, msg: `${m.name} will be back in the morning.` };
}

/** Dock pay: ends skimming for good, loyalty -10, smaller wage. */
export function dockPay(state, id) {
  const m = member(state, id);
  if (!m) return { ok: false, msg: 'No such crew member.' };
  m.docked = true;
  loyal(m, C.loyalty.dock);
  return { ok: true, msg: `${m.name}'s pay is docked.` };
}

/** Threaten (a gun in his face): no skimming for 10 days, loyalty -20, 20% he quits on the spot. */
export function threaten(state, id) {
  const m = member(state, id);
  if (!m) return { ok: false, msg: 'No such crew member.' };
  m.noSkimUntil = nowGh(state) + RN.threatenDays * DAY;
  loyal(m, C.loyalty.threatened);
  if (rngOf(state, (r) => r.chance(RN.threatenQuit))) { quit(state, m); return { ok: true, msg: `${m.name} quit on the spot.` }; }
  return { ok: true, msg: `${m.name} keeps his hands in sight.` };
}

/** Mark/unmark a rack as the runners' outgoing shelf. */
export function toggleOutgoing(state, rackId) {
  const rack = state.objects.find((o) => o.id === rackId && o.kind === 'rack');
  if (!rack) return false;
  rack.outgoing = !rack.outgoing;
  return rack.outgoing;
}

/** Place one of the guard's two patrol markers at a tile. */
export function placeMarker(state, which, tileX) {
  const Z = CONFIG.world.zones;
  crewOf(state).markers[which ? 1 : 0] = clamp(Math.round(tileX), Z.lotX0, Z.lotX1 - 1);
}

// -------------------------------------------------------------- quitting --

function quit(state, m) {
  remove(state, m);
  toast(state, `${m.name} quit.`);
  const sold = rngOf(state, (r) => r.next() < C.quit.sellout ? (r.next() < 0.5 ? 'raid' : 'dale') : null);
  if (sold === 'raid') {
    const t = tt(state);
    t.selloutUntil = Math.max(t.selloutUntil, nightKey(state.time) + C.quit.breakInNights - 1);
    toast(state, `${m.name} sold you out to thieves.`);
  } else if (sold === 'dale') {
    rivalBump(state, C.quit.daleBump);
    toast(state, `${m.name} went to work for Dale.`);
  }
}

// ---------------------------------------------------------------- runner --

/** Product a runner carries goes back to the outgoing shelf (or your bag). */
function dropCarried(state, m) {
  const tag = `runner:${m.id}`;
  for (const b of state.product) if (b.where === tag) b.where = m.trip && m.trip.shelfId ? m.trip.shelfId : 'inv';
  if (m.trip) {
    const o = state.economy.orders.find((x) => x.id === m.trip.orderId);
    if (o) o.runnerId = null;
  }
  m.trip = null;
}

const outgoing = (state) => state.objects.filter((o) => o.kind === 'rack' && o.outgoing);

/** Take up to `grams` of dry, good-enough product from the outgoing shelves into the runner's bag. */
function loadBag(state, m, order) {
  const shelves = outgoing(state);
  const ids = new Set(shelves.map((o) => o.id));
  const stock = state.product
    .filter((b) => ids.has(b.where) && !b.wet && b.quality >= order.minQ && b.grams > 0)
    .sort((a, c) => c.quality - a.quality);
  const have = stock.reduce((n, b) => n + b.grams, 0);
  if (have < order.grams * CONFIG.economy.trust.partialMin) return null;
  let left = Math.min(order.grams, have);
  const shelfId = stock[0].where;
  for (const b of stock) {
    if (left <= 1e-9) break;
    const take = Math.min(left, b.grams);
    left -= take;
    b.grams -= take;
    state.product.push({ ...b, id: state.nextId++, grams: take, where: `runner:${m.id}` });
    if (b.grams <= 1e-6) state.product.splice(state.product.indexOf(b), 1);
  }
  return { shelfId, shelf: shelves.find((o) => o.id === shelfId) };
}

function dispatch(state, m) {
  for (const order of state.economy.orders) {
    if (order.runnerId || !buyerPresent(state, order.buyer)) continue;
    const bag = loadBag(state, m, order);
    if (!bag) continue;
    order.runnerId = m.id;
    const x0 = bag.shelf.x * TS;
    const x1 = CONFIG.economy.buyers[order.buyer].x * TS;
    const leg = Math.abs(x1 - x0) / RN.speed / CONFIG.clock.secPerGh; // off screen it is a timer
    const now = nowGh(state);
    m.trip = { orderId: order.id, shelfId: bag.shelfId, x0, x1, leg, start: now, arriveAt: now + leg, homeAt: now + 2 * leg, stage: 'out' };
    return;
  }
}

/** The per-delivery risks (plan §A8) as probabilities: busted, robbed, late; and whether he skims. */
export function runnerOdds(state, m, grams) {
  const heavy = grams > RN.heavyG ? RN.heavyMult : 1;
  return {
    bust: (RN.bustBase + (state.heat / RN.bustHeatDiv) * (1 - m.disc / RN.bustDisc)) / 100 * heavy,
    rob: grams > RN.robG ? RN.robChance : 0,
    late: (100 - m.rel) / RN.lateDiv / 100,
    skimming: m.greed > m.loyalty && nowGh(state) >= m.noSkimUntil && !m.docked,
  };
}

function arrive(state, m) {
  const t = m.trip;
  const tag = `runner:${m.id}`;
  const bag = state.product.filter((b) => b.where === tag);
  const grams = bag.reduce((n, b) => n + b.grams, 0);
  const order = state.economy.orders.find((o) => o.id === t.orderId);
  t.stage = 'back';
  if (!order) { dropCarried(state, m); m.trip = null; return; }
  const d = rngOf(state, (r) => ({ bust: r.next(), rob: r.next(), late: r.next(), skim: r.range(RN.skimMin, RN.skimMax) }));
  const odds = runnerOdds(state, m, grams);
  if (d.bust < odds.bust) return busted(state, m, order, bag);
  if (d.rob < odds.rob) return robbed(state, m, order, bag);
  const late = d.late < odds.late;
  const skimming = odds.skimming;
  const r = fillOrder(state, order.id, { runner: m.name, stock: bag, late, cut: skimming ? d.skim : 0 });
  if (!r.ok) { dropCarried(state, m); return; }
  m.deliveries++;
  m.owed += r.value * C.runnerCut;
  if (skimming) m.skimmed += r.value - r.paid;
  runnerDeliveryHeat(state, m.disc);
  toast(state, `${m.name} delivered ${Math.round(r.grams)} g${late ? ' (late)' : ''}.`);
}

function lose(state, m, order, bag) {
  for (const b of bag) { const i = state.product.indexOf(b); if (i >= 0) state.product.splice(i, 1); }
  order.runnerId = null;
  m.trip = null;
}

function busted(state, m, order, bag) {
  lose(state, m, order, bag);
  heatEvent(state, 'runnerBusted');
  m.status = 'jailed';
  m.bailed = false;
  m.backAt = nowGh(state) + RN.jailDays * DAY;
  stressEvent(state);
  toast(state, `${m.name} was busted with the product. Bail is $${RN.bail}.`);
  if (m.loyalty < RN.snitchBelow) {
    heatEvent(state, 'runnerSnitch');
    hs(state).snitched = true;
    toast(state, `${m.name} is talking to the cops.`);
  }
}

function robbed(state, m, order, bag) {
  lose(state, m, order, bag);
  m.status = 'hurt';
  m.backAt = nowGh(state) + RN.hurtDays * DAY;
  toast(state, `${m.name} was robbed and beaten. He is out for ${RN.hurtDays} days.`);
}

function stepRunner(state, m, now) {
  const t = m.trip;
  if (!t) { dispatch(state, m); return; }
  if (t.stage === 'out') {
    m.x = t.x0 + (t.x1 - t.x0) * clamp((now - t.start) / t.leg, 0, 1);
    if (now >= t.arriveAt) arrive(state, m);
  } else if (t) {
    m.x = t.x1 + (t.x0 - t.x1) * clamp((now - t.arriveAt) / t.leg, 0, 1);
    if (now >= t.homeAt) m.trip = null;
  }
}

// ----------------------------------------------------------------- guard --

const hostiles = (state) => (state.entities || []).filter(isHostile);

function stepGuard(state, m, dt) {
  const G = C.guard;
  const c = crewOf(state);
  m.cd -= dt;
  m.y = groundY(state, m.x);
  let tgt = null;
  let best = G.aggroTiles * TS;
  for (const e of hostiles(state)) {
    const d = Math.abs(e.x - m.x);
    if (d < best) { best = d; tgt = e; }
  }
  if (tgt) {
    m.dir = Math.sign(tgt.x - m.x) || m.dir;
    const los = !raycastSolid(state.tiles, m.x, m.y - 12, tgt.x, tgt.y - 12, 2000);
    if (best > G.rangeTiles * TS * 0.8 || !los) m.x += m.dir * Math.min(Math.abs(tgt.x - m.x), G.speed * dt);
    if (best <= G.rangeTiles * TS && los && m.cd <= 0) {
      m.cd = 1 / G.rate;
      if (rngOf(state, (r) => r.chance(G.acc))) {
        damageEntity(state, tgt, G.dmg, 'gun');
        if (tgt.kind === 'thief') tgt.attacked = false; // it flees, it does not turn on you
      }
      gunNoise(state, 'pistol22', false, m.x);
    }
    return;
  }
  const [a, b] = c.markers.map((tx) => tx * TS + TS / 2).sort((p, q) => p - q);
  if (m.x < a) m.dir = 1; else if (m.x > b) m.dir = -1;
  m.x = clamp(m.x + m.dir * G.speed * dt, a, b);
  if (m.x <= a || m.x >= b) m.dir = m.x <= a ? 1 : -1;
}

// -------------------------------------------------------------- gardener --

function stepGardener(state, m, gh, tended) {
  const G = C.gardener;
  m.budget = Math.min(G.actionsPerGh, m.budget + G.actionsPerGh * gh);
  const P = CONFIG.plants;
  const inv = state.player.inv;
  const mine = state.plants.filter((p) => !p.dead).slice(0, G.plants);
  for (const p of mine) {
    tended.add(p.id);
    if (m.budget < 1) continue;
    const pot = potOf(state, p);
    if (pot) { m.x = pot.x * TS; m.y = pot.y * TS; }
    if (p.moisture < G.moistureBelow) { waterPour(state, p, P.tapPourPh, 'tap'); m.budget--; }
    if (p.nutrients < G.nutrientsBelow && stageOf(p) !== 'ripe' && inv.nutrients > 0) { inv.nutrients--; feedDose(state, p); m.budget--; }
    if ((p.ph > P.phIdeal.hi - G.phMargin || p.ph < P.phIdeal.lo + G.phMargin) && inv.phkit > 0) {
      inv.phkit--; phAdjust(state, p, p.ph > 6.4 ? -1 : 1); m.budget--;
    }
    if (p.infested && inv.neem > 0) { inv.neem--; neemPlant(state, p); m.budget--; }
  }
}

// ----------------------------------------------------------- the daily ---

const wageOf = (m) => Math.round(C.wage[m.role] * (m.docked ? C.dockWageMult : 1));

function payroll(state) {
  const h = hs(state);
  for (const m of crewOf(state).members.slice()) {
    if (m.status !== 'active') continue;
    const due = wageOf(m) + Math.round(m.owed);
    if (state.player.cash >= due) {
      state.player.cash -= due;
      m.owed = 0;
      loyal(m, C.loyalty.paid);
    } else {
      loyal(m, C.loyalty.unpaid);
      toast(state, `You could not pay ${m.name}.`);
    }
    if (h.withdrawal || state.player.addicted) loyal(m, C.loyalty.withdrawal);
  }
}

function dawn(state) {
  for (const m of crewOf(state).members.slice()) {
    if (m.loyalty < C.quit.below && rngOf(state, (r) => r.chance(C.quit.chance))) quit(state, m);
  }
}

function comeBack(state, m) {
  if (m.status === 'jailed' && !m.bailed) {
    // Nobody bailed him out: he comes back bitter, or not at all.
    loyal(m, RN.jailLoyalty);
    for (const o of crewOf(state).members) if (o !== m) loyal(o, C.loyalty.crewBusted);
    if (m.loyalty < RN.goneBelow) { remove(state, m); toast(state, `${m.name} is gone for good.`); return; }
  }
  m.status = 'active';
  m.hp = C.guard.hp;
  toast(state, `${m.name} is back.`);
}

/** The 2 Hz crew step (plan §B3: after economy, before threats). */
export function stepCrew(state, dt) {
  const c = crewOf(state);
  const cur = state.time.hour;
  const prev = c.lastHour === null ? cur : c.lastHour;
  c.lastHour = cur;
  const gh = dt / CONFIG.clock.secPerGh;
  const now = nowGh(state);
  if (crossed(prev, cur, C.payHour)) payroll(state);
  if (crossed(prev, cur, CONFIG.clock.wakeHour)) dawn(state);
  const raid = !!hs(state).raid;
  if (raid && !c.sawRaid) for (const m of c.members) loyal(m, C.loyalty.raid);
  c.sawRaid = raid;
  const tended = new Set();
  let guard = false;
  for (const m of c.members.slice()) {
    if (m.status !== 'active') { if (now >= m.backAt) comeBack(state, m); continue; }
    if (m.role === 'runner') stepRunner(state, m, now);
    else if (m.role === 'guard') {
      if (m.hp <= 0) { m.status = 'hurt'; m.backAt = now + C.guard.hurtDays * DAY; toast(state, `${m.name} is down.`); continue; }
      stepGuard(state, m, dt);
      guard = true;
    } else stepGardener(state, m, gh, tended);
  }
  for (const p of state.plants) p.gardened = tended.has(p.id);
  c.guard = guard; // read by the break-in roll (-20)
}
