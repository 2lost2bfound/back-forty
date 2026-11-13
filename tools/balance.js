// balance.js — headless balance bot (plan My Addition 11, Milestone 3).
// Runs the pure simulation in Node with a scripted policy for 45 days and
// prints one row per day. The policy is abstract: no walking, the "player" is
// wherever the shop, buyer or pot needs them. M3 has no threats, so this is
// the economy's best case; later milestones add threats and extend the policy.
//
// M10: the standard policy is the full one (hidden room, clones, buried stash,
// bribes, Dale's tribute, the farm-stand front, laundering, the quiet phase, the
// license sample and application); --careless is the careless policy (street
// sales at any heat, grows in view, never hides, never launders). `--sweep [n]`
// runs both over n seeds and checks the M10 gate (plan §D4).
//
// Usage: node tools/balance.js [seed] [days] [--no-heat] [--careless] | --sweep [n]
// M4: with heat on (default on the CLI) the bot runs the real heat system. It
// hides its grow in an underground room behind a hatch, lights it with HPS
// lamps, filters the smell, buys a generator, lays off street sales while hot
// and bribes the deputy; raids, fines and arrests happen to it like to anyone.
// runBalance() defaults to heat off, the M3 "no threats" baseline.
// Policy: water at 40, feed at 40, fix pH, hang wet batches on racks, deliver
// every order that can be filled, sell overflow on the street, ask around for
// buyers, and spend cash on pots and seeds (keeping a small reserve).
// M5: the bot also fits a lock, buys a dog and two floodlights; thieves arrive
// by the real break-in roll and the bot never fights back (it is not present).

import { CONFIG } from '../src/config.js';
import { newGame, addObject } from '../src/state.js';
import { stepTime } from '../src/sim/time.js';
import { stepSim } from '../src/sim/sim.js';
import { setTile, T } from '../src/world/tiles.js';
import { heatTier, bribePrice } from '../src/sim/heat.js';
import {
  stepPlants, plantSeed, plantCutting, takeCutting, canCut, canHarvest, harvestPlant, waterPour, feedDose, phAdjust, stageOf, neemPlant,
} from '../src/sim/plants.js';
import {
  stepEconomy, addProduct, loadRack, unloadRack, rackFreeSlots, buyItem, shopOpen,
  fillOrder, fillQuote, orderOf, buyerPresent, streetSale, rollInterest, nowGh,
  carriedGrams, carryCap, BUYER_KEYS, askAround,
} from '../src/sim/economy.js';
import { stepSpawn } from '../src/entities/spawn.js';
import { installLock, waterPoisoned, purgeWater, payTribute, rv } from '../src/sim/threats.js';
import { useContainer } from '../src/entities/player.js';
import { strainUnlocked } from '../src/sim/mastery.js';
import { lic, launder, launderRoom, licenseReqs, submitSample, applyLicense, upgradeFront } from '../src/sim/license.js';

const B = CONFIG.balance;
const P = CONFIG.plants;
const TS = CONFIG.world.tile;

/**
 * policy 'standard': hides the grow, lays low when hot, launders through the
 * front and walks the license process (quiet phase, sample, application).
 * policy 'careless': street sales at any heat, grows outdoors in view of the
 * road, never hides, never bribes, never fits security, never launders.
 */
export function runBalance(seed = 1, days = B.days, {
  quiet = false, heat = false, policy = 'standard', difficulty = 'standard', stopAtLicense = true,
} = {}) {
  const careless = policy === 'careless';
  const s = newGame(seed, { difficulty });
  const DT = 1 / CONFIG.loop.simHz;
  const GH = DT / CONFIG.clock.secPerGh;
  const rows = [];
  let lastDay = s.time.day;
  let nextPotX = B.firstNewPotX;
  const room = { built: false, groups: 0, rackX: B.roomX0 + 40 };
  let raids = 0, arrests = 0, hostile = 0, thefts = 0, firstRaidDay = null;
  let quietMode = false;
  const sales = {}, missed = {}, missLog = [], spent = {};
  const floorY = () => s.surface[B.roomX0] + B.roomTop + B.roomRows - 1;

  // The bot buys with dirty cash only: the Bank is saved for the license.
  const buy = (key, shop = 'hardware') => {
    if (s.player.cash < (CONFIG.economy.prices[key] || 0)) return false;
    const ok = buyItem(s, key, shop).ok;
    if (ok) spent[key] = (spent[key] || 0) + CONFIG.economy.prices[key];
    return ok;
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
    if (waterPoisoned(s, 'tap')) purgeWater(s); // M6: the pH meter flags Dale's poison; the bot dumps it
    for (const pl of s.plants) {
      if (pl.dead) continue;
      if (pl.infested) { // M6: neem cures the pest jar
        if (!(inv.neem > 0)) buyAnytime('neem');
        if (inv.neem > 0) { inv.neem--; neemPlant(s, pl); }
      }
      if (pl.moisture < B.waterAt) waterPour(s, pl, P.tapPourPh, 'tap');
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

  /** Cut clones from healthy vegetative plants (best strain first) so replanting costs nothing. */
  function cloneStep() {
    const cuts = s.player.cuttings || [];
    if (cuts.length >= B.cutStock) return;
    const rank = { widow: 2, blue: 1, ditch: 0 };
    const mothers = s.plants.filter((pl) => canCut(pl) && pl.health >= B.motherHealth && (pl.cutsMade || 0) < B.cutsPerMother)
      .sort((a, c) => rank[c.strainKey] - rank[a.strainKey]);
    for (const m of mothers) {
      if (s.player.cuttings.length >= B.cutStock) break;
      m.cutsMade = (m.cutsMade || 0) + 1;
      takeCutting(s, m);
    }
  }

  /** Cash the bot keeps back: base reserve, upkeep, and a rack if it has none. */
  const floor = () => B.reserve + B.upkeepPerPlant * s.plants.length +
    (racks().length === 0 ? CONFIG.economy.prices.rack : 0) +
    (heat && !careless && s.economy.gross >= B.bribeAfterGross ? Math.max(B.bribeReserve, bribePrice(s) + 100) : 0);

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

  /** Best unlocked strain whose seeds fit the cash (Widow Kush > Blue Haze > Ditch Weed). */
  function seedKey(spare = s.player.cash) {
    for (const k of ['widow', 'blue', 'ditch']) {
      if (strainUnlocked(s, k) && CONFIG.economy.prices[CONFIG.strains[k].item] <= spare) return k;
    }
    return 'ditch';
  }

  /** Buy and take one seed of strain k out of the bag. */
  function takeSeed(k) {
    const item = CONFIG.strains[k].item;
    if (!(s.player.inv[item] > 0) && !buyAnytime(item)) return false;
    s.player.inv[item]--;
    return true;
  }

  function plantAndExpand() {
    const pots = s.objects.filter((o) => o.kind === 'pot');
    const under = (p) => p.y > s.surface[p.x];
    // With heat on, outdoor pots are only used until the hidden room exists.
    const empty = pots.filter((p) => !p.plantId && !(heat && room.built && !under(p)));
    if (quietMode) return; // cooling off for the license: no new plants
    // Replant empties first, then buy new pots while cash allows.
    for (const pot of empty) {
      if ((s.player.cuttings || []).length > 0) { plantCutting(s, pot); continue; } // free clones first
      const held = ['widow', 'blue', 'ditch'].find((k) => s.player.inv[CONFIG.strains[k].item] > 0); // seeds already in the bag cost nothing
      if (held && s.plants.length < CONFIG.limits.plants) { s.player.inv[CONFIG.strains[held].item]--; plantSeed(s, pot, held); continue; }
      const k = seedKey(s.player.cash - floor());
      if (s.player.cash - CONFIG.economy.prices[CONFIG.strains[k].item] < floor()) return;
      if (s.plants.length >= CONFIG.limits.plants) return;
      if (!takeSeed(k)) return;
      plantSeed(s, pot, k);
    }
    const cap = careless ? B.carelessCap : heat ? B.outdoorCap : CONFIG.limits.plants;
    while (!(heat && room.built && !careless) && pots.length < cap) {
      const k = seedKey(s.player.cash - floor());
      if (s.player.cash - CONFIG.economy.prices[CONFIG.strains[k].item] - CONFIG.economy.prices.pot < floor()) break;
      if (!buyAnytime('pot') || !takeSeed(k)) break;
      s.player.inv.pot--;
      const x = nextPotX++;
      const pot = addObject(s, {
        kind: 'pot', x, y: s.surface[x] - 1, soil: 'cheap', soilPh: P.freshSoilPh, plantId: null,
      });
      pots.push(pot);
      plantSeed(s, pot, k);
    }
  }

  /** Dry grams that open orders will need (keep these for buyers). */
  const reserve = () => s.economy.orders.reduce((n, o) => n + o.grams, 0) * B.streetReserveMult;

  function sell() {
    const inTown = s.time.hour >= B.townFrom && s.time.hour < B.townTo;
    for (const key of BUYER_KEYS) {
      const o = orderOf(s, key);
      if (!o || !buyerPresent(s, key)) continue;
      if (quietMode && CONFIG.economy.buyers[key].heat && s.heat >= B.quietSellHeat) continue; // laying low: heat-free sales only
      if (heat && !careless && s.heat >= B.sellHeatCap && CONFIG.economy.buyers[key].heat) continue; // too hot to sell
      const q = fillQuote(s, o);
      const urgent = o.deadline - nowGh(s) < B.partialWithinGh;
      if (q.grams >= o.grams || (urgent && q.grams >= o.grams * CONFIG.economy.trust.partialMin)) {
        fillOrder(s, o.id);
      }
    }
    // Overflow: street sales while in town (one approach per sim tick, capped per day).
    if (quietMode) return;
    if (inTown && s.streetToday < (careless ? B.carelessStreetPerDay : B.streetPerDay)) {
      const dry = s.product.filter((b) => b.where === 'inv' && !b.wet).reduce((n, b) => n + b.grams, 0);
      const wetStuck = s.player.cash < CONFIG.economy.prices.rack &&
        s.product.some((b) => b.where === 'inv' && b.wet);
      if ((dry > reserve() + B.streetKeep || wetStuck) && (!heat || careless || s.heat < (s.time.day < B.streetEarlyDays ? B.streetEarlyHeat : B.streetMaxHeat))) {
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
    const k = seedKey((s.player.cash - floor() - CONFIG.economy.prices.lamp_hps - 4 * CONFIG.economy.prices.pot) / 4);
    const item = CONFIG.strains[k].item;
    const fromCuts = Math.min(4, (s.player.cuttings || []).length);
    const need = ['lamp_hps', 'pot', 'pot', 'pot', 'pot', ...Array(4 - fromCuts).fill(item)];
    for (const n of need) if (!buyAnytime(n)) return false;
    const x0 = B.roomX0 + room.groups * 4;
    s.player.inv.lamp_hps--;
    addObject(s, { kind: 'lamp', lamp: 'lamp_hps', x: x0 + 1, y: floorY() - 1, hours: CONFIG.lamps.hoursNormal });
    for (let i = 0; i < 4; i++) {
      s.player.inv.pot--;
      const pot = addObject(s, {
        kind: 'pot', x: x0 + i, y: floorY(), soil: 'cheap', soilPh: P.freshSoilPh, plantId: null,
      });
      if (i < fromCuts) plantCutting(s, pot);
      else { s.player.inv[item]--; plantSeed(s, pot, k); }
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
    if (quietMode) return;
    if (!room.built && s.player.cash >= B.roomCost + floor()) buildRoom();
    const PR = CONFIG.economy.prices;
    while (room.built && room.groups < B.maxGroups) {
      const k = seedKey((s.player.cash - floor() - PR.lamp_hps - 4 * PR.pot) / 4);
      const cost = PR.lamp_hps + 4 * (PR.pot + PR[CONFIG.strains[k].item]);
      if (s.player.cash - cost < floor() + PR.filter || !addGroup()) break;
    }
  }

  /** Three drinks and a chat at the bar reveal Marla (the bot ignores bar hours). */
  function meetMarla() {
    if (s.economy.buyers.marla.known || s.player.cash < 3 * CONFIG.economy.prices.drink + 20) return;
    const save = s.time.hour;
    s.time.hour = CONFIG.economy.bar.open;
    for (let i = 0; i < 3 && !s.economy.buyers.marla.known; i++) buyItem(s, 'drink', 'bar');
    s.time.hour = save;
  }

  /** Keep Dale on a leash: the weekly tribute once his aggression is up (his tips are +15 heat each). */
  function paceDale() {
    if (quietMode && rv(s).aggression >= CONFIG.threats.rival.truce.minAggression && s.player.cash >= CONFIG.economy.prices.truce) {
      const save = s.time.hour;
      s.time.hour = CONFIG.economy.bar.open;
      buyItem(s, 'truce', 'bar'); // frozen for 10 days: no tips during the review
      s.time.hour = save;
    }
    if (s.economy.gross < B.tributeAfterGross || rv(s).aggression < B.tributeAt) return;
    if (s.player.cash >= CONFIG.threats.rival.tribute.cost + floor()) payTribute(s);
  }

  /** Bribe the deputy when heat is up (the bar's hours do not matter to the bot). */
  function bribe() {
    if (s.heat < (quietMode ? CONFIG.license.heatMax + B.quietBribeMargin : (s.player.bank || 0) >= B.preQuietBank ? CONFIG.license.heatMax - 3 : B.bribeAt) || s.time.day < CONFIG.heat.bribe.minDay) return;
    const save = s.time.hour;
    s.time.hour = CONFIG.economy.bar.open;
    buyItem(s, 'bribe', 'bar');
    s.time.hour = save;
  }

  /** M5: a lock, a dog and two floodlights once there is something worth stealing. */
  function secure() {
    const prices = CONFIG.economy.prices;
    if (s.economy.gross < B.securityAfterGross) return; // nothing worth guarding yet
    const spare = () => s.player.cash - floor();
    if (!s.threats.lock && spare() > prices.padlock && buyAnytime('padlock')) installLock(s);
    if (!s.threats.dog && spare() > prices.dog + B.dogReserve) {
      const save = s.time.hour;
      s.time.hour = CONFIG.economy.walt.open;
      buyItem(s, 'dog', 'walt');
      s.time.hour = save;
    }
    const lights = s.objects.filter((o) => o.kind === 'floodlight').length;
    if (lights < 2 && spare() > prices.floodlight && buyAnytime('floodlight')) {
      s.player.inv.floodlight--;
      addObject(s, { kind: 'floodlight', x: B.firstNewPotX - 4 * (lights + 1), y: s.surface[B.firstNewPotX - 4 * (lights + 1)] - 1 });
    }
  }

  /** Town hall errands: the bot ignores opening hours (it only needs the right door). */
  function atTownHall(fn) {
    const save = s.time.hour;
    s.time.hour = CONFIG.economy.townhall.open;
    const r = fn();
    s.time.hour = save;
    return r;
  }

  /**
   * The license plan: buy the front once there is money to spare, launder every
   * day, upgrade the stand, go quiet when the bank will reach $50k, hand in a
   * sample, and apply the moment heat allows.
   */
  function licenseSteps() {
    const l = lic(s);
    const PR = CONFIG.economy.prices;
    if (!l.frontOwned && s.player.cash >= PR.permit + B.frontReserve && s.economy.gross >= B.frontAfterGross &&
      (room.groups >= B.frontAfterGroups || s.time.day >= B.frontByDay)) { // production first, but never later than frontByDay
      atTownHall(() => buyItem(s, 'permit', 'townhall'));
    }
    if (l.frontOwned) {
      if (!l.upgraded && s.player.cash + (s.player.bank || 0) >= CONFIG.license.front.upgradeCost + B.frontReserve &&
        l.totalLaundered >= B.upgradeAfterLaundered) upgradeFront(s); // cash first, then the bank
      const expanding = room.built && room.groups < B.maxGroups && !quietMode; // production first: keep the next group's cost
      const keep = quietMode ? (s.heat > CONFIG.license.heatMax - 2 ? bribePrice(s) + 50 : 0) : // quiet: only a bribe for a heat spike stays out of the bank
         floor() + B.launderKeep + (expanding ? B.expandKeep : 0);
      if (s.player.cash > keep && launderRoom(s) > 0) launder(s, s.player.cash - keep);
    }
    if (!l.granted && !quietMode && l.frontOwned && s.player.level >= CONFIG.license.level &&
      (s.player.bank || 0) + s.player.cash * (1 - CONFIG.license.front.fee) >= CONFIG.license.bankRequired) quietMode = true;
    if (s.player.level >= CONFIG.license.level) submitSample(s);
    if (!l.applied && !l.granted && licenseReqs(s).every((r) => r.ok)) atTownHall(() => applyLicense(s));
  }

  /**
   * Nightly: bury product and cash in a stash in solid dirt under the room
   * (a raid finds a buried stash 10% of the time), and dig it up after the raid hour.
   */
  function stashRoutine() {
    let box = s.objects.find((o) => o.kind === 'stash');
    if (!box) {
      if (s.economy.gross < B.stashAfterGross || !buyAnytime('stash')) return;
      s.player.inv.stash--;
      box = addObject(s, { kind: 'stash', x: B.roomX0 + 2, y: floorY() + 3, cash: 0 });
    }
    const carried = s.product.some((b) => b.where === 'inv');
    const stored = s.product.some((b) => b.where === box.id) || box.cash > 0;
    if (s.time.hour >= B.stashAt && s.time.hour < B.stashAt + 1 && (carried || s.player.cash > 0)) useContainer(s, box);
    else if (s.time.hour >= B.fetchAt && s.time.hour < B.fetchAt + 1 && stored) { // dig it all up (even with a bag already in hand)
      for (const b of s.product) if (b.where === box.id) b.where = 'inv';
      s.player.cash += box.cash; box.cash = 0;
    }
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
      if (e.type === 'sale') { const t = (sales[e.buyer] ||= { n: 0, value: 0, g: 0 }); t.n++; t.value += e.value; t.g += e.grams; }
      if (e.type === 'missed') {
        missed[e.name] = (missed[e.name] || 0) + 1;
        missLog.push({ day: s.time.day, hour: Math.round(s.time.hour), name: e.name, inv: s.product.filter((b) => b.where === 'inv' && !b.wet).map((b) => `${b.strainName.slice(0, 4)} ${Math.round(b.grams)}g q${Math.round(b.quality)}`).join(', ') });
      }
      if (e.type === 'raidStart') { raids++; if (firstRaidDay === null) firstRaidDay = s.time.day; }
      if (e.type === 'skipped') arrests++;
      if (e.type === 'hostile') hostile++;
      if (e.type === 'theft') thefts++;
    }
    s.events.length = 0;
    if (s.won && stopAtLicense) break;
    if (++ticks % B.policyEvery === 0) {
      tend(); cloneStep(); harvest(); hang(); sell();
      if (heat && !careless) stashRoutine();
      if (heat && (quietMode || (s.player.bank || 0) >= B.preQuietBank)) bribe(); // a tip during the review: cool it right away
    }
    if (Math.abs(s.time.hour - B.shopHour) < GH / 2) {
      meetMarla();
      plantAndExpand();
      if (heat && !careless) { expandRoom(); bribe(); secure(); paceDale(); }
    }
    if (heat && !careless && Math.abs(s.time.hour - B.launderHour) < GH / 2) licenseSteps();
    if (s.time.day !== lastDay) {
      lastDay = s.time.day;
      s.streetToday = 0;
      const known = BUYER_KEYS.filter((k) => s.economy.buyers[k].known).length;
      rows.push({
        day: s.time.day - 1, cash: Math.round(s.player.cash), gross: Math.round(s.economy.gross),
        heat: Math.round(s.heat), raids, arrests, hostile, thefts, plants: s.plants.length, level: s.player.level, buyers: known,
        carried: Math.round(carriedGrams(s)), bank: Math.round(s.player.bank || 0), q: quietMode ? 1 : 0,
      });
    }
  }
  rows.spent = spent; rows.sales = sales; rows.missed = missed; rows.missLog = missLog;
  rows.licenseDay = s.won ? s.won.day : null;
  rows.firstRaidDay = firstRaidDay;
  rows.gameOver = s.gameOver ? s.gameOver.reason : null;
  rows.state = s;
  if (!quiet) {
    console.log('day  cash    gross   heat raids arrests hostile thefts plants lvl buyers carried   bank q');
    for (const r of rows) {
      console.log([r.day, r.cash, r.gross, r.heat, r.raids, r.arrests, r.hostile, r.thefts, r.plants, r.level, r.buyers, r.carried, r.bank, r.q]
        .map((v, i) => String(v).padStart([3, 7, 8, 5, 6, 8, 8, 7, 6, 4, 6, 8, 7, 2][i])).join(' '));
    }
  }
  return rows;
}

/**
 * The M10 balance gate: both policies over `seeds` seeds on `difficulty`.
 * Standard must reach the license on a day in [licenseFrom, licenseTo] for
 * `needLicense` of the seeds; careless must be raided before `carelessRaidBy`.
 */
export function sweep({ seeds = B.sweepSeeds, difficulty = 'standard', maxDays = B.sweepDays } = {}) {
  const out = { standard: [], careless: [] };
  for (const seed of seeds) {
    const a = runBalance(seed, maxDays, { quiet: true, heat: true, policy: 'standard', difficulty });
    out.standard.push({ seed, licenseDay: a.licenseDay, gameOver: a.gameOver, gross: a[a.length - 1].gross, bank: a[a.length - 1].bank });
    const c = runBalance(seed, B.carelessDays, { quiet: true, heat: true, policy: 'careless', difficulty });
    out.careless.push({ seed, firstRaidDay: c.firstRaidDay, gameOver: c.gameOver });
  }
  const inWin = (d) => d !== null && d >= B.licenseFrom && d <= B.licenseTo;
  out.licenseOk = out.standard.filter((r) => inWin(r.licenseDay)).length;
  out.carelessOk = out.careless.filter((r) => r.firstRaidDay !== null && r.firstRaidDay < B.carelessRaidBy).length;
  return out;
}

// Run as a script (not when imported).
if (process.argv[1] && process.argv[1].endsWith('balance.js')) {
  const nums = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const seed = Number(nums[0] || CONFIG.dev.seed);
  const days = Number(nums[1] || CONFIG.balance.days);
  const t0 = Date.now();
  if (process.argv.includes('--sweep')) {
    const n = Number(nums[0] || B.sweepSeeds.length);
    const r = sweep({ seeds: Array.from({ length: n }, (_, i) => i + 1) });
    console.log('seed  license-day  gross   bank  end        | careless first-raid');
    r.standard.forEach((a, i) => console.log(`${String(a.seed).padStart(4)}  ${String(a.licenseDay).padStart(11)} ${String(a.gross).padStart(7)} ${String(a.bank).padStart(6)}  ${String(a.gameOver || 'ok').padEnd(10)} | ${r.careless[i].firstRaidDay}${r.careless[i].gameOver ? ' (' + r.careless[i].gameOver + ')' : ''}`));
    console.log(`standard license day ${B.licenseFrom}-${B.licenseTo}: ${r.licenseOk}/${n} (need ${B.needLicense}); careless raided before day ${B.carelessRaidBy}: ${r.carelessOk}/${n}`);
    process.exit(0);
  }
  const policy = process.argv.includes('--careless') ? 'careless' : 'standard';
  const rows = runBalance(seed, days, { heat: !process.argv.includes('--no-heat'), policy });
  const last = rows[rows.length - 1];
  console.log(`\nlicense day: ${rows.licenseDay}  first raid: ${rows.firstRaidDay}  game over: ${rows.gameOver}`);
  console.log(`day ${last.day}: gross $${last.gross}, cash $${last.cash}, heat ${last.heat} (${Date.now() - t0} ms)`);
}
