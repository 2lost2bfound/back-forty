// edibles.js — M12: the kitchen stove, three recipes, and edible sales at the
// dispensary (Bank, no heat) and to buyers (dirty cash, +1 heat per sale).
// Pure and deterministic: no RNG. Edibles live in state.edibles, never in
// state.product, so raids and patrol stops (which only touch product) skip them.

import { CONFIG } from '../config.js';
import { spendMoney, canAfford } from './license.js';
import { shopOpen, ledger, buyerPresent, buyerLevel, BUYER_KEYS } from './economy.js';
import { heatEvent, noteSale } from './heat.js';
import { lineOf } from './genetics.js';

const X = CONFIG.edibles;
export const RECIPE_KEYS = Object.keys(X.recipes);

export const initEdibles = () => ({ batches: [], dispDay: -1, dispToday: 0, buyerDay: {}, buyerToday: {} });
export const ed = (state) => state.edibles || (state.edibles = initEdibles());

export const hasLicense = (state) => !!(state.license && state.license.granted);
export const stoveOf = (state) => state.objects.find((o) => o.kind === 'stove') || null;

/** Dry bud in the pack that can feed a recipe. */
export const budBatches = (state, recipe) =>
  state.product.filter((b) => b.where === 'inv' && !b.wet && b.grams >= X.recipes[recipe].grams - 1e-9);

export function startCook(state, stove, recipeKey, batch) {
  const r = X.recipes[recipeKey];
  if (!hasLicense(state)) return { ok: false, msg: 'Edibles need the business license.' };
  if (!r || !stove || stove.kind !== 'stove') return { ok: false, msg: 'No such recipe or stove.' };
  if (stove.cook) return { ok: false, msg: stove.cook.left <= 0 ? 'Collect the finished batch first.' : 'The stove is busy.' };
  if (!batch || batch.where !== 'inv' || !state.product.includes(batch)) return { ok: false, msg: 'Pick a dry batch from your pack.' };
  if (batch.wet) return { ok: false, msg: 'Wet bud will not do: dry it first.' };
  if (batch.grams < r.grams - 1e-9) return { ok: false, msg: `${r.name} need ${r.grams} g of dry bud.` };
  if (!canAfford(state, r.cost)) return { ok: false, msg: `Ingredients cost $${r.cost}.` };
  spendMoney(state, r.cost);
  batch.grams -= r.grams;
  if (batch.grams <= 1e-6) state.product.splice(state.product.indexOf(batch), 1);
  stove.cook = { recipe: recipeKey, quality: batch.quality, strainName: batch.strainName, lineId: batch.lineId || null, left: r.gh };
  return { ok: true, msg: `${r.name} are in the oven (${r.gh} gh).` };
}

/** Take a finished batch out of the stove into the edible stock (merging equal batches). */
export function collectCook(state, stove) {
  const c = stove && stove.cook;
  if (!c) return { ok: false, msg: 'Nothing is cooking.' };
  if (c.left > 0) return { ok: false, msg: 'Still cooking.' };
  const r = X.recipes[c.recipe];
  const list = ed(state).batches;
  const ex = list.find((b) => b.product === c.recipe && b.strainName === c.strainName && b.lineId === c.lineId && b.quality === c.quality);
  if (ex) ex.units += r.units;
  else list.push({ product: c.recipe, quality: c.quality, units: r.units, strainName: c.strainName, lineId: c.lineId });
  stove.cook = null;
  return { ok: true, msg: `Collected ${r.units} ${r.name.toLowerCase()}.` };
}

/** 2 Hz: cooks run on game time (also while asleep or away). Lands within half a tick of zero like drying. */
export function stepEdibles(state, gh) {
  for (const o of state.objects) {
    const c = o.kind === 'stove' && o.cook;
    if (!c || c.left <= 0) continue;
    c.left -= gh;
    if (c.left <= gh / 2) {
      c.left = 0;
      state.events.push({ type: 'toast', msg: `${X.recipes[c.recipe].name} are done.` });
    }
  }
}

export const totalUnits = (state, product) =>
  ed(state).batches.reduce((n, b) => (!product || b.product === product ? n + b.units : n), 0);

const named = (state, b) => { const l = lineOf(state, b.lineId); return !!(l && l.name); };

/** Price of one unit. channel: 'dispensary' or a buyer key. */
export function unitPrice(state, b, channel) {
  const buyer = channel !== 'dispensary';
  const mult = buyer ? X.buyer.mult : X.dispensary.mult;
  const bonusOk = named(state, b) && (!buyer || buyerLevel(state, channel) >= CONFIG.genetics.breeding.namedTrust);
  return X.recipes[b.product].price * (X.qualityBase + b.quality / X.qualityDiv) * mult * (1 + (bonusOk ? X.namedBonus : 0));
}

/** Units still sellable today on a channel. */
export function roomToday(state, channel) {
  const e = ed(state);
  if (channel === 'dispensary') return X.dispensary.perDay - (e.dispDay === state.time.day ? e.dispToday : 0);
  return X.buyer.perDay - (e.buyerDay[channel] === state.time.day ? e.buyerToday[channel] : 0);
}

/**
 * Sell up to `n` units of one product, best-paying batches first.
 * Dispensary: licensed, open 9-17, to the Bank, no heat, 40/day.
 * Buyer: present, trust 2+, dirty cash, 10/day each, +1 heat per sale (one sale = one sell action).
 */
export function sellEdibles(state, channel, product, n = 1) {
  const e = ed(state);
  const buyer = channel !== 'dispensary';
  if (!hasLicense(state)) return { ok: false, msg: 'Edibles are sold by licensed growers only.' };
  if (buyer) {
    if (!BUYER_KEYS.includes(channel)) return { ok: false, msg: 'Nobody by that name.' };
    const def = CONFIG.economy.buyers[channel];
    if (!buyerPresent(state, channel)) return { ok: false, msg: `${def.name} isn't here.` };
    if (buyerLevel(state, channel) < X.buyer.trust) return { ok: false, msg: `${def.name} only buys edibles from people they trust (level ${X.buyer.trust}+).` };
  } else if (!shopOpen(state.time, 'townhall')) return { ok: false, msg: 'The town hall is closed.' };
  const room = roomToday(state, channel);
  const mine = e.batches.filter((b) => b.product === product && b.units > 0).sort((a, b) => unitPrice(state, b, channel) - unitPrice(state, a, channel));
  const count = Math.min(n, room, mine.reduce((t, b) => t + b.units, 0));
  if (count <= 0) return { ok: false, msg: room <= 0 ? 'No more edibles will sell today.' : 'You have none of those.' };
  let left = count;
  let value = 0;
  for (const b of mine) {
    const g = Math.min(left, b.units);
    value += g * unitPrice(state, b, channel);
    b.units -= g; left -= g;
    if (b.units <= 0) e.batches.splice(e.batches.indexOf(b), 1);
    if (left <= 0) break;
  }
  const name = X.recipes[product].name.toLowerCase();
  if (buyer) {
    const def = CONFIG.economy.buyers[channel];
    if (e.buyerDay[channel] !== state.time.day) { e.buyerDay[channel] = state.time.day; e.buyerToday[channel] = 0; }
    e.buyerToday[channel] += count;
    state.player.cash += value;
    state.economy.gross += value;
    heatEvent(state, 'edibleSale'); // deliberately also in Legacy: see M12 rulings
    noteSale(state);
    ledger(state, `${def.name}: ${count} ${name}`, value, { buyer: channel });
  } else {
    if (e.dispDay !== state.time.day) { e.dispDay = state.time.day; e.dispToday = 0; }
    e.dispToday += count;
    state.player.bank = Math.round(((state.player.bank || 0) + value) * 100) / 100; // whole cents
    ledger(state, `Dispensary: ${count} ${name} (Bank)`, value);
  }
  return { ok: true, count, value, msg: `Sold ${count} ${name} for $${Math.round(value)}${buyer ? '' : ' (to the Bank)'}.` };
}
