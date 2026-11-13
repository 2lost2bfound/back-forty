// allies.js — System 10 (plan §A13): Walt, Benny, June and Rosa. Friendship
// points, gifts, favors, calling for defense, ally combat and healing, and
// the four ways it goes wrong (hurt, killed, arrested, estranged) plus
// Benny's loan. Pure module: no window/document. Persistent records live in
// state.allies (saved, with its own PRNG stream so older systems' draws never
// shift); an ally on the lot is a runtime entity in state.entities
// (kind 'ally'), fought with the same combat code as thieves and the guard.
// Time is absolute game hours (day*24 + hour); fight timers are sim seconds.

import { CONFIG } from '../config.js';
import { createRng } from '../rng.js';
import { addHeat, hs } from './heat.js';
import { addOf, friendshipMult, stressEvent, useSubstance } from './addiction.js';
import { nightKey } from './time.js';
import { damageEntity, gunNoise, groundY, isHostile, sendToClinic } from '../entities/combat.js';
import { raycastSolid } from '../world/physics.js';

const A = CONFIG.allies;
const G = A.gains;
const P = A.perks;
const TS = CONFIG.world.tile;
const Z = CONFIG.world.zones;
export const ALLY_KEYS = Object.keys(A.defs);
const nowGh = (s) => s.time.day * 24 + s.time.hour;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dayKeyOf = (t) => Math.floor((t - CONFIG.clock.wakeHour) / 24);
const isNight = (h) => h < CONFIG.clock.sunStart || h >= CONFIG.clock.sunEnd;
const crossed = (prev, cur, at) => (prev - cur > 12 ? at > prev || at <= cur : prev < at && at <= cur);
const toast = (state, msg) => state.events.push({ type: 'toast', msg });
const playerTile = (state) => (state.player.x + state.player.w / 2) / TS;
const onLot = (state) => { const t = playerTile(state); return t >= Z.lotX0 && t < Z.lotX1; };

export function initAllies(seed = 1) {
  return {
    rngState: ((seed ^ 0xa11e5) >>> 0),
    list: ALLY_KEYS.map((id) => ({
      id, pts: 0, peakPts: 0, status: 'ok', until: 0, cooldownUntil: 0, lastContact: null,
      giftDay: null, drinkDay: null, favor: null, nextFavorAt: 0, estranged: false, actDone: false,
      bill: false, bailed: false, decided: false, bailBy: 0,
    })),
    calls: [], griefUntil: 0, loan: null, lastHour: null,
    banUntil: 0, priceUntil: 0, refuseUntil: 0, hatchKnown: false, hatchBreakIns: 0,
    hidden: [], hideUntil: 0, flowersDay: null, revive: null,
    stats: { fights: 0, hurt: 0, killed: 0, arrested: 0, favors: 0 },
  };
}

export const alOf = (state) => state.allies || (state.allies = initAllies(state.seed));
export const allyOf = (state, id) => alOf(state).list.find((a) => a.id === id);
const rngOf = (state, fn) => {
  const al = alOf(state);
  const rng = createRng(al.rngState);
  const out = fn(rng);
  al.rngState = rng.state;
  return out;
};

/** Hearts 0-5 (20 points each); an estranged or dead ally counts as 0. */
export function hearts(state, id) {
  const a = allyOf(state, id);
  return !a || a.estranged || a.status === 'dead' ? 0 : Math.min(5, Math.floor(a.pts / A.ptsPerHeart));
}
const contact = (state, a) => { a.lastContact = nowGh(state); };
const entOf = (state, id) => (state.entities || []).find((e) => e.kind === 'ally' && e.ally === id);
const allyEnts = (state) => (state.entities || []).filter((e) => e.kind === 'ally');
const removeEnt = (state, e) => { const i = state.entities.indexOf(e); if (i >= 0) state.entities.splice(i, 1); };
const policeHere = (state) => !!hs(state).raid || (state.cops || []).some((c) => c.responder);

// ------------------------------------------------------------ friendship --

/** Change friendship points; positive gains get the Booze multiplier. */
export function gain(state, a, n) {
  if (a.status === 'dead') return;
  if (n > 0) n *= friendshipMult(state);
  a.pts = clamp(a.pts + n, 0, A.maxPts);
  a.peakPts = Math.max(a.peakPts, a.pts);
  if (a.estranged) {
    if (a.pts >= A.estrange.winBack) {
      a.estranged = false; a.peakPts = a.pts;
      toast(state, `${A.defs[a.id].name} is talking to you again.`);
    }
  } else if (a.peakPts >= A.estrange.from && a.pts < A.estrange.below) estrange(state, a);
}

/** Once 60+ and then below 20: Estranged, with one hostile act, once ever. */
function estrange(state, a) {
  a.estranged = true;
  a.pts = 0;
  const al = alOf(state);
  const t = nowGh(state);
  const H = A.hostileAct;
  toast(state, `${A.defs[a.id].name} has turned on you.`);
  if (a.actDone) return;
  a.actDone = true;
  if (a.id === 'walt') addHeat(state, H.walt.heat, 'Walt reported you');
  else if (a.id === 'benny') {
    const th = state.threats;
    th.selloutUntil = Math.max(th.selloutUntil || 0, nightKey(state.time) + H.benny.breakInDays);
    al.hatchKnown = true; al.hatchBreakIns = th.stats.breakIns;
  } else if (a.id === 'june') { al.banUntil = t + H.june.banDays * 24; al.priceUntil = t + H.june.priceDays * 24; }
  else if (a.id === 'rosa') al.refuseUntil = t + H.rosa.refuseDays * 24;
}

/** Hearts-based shop effects: June's discount, Rosa's taper price, and the estranged acts. */
export function shopBlocked(state, shopKey) {
  const al = alOf(state);
  const t = nowGh(state);
  if (shopKey === 'hardware' && t < al.banUntil) return 'June has banned you from the store.';
  if (shopKey === 'clinic' && t < al.refuseUntil) return 'Rosa told the clinic not to serve you.';
  return null;
}
export function priceMult(state, shopKey, key) {
  const al = alOf(state);
  let m = 1;
  if (shopKey === 'hardware') {
    if (hearts(state, 'june') >= P.discountHearts) m *= 1 - P.discount;
    if (nowGh(state) < al.priceUntil) m *= A.hostileAct.june.priceMult;
  }
  if (shopKey === 'clinic' && key === 'taper' && hearts(state, 'rosa') >= P.taperHearts) m *= P.taperMult;
  return m;
}

// ----------------------------------------------------------------- gifts --

const budBatch = (state) => state.product.find((b) => b.where === 'inv' && b.quality >= A.gift.budQuality && b.grams >= A.gift.budGrams);

/** What the player could give: [{key, label, react}] ('bud' = a 60+ quality batch). */
export function giftOptions(state, id) {
  const d = A.defs[id];
  const out = [];
  const react = (key, ok = true) => (!ok ? 'neutral' : d.loved.includes(key) ? 'loved' : d.liked.includes(key) ? 'liked' : d.disliked.includes(key) ? 'disliked' : 'neutral');
  for (const [key, n] of Object.entries(state.player.inv)) {
    if (!(n > 0)) continue;
    if (key === 'wood') { if (n >= A.gift.wood) out.push({ key, label: `Firewood (${A.gift.wood} wood)`, react: react('wood') }); continue; }
    out.push({ key, label: CONFIG.itemNames[key] || key, react: react(key) });
  }
  if (budBatch(state)) out.push({ key: 'bud', label: `Quality ${A.gift.budQuality}+ bud (${A.gift.budGrams} g)`, react: react('bud') });
  return out;
}

/** One gift per ally per day: loved +8, liked +5, neutral +1, disliked -3. */
export function giveGift(state, id, key) {
  const a = allyOf(state, id);
  const d = A.defs[id];
  if (!a || a.status === 'dead') return { ok: false, msg: 'No one to give it to.' };
  if (a.estranged) return { ok: false, msg: `${d.name} refuses your gifts.` };
  const day = dayKeyOf(nowGh(state));
  if (a.giftDay === day) return { ok: false, msg: `${d.name} already got a gift today.` };
  const opt = giftOptions(state, id).find((o) => o.key === key);
  if (!opt) return { ok: false, msg: 'You do not have that.' };
  if (key === 'bud') budBatch(state).grams -= A.gift.budGrams;
  else state.player.inv[key] -= key === 'wood' ? A.gift.wood : 1;
  a.giftDay = day;
  contact(state, a);
  gain(state, a, G[opt.react]);
  const word = { loved: 'loves it', liked: 'likes it', neutral: 'says thanks', disliked: 'does not like that' }[opt.react];
  return { ok: true, react: opt.react, msg: `${d.name} ${word}.` };
}

/** Drink together at the bar: +3, costs a Booze use (an addiction hook). */
export function drinkTogether(state, id) {
  const a = allyOf(state, id);
  const d = A.defs[id];
  if (!a || a.status !== 'ok' || a.estranged) return { ok: false, msg: `${d ? d.name : 'They'} will not drink with you.` };
  const day = dayKeyOf(nowGh(state));
  if (a.drinkDay === day) return { ok: false, msg: `You already drank with ${d.name} today.` };
  if (state.player.cash < A.drinkPrice) return { ok: false, msg: 'Not enough cash.' };
  state.player.cash -= A.drinkPrice;
  a.drinkDay = day;
  contact(state, a);
  gain(state, a, G.drink);   // the round is on the table before the buzz kicks in
  useSubstance(state, 'booze');
  return { ok: true, msg: `You drink with ${d.name}.` };
}

/** Opening a conversation counts as contact. */
export function talkTo(state, id) { const a = allyOf(state, id); if (a) contact(state, a); }

// ---------------------------------------------------------------- favors --

const favorText = {
  fetch: (id) => `Bring me a ${CONFIG.itemNames[A.favors.fetch[id]]}.`,
  deliver: () => 'Carry this package across town.',
  walk: () => 'Walk me home tonight.',
  fence: () => `Fix my fence with ${A.favors.fenceWood} wood.`,
};
export const describeFavor = (id, f) => (f ? favorText[f.kind](id) : null);

function offerFavors(state, al) {
  const t = nowGh(state);
  for (const a of al.list) {
    if (a.favor && t - a.favor.since >= A.favors.everyDays * 24) {
      if (a.favor.kind === 'deliver' && a.favor.accepted && state.player.inv.package > 0) state.player.inv.package--;
      a.favor = null;
    }
    if (a.favor || a.status !== 'ok' || t < a.nextFavorAt) continue;
    a.favor = { kind: rngOf(state, (r) => r.pick(A.favors.kinds)), since: t, accepted: false };
    a.nextFavorAt = t + A.favors.everyDays * 24;
  }
}

export function acceptFavor(state, id) {
  const a = allyOf(state, id);
  if (!a || !a.favor || a.favor.accepted) return { ok: false, msg: 'Nothing to accept.' };
  a.favor.accepted = true;
  if (a.favor.kind === 'deliver') state.player.inv.package = (state.player.inv.package || 0) + 1;
  contact(state, a);
  return { ok: true, msg: describeFavor(id, a.favor) };
}

function favorReady(state, a) {
  const f = a.favor;
  const d = A.defs[a.id];
  const inv = state.player.inv;
  if (!f || !f.accepted) return false;
  const near = (x) => Math.abs(playerTile(state) - x) <= A.favors.reachTiles;
  if (f.kind === 'fetch') return (inv[A.favors.fetch[a.id]] || 0) > 0;
  if (f.kind === 'fence') return (inv.wood || 0) >= A.favors.fenceWood && onLot(state);
  if (f.kind === 'deliver') return (inv.package || 0) > 0 && near(d.deliverTo);
  return isNight(state.time.hour) && near(d.home); // walk
}

/** Hand over / finish an accepted favor if its condition holds: +12 and -1 heat. */
export function completeFavor(state, id) {
  const a = allyOf(state, id);
  if (!a || !a.favor) return { ok: false, msg: 'No favor to finish.' };
  if (!favorReady(state, a)) return { ok: false, msg: 'Not done yet.' };
  const inv = state.player.inv;
  const k = a.favor.kind;
  if (k === 'fetch') inv[A.favors.fetch[id]]--;
  else if (k === 'fence') inv.wood -= A.favors.fenceWood;
  else if (k === 'deliver') inv.package--;
  a.favor = null;
  contact(state, a);
  gain(state, a, G.favor);
  addHeat(state, G.favorHeat, `Favor for ${A.defs[id].name}`);
  alOf(state).stats.favors++;
  return { ok: true, msg: `${A.defs[id].name} is grateful.` };
}

// ------------------------------------------------------------- calling ---

const claimed = (state) => allyEnts(state).length + alOf(state).calls.length;

export function canCall(state, id, minHearts = A.callMinHearts) {
  const a = allyOf(state, id);
  if (!a || a.status !== 'ok') return { ok: false, msg: `${A.defs[id].name} is not available.` };
  if (hearts(state, id) < minHearts) return { ok: false, msg: `Needs ${minHearts} hearts.` };
  if (nowGh(state) < a.cooldownUntil) return { ok: false, msg: `${A.defs[id].name} needs a rest.` };
  if (entOf(state, id) || alOf(state).calls.some((c) => c.id === id)) return { ok: false, msg: 'Already on the way.' };
  if (claimed(state) >= A.max) return { ok: false, msg: `Only ${A.max} allies at once.` };
  if (policeHere(state)) return { ok: false, msg: 'Police are on the lot.' };
  return { ok: true };
}

/** Arrival in (6 - hearts) x 20 s, +20 s at night. */
export const arrivalSeconds = (state, id) =>
  (A.callBase - hearts(state, id)) * A.callSecondsPerHeart + (isNight(state.time.hour) ? A.nightExtraS : 0);

export function callAlly(state, id, { auto = false } = {}) {
  const c = canCall(state, id, auto ? A.autoHearts : A.callMinHearts);
  if (!c.ok) return c;
  const eta = arrivalSeconds(state, id);
  alOf(state).calls.push({ id, left: eta, auto });
  contact(state, allyOf(state, id));
  return { ok: true, eta, msg: `${A.defs[id].name} is on the way (${eta} s).` };
}

function spawnAlly(state, id) {
  const d = A.defs[id];
  const x = (Z.lotX1 - A.spawnOffsetTiles) * TS;
  const e = {
    id: state.nextId++, kind: 'ally', ally: id, x, y: groundY(state, x), hp: d.hp, maxHp: d.hp,
    state: 'defend', cd: 0, dir: -1, fought: false, quiet: 0, reviveT: 0, reviveFor: null, downedLeft: 0,
  };
  (state.entities || (state.entities = [])).push(e);
  toast(state, `${d.name} has arrived.`);
  return e;
}

// --------------------------------------------------- hostile targeting ----

/** Nearest ally a hostile can hit: standing ones, and downed ones only for gunmen. */
export function allyTargetNear(state, x, rangePx, gun = false) {
  let best = null;
  let bd = rangePx;
  for (const e of allyEnts(state)) {
    if (e.state === 'leave' || (e.state === 'downed' && !gun)) continue;
    const d = Math.abs(e.x - x) + (e.state === 'downed' ? rangePx * 0.5 : 0); // prefer someone standing
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

/** A hostile attacks an ally: accuracy roll, then hurt / downed / (gunfire on a downed ally) killed. */
export function strikeAlly(state, e, dmg, accuracy, gun) {
  if (!rngOf(state, (r) => r.chance(accuracy))) return false;
  if (e.state === 'downed') {
    if (gun && rngOf(state, (r) => r.chance(A.downed.killChance))) killAlly(state, e);
    return true;
  }
  e.hp -= dmg;
  if (e.hp <= 0) downAlly(state, e);
  return true;
}

function downAlly(state, e) {
  e.hp = 0;
  e.state = 'downed';
  e.downedLeft = A.downed.windowS;
  e.reviveT = 0;
  stressEvent(state); // "ally hurt"
  state.events.push({ type: 'allyDown', ally: e.ally });
  toast(state, `${A.defs[e.ally].name} is down! Hold E next to them to help.`);
}

/** Revive (Rosa, or you holding E for 5 s): up at 30 hp. */
export function reviveAlly(state, entId) {
  const e = allyEnts(state).find((x) => x.id === entId);
  if (!e || e.state !== 'downed') return false;
  e.state = 'defend';
  e.hp = A.downed.reviveHp;
  e.downedLeft = 0;
  e.quiet = 0;
  toast(state, `${A.defs[e.ally].name} is back on their feet.`);
  return true;
}

function toHospital(state, a, e) {
  removeEnt(state, e);
  a.status = 'hospital';
  a.until = nowGh(state) + A.downed.hospitalDays * 24;
  a.bill = true;
  alOf(state).stats.hurt++;
  toast(state, `${A.defs[a.id].name} is in the hospital for ${A.downed.hospitalDays} days. The bill is $${A.downed.bill}.`);
}

function killAlly(state, e) {
  const a = allyOf(state, e.ally);
  const al = alOf(state);
  removeEnt(state, e);
  a.status = 'dead';
  al.stats.killed++;
  for (const o of al.list) if (o !== a && o.status !== 'dead') gain(state, o, G.killedOthers);
  al.griefUntil = nowGh(state) + A.grief.days * 24;
  stressEvent(state);
  state.events.push({ type: 'notice', title: 'Killed', lines: [`${A.defs[a.id].name} is dead. The others are shaken, and so are you.`] });
}

function arrestAlly(state, a, e) {
  removeEnt(state, e);
  const t = nowGh(state);
  a.status = 'jailed'; a.until = t + A.arrest.days * 24; a.bailBy = t + A.arrest.windowGh;
  a.bailed = false; a.decided = false;
  alOf(state).stats.arrested++;
  toast(state, `${A.defs[a.id].name} was arrested. Bail is $${A.arrest.bail}.`);
}

/** Pay the $400 hospital bill (+15). Unpaid when they come home: -20. */
export function payBill(state, id) {
  const a = allyOf(state, id);
  if (!a || a.status !== 'hospital' || !a.bill) return { ok: false, msg: 'No bill to pay.' };
  if (state.player.cash < A.downed.bill) return { ok: false, msg: 'Not enough cash.' };
  state.player.cash -= A.downed.bill;
  a.bill = false;
  gain(state, a, G.paidBill);
  contact(state, a);
  return { ok: true, msg: `You paid ${A.defs[id].name}'s hospital bill.` };
}

/** Bail $600 (+15): they are back at the next dawn. */
export function bailAlly(state, id) {
  const a = allyOf(state, id);
  if (!a || a.status !== 'jailed' || a.bailed || a.decided) return { ok: false, msg: 'Nobody to bail out.' };
  if (state.player.cash < A.arrest.bail) return { ok: false, msg: 'Not enough cash.' };
  state.player.cash -= A.arrest.bail;
  a.bailed = true;
  a.until = Math.min(a.until, (state.time.hour < CONFIG.clock.wakeHour ? state.time.day : state.time.day + 1) * 24 + CONFIG.clock.wakeHour);
  gain(state, a, G.bail);
  contact(state, a);
  return { ok: true, msg: `${A.defs[id].name} will be out by morning.` };
}

/** Leave them in: -40, and unavailable for the full 6 days. */
export function leaveInJail(state, id) {
  const a = allyOf(state, id);
  if (!a || a.status !== 'jailed' || a.bailed || a.decided) return { ok: false, msg: 'Nothing to decide.' };
  a.decided = true;
  gain(state, a, G.leftInJail);
  return { ok: true, msg: `You left ${A.defs[id].name} in.` };
}

// ------------------------------------------------------------ the loan ---

export function answerLoan(state, lend) {
  const al = alOf(state);
  const a = allyOf(state, 'benny');
  if (!al.loan || al.loan.status !== 'asked') return { ok: false, msg: 'No one is asking.' };
  if (!lend) { al.loan.status = 'refused'; gain(state, a, G.loanRefuse); return { ok: true, msg: 'You turned Benny down.' }; }
  if (state.player.cash < A.loan.amount) return { ok: false, msg: 'Not enough cash.' };
  state.player.cash -= A.loan.amount;
  al.loan = {
    status: 'lent', repayAt: nowGh(state) + A.loan.repayDays * 24,
    willRepay: rngOf(state, (r) => r.chance(A.loan.repayChance)),
  };
  gain(state, a, G.loanLend);
  contact(state, a);
  return { ok: true, msg: 'You lent Benny the money.' };
}

// -------------------------------------------------------------- flowers ---

export function canPickFlowers(state) { return alOf(state).flowersDay !== dayKeyOf(nowGh(state)); }
export function pickFlowers(state) {
  if (!canPickFlowers(state)) return { ok: false, msg: 'The flower bed is bare today.' };
  alOf(state).flowersDay = dayKeyOf(nowGh(state));
  state.player.inv.flowers = (state.player.inv.flowers || 0) + A.flowers.perDay;
  return { ok: true, msg: 'You pick a bunch of flowers.' };
}

/** Allies standing at their town spots right now: [{id, x}] (tile x). */
export function spotsNow(state) {
  const h = state.time.hour;
  return alOf(state).list.filter((a) => {
    const s = A.defs[a.id].spot;
    return a.status === 'ok' && !entOf(state, a.id) && (s.open <= s.close ? h >= s.open && h < s.close : h >= s.open || h < s.close);
  }).map((a) => ({ id: a.id, x: A.defs[a.id].spot.x }));
}

// ----------------------------------------------------------- combat AI ---

function walk(e, tx, dt, speed) {
  const dx = tx - e.x;
  const step = speed * dt;
  if (Math.abs(dx) <= step) { e.x = tx; return true; }
  e.x += Math.sign(dx) * step;
  e.dir = Math.sign(dx);
  return false;
}

function depart(state, a, e) {
  removeEnt(state, e);
  if (!e.fought) return;
  gain(state, a, G.fought);
  contact(state, a);
  a.cooldownUntil = nowGh(state) + A.cooldownDays * 24;
  alOf(state).stats.fights++;
}

function stepRosa(state, e, d, dt, px) {
  const p = state.player;
  const al = alOf(state);
  // Whoever is down and closest gets her attention first.
  let cand = null;
  let bd = 1e9;
  for (const o of allyEnts(state)) {
    if (o !== e && o.state === 'downed' && Math.abs(o.x - e.x) < bd) { bd = Math.abs(o.x - e.x); cand = { x: o.x, key: o.id, ent: o }; }
  }
  if (p.downed && al.revive && Math.abs(px - e.x) < bd) cand = { x: px, key: 'player' };
  if (cand) {
    if (e.reviveFor !== cand.key) { e.reviveFor = cand.key; e.reviveT = 0; }
    if (Math.abs(cand.x - e.x) > A.downed.reviveReachTiles * TS) walk(e, cand.x, dt, d.speed);
    else {
      e.reviveT += dt;
      e.fought = true;
      if (e.reviveT >= A.downed.reviveS) {
        if (cand.key === 'player') {
          p.downed = false; p.hp = Math.min(A.downed.reviveHp, 100); al.revive = null;
          toast(state, 'Rosa pulls you back to your feet.');
        } else reviveAlly(state, cand.key);
        e.reviveT = 0; e.reviveFor = null;
      }
    }
  } else {
    e.reviveFor = null; e.reviveT = 0;
    if (Math.abs(px - e.x) > 2 * TS) walk(e, px, dt, d.speed);
    e.quiet += dt;
    if (e.quiet >= A.idleLeaveS) e.state = 'leave';
  }
  // 5 hp/s to anyone hurt within 3 tiles.
  const hp = d.healHps * dt;
  const r = d.healTiles * TS;
  if (!p.downed && Math.abs(px - e.x) <= r && p.hp < 100) { p.hp = Math.min(100, p.hp + hp); e.fought = true; e.quiet = 0; }
  for (const o of allyEnts(state)) {
    if (o !== e && o.state !== 'downed' && o.hp < o.maxHp && Math.abs(o.x - e.x) <= r) { o.hp = Math.min(o.maxHp, o.hp + hp); e.fought = true; e.quiet = 0; }
  }
}

function stepEntity(state, e, dt) {
  const a = allyOf(state, e.ally);
  const d = A.defs[e.ally];
  const p = state.player;
  e.y = groundY(state, e.x);
  e.cd = Math.max(0, e.cd - dt);
  if (policeHere(state) && e.state !== 'leave') { // allies never fight police
    if (e.state === 'downed') { toHospital(state, a, e); return; }
    e.state = 'leave';
  }
  if (e.state === 'downed') {
    e.downedLeft -= dt;
    if (e.downedLeft <= 0) toHospital(state, a, e);
    return;
  }
  if (e.state === 'leave' || e.state === 'retreat') {
    if (walk(e, (Z.lotX1 + 2) * TS, dt, d.speed)) depart(state, a, e);
    return;
  }
  if (e.hp < e.maxHp * A.retreatFrac) { e.state = 'retreat'; return; }
  const px = p.x + p.w / 2;
  if (d.heals) { stepRosa(state, e, d, dt, px); return; }
  let tgt = null;
  let best = A.aggroTiles * TS;
  for (const h of state.entities) {
    if (h.kind === 'ally' || !isHostile(h)) continue;
    const dd = Math.abs(h.x - e.x);
    if (dd < best) { best = dd; tgt = h; }
  }
  if (!tgt) {
    if (Math.abs(px - e.x) > 3 * TS) walk(e, px, dt, d.speed);
    e.quiet += dt;
    if ((e.fought && e.quiet >= A.fightEndS) || e.quiet >= A.idleLeaveS) e.state = 'leave';
    return;
  }
  e.quiet = 0;
  e.dir = Math.sign(tgt.x - e.x) || e.dir;
  const range = d.rangeTiles * TS;
  const los = d.melee || !raycastSolid(state.tiles, e.x, e.y - 12, tgt.x, tgt.y - 12, 2000);
  const inRange = best <= range && los;
  if (!inRange || best > range * 0.8) { // close in, but stay within 10 tiles of the player
    const nx = e.x + e.dir * Math.min(best, d.speed * dt);
    if (Math.abs(nx - px) <= A.followTiles * TS || Math.abs(nx - px) < Math.abs(e.x - px)) e.x = nx;
  }
  if (inRange && e.cd <= 0) {
    e.cd = 1 / d.rate;
    e.fought = true;
    if (rngOf(state, (r) => r.chance(d.acc))) damageEntity(state, tgt, d.dmg, d.melee ? 'melee' : 'gun');
    if (!d.melee) gunNoise(state, d.weapon, false, e.x);
  }
}

// ------------------------------------------------------- the 2 Hz step ---

/** Unhandled events of a type (marked, so a second sim tick in the same frame skips them). */
function fresh(state, type) {
  const out = [];
  for (const ev of state.events) if (ev.type === type && !ev.allySeen) { ev.allySeen = true; out.push(ev); }
  return out;
}

/** A near ally sees you use a hard drug: -3. */
function witnessed(state) {
  const h = state.time.hour;
  const px = playerTile(state);
  for (const a of alOf(state).list) {
    if (a.status === 'dead') continue;
    const e = entOf(state, a.id);
    const s = A.defs[a.id].spot;
    const open = s.open <= s.close ? h >= s.open && h < s.close : h >= s.open || h < s.close;
    const near = e ? Math.abs(e.x / TS - px) <= A.witnessTiles : a.status === 'ok' && open && Math.abs(s.x - px) <= A.witnessTiles;
    if (near) gain(state, a, G.hardDrug);
  }
}

/** 4+ heart allies come when a camera or dog alert fires and you are away or asleep. */
function autoRespond(state, woke) {
  const away = state.sleeping || woke || hs(state).jailed || !onLot(state);
  if (!away) return;
  const order = ALLY_KEYS.filter((id) => hearts(state, id) >= A.autoHearts).sort((x, y) => hearts(state, y) - hearts(state, x));
  for (const id of order) callAlly(state, id, { auto: true });
}

/** Benny at 5 hearts: four plants go for a drive when a raid is coming. */
function hidePots(state, al) {
  const h = hs(state);
  const t = nowGh(state);
  if (al.hidden.length === 0 && hearts(state, 'benny') >= P.hideHearts && allyOf(state, 'benny').status === 'ok') {
    const mine = state.plants.filter((pl) => !pl.dead).sort((x, y) => y.progress - x.progress).slice(0, P.hidePots);
    for (const pl of mine) pl.away = true;
    al.hidden = mine.map((pl) => pl.id);
    al.hideUntil = t + P.hideGh;
    if (mine.length) toast(state, `Benny drives ${mine.length} pots out of sight.`);
  } else if (al.hidden.length && t >= al.hideUntil && !h.raid) {
    for (const pl of state.plants) if (al.hidden.includes(pl.id)) pl.away = false;
    al.hidden = [];
  }
}

export function allyCover(state) {
  return hs(state).jailed && ALLY_KEYS.some((id) => hearts(state, id) >= A.coverHearts && allyOf(state, id).status === 'ok');
}

function daily(state, al) {
  const t = nowGh(state);
  for (const a of al.list) {
    if (a.status === 'ok' && a.lastContact !== null && t - a.lastContact > A.noContactDays * 24) gain(state, a, G.noContact);
  }
  const benny = allyOf(state, 'benny');
  if (!al.loan && state.time.day > A.loan.afterDay && benny.status === 'ok' && !benny.estranged) {
    al.loan = { status: 'asked' };
    state.events.push({ type: 'notice', title: 'Benny', lines: [`Benny needs $${A.loan.amount} and asks you for a loan. (Phone, Allies.)`] });
  }
  if (al.hatchKnown && state.threats.stats.breakIns > al.hatchBreakIns) al.hatchKnown = false;
}

export function stepAllies(state, dt) {
  const al = alOf(state);
  const h = state.time.hour;
  const t = nowGh(state);
  const prev = al.lastHour === null ? h : al.lastHour;
  al.lastHour = h;
  for (const a of al.list) if (a.lastContact === null) a.lastContact = t;
  if (crossed(prev, h, CONFIG.clock.wakeHour)) daily(state, al);

  // Back from the hospital or a cell; the loan comes due.
  for (const a of al.list) {
    if (a.status === 'jailed' && !a.bailed && !a.decided && t >= a.bailBy) leaveInJail(state, a.id);
    if ((a.status === 'hospital' || a.status === 'jailed') && t >= a.until) {
      if (a.status === 'hospital' && a.bill) { a.bill = false; gain(state, a, G.unpaidBill); }
      a.status = 'ok'; a.bailed = false; a.decided = false;
      toast(state, `${A.defs[a.id].name} is back.`);
    }
  }
  if (al.loan && al.loan.status === 'lent' && t >= al.loan.repayAt) {
    if (al.loan.willRepay) { state.player.cash += A.loan.amount; toast(state, 'Benny paid you back.'); }
    else toast(state, 'Benny never paid you back.');
    al.loan.status = al.loan.willRepay ? 'repaid' : 'defaulted';
  }
  offerFavors(state, al);
  for (const a of al.list) if (a.favor && a.favor.accepted && (a.favor.kind === 'deliver' || a.favor.kind === 'walk')) {
    if (favorReady(state, a)) toast(state, completeFavor(state, a.id).msg);
  }

  // Things that happened this tick.
  if (fresh(state, 'hardUse').length) witnessed(state);
  const woke = state.events.some((e) => e.type === 'wake' && !e.allySeen);
  for (const ev of fresh(state, 'alert')) if (A.autoKinds.includes(ev.kind)) autoRespond(state, woke);
  const warned = fresh(state, 'raidWarning').length + fresh(state, 'raidStart').length;
  if (warned || hs(state).raid || al.hidden.length) hidePots(state, al);

  // Calls arrive (never into police).
  for (const c of al.calls.slice()) {
    c.left -= dt;
    if (c.left <= 0 && !policeHere(state)) { al.calls.splice(al.calls.indexOf(c), 1); spawnAlly(state, c.id); }
  }
  // A patrol answering gunfire: armed allies still here are arrested 50% of the time; the rest leave.
  let responders = false;
  for (const c of state.cops || []) if (c.responder && !c.allyChecked) { c.allyChecked = true; responders = true; }
  if (responders) {
    for (const e of allyEnts(state)) {
      if (A.defs[e.ally].armed && rngOf(state, (r) => r.chance(A.arrest.chance))) arrestAlly(state, allyOf(state, e.ally), e);
    }
  }
  for (const e of allyEnts(state)) stepEntity(state, e, dt);

  // Rosa saving the player: she has to reach them in time, or it is the clinic.
  const p = state.player;
  if (al.revive) {
    al.revive.left -= dt;
    const rosa = entOf(state, 'rosa');
    if (!p.downed) al.revive = null;
    else if (al.revive.left <= 0 || !rosa || rosa.state !== 'defend') { al.revive = null; sendToClinic(state); }
  }

  // Perks, sponsor, patrol warning, absence cover.
  const w = allyOf(state, 'walt');
  if (hearts(state, 'walt') >= P.warnHearts && w.status === 'ok' && state.patrolCar && !state.patrolCar.warned) {
    state.patrolCar.warned = true;
    toast(state, 'Walt calls: a patrol car just went up the road.');
  }
  addOf(state).sponsor = ALLY_KEYS.some((id) => hearts(state, id) >= P.sponsorHearts && allyOf(state, id).status === 'ok');
  const cover = allyCover(state);
  for (const pl of state.plants) {
    if (cover) {
      pl.gardened = true; pl.careCap = A.coverCareCap;
      pl.moisture = Math.max(pl.moisture, 50); pl.nutrients = Math.max(pl.nutrients, 50);
    } else if (pl.careCap === A.coverCareCap) delete pl.careCap;
  }
}

/** Player hit 0 hp: Rosa on the lot gets a chance to reach them (true = the clinic is put on hold). */
export function beginPlayerRevive(state) {
  const rosa = entOf(state, 'rosa');
  if (!rosa || rosa.state !== 'defend' || policeHere(state)) return false;
  alOf(state).revive = { left: A.downed.playerWaitS };
  toast(state, 'You are down. Rosa is running to you.');
  return true;
}

export const reviving = (state) => !!(state.allies && state.allies.revive);
