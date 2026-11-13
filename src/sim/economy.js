// economy.js — money, pricing, shops, product batches and drying (plan §A7).
// Pure module: no window/document, runs unmodified in Node (plan §B3 rule).
//
// M2 scope: cash only (the clean Bank balance arrives with laundering in M10),
// Skeet with a fixed price (trust/orders/discovery are M3), and the hardware
// shop with seeds/pots/soil/nutrients/pH kit/meters/rack only.
//
// Product is stored as batches {strainName, quality, grams, wet, ...}. Wet
// batches dry 24 gh on a drying rack; batches of the same strain merge into a
// weighted-average quality (plan §A7). Heat from sales arrives with M4.

import { CONFIG } from '../config.js';
import { withStateRng } from '../rng.js';
import { rollSeedGenome } from './genetics.js';
import { seedBagOf } from './plants.js';
import { strainUnlocked } from './mastery.js';
import { canBuyDog, giveDog, dogHurt, healDog } from '../entities/dog.js';
import { buyTruce } from './threats.js';
import { shopBlocked, priceMult } from './allies.js';
import { spendMoney, canAfford, buyFront, legacyQuiet } from './license.js';
import { dealerPrice, buyerPenalty, canTaper, startTaper, detox, useSubstance } from './addiction.js';
import {
  addHeat, heatTier, noteSale, noteSpend, bribeDeputy, bribePrice, hireLawyer, rumorText,
} from './heat.js';

export { addHeat, heatTier };

const E = CONFIG.economy;
const P = CONFIG.plants;

/** Absolute game hours since day 0, monotonic across day rollovers. */
export const nowGh = (state) => state.time.day * 24 + state.time.hour;

/** Is `hour` inside [open, close)? open > close wraps past midnight. */
export function inHours(hour, open, close) {
  return open <= close ? hour >= open && hour < close : hour >= open || hour < close;
}

/** Is a shop open at this clock hour? Hours come from config. */
export function shopOpen(time, shopKey) {
  const s = E[shopKey];
  return inHours(time.hour, s.open, s.close);
}

/** A shop's stock in menu order: {key, name, price, service, unreg}. */
export function shopStock(shopKey, state) {
  return E.stock[shopKey].filter((key) => !state || !seedStrain(key) || strainUnlocked(state, seedStrain(key))).map((key) => {
    const unreg = shopKey === 'alley' && E.unregStock.includes(key);
    const base = key === 'bribe' && state ? bribePrice(state) : E.prices[key];
    const mult = state ? priceMult(state, shopKey, key) : 1; // June's discount / markup, Rosa's taper price (M9)
    return {
      key, name: CONFIG.itemNames[key], unreg,
      price: unreg ? Math.round(base * (1 + E.alleyGunMarkup))
        : state && shopKey === 'alley' && (key === 'crank' || key === 'blues') ? dealerPrice(state, key) : Math.round(base * mult),
      service: E.services.includes(key),
    };
  });
}

/** Strain key whose seeds an item key is, or null. */
const seedStrain = (key) => Object.keys(CONFIG.strains).find((k) => CONFIG.strains[k].item === key) || null;

export const hardwareStock = () => shopStock('hardware');

function grantItem(state, key, shopKey) {
  const inv = state.player.inv;
  // Alley guns are unregistered: found in a raid = arrest (plan §A9).
  if (shopKey === 'alley' && E.unregStock.includes(key)) {
    state.player.unreg = { ...(state.player.unreg || {}), [key]: true };
    state.player.gunUnregistered = true;
  }
  if (seedStrain(key)) {
    // Purchased seeds are feminized and vary ±3 per trait (plan §A4); the
    // genome is rolled at purchase with the save's PRNG and queued in the
    // strain's seed bag. The starter seeds are exact base-strain genomes.
    const sk = seedStrain(key);
    seedBagOf(state.player, sk).push(withStateRng(state, (rng) => rollSeedGenome(sk, rng)));
    inv[key] = (inv[key] || 0) + 1;
  } else if (key === 'nutrients') {
    inv.nutrients = (inv.nutrients || 0) + E.doses.nutrients;
  } else if (key === 'phkit') {
    inv.phkit = (inv.phkit || 0) + E.doses.phkit;
  } else {
    inv[key] = (inv[key] || 0) + (E.packs[key] || 1);
  }
}

/**
 * Buy from a shop (default hardware). Checks hours and stock when the shop is
 * named by the caller. Services are paid for but not carried; the bar's drink
 * and ask-around have their effects here, the rest are events for later
 * milestones. Returns {ok, msg}.
 */
export function buyItem(state, key, shopKey = 'hardware') {
  const entry = shopStock(shopKey, state).find((e) => e.key === key);
  if (!entry) return { ok: false, msg: 'They don\'t stock that.' };
  if (!shopOpen(state.time, shopKey)) return { ok: false, msg: `${E[shopKey].label} is closed.` };
  const blocked = shopBlocked(state, shopKey);
  if (blocked) return { ok: false, msg: blocked };
  const p = state.player;
  if (seedStrain(key) && !strainUnlocked(state, seedStrain(key))) return { ok: false, msg: 'Those seeds are not on sale yet.' };
  if (key === 'bribe') return bribeDeputy(state);
  if (key === 'truce') return buyTruce(state);
  if (key === 'dog' && !canBuyDog(state)) return { ok: false, msg: 'You already have a dog.' };
  if (key === 'taper' && !canTaper(state)) return { ok: false, msg: 'You already have a taper kit for today.' };
  if (key === 'vet' && !dogHurt(state)) return { ok: false, msg: 'Your dog is fine.' };
  if (!canAfford(state, entry.price)) return { ok: false, msg: 'Not enough cash.' };
  if (key === 'ask_around') return askAround(state);
  if (key === 'permit') return buyFront(state); // pays from cash, then bank
  spendMoney(state, entry.price); // cash (dirty) first, then bank; dirty spending feeds flashy heat
  if (entry.service) {
    state.events.push({ type: 'service', key });
    if (key === 'drink') {
      drinkAtBar(state);
      if (heatTier(state.heat) >= 1) return { ok: true, msg: CONFIG.heat.peopleTalking };
    }
    if (key === 'rumor') return { ok: true, msg: rumorText(state) };
    if (key === 'lawyer') hireLawyer(state);
    if (key === 'dog') giveDog(state);
    if (key === 'vet') healDog(state);
    if (key === 'taper') return startTaper(state);
    if (key === 'detox') return detox(state);
    return { ok: true, msg: `Paid for: ${entry.name}` };
  }
  grantItem(state, key, shopKey);
  state.events.push({ type: 'action', name: 'cash' });
  return { ok: true, msg: `Bought ${entry.name}` };
}

/** Price per gram (plan §A7): ($4 + $0.10*quality) x wet multiplier. */
export function pricePerGram(batch) {
  const wet = batch.wet ? P.wetPriceMult : 1;
  return (E.priceBase + E.pricePerQuality * batch.quality) * wet;
}

/** Inventory batches (where === 'inv'). */
export function invBatches(state) {
  return state.product.filter((b) => b.where === 'inv');
}

/**
 * Add a batch to the inventory, merging into an existing dry batch of the
 * same strain as a weighted average (plan §A7). Wet batches stay separate
 * (each dries on its own rack slot).
 */
export function addProduct(state, batch) {
  if (!batch.wet) {
    const ex = state.product.find((b) =>
      b.where === 'inv' && !b.wet && b.strainName === batch.strainName);
    if (ex) {
      const grams = ex.grams + batch.grams;
      ex.quality = Math.round(((ex.quality * ex.grams + batch.quality * batch.grams) / grams) * 10) / 10;
      ex.grams = grams;
      return ex;
    }
  }
  state.product.push(batch);
  return batch;
}

/** Sell one batch (M2: Skeet, fixed price, no trust/heat yet). */
export function sellBatch(state, batch) {
  const value = pricePerGram(batch) * batch.grams;
  const idx = state.product.indexOf(batch);
  if (idx >= 0) state.product.splice(idx, 1);
  state.player.cash += value;
  state.events.push({
    type: 'sale', buyer: 'Skeet', strainName: batch.strainName,
    grams: batch.grams, value, wet: batch.wet,
  });
  return value;
}

/** Batches currently on a rack. */
export function rackBatches(state, rackId) {
  return state.product.filter((b) => b.where === rackId);
}

export function rackFreeSlots(state, rack) {
  return P.rackCapacity - rackBatches(state, rack.id).length;
}

/** Load one wet inventory batch onto a rack. Returns {ok, msg}. */
export function loadRack(state, rack) {
  const batch = state.product.find((b) => b.where === 'inv' && b.wet);
  if (!batch) return { ok: false, msg: 'Nothing wet to hang.' };
  if (rackFreeSlots(state, rack) <= 0) return { ok: false, msg: 'The rack is full.' };
  batch.where = rack.id;
  batch.rackId = rack.id;
  return { ok: true, msg: 'Hung a batch to dry.' };
}

/** Unload every dried batch back to the inventory (merged by addProduct). */
export function unloadRack(state, rack) {
  let n = 0;
  for (const b of state.product.slice()) {
    if (b.where === rack.id && !b.wet) {
      b.where = 'inv';
      b.rackId = null;
      state.product.splice(state.product.indexOf(b), 1);
      addProduct(state, b);
      n++;
    }
  }
  return n;
}

/** 2 Hz tick: wet batches on racks dry toward the 24 gh mark (plan §A4).
 *  The remaining time is allowed to land within half a tick of zero so float
 *  residue in the countdown cannot add a whole extra tick. */
export function stepEconomy(state, gh) {
  stepBuyers(state);
  const eps = gh / 2;
  for (const b of state.product) {
    if (b.wet && b.where !== 'inv') {
      b.dryHoursLeft -= gh;
      if (b.dryHoursLeft <= eps) {
        b.wet = false;
        b.dryHoursLeft = 0;
        state.events.push({ type: 'dried', strainName: b.strainName, grams: b.grams });
      }
    }
  }
}

// ======================================================== M3: buyers ======
// Orders, trust, discovery and street sales (plan §A7). All state lives in
// state.economy (saved); the heat meter itself lives in heat.js.

const TR = E.trust;
const MISS = E.miss;
const DAY = 24;
export const BUYER_KEYS = Object.keys(E.buyers);

/** Fresh economy block for a new run (or a save from before M3). */
export function initEconomy(time) {
  const start = time.day * DAY + time.hour;
  const buyers = {};
  for (const key of BUYER_KEYS) {
    const def = E.buyers[key];
    buyers[key] = {
      known: !!def.start, pts: 0, streak: 0, misses: [], smaller: false,
      dormantUntil: 0, returnPts: 0,
      nextOrderAt: def.start ? start + def.firstOrderGh : 0,
    };
  }
  return {
    buyers, orders: [], ledger: [], gross: 0, drinks: 0, askAt: null,
    fees: [], daleAggression: 0, streetSales: [], nextOrderId: 1,
  };
}

export function trustLevel(pts) {
  let l = 0;
  for (const t of TR.thresholds) if (pts >= t) l++;
  return l;
}

export const buyerLevel = (state, key) => trustLevel(state.economy.buyers[key].pts);

function ledger(state, text, amount = 0, extra) {
  const L = state.economy.ledger;
  L.push({ day: state.time.day, hour: Math.floor(state.time.hour), text, amount, ...extra });
  while (L.length > E.ledgerMax) L.shift();
}

/** The buyer's current order, or undefined. */
export const orderOf = (state, key) => state.economy.orders.find((o) => o.buyer === key);

/** Is this buyer standing at their spot right now? (known, awake, in hours) */
export function buyerPresent(state, key) {
  const b = state.economy.buyers[key];
  const def = E.buyers[key];
  if (!b.known || b.dormantUntil) return false;
  if (def.weekdays && !def.weekdays.includes(state.time.day % 7)) return false;
  return inHours(state.time.hour, def.open, def.close);
}

/** Order size from trust level, shrunk once after a miss. */
export function orderSize(state, key) {
  const def = E.buyers[key];
  const b = state.economy.buyers[key];
  let g = def.min + (def.max - def.min) * trustLevel(b.pts) / 5;
  if (b.smaller) g *= MISS.smallerMult;
  return Math.max(1, Math.round(g));
}

export function discoverBuyer(state, key, via) {
  const b = state.economy.buyers[key];
  if (b.known) return false;
  b.known = true;
  b.nextOrderAt = nowGh(state) + E.firstOrderDelayGh;
  ledger(state, `Met ${E.buyers[key].name} (${via})`);
  state.events.push({ type: 'discover', buyer: key, name: E.buyers[key].name, via });
  return true;
}

function checkReferrals(state, key) {
  const lvl = buyerLevel(state, key);
  for (const r of E.referrals) {
    if (r.from === key && lvl >= r.level) discoverBuyer(state, r.to, `${E.buyers[key].name} referral`);
  }
}

function issueOrder(state, key) {
  const def = E.buyers[key];
  const b = state.economy.buyers[key];
  const now = nowGh(state);
  const order = {
    id: state.economy.nextOrderId++, buyer: key,
    grams: orderSize(state, key), minQ: def.minQ,
    issued: now, deadline: now + def.deadlineGh,
  };
  b.smaller = false;
  b.nextOrderAt = now + def.everyDays * DAY;
  state.economy.orders.push(order);
  state.events.push({ type: 'order', buyer: key, name: def.name, grams: order.grams });
  return order;
}

/** Dry inventory batches good enough for this order, best quality first. */
function fillStock(state, order) {
  return state.product
    .filter((b) => b.where === 'inv' && !b.wet && b.quality >= order.minQ && b.grams > 0)
    .sort((a, c) => c.quality - a.quality);
}

/** Price multiplier for a buyer at their current trust. */
export function buyerMult(state, key) {
  const lv = buyerLevel(state, key);
  return TR.priceMult[lv] * E.buyers[key].mod * buyerPenalty(state, lv);
}

/** Preview/execute: grams you can deliver and the payout. */
export function fillQuote(state, order, stock = fillStock(state, order)) {
  const mult = buyerMult(state, order.buyer);
  let left = order.grams;
  let grams = 0;
  let value = 0;
  let qsum = 0;
  for (const b of stock) {
    const g = Math.min(left, b.grams);
    grams += g; left -= g;
    value += g * pricePerGram(b) * mult;
    qsum += g * b.quality;
    if (left <= 0) break;
  }
  return { grams, value, quality: grams > 0 ? qsum / grams : 0 };
}

/**
 * Deliver an order from inventory. Needs the buyer present. At least half the
 * order is required (partial fill); the order closes either way. Trust points:
 * full on time +10 (+5 if quality is 20+ over the minimum), partial on time
 * +3, late (within grace) 0.
 */
export function fillOrder(state, orderId, opts = {}) {
  const order = state.economy.orders.find((o) => o.id === orderId);
  if (!order) return { ok: false, msg: 'No such order.' };
  const key = order.buyer;
  const def = E.buyers[key];
  // A runner (M6) delivers from his own bag: opts.stock, opts.late (he dawdled),
  // opts.cut (the share he skims off the payment).
  if (!opts.runner && !buyerPresent(state, key)) return { ok: false, msg: `${def.name} isn't here.` };
  const stock = opts.stock || fillStock(state, order);
  const q = fillQuote(state, order, stock);
  if (q.grams < order.grams * TR.partialMin) {
    return { ok: false, msg: `Need at least ${Math.ceil(order.grams * TR.partialMin)} g of q${order.minQ}+ dry product.` };
  }
  // Consume, best quality first (same order the quote used).
  let left = q.grams;
  for (const b of stock) {
    const g = Math.min(left, b.grams);
    b.grams -= g; left -= g;
    if (b.grams <= 1e-6) state.product.splice(state.product.indexOf(b), 1);
    if (left <= 1e-9) break;
  }
  const bs = state.economy.buyers[key];
  if (!opts.runner) bs.personal = true; // you have sold to them yourself (ledger shows "expected")
  const late = !!opts.late || nowGh(state) > order.deadline;
  const partial = q.grams < order.grams - 1e-9;
  let pts = TR.late;
  if (!late) {
    pts = partial ? TR.partial : TR.full + (q.quality >= order.minQ + TR.qualityBonusOver ? TR.qualityBonus : 0);
  }
  const lvl = trustLevel(bs.pts);
  const paid = q.value * (1 - (opts.cut || 0));
  state.player.cash += paid;
  state.economy.gross += paid;
  if (def.heat && !legacyQuiet(state)) addHeat(state, E.saleHeat[lvl], `Sale to ${def.name}`);
  noteSale(state);
  bs.pts += pts;
  bs.streak = 0;
  state.economy.orders.splice(state.economy.orders.indexOf(order), 1);
  const outcome = late ? 'late' : partial ? 'partial' : 'full';
  ledger(state, `${def.name}: ${outcome} order, ${q.grams.toFixed(0)} g${opts.runner ? ` (${opts.runner})` : ''}`, paid,
    { buyer: key, expected: q.value });
  state.events.push({
    type: 'sale', buyer: def.name, grams: q.grams, value: paid, outcome, pts,
  });
  checkReferrals(state, key);
  return { ok: true, outcome, pts, value: q.value, paid, grams: q.grams };
}

function missOrder(state, order) {
  const key = order.buyer;
  const def = E.buyers[key];
  const b = state.economy.buyers[key];
  const now = nowGh(state);
  state.economy.orders.splice(state.economy.orders.indexOf(order), 1);
  b.pts = Math.max(0, b.pts + TR.missed);
  b.smaller = true;
  b.streak++;
  b.misses.push(now);
  b.misses = b.misses.filter((t) => now - t <= MISS.repeatWindowDays * DAY);
  ledger(state, `Missed ${def.name}'s order`);
  state.events.push({ type: 'missed', buyer: key, name: def.name });
  if (key === 'tone') {
    state.economy.fees.push({ buyer: key, amount: MISS.toneFee });
    state.events.push({ type: 'toast', msg: `A biker is coming for Big Tone's $${MISS.toneFee} "inconvenience fee".` });
  }
  let days = 0;
  if (b.misses.length >= MISS.repeatCount) {
    days = MISS.repeatDormantDays;
    b.returnPts = 0;
  } else if (b.streak >= 2) {
    days = MISS.streakDormantDays;
    const lvl = Math.max(0, trustLevel(b.pts) - MISS.streakLevelDrop);
    b.returnPts = lvl > 0 ? TR.thresholds[lvl - 1] : 0;
  }
  if (!days) return;
  if (key === 'skeet') days = Math.min(days, MISS.skeetMaxDormantDays);
  b.dormantUntil = now + days * DAY;
  b.streak = 0;
  b.misses = [];
  ledger(state, `${def.name} found another supplier`);
  state.events.push({ type: 'toast', msg: `${def.name} found another supplier.` });
  if (def.dale) {
    state.economy.daleAggression += MISS.daleAggression;
    state.events.push({ type: 'daleGloat', buyer: key });
  }
}

/** Pay a pending collection fee (Big Tone's biker; refusing is a fight in M5). */
export function payFee(state) {
  const fee = state.economy.fees[0];
  if (!fee) return { ok: false, msg: 'Nobody is collecting.' };
  if (state.player.cash < fee.amount) return { ok: false, msg: 'Not enough cash.' };
  state.player.cash -= fee.amount;
  state.economy.fees.shift();
  ledger(state, 'Paid the collection fee', -fee.amount);
  return { ok: true, msg: `Paid $${fee.amount}.` };
}

/** 2 Hz: issue due orders, expire missed ones, wake dormant buyers, ask-around. */
export function stepBuyers(state) {
  const eco = state.economy;
  const now = nowGh(state);
  for (const key of BUYER_KEYS) {
    const b = eco.buyers[key];
    if (!b.known) continue;
    if (b.dormantUntil) {
      if (now < b.dormantUntil) continue;
      b.dormantUntil = 0;
      b.pts = b.returnPts;
      b.nextOrderAt = now + E.returnDelayGh;
      state.events.push({ type: 'toast', msg: `${E.buyers[key].name} is back.` });
    }
    if (now >= b.nextOrderAt && !orderOf(state, key)) issueOrder(state, key);
  }
  for (const o of eco.orders.slice()) {
    if (now > o.deadline + E.lateGraceGh) missOrder(state, o);
  }
  if (eco.askAt !== null && now >= eco.askAt) {
    eco.askAt = null;
    const hidden = BUYER_KEYS.filter((k) => !eco.buyers[k].known);
    if (hidden.length > 0) {
      discoverBuyer(state, withStateRng(state, (rng) => rng.pick(hidden)), 'asking around');
    }
  }
}

// ----------------------------------------------------------- discovery ----

/** Bar: $50, +4 heat, one random hidden buyer shows up in 1-2 days. */
export function askAround(state) {
  const eco = state.economy;
  const A = E.askAround;
  if (eco.askAt !== null) return { ok: false, msg: 'You already put the word out.' };
  if (BUYER_KEYS.every((k) => eco.buyers[k].known)) return { ok: false, msg: 'You know everyone already.' };
  if (state.player.cash < A.cost) return { ok: false, msg: 'Not enough cash.' };
  state.player.cash -= A.cost;
  addHeat(state, A.heat, 'Asked around for buyers');
  eco.askAt = nowGh(state) + withStateRng(state, (rng) => rng.range(A.minGh, A.maxGh));
  ledger(state, 'Asked around at the bar', -A.cost);
  return { ok: true, msg: 'The bartender nods. Someone will find you.' };
}

function drinkAtBar(state) {
  const eco = state.economy;
  eco.drinks++;
  useSubstance(state, 'booze');
  if (eco.drinks >= E.barDrinksToTalk) discoverBuyer(state, 'marla', 'a chat at the bar');
}

// -------------------------------------------------------- street sales ----

/** A new pedestrian's interest is rolled once, at spawn. */
export function rollInterest(state) {
  return withStateRng(state, (rng) => rng.chance(E.street.interest));
}

/**
 * Approach a pedestrian (plan §A7). Interested ones (20%) buy 3.5-14 g of
 * your best batch at x1.0 for +3 heat; an undercover (2/5/10/20% by heat
 * tier) takes the product and adds +12 heat. Each pedestrian is asked once.
 */
export function streetSale(state, ped) {
  const S = E.street;
  if (ped.asked) return { ok: false, msg: 'They already said no.' };
  ped.asked = true;
  if (!ped.interested) return { ok: false, msg: '"Not interested."' };
  const batch = state.product
    .filter((b) => b.where === 'inv' && b.grams > 0)
    .sort((a, c) => (pricePerGram(c) - pricePerGram(a)))[0];
  if (!batch) return { ok: false, msg: 'You have nothing to sell.' };
  const r = withStateRng(state, (rng) => ({ g: rng.range(S.minG, S.maxG), cop: rng.next() }));
  const grams = Math.min(batch.grams, Math.round(r.g * 10) / 10);
  const take = () => {
    batch.grams -= grams;
    if (batch.grams <= 1e-6) state.product.splice(state.product.indexOf(batch), 1);
  };
  if (r.cop < S.undercover[heatTier(state.heat || 0)]) {
    take();
    addHeat(state, S.undercoverHeat, 'Sold to an undercover');
    ledger(state, `Undercover! Lost ${grams} g`);
    state.events.push({ type: 'undercover', grams });
    return { ok: false, undercover: true, msg: 'Undercover cop! Product gone.' };
  }
  const value = grams * pricePerGram(batch) * S.mod;
  take();
  state.player.cash += value;
  state.economy.gross += value;
  if (!legacyQuiet(state)) addHeat(state, S.heat, 'Street sale to a stranger');
  noteSale(state);
  state.economy.streetSales.push(nowGh(state));
  ledger(state, `Street sale, ${grams} g`, value);
  state.events.push({ type: 'sale', buyer: 'a stranger', grams, value, outcome: 'street' });
  return { ok: true, value, grams };
}

// ---------------------------------------------------------- carry limit ---

export const carriedGrams = (state) =>
  state.product.reduce((n, b) => (b.where === 'inv' ? n + b.grams : n), 0);

export const carryCap = (state) =>
  state.player.inv.duffel > 0 ? E.carry.duffel : E.carry.backpack;
