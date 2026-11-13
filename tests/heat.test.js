// heat.test.js — M4: heat sources and decay, tells, raids, hidden rooms,
// seizure and fines, lamps and underground growing, arrests, weather.
import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { createRng } from '../src/rng.js';
import { newGame, serializeState, deserializeState, addObject } from '../src/state.js';
import { stepTime, isRaining, weatherNow } from '../src/sim/time.js';
import { stepSim } from '../src/sim/sim.js';
import {
  stepPlants, createPlant, stageOf, lightFactor, lampCoverage, stressorsOf,
} from '../src/sim/plants.js';
import {
  addHeat, heatEvent, runnerDeliveryHeat, dailyHeat, stepHeat, hs, heatTier, raidChance,
  hatchFindChance, searchLot, applyRaid, resolveRaid, arrestPlayer, scannerView, worldTells,
  bribeDeputy, bribePrice, hireLawyer, lawyerActive, payDebt, noteSale,
} from '../src/sim/heat.js';
import {
  buyItem, fillOrder, orderOf, nowGh, askAround, streetSale, stepEconomy, addProduct,
} from '../src/sim/economy.js';
import { setTile, T } from '../src/world/tiles.js';
import { roomOf, visibleFromRoad, isBuried } from '../src/world/rooms.js';
import { findPath } from '../src/world/nav.js';
import { placeObject, useContainer } from '../src/entities/player.js';
import { runBalance } from '../tools/balance.js';

const H = CONFIG.heat;
const DT = 0.5;
const GH = DT / CONFIG.clock.secPerGh;

function game(seed = 5) {
  const s = newGame(seed);
  s.player.cash = 10000;
  s.player.inv.scanner = 1;
  return s;
}
/** Jump the clock (and the heat step's last-hour memory). */
const at = (s, day, hour) => { s.time.day = day; s.time.hour = hour; hs(s).lastHour = hour; };
const logOf = (s) => hs(s).log;
const stock = (s, grams, quality = 80, where = 'inv') => {
  const b = { id: s.nextId++, strainName: 'Ditch Weed', quality, grams, wet: false, where };
  s.product.push(b);
  return b;
};
const sy = (s, x = 60) => s.surface[x];

/** An outdoor plant in a pot on the surface at tile x. */
function outdoorPlant(s, x, extra = {}) {
  const pot = addObject(s, { kind: 'pot', x, y: sy(s, x) - 1, soil: 'cheap', soilPh: 6.4, plantId: null });
  const plant = createPlant(s, pot, 'ditch');
  pot.plantId = plant.id;
  Object.assign(plant, extra);
  return { pot, plant };
}

/** Dig a hidden underground room behind a hatch: chamber x0..x0+5, floor row. */
function hiddenRoom(s, x0 = 60) {
  const y0 = sy(s, x0);
  const floor = y0 + 8;
  for (let y = y0; y <= floor; y++) setTile(s, 58, y, T.AIR);               // shaft
  for (let x = 58; x < x0 + 6; x++) for (let y = floor - 2; y <= floor; y++) setTile(s, x, y, T.AIR);
  addObject(s, { kind: 'hatch', x: 58, y: y0 + 1 });
  return { floor, x0 };
}
function undergroundPlant(s, x, floor) {
  const pot = addObject(s, { kind: 'pot', x, y: floor, soil: 'cheap', soilPh: 6.4, plantId: null });
  const plant = createPlant(s, pot, 'ditch');
  pot.plantId = plant.id;
  return { pot, plant };
}

const entry = (s, label) => logOf(s).find((e) => e.label.includes(label));

// ------------------------------------------------------------ sources -----

test('sales heat: stranger +3, trust 0-1/2-3/4-5 = +2/+1/+0.5, Doc Renner 0, all in the scanner log', () => {
  const s = game();
  // Street sale (retry seeds: ~2% roll an undercover instead).
  for (let seed = 1; seed < 50; seed++) {
    const t = game(seed);
    stock(t, 100, 50);
    const r = streetSale(t, { interested: true, asked: false });
    if (!r.ok) continue;
    assert.equal(t.heat, 3);
    assert.equal(entry(t, 'Street sale').amount, 3);
    break;
  }
  const deliver = (key, pts, hour) => {
    const t = game();
    t.time.day = 20; t.time.hour = hour;
    const b = t.economy.buyers[key];
    b.known = true; b.pts = pts; b.nextOrderAt = nowGh(t);
    stepTime(t, DT); stepEconomy(t, GH);
    stock(t, 900, 90);
    assert.ok(fillOrder(t, orderOf(t, key).id).ok);
    return t;
  };
  assert.equal(deliver('marla', 0, 17).heat, 2);
  assert.equal(deliver('marla', 30, 17).heat, 1);
  assert.equal(deliver('marla', 100, 17).heat, 0.5);
  const doc = deliver('doc', 0, 19);
  assert.equal(doc.heat, 0);
  const m = deliver('marla', 30, 17);
  assert.equal(entry(m, 'Sale to Marla').amount, 1);
  assert.ok(scannerView(m).log.length >= 1);
  void s;
});

test('one-off sources: runner, patrol, guns, kills, officer, collapse, rival tip, ask around, undercover', () => {
  const cases = [
    ['runnerBusted', 1, 10], ['runnerSnitch', 1, 20], ['patrolStop', 1, 10],
    ['killCriminal', 1, 8], ['killCivilian', 1, 40], ['collapse', 1, 5], ['rivalTip', 1, 15],
    ['gunshotLot', 3, 3], ['gunshotLot', 20, 8], ['gunshotTown', 2, 8], ['gunshotTown', 9, 20],
  ];
  for (const [key, n, expect] of cases) {
    const s = game();
    heatEvent(s, key, n);
    assert.equal(s.heat, expect, `${key} x${n}`);
    assert.equal(entry(s, key).amount, expect);
  }
  const sup = game();
  heatEvent(sup, 'gunshotLot', 4, { suppressed: true });
  assert.equal(sup.heat, 1); // 4 x 0.25
  const cop = game();
  heatEvent(cop, 'shootOfficer');
  assert.equal(cop.heat, 50);
  assert.equal(hs(cop).floor, 25);
  hs(cop).floor = 25; cop.heat = 25;
  addHeat(cop, -100, 'test');
  assert.equal(cop.heat, 25, 'heat never drops below the floor');
  const run = game();
  runnerDeliveryHeat(run, 50);
  assert.equal(run.heat, 0.5);
  const ask = game();
  at(ask, 2, 18);
  assert.ok(askAround(ask).ok);
  assert.equal(ask.heat, 4);
  assert.ok(entry(ask, 'Asked around'));
  const uc = game();
  stock(uc, 100, 50);
  uc.heat = 80;
  for (let seed = 1; seed < 200 && !uc.economy.ledger.some((l) => /Undercover/.test(l.text)); seed++) {
    uc.rngState = seed; uc.heat = 80; hs(uc).log = [];
    streetSale(uc, { interested: true, asked: false });
  }
  assert.equal(entry(uc, 'undercover').amount, 12);
});

test('flashy spending: over $2,000 dirty cash in a day is +3, once', () => {
  const s = game();
  at(s, 2, 9);
  buyItem(s, 'hatch', 'hardware'); // $600
  buyItem(s, 'hatch', 'hardware');
  buyItem(s, 'hatch', 'hardware');
  assert.equal(s.heat, 0);
  buyItem(s, 'hatch', 'hardware'); // $2,400 total
  assert.equal(s.heat, 3);
  buyItem(s, 'hatch', 'hardware');
  assert.equal(s.heat, 3, 'only once per day');
  assert.ok(entry(s, 'Flashy'));
});

test('daily sources: visible plants, smell, racks, filter, lamps, generator, big grows', () => {
  const s = game();
  for (let i = 0; i < 4; i++) {
    const { plant } = outdoorPlant(s, 60 + i);
    plant.progress = 0.6; // flowering
  }
  const rack = addObject(s, { kind: 'rack', x: 70, y: sy(s, 70) - 1 });
  stock(s, 10, 50, rack.id).wet = true;
  dailyHeat(s);
  // 4 x 0.3 visible + 4 x 0.1 outdoor smell + 0.5 rack - decay (laying low: 2 x2)
  const l = (label) => entry(s, label).amount;
  assert.equal(l('visible from the road'), 1.2);
  assert.equal(l('Smell: 4 outdoor'), 0.4);
  assert.equal(l('Smell: 1 loaded rack'), 0.5);
  assert.equal(l('Laying low'), -H.decay.low * H.layLowMult);
  assert.equal(s.heat, 0); // clamped at the floor, 2.1 up then -4

  // Filter within 6 tiles removes all smell heat.
  const f = game();
  for (let i = 0; i < 4; i++) outdoorPlant(f, 60 + i).plant.progress = 0.6;
  addObject(f, { kind: 'filter', x: 62, y: sy(f, 62) - 1 });
  dailyHeat(f);
  assert.equal(entry(f, 'Smell'), undefined);

  // Lamps: HPS 0.4, 18 h doubles, generator removes lamp heat.
  const lm = game();
  addObject(lm, { kind: 'lamp', lamp: 'lamp_hps', x: 60, y: 30, hours: 14 });
  addObject(lm, { kind: 'lamp', lamp: 'lamp_led', x: 62, y: 30, hours: 18 });
  dailyHeat(lm);
  assert.ok(Math.abs(entry(lm, 'Grow lamps').amount - (0.4 + 0.15 * 2)) < 1e-9);
  const gen = game();
  addObject(gen, { kind: 'lamp', lamp: 'lamp_hps', x: 60, y: 30, hours: 14 });
  addObject(gen, { kind: 'generator', x: 61, y: sy(gen, 61) - 1 });
  dailyHeat(gen);
  assert.equal(entry(gen, 'Grow lamps'), undefined);

  // Big grows: >12 plants +1, >30 plants +3.
  const g13 = game();
  for (let i = 0; i < 13; i++) outdoorPlant(g13, 50 + i);
  dailyHeat(g13);
  assert.equal(entry(g13, 'Big grow').amount, 1);
  const g31 = game();
  for (let i = 0; i < 31; i++) outdoorPlant(g31, 41 + i);
  dailyHeat(g31);
  assert.equal(entry(g31, 'Big grow').amount, 3);
});

test('underground and walled-in plants are never visible; indoor smell is the indoor rate', () => {
  const s = game();
  const room = hiddenRoom(s);
  const { pot, plant } = undergroundPlant(s, 61, room.floor);
  plant.progress = 0.6;
  assert.equal(visibleFromRoad(s, pot), false);
  const out = outdoorPlant(s, 70);
  assert.equal(visibleFromRoad(s, out.pot), true);
  // A roof over an outdoor plant hides it too.
  setTile(s, 70, sy(s, 70) - 3, T.WOOD);
  assert.equal(visibleFromRoad(s, out.pot), false);
  out.plant.progress = 0; // seedling: no smell
  dailyHeat(s);
  assert.equal(entry(s, 'visible'), undefined);
  assert.equal(entry(s, 'Smell: 1 indoor').amount, 0.2);
});

test('decay: low at Cold/Warm, high at Hot/Burning (config), doubled on a zero-sale day, plus the farm stand', () => {
  const decayAt = (heat, sales, front) => {
    const s = game();
    s.heat = heat;
    if (sales) noteSale(s);
    if (front) s.license = { frontOwned: true };
    dailyHeat(s);
    return heat - s.heat;
  };
  const D = H.decay;
  assert.equal(decayAt(10, true), D.low);
  assert.equal(decayAt(40, true), D.low);
  assert.equal(decayAt(60, true), D.high);
  assert.equal(decayAt(90, true), D.high);
  assert.equal(decayAt(10, false), D.low * H.layLowMult);
  assert.equal(decayAt(60, false), D.high * H.layLowMult);
  assert.equal(decayAt(60, true, true), D.high + H.farmStandDecay);
});

test('bribe the deputy: after day 6, -15 for $500, 5-day cooldown, +$250 each use', () => {
  const s = game();
  at(s, 5, 17);
  s.heat = 60;
  assert.equal(buyItem(s, 'bribe', 'bar').ok, false, 'not before day 6');
  at(s, 6, 17);
  const cash = s.player.cash;
  assert.ok(buyItem(s, 'bribe', 'bar').ok);
  assert.equal(s.heat, 45);
  assert.equal(s.player.cash, cash - 500);
  assert.equal(bribePrice(s), 750);
  assert.equal(bribeDeputy(s).ok, false, 'cooldown');
  at(s, 11, 17);
  assert.ok(bribeDeputy(s).ok);
  assert.equal(s.player.cash, cash - 500 - 750);
  assert.ok(entry(s, 'Bribed'));
});

// -------------------------------------------------------------- tells -----

test('world tells by tier and patrol-car schedule (1/day Warm, 3/day Hot)', () => {
  const s = game();
  const tells = (h) => { s.heat = h; return worldTells(s); };
  assert.deepEqual([tells(0).tier, tells(25).tier, tells(50).tier, tells(75).tier], [0, 1, 2, 3]);
  assert.equal(tells(10).peopleTalking, false);
  assert.equal(tells(30).peopleTalking, true);
  assert.equal(tells(30).helicopter, false);
  assert.ok(tells(60).helicopter && tells(60).blinds && !tells(60).unmarkedCar);
  assert.ok(tells(80).unmarkedCar && tells(80).stopSearch);

  const carsPerDay = (heat) => {
    const g = game(9);
    g.heat = heat;
    at(g, 3, 6.0);
    let cars = 0, heli = 0;
    for (let i = 0; i < 24 * 60; i++) { // one full day at 2 Hz
      g.heat = heat;
      stepTime(g, DT);
      stepHeat(g, GH);
      if (g.patrolCar) { cars++; g.patrolCar = null; }
      for (const e of g.events) if (e.type === 'helicopter') heli++;
      g.events.length = 0;
    }
    return { cars, heli };
  };
  assert.deepEqual(carsPerDay(10), { cars: 0, heli: 0 });
  assert.deepEqual(carsPerDay(30), { cars: 1, heli: 0 });
  assert.deepEqual(carsPerDay(60), { cars: 3, heli: 1 });
  assert.deepEqual(carsPerDay(80), { cars: 3, heli: 1 });
});

test('bartender: a drink at Warm says people are talking; the rumor states tonight\'s chance', () => {
  const s = game();
  at(s, 3, 17);
  s.heat = 30;
  assert.equal(buyItem(s, 'drink', 'bar').msg, H.peopleTalking);
  s.heat = 0;
  assert.equal(buyItem(s, 'rumor', 'bar').msg, 'Nothing is stirring tonight.');
  s.heat = 100;
  assert.match(buyItem(s, 'rumor', 'bar').msg, /tonight/);
});

// -------------------------------------------------------------- raids -----

test('raid chance: 0 below 50, (heat-50) x1.2% when Hot, 30% + (heat-75) x2.8% when Burning, lawyer x0.75', () => {
  const s = game();
  const c = (h) => raidChance(s, h);
  assert.equal(c(49.9), 0);
  assert.ok(Math.abs(c(60) - 0.12) < 1e-9);
  assert.ok(Math.abs(c(74) - 0.288) < 1e-9);
  assert.ok(Math.abs(c(75) - 0.30) < 1e-9);
  assert.ok(Math.abs(c(85) - 0.58) < 1e-9);
  assert.equal(c(100), 1);
  hireLawyer(s);
  assert.ok(lawyerActive(s));
  assert.ok(Math.abs(c(60) - 0.09) < 1e-9);
});

/** Run heat ticks from `from` hour until `to` hour (same day). */
function runHeat(s, from, to) {
  at(s, s.time.day, from);
  const ticks = Math.round((to - from) / GH);
  for (let i = 0; i < ticks; i++) { stepTime(s, DT); stepHeat(s, GH); }
}

test('raid roll happens at 05:00: not before, not on day < 6, not below Hot', () => {
  const roll = (day, heat, u) => {
    const s = game();
    s.heat = heat;
    s.time.day = day;
    hs(s).raidU = u;
    runHeat(s, 4.5, 4.99);
    const before = !!hs(s).raid;
    runHeat(s, 4.99, 5.05);
    return { before, after: !!hs(s).raid, s };
  };
  const hit = roll(8, 60, 0.0);
  assert.equal(hit.before, false, 'nothing before 05:00');
  assert.equal(hit.after, true);
  assert.equal(roll(8, 60, 0.5).after, false, 'u above the 12% chance');
  assert.equal(roll(5, 100, 0).after, false, 'no raids before day 6');
  assert.equal(roll(8, 40, 0).after, false, 'no raids below Hot');
  assert.equal(roll(8, 100, 0.99).after, true, '100 heat is a certain raid');
  const raid = hit.s.events.find((e) => e.type === 'raidStart');
  assert.equal(raid.cops, 4);
  hit.s.heat = 80; hs(hit.s).raid = null;
  hit.s.time.day = 9; hs(hit.s).raidU = 0; runHeat(hit.s, 4.9, 5.1);
  assert.equal(hit.s.events.filter((e) => e.type === 'raidStart').pop().cops, 6, 'six cops at Burning');
});

test('warnings: scanner at 03:00, deputy tip at 23:00 within 5 days of a bribe; sleep stops', () => {
  const s = game();
  s.time.day = 9; s.heat = 100;
  runHeat(s, 22.5, 23.1); // pre-roll at 23:00
  assert.ok(hs(s).raidU !== null);
  hs(s).raidU = 0;        // tonight is a raid
  s.events.length = 0;
  s.sleeping = true; s.sleepRemain = 7;
  s.time.day = 10;
  runHeat(s, 2.9, 3.1);
  const w = s.events.find((e) => e.type === 'raidWarning');
  assert.equal(w.source, 'scanner');
  assert.equal(w.gh, 2);
  assert.equal(s.sleeping, false);

  const d = game();
  d.player.inv.scanner = 0;
  d.time.day = 9; d.heat = 100;
  hs(d).lastBribeDay = 7; // within 5 days
  runHeat(d, 22.9, 23.1);
  const tip = d.events.find((e) => e.type === 'raidWarning');
  // 6 gh ahead: the roll at 23:00 may or may not be a raid night; check the tip matches it.
  assert.equal(!!tip, hs(d).raidU < raidChance(d));
  if (tip) assert.equal(tip.source, 'deputy');
  d.heat = 100; hs(d).raidU = null; hs(d).lastBribeDay = 1;
  d.events.length = 0;
  runHeat(d, 22.9, 23.1);
  assert.equal(d.events.some((e) => e.type === 'raidWarning'), false, 'no tip without a bribe');
});

test('cops path through the lot: BFS from the road edge to the shack door', () => {
  const s = game();
  const door = CONFIG.world.buildings.find((b) => b.key === 'shack');
  const from = { x: 139, y: sy(s, 139) - 1 };
  const to = { x: door.x + door.w - 1, y: sy(s, door.x + door.w - 1) - 1 };
  const path = findPath(s, from, to);
  assert.ok(path && path.length >= 80, 'walks about 80 tiles');
  assert.deepEqual(path[0], from);
  assert.deepEqual(path[path.length - 1], to);
  // Walling the lot off with stone makes the shack unreachable.
  for (let y = 0; y < 30; y++) setTile(s, 100, y, T.STONE);
  assert.equal(findPath(s, from, to), null);
  s.heat = 80; hs(s).raidU = 0; s.time.day = 9;
  runHeat(s, 4.9, 5.1);
  assert.ok(hs(s).raid.path.length >= 2);
});

// -------------------------------------------------------- hidden rooms ----

const trials = (s, n, seed = 7) => {
  const rng = createRng(seed);
  return Array.from({ length: n }, () => searchLot(s, rng));
};

test('hidden room: found with 30% + (heat-50)%, +20% K-9 at Burning, +30% snitch; open rooms always', () => {
  const s = game();
  const room = hiddenRoom(s);
  const { pot } = undergroundPlant(s, 61, room.floor);
  s.player.x = 10 * 16; // away from the lot: carried items are not at risk
  assert.equal(roomOf(s, pot.x, pot.y).open, false);
  s.heat = 60;
  assert.ok(Math.abs(hatchFindChance(s) - 0.40) < 1e-9);
  const n = 4000;
  const found = trials(s, n).filter((f) => f.plants.length === 1).length / n;
  assert.ok(Math.abs(found - 0.40) < 0.03, `found ${found}`);
  s.heat = 80;
  assert.ok(Math.abs(hatchFindChance(s) - 0.80) < 1e-9, '30 + 30 + 20 K-9');
  hs(s).snitched = true;
  assert.equal(hatchFindChance(s), 1);

  // No hatch: the same room is an open shaft and is always found.
  const open = game();
  const r2 = hiddenRoom(open);
  open.objects = open.objects.filter((o) => o.kind !== 'hatch');
  const { pot: p2 } = undergroundPlant(open, 61, r2.floor);
  assert.equal(roomOf(open, p2.x, p2.y).open, true);
  open.heat = 55; open.player.x = 160;
  assert.ok(trials(open, 50).every((f) => f.plants.length === 1));

  // An outdoor plant and the shack interior are always found.
  const out = game();
  outdoorPlant(out, 70);
  out.player.x = 160;
  assert.ok(trials(out, 50).every((f) => f.plants.length === 1));
  const shack = outdoorPlant(out, 52); // inside the shack (roof overhead)
  assert.equal(roomOf(out, shack.pot.x, shack.pot.y).open, true, 'door gap makes the shack open');
});

test('safe opens 50% in a found room; buried stash is found 10%; stash in an open room is found', () => {
  const s = game();
  s.heat = 90; s.player.x = 160;
  const safe = addObject(s, { kind: 'safe', x: 52, y: sy(s, 52) - 1, cash: 800 }); // shack
  const n = 4000;
  const opened = trials(s, n).filter((f) => f.containers.includes(safe)).length / n;
  assert.ok(Math.abs(opened - 0.5) < 0.03, `safe ${opened}`);

  const b = game();
  b.heat = 90; b.player.x = 160;
  const y = sy(b, 70) + 3;
  for (let dy = -1; dy <= 1; dy++) for (let x = 69; x <= 71; x++) setTile(b, x, y + dy, T.DIRT);
  setTile(b, 70, y, T.AIR);
  const stash = addObject(b, { kind: 'stash', x: 70, y, cash: 500 });
  assert.equal(isBuried(b, 70, y), true);
  const hit = trials(b, n).filter((f) => f.containers.includes(stash)).length / n;
  assert.ok(Math.abs(hit - 0.10) < 0.02, `stash ${hit}`);
});

test('stash and safe can be placed; E moves carried product and cash in and out', () => {
  const s = game();
  s.player.inv.stash = 1;
  const y = sy(s, 70) - 1;
  assert.ok(placeObject(s, 'stash', 70, y));
  const box = s.objects.find((o) => o.kind === 'stash');
  stock(s, 50);
  s.player.cash = 300;
  useContainer(s, box);
  assert.equal(s.player.cash, 0);
  assert.equal(box.cash, 300);
  assert.ok(s.product.every((b) => b.where === box.id));
  useContainer(s, box);
  assert.equal(s.player.cash, 300);
  assert.ok(s.product.every((b) => b.where === 'inv'));
  // A hatch only goes in a shaft or tunnel (solid on both sides).
  s.player.inv.hatch = 1;
  assert.equal(placeObject(s, 'hatch', 75, sy(s, 75) - 1), false);
});

// ------------------------------------------------- seizure and fines ------

test('seizure: found plants destroyed, product taken, 50% of found cash, $50/plant from bank then cash', () => {
  const s = game();
  s.heat = 70;
  s.player.cash = 1000;
  s.player.bank = 100;
  for (let i = 0; i < 4; i++) outdoorPlant(s, 60 + i);
  stock(s, 100, 70);
  const found = searchLot(s, createRng(1));
  assert.equal(found.plants.length, 4);
  const r = applyRaid(s, found);
  assert.equal(s.plants.length, 0);
  assert.equal(s.product.length, 0);
  assert.equal(r.cashSeized, 500);
  assert.equal(r.fine, 200);
  assert.equal(s.player.bank, 0, 'fine comes out of the bank first');
  assert.equal(s.player.cash, 500 - 100);
  assert.equal(s.heat, 70 - 30);
  assert.equal(s.objects.filter((o) => o.kind === 'pot' && o.plantId).length, 0);
  const notice = s.events.find((e) => e.type === 'notice');
  assert.ok(notice.lines.join(' ').includes('Plants destroyed: 4'));
});

test('seizure: a shortfall becomes debt, a found-nothing raid cools 40, lawyer halves fines and seizure', () => {
  const s = game();
  s.heat = 70; s.player.cash = 0; s.player.x = 160;
  for (let i = 0; i < 4; i++) outdoorPlant(s, 60 + i);
  const r = applyRaid(s, searchLot(s, createRng(1)));
  assert.equal(r.fine, 200);
  assert.equal(s.player.debt, 200);
  assert.equal(payDebt(s), 0);
  s.player.cash = 150;
  assert.equal(payDebt(s), 150);
  assert.equal(s.player.debt, 50);

  const n = game();
  n.heat = 70; n.player.x = 160;
  const rn = applyRaid(n, searchLot(n, createRng(1)));
  assert.equal(rn.nothing, true);
  assert.equal(n.heat, 30, '-40 when they find nothing');

  const l = game();
  l.heat = 70; l.player.cash = 1000; l.player.bank = 0;
  hireLawyer(l);
  for (let i = 0; i < 4; i++) outdoorPlant(l, 60 + i);
  const rl = applyRaid(l, searchLot(l, createRng(1)));
  assert.equal(rl.fine, 100);
  assert.equal(rl.cashSeized, 250);
});

test('arrest if 20+ plants, 450+ g found, an unregistered gun, or you fired at police; lawyer x1.5', () => {
  const run = (setup, lawyer = false) => {
    const s = game();
    s.heat = 70; s.player.cash = 100000;
    if (lawyer) hireLawyer(s);
    setup(s);
    return applyRaid(s, searchLot(s, createRng(1))).arrested;
  };
  const plants = (n) => (s) => { for (let i = 0; i < n; i++) outdoorPlant(s, 41 + i); };
  assert.equal(run(plants(19)), false);
  assert.equal(run(plants(20)), true);
  assert.equal(run(plants(20), true), false);
  assert.equal(run(plants(30), true), true);
  assert.equal(run((s) => stock(s, 449)), false);
  assert.equal(run((s) => stock(s, 450)), true);
  assert.equal(run((s) => stock(s, 450), true), false);
  assert.equal(run((s) => stock(s, 675), true), true);
  assert.equal(run((s) => { s.player.gunUnregistered = true; }), true);
  assert.equal(run((s) => { hs(s).firedAtPolice = true; }), true);
  // Absent from the lot: product on you is safe, and only the plant count arrests.
  const away = game();
  away.heat = 70; away.player.x = 160;
  stock(away, 800);
  const r = applyRaid(away, searchLot(away, createRng(1)));
  assert.equal(r.arrested, false);
  assert.equal(away.product.length, 1, 'product you carried away is not seized');
});

test('arrests: bail $1,500 then $3,000 loses a day; no money = 4 days; third arrest is game over', () => {
  const s = game();
  at(s, 10, 5.5);
  s.player.cash = 5000;
  const a1 = arrestPlayer(s, 'raid');
  assert.deepEqual([a1.bail, a1.afford, a1.days], [1500, true, 1]);
  assert.equal(s.player.cash, 3500);
  assert.equal(hs(s).pendingSkip, 1);
  hs(s).pendingSkip = 0;
  const a2 = arrestPlayer(s, 'raid');
  assert.deepEqual([a2.bail, a2.afford, a2.days], [3000, true, 1]);
  assert.equal(s.player.cash, 500);
  hs(s).pendingSkip = 0;
  assert.equal(s.gameOver, null);
  const a3 = arrestPlayer(s, 'raid');
  assert.equal(a3.gameOver, true);
  assert.deepEqual(s.gameOver, { reason: 'prison' });
  assert.ok(s.events.some((e) => e.type === 'gameOver'));
  const tick = s.simTicks;
  stepSim(s, DT);
  assert.equal(s.simTicks, tick, 'the sim stops after game over');

  const broke = game();
  broke.player.cash = 100;
  const a = arrestPlayer(broke, 'patrol');
  assert.deepEqual([a.afford, a.days], [false, 4]);
  assert.equal(broke.player.cash, 100, 'no bail paid when you cannot');
});

test('jail skips time: bail loses 1 day, jail 4; unwatered plants die, a drip kit saves them', () => {
  const run = (days, drip) => {
    const s = game();
    at(s, 10, 5.5);
    s.heat = 0;
    s.player.inv.drip = drip ? 1 : 0;
    outdoorPlant(s, 70);
    hs(s).pendingSkip = days;
    stepSim(s, DT);
    return s;
  };
  const one = run(1, false);
  assert.equal(one.time.day, 11);
  assert.ok(Math.abs(one.time.hour - 6) < 0.05, `woke at ${one.time.hour}`);
  assert.equal(one.plants[0].dead, true, 'a day unwatered kills outdoor plants');
  const four = run(4, false);
  assert.equal(four.time.day, 14);
  const saved = run(4, true);
  assert.equal(saved.plants[0].dead, false);
  assert.ok(one.events.some((e) => e.type === 'skipped'));
});

test('patrol stop in town: >100 g near a cop rolls 2/6/15/30%, product lost, $200 fine, +10 heat, >448 g arrests', () => {
  const stops = (tier, grams, duffel) => {
    let n = 0;
    const heat = [0, 30, 60, 80][tier];
    const N = 400;
    for (let i = 0; i < N; i++) {
      const s = game(1000 + i);
      at(s, 3, 12);
      s.heat = heat;
      s.player.cash = 5000;
      if (duffel) s.player.inv.duffel = 1;
      stock(s, grams);
      s.player.x = 300 * 16;
      s.cops = [{ x: 301 * 16, dir: 1, coolUntil: 0 }];
      s.heat = heat;
      stepHeat(s, GH);
      if (s.events.some((e) => e.type === 'notice')) n++;
    }
    return n / N;
  };
  assert.ok(Math.abs(stops(0, 150) - 0.02) < 0.02);
  assert.ok(Math.abs(stops(1, 150) - 0.06) < 0.035);
  assert.ok(Math.abs(stops(2, 150) - 0.15) < 0.05);
  assert.ok(Math.abs(stops(3, 150) - 0.30) < 0.06);
  assert.ok(Math.abs(stops(3, 150, true) - 0.45) < 0.06, 'duffel x1.5');
  assert.equal(stops(3, 100), 0, 'at most 100 g is never searched');

  let s;
  for (let seed = 1; seed < 400; seed++) {
    s = game(seed);
    at(s, 3, 12); s.heat = 80; s.player.cash = 5000;
    stock(s, 500);
    s.player.x = 300 * 16;
    s.cops = [{ x: 300 * 16, dir: 1, coolUntil: 0 }];
    stepHeat(s, GH);
    if (s.events.some((e) => e.type === 'notice')) break;
  }
  assert.equal(s.product.length, 0);
  assert.equal(entry(s, 'Stopped by patrol').amount, 10);
  assert.equal(s.player.arrests, 1, 'over 448 g is an arrest');
  assert.equal(s.player.cash, 5000 - 200 - 1500);
});

// --------------------------------------------------- lamps, underground ---

/** Tend a plant ideally every tick so only light limits growth. */
function growDays(s, plant, days, stop) {
  const ticks = days * 24 * 60;
  for (let i = 0; i < ticks; i++) {
    plant.moisture = 60; plant.nutrients = 60; plant.ph = 6.4;
    stepTime(s, DT);
    stepPlants(s, GH);
    if (stop && stop()) return i / 60 / 24;
  }
  return days;
}

test('underground lamp growing: an HPS lamp ripens a hidden plant on the sun schedule, and it is invisible', () => {
  const sun = game();
  const o = outdoorPlant(sun, 70);
  const dOut = growDays(sun, o.plant, 8, () => stageOf(o.plant) === 'ripe');

  const s = game();
  const room = hiddenRoom(s);
  const { pot, plant } = undergroundPlant(s, 61, room.floor);
  addObject(s, { kind: 'lamp', lamp: 'lamp_hps', x: 61, y: room.floor - 1, hours: 14 });
  assert.equal(visibleFromRoad(s, pot), false);
  assert.equal(lightFactor(s, pot), 1, 'lamp on at 06:00');
  const dIn = growDays(s, plant, 8, () => stageOf(plant) === 'ripe');
  assert.ok(dOut > 4 && dOut < 7, `outdoor ${dOut}`);
  assert.ok(Math.abs(dIn - dOut) < 0.1, `underground ${dIn} vs outdoor ${dOut}`);
  assert.equal(plant.dead, false);

  // Invisible to the road, to heat, and to a failed hatch roll.
  s.heat = 60; s.player.x = 160;
  const rng = { chance: () => false, next: () => 0.99 };
  assert.equal(searchLot(s, rng).plants.length, 0);
  dailyHeat(s);
  assert.equal(entry(s, 'visible'), undefined);
});

test('lamp types: nearest N pots within radius, light factor, 14 h timer, 18 h = 29% faster', () => {
  const s = game();
  const room = hiddenRoom(s);
  const pots = [];
  for (let i = 0; i < 6; i++) pots.push(undergroundPlant(s, 59 + i, room.floor).pot);
  addObject(s, { kind: 'lamp', lamp: 'lamp_cfl', x: 60, y: room.floor - 1 });
  let cov = lampCoverage(s, 7);
  assert.equal(cov.size, 2, 'CFL lights 2 pots');
  assert.equal(cov.get(pots[1].id), 0.7);
  s.objects = s.objects.filter((o) => o.kind !== 'lamp');
  addObject(s, { kind: 'lamp', lamp: 'lamp_led', x: 61, y: room.floor - 1 });
  cov = lampCoverage(s, 7);
  assert.equal(cov.size, 4, 'LED lights 4 pots');
  assert.equal([...cov.values()][0], 1.1);
  assert.equal(lampCoverage(s, 21).size, 0, 'off after the 14 h timer (06:00-20:00)');
  s.objects.find((o) => o.kind === 'lamp').hours = 18;
  assert.equal(lampCoverage(s, 21).size, 4, '18 h timer still on at 21:00');
  assert.equal(lampCoverage(s, 23.5).size, 4);
  assert.equal(lampCoverage(s, 0.5).size, 0, '18 h from 06:00 ends at midnight');

  // 18 h grows ~29% faster than 14 h.
  const grow = (hours) => {
    const t = game();
    const r = hiddenRoom(t);
    const { plant } = undergroundPlant(t, 61, r.floor);
    addObject(t, { kind: 'lamp', lamp: 'lamp_hps', x: 61, y: r.floor - 1, hours });
    return growDays(t, plant, 6, () => stageOf(plant) === 'ripe');
  };
  const ratio = grow(14) / grow(18);
  assert.ok(Math.abs(ratio - 18 / 14) < 0.05, `ratio ${ratio}`);
});

test('an indoor plant with no light for 24 gh takes stress; lamp-lit and outdoor plants do not', () => {
  const s = game();
  const room = hiddenRoom(s);
  const dark = undergroundPlant(s, 61, room.floor).plant;
  const lit = undergroundPlant(s, 63, room.floor).plant;
  addObject(s, { kind: 'lamp', lamp: 'lamp_cfl', x: 63, y: room.floor - 1 });
  const out = outdoorPlant(s, 70).plant;
  for (const p of [dark, lit, out]) { p.moisture = 60; }
  growDays(s, dark, 0); // no-op, keep imports honest
  for (let i = 0; i < 23 * 60; i++) {
    for (const p of [dark, lit, out]) { p.moisture = 60; p.nutrients = 60; p.ph = 6.4; }
    stepTime(s, DT); stepPlants(s, GH);
  }
  assert.equal(stressorsOf(dark).includes('noLight'), false, 'not yet');
  for (let i = 0; i < 2 * 60; i++) {
    for (const p of [dark, lit, out]) { p.moisture = 60; p.nutrients = 60; p.ph = 6.4; }
    stepTime(s, DT); stepPlants(s, GH);
  }
  assert.equal(stressorsOf(dark).includes('noLight'), true);
  assert.equal(stressorsOf(lit).includes('noLight'), false);
  assert.equal(stressorsOf(out).includes('noLight'), false);
  assert.ok(dark.health < 100);
});

// ------------------------------------------------------------- weather ----

test('weather rolls at 06:00; rain lasts 6 gh and waters outdoor plants (+4/gh), not covered ones', () => {
  const s = game();
  at(s, 3, 5.99);
  s.time.weather = 'clear';
  stepTime(s, DT); stepTime(s, DT);
  assert.ok(['clear', 'rain', 'heatwave'].includes(s.time.weather));
  // Force a rain day.
  s.time.weather = 'rain';
  s.time.hour = 7;
  assert.ok(isRaining(s));
  s.time.hour = 12.1;
  assert.equal(isRaining(s), false);
  assert.equal(weatherNow(s), 'clear');
  s.time.hour = 11.9;
  assert.equal(weatherNow(s), 'rain');

  const mk = (weather, hour) => {
    const t = game();
    at(t, 3, hour);
    t.time.weather = weather;
    const open = outdoorPlant(t, 70).plant;
    const room = hiddenRoom(t);
    const hidden = undergroundPlant(t, 61, room.floor).plant;
    open.moisture = hidden.moisture = 50;
    for (let i = 0; i < 60; i++) { stepTime(t, DT); stepPlants(t, GH); } // 1 gh
    return { open, hidden };
  };
  const rain = mk('rain', 7);
  const clear = mk('clear', 7);
  assert.ok(rain.open.moisture - clear.open.moisture > 3.5, 'rain adds ~4 per gh outdoors');
  assert.ok(Math.abs(rain.hidden.moisture - clear.hidden.moisture) < 1e-6, 'underground is dry');
  const heat = mk('heatwave', 7);
  const lossClear = 50 - clear.open.moisture;
  const lossHeat = 50 - heat.open.moisture;
  assert.ok(Math.abs(lossHeat / lossClear - 1.5) < 0.02, 'heatwave x1.5 outdoors');
});

test('rain refills the barrel', () => {
  const s = game();
  at(s, 3, 7);
  s.time.weather = 'rain';
  const barrel = s.objects.find((o) => o.kind === 'barrel');
  barrel.charges = 10;
  for (let i = 0; i < 60; i++) stepTime(s, DT);
  assert.ok(barrel.charges > 17 && barrel.charges <= CONFIG.weather.barrelMax);
});

// -------------------------------------------------- save, migration, bot --

test('saves: heatState round-trips; an old save with a plain heat number loads', () => {
  const s = game();
  addHeat(s, 12, 'test');
  hs(s).bribeCount = 2;
  s.player.arrests = 2;
  const back = deserializeState(serializeState(s));
  assert.equal(back.heat, 12);
  assert.deepEqual(back.heatState, s.heatState);
  assert.equal(back.player.arrests, 2);

  const old = JSON.parse(serializeState(s));
  delete old.heatState;
  delete old.gameOver;
  delete old.player.arrests;
  delete old.player.debt;
  old.heat = 33;
  const loaded = deserializeState(JSON.stringify(old));
  assert.equal(loaded.heat, 33);
  assert.equal(loaded.heatState.floor, 0);
  assert.equal(loaded.heatState.lastHour, old.time.hour);
  assert.equal(loaded.player.arrests, 0);
  assert.equal(loaded.player.debt, 0);
  assert.equal(heatTier(loaded.heat), 1);
});

test('full-sim smoke: raid at 05:00 through stepSim finds an outdoor plant and cools heat', () => {
  const s = game(11);
  at(s, 9, 4.9);
  s.heat = 100;
  s.player.x = 160;
  outdoorPlant(s, 70);
  hs(s).raidU = 0;
  for (let i = 0; i < 90 * 2; i++) { s.heat = Math.max(s.heat, 0); stepSim(s, DT); }
  assert.equal(s.plants.length, 0, 'the outdoor plant was found and destroyed');
  assert.ok(s.heat <= 70);
  assert.equal(hs(s).raid, null);
});

test('balance bot with heat on: runs 45 days, heat stays in range, raids and arrests are counted', () => {
  const rows = runBalance(CONFIG.dev.seed, 45, { quiet: true, heat: true });
  assert.ok(rows.length >= 30, 'the bot may lose days to jail but keeps running');
  assert.ok(rows.every((r) => r.heat >= 0 && r.heat <= 100));
  assert.ok(rows[rows.length - 1].gross > 5000, `gross ${rows[rows.length - 1].gross}`);
});
