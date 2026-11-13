// balance.js — headless balance bot (plan My Addition 11, Milestone 3).
// Runs the pure simulation in Node with a scripted policy for 45 days and
// prints one row per day. The policy is abstract: no walking, the "player" is
// wherever the shop, buyer or pot needs them. M3 has no threats, so this is
// the economy's best case; later milestones add threats and extend the policy.
//
// Usage: node tools/balance.js [seed] [days] [--no-heat]
// M4: with heat on (default on the CLI) the bot runs the real heat system. It
// hides its grow in an underground room behind a hatch, lights it with HPS
// lamps, filters the smell, buys a generator, lays off street sales while hot
// and bribes the deputy; raids, fines and arrests happen to it like to anyone.
// runBalance() defaults to heat off, the M3 "no threats" baseline.
// Policy: water at 40, feed at 40, fix pH, hang wet batches on racks, deliver
// every order that can be filled, sell overflow on the street, ask around for
// buyers, and spend cash on pots and seeds (keeping a small reserve).

import { CONFIG } from '../src/config.js';
import { newGame, addObject } from '../src/state.js';
import { stepTime } from '../src/sim/time.js';
import { stepSim } from '../src/sim/sim.js';
import { setTile, T } from '../src/world/tiles.js';
import { heatTier } from '../src/sim/heat.js';
import {
  stepPlants, plantSeed, canHarvest, harvestPlant, waterPour, feedDose, phAdjust, stageOf,
} from '../src/sim/plants.js';
import {
  stepEconomy, addProduct, loadRack, unloadRack, rackFreeSlots, buyItem, shopOpen,
  fillOrder, fillQuote, orderOf, buyerPresent, streetSale, rollInterest, nowGh,
  carriedGrams, carryCap, BUYER_KEYS, askAround,
} from '../src/sim/economy.js';
import { stepSpawn } from '../src/entities/spawn.js';

const B = CONFIG.balance;
const P = CONFIG.plants;
const TS = CONFIG.world.tile;

export function runBalance(seed = 1, days = B.days, { quiet = false, heat = false } = {}) {
  const s = newGame(seed);
  const DT = 1 / CONFIG.loop.simHz;
  const GH = DT / CONFIG.clock.secPerGh;
  const rows = [];
  let lastDay = s.time.day;
  let nextPotX = B.firstNewPotX;
  const room = { built: false, groups: 0, rackX: B.roomX0 + 40 };
  let raids = 0, arrests = 0;
  const floorY = () => s.surface[B.roomX0] + B.roomTop + B.roomRows - 1;

  const buy = (key, shop = 'hardware') => {
    const r = buyItem(s, key, shop);
    return r.ok;
  };
  // The bot may shop out of hours: it only cares about the price.
  const buyAnytime = (key) => {
    const save = s.time.hour;
    s.time.hour = CONFIG.economy.hardware.open;
    const ok = buy(key);
    s.time.hour = save;
    return ok;
  };

  function tend() {
    const inv = s.player.inv;
    for (const pl of s.plants) {
      if (pl.dead) continue;
      if (pl.moisture < B.waterAt) waterPour(s, pl, P.tapPourPh);
      if (pl.nutrients < B.feedAt && stageOf(pl) !== 'ripe') {
        if (!(inv.nutrients > 0)) buyAnytime('nutrients');
        if (inv.nutrients > 0) { inv.nutrients--; feedDose(s, pl); }
      }
      if (pl.ph > P.phIdeal.hi - B.phMargin || pl.ph < P.phIdeal.lo + B.phMargin) {
        if (!(inv.phkit > 0)) buyAnytime('phkit');
        if (inv.phkit > 0) { inv.phkit--; phAdjust(s, pl, pl.ph > 6.4 ? -1 : 1); }
      }
    }
  }

  /** Cash the bot keeps back: base reserve, upkeep, and a rack if it has none. */
  const floor = () => B.reserve + B.upkeepPerPlant * s.plants.length +
    (racks().length === 0 ? CONFIG.economy.prices.rack : 0);

  function racks() { return s.objects.filter((o) => o.kind === 'rack'); }

  function hang() {
    for (let n = s.product.filter((x) => x.where === 'inv' && x.wet).length; n > 0; n--) {
      let rack = racks().find((r) => rackFreeSlots(s, r) > 0);
      if (!rack) {
        if (!buyAnytime('rack')) return;
        s.player.inv.rack--;
        const x = room.built ? room.rackX++ : nextPotX++;
        rack = addObject(s, { kind: 'rack', x, y: room.built ? floorY() : s.surface[x] - 1 });
      }
      loadRack(s, rack);
    }
    for (const r of racks()) unloadRack(s, r);
  }

  function harvest() {
    for (const pl of s.plants.slice()) { // rip out plants that died in jail
      if (!pl.dead) continue;
      const pot = s.objects.find((o) => o.id === pl.potId);
      if (pot) pot.plantId = null;
      s.plants.splice(s.plants.indexOf(pl), 1);
    }
    for (const pl of s.plants.slice()) {
      if (!canHarvest(pl) || stageOf(pl) !== 'ripe') continue;
      if (carriedGrams(s) >= carryCap(s) && !(s.player.inv.duffel > 0) && !buyAnytime('duffel')) break;
      if (carriedGrams(s) >= carryCap(s)) break;
      const batch = harvestPlant(s, pl);
      const pot = s.objects.find((o) => o.id === pl.potId);
      if (pot) pot.plantId = null;
      if (batch) addProduct(s, batch);
    }
  }

  function plantAndExpand() {
    const pots = s.objects.filter((o) => o.kind === 'pot');
    const under = (p) => p.y > s.surface[p.x];
    // With heat on, outdoor pots are only used until the hidden room exists.
    const empty = pots.filter((p) => !p.plantId && !(heat && room.built && !under(p)));
    const seedCost = CONFIG.economy.prices.seeds;
    // Replant empties first, then buy new pots while cash allows.
    for (const pot of empty) {
      if (s.player.cash - seedCost < floor()) return;
      if (s.plants.length >= CONFIG.limits.plants) return;
      if (!(s.player.inv.seeds > 0) && !buyAnytime('seeds')) return;
      s.player.inv.seeds--;
      plantSeed(s, pot, 'ditch');
    }
    while (!(heat && room.built) && pots.length < (heat ? B.outdoorCap : CONFIG.limits.plants) &&
      s.player.cash - seedCost - CONFIG.economy.prices.pot >= floor()) {
      if (!buyAnytime('pot') || !buyAnytime('seeds')) break;
      s.player.inv.pot--;
      s.player.inv.seeds--;
      const x = nextPotX++;
      const pot = addObject(s, {
        kind: 'pot', x, y: s.surface[x] - 1, soil: 'cheap', soilPh: P.freshSoilPh, plantId: null,
      });
      pots.push(pot);
      plantSeed(s, pot, 'ditch');
    }
  }

  /** Dry grams that open orders will need (keep these for buyers). */
  const reserve = () => s.economy.orders.reduce((n, o) => n + o.grams, 0) * B.streetReserveMult;

  function sell() {
    const inTown = s.time.hour >= B.townFrom && s.time.hour < B.townTo;
    for (const key of BUYER_KEYS) {
      const o = orderOf(s, key);
      if (!o || !buyerPresent(s, key)) continue;
      const q = fillQuote(s, o);
      const urgent = o.deadline - nowGh(s) < B.partialWithinGh;
      if (q.grams >= o.grams || (urgent && q.grams >= o.grams * CONFIG.economy.trust.partialMin)) {
        fillOrder(s, o.id);
      }
    }
    // Overflow: street sales while in town (one approach per sim tick, capped per day).
    if (inTown && s.streetToday < B.streetPerDay) {
      const dry = s.product.filter((b) => b.where === 'inv' && !b.wet).reduce((n, b) => n + b.grams, 0);
      const wetStuck = s.player.cash < CONFIG.economy.prices.rack &&
        s.product.some((b) => b.where === 'inv' && b.wet);
      if ((dry > reserve() + B.streetKeep || wetStuck) && (!heat || s.heat < B.streetMaxHeat)) {
        s.streetToday++;
        streetSale(s, { interested: rollInterest(s), asked: false });
      }
    }
    // Ask around whenever someone is still hidden and the bar is open.
    if (shopOpen(s.time, 'bar') && s.economy.askAt === null && s.player.cash > floor() + CONFIG.economy.askAround.cost &&
      BUYER_KEYS.some((k) => !s.economy.buyers[k].known)) {
      askAround(s);
    }
  }

  /** Dig the hidden room: a shaft with a hatch, a 3-row chamber below it. */
  function buildRoom() {
    if (!buyAnytime('hatch')) return;
    const y0 = s.surface[B.shaftX];
    for (let y = y0; y < y0 + B.roomTop + B.roomRows; y++) setTile(s, B.shaftX, y, T.AIR);
    for (let x = B.roomX0 - 1; x < B.roomX0 + B.roomWidth; x++) {
      for (let y = y0 + B.roomTop; y < y0 + B.roomTop + B.roomRows; y++) setTile(s, x, y, T.AIR);
    }
    s.player.inv.hatch--;
    addObject(s, { kind: 'hatch', x: B.shaftX, y: y0 + 1 });
    room.built = true;
  }

  /** One group: an HPS lamp over 4 pots, each planted; a filter/generator now and then. */
  function addGroup() {
    const need = ['lamp_hps', 'pot', 'pot', 'pot', 'pot', 'seeds', 'seeds', 'seeds', 'seeds'];
    for (const k of need) if (!buyAnytime(k)) return false;
    const x0 = B.roomX0 + room.groups * 4;
    s.player.inv.lamp_hps--;
    addObject(s, { kind: 'lamp', lamp: 'lamp_hps', x: x0 + 1, y: floorY() - 1, hours: CONFIG.lamps.hoursNormal });
    for (let i = 0; i < 4; i++) {
      s.player.inv.pot--; s.player.inv.seeds--;
      const pot = addObject(s, {
        kind: 'pot', x: x0 + i, y: floorY(), soil: 'cheap', soilPh: P.freshSoilPh, plantId: null,
      });
      plantSeed(s, pot, 'ditch');
    }
    room.groups++;
    if (room.groups % B.filterEveryGroups === 1 && buyAnytime('filter')) {
      s.player.inv.filter--;
      addObject(s, { kind: 'filter', x: x0 + 2, y: floorY() });
    }
    if (room.groups === B.generatorAtGroups && buyAnytime('generator')) {
      s.player.inv.generator--;
      addObject(s, { kind: 'generator', x: B.roomX0 + 30, y: floorY() });
    }
    return true;
  }

  function expandRoom() {
    if (!room.built && s.player.cash >= B.roomCost + floor()) buildRoom();
    const cost = CONFIG.economy.prices.lamp_hps + 4 * (CONFIG.economy.prices.pot + CONFIG.economy.prices.seeds);
    while (room.built && room.groups < B.maxGroups && s.player.cash - cost >= floor() + CONFIG.economy.prices.filter) {
      if (!addGroup()) break;
    }
  }

  /** Bribe the deputy when heat is up (the bar's hours do not matter to the bot). */
  function bribe() {
    if (s.heat < B.bribeAt || s.time.day < CONFIG.heat.bribe.minDay) return;
    const save = s.time.hour;
    s.time.hour = CONFIG.economy.bar.open;
    buyItem(s, 'bribe', 'bar');
    s.time.hour = save;
  }

  s.streetToday = 0;
  let ticks = 0;
  const target = Math.floor(s.time.day) + days;
  while (s.time.day < target) {
    if (heat) {
      stepSim(s, DT);
      if (s.gameOver) break;
    } else {
      stepTime(s, DT);
      stepPlants(s, GH);
      stepEconomy(s, GH);
      stepSpawn(s);
    }
    s.npcs.length = 0; // the bot never walks, pedestrians are abstract
    for (const e of s.events) {
      if (e.type === 'raidStart') raids++;
      if (e.type === 'skipped') arrests++;
    }
    s.events.length = 0;
    if (++ticks % B.policyEvery === 0) { tend(); harvest(); hang(); sell(); }
    if (Math.abs(s.time.hour - B.shopHour) < GH / 2) {
      plantAndExpand();
      if (heat) { expandRoom(); bribe(); }
    }
    if (s.time.day !== lastDay) {
      lastDay = s.time.day;
      s.streetToday = 0;
      const known = BUYER_KEYS.filter((k) => s.economy.buyers[k].known).length;
      rows.push({
        day: s.time.day - 1, cash: Math.round(s.player.cash), gross: Math.round(s.economy.gross),
        heat: Math.round(s.heat), raids, arrests, plants: s.plants.length, level: s.player.level, buyers: known,
        carried: Math.round(carriedGrams(s)),
      });
    }
  }
  if (!quiet) {
    console.log('day  cash    gross   heat raids arrests plants lvl buyers carried');
    for (const r of rows) {
      console.log([r.day, r.cash, r.gross, r.heat, r.raids, r.arrests, r.plants, r.level, r.buyers, r.carried]
        .map((v, i) => String(v).padStart([3, 7, 8, 5, 6, 8, 6, 4, 6, 8][i])).join(' '));
    }
  }
  return rows;
}

// Run as a script (not when imported).
if (process.argv[1] && process.argv[1].endsWith('balance.js')) {
  const nums = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const seed = Number(nums[0] || CONFIG.dev.seed);
  const days = Number(nums[1] || CONFIG.balance.days);
  const t0 = Date.now();
  const rows = runBalance(seed, days, { heat: !process.argv.includes('--no-heat') });
  const last = rows[rows.length - 1];
  console.log(`\nday ${last.day}: gross $${last.gross}, cash $${last.cash}, heat ${last.heat} (${Date.now() - t0} ms)`);
}
