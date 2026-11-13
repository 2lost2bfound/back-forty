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

const E = CONFIG.economy;
const P = CONFIG.plants;

/** Is a shop open at this clock hour? Hours come from config. */
export function shopOpen(time, shopKey) {
  const s = E[shopKey];
  return time.hour >= s.open && time.hour < s.close;
}

/** The hardware stock for M2 (menu order). */
export function hardwareStock() {
  const keys = ['seeds', 'pot', 'soil_potting', 'soil_living', 'nutrients',
    'phkit', 'moisture_meter', 'ph_meter', 'loupe', 'rack'];
  return keys.map((key) => ({
    key,
    name: CONFIG.itemNames[key],
    price: E.prices[key],
  }));
}

function grantItem(state, key) {
  const inv = state.player.inv;
  if (key === 'seeds') {
    // Purchased seeds are feminized and vary ±3 per trait (plan §A4); the
    // genome is rolled at purchase with the save's PRNG and queued in the
    // seed bag. The starter seeds are exact base-strain genomes.
    state.player.seedBag.push(withStateRng(state, (rng) => rollSeedGenome('ditch', rng)));
    inv.seeds = (inv.seeds || 0) + 1;
  } else if (key === 'nutrients') {
    inv.nutrients = (inv.nutrients || 0) + E.doses.nutrients;
  } else if (key === 'phkit') {
    inv.phkit = (inv.phkit || 0) + E.doses.phkit;
  } else {
    inv[key] = (inv[key] || 0) + 1;
  }
}

/** Buy from the hardware shop. Returns {ok, msg}. */
export function buyItem(state, key) {
  const price = E.prices[key];
  if (price === undefined) return { ok: false, msg: 'They don\'t stock that.' };
  const p = state.player;
  if (p.cash < price) return { ok: false, msg: 'Not enough cash.' };
  p.cash -= price;
  grantItem(state, key);
  state.events.push({ type: 'action', name: 'cash' });
  return { ok: true, msg: `Bought ${CONFIG.itemNames[key]}` };
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
