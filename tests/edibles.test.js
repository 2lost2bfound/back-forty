// edibles.test.js — M12: the stove, recipes, cook timer, prices, dispensary and
// buyer sales, named bonus, raids, save/load (plan Deliverable 6, M12 "Done when").
import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { newGame, serializeState, deserializeState } from '../src/state.js';
import { stepSim } from '../src/sim/sim.js';
import { hs, applyRaid, searchLot } from '../src/sim/heat.js';
import { buyItem, shopStock } from '../src/sim/economy.js';
import { placeObject } from '../src/entities/player.js';
import { createRng } from '../src/rng.js';
import {
  startCook, collectCook, sellEdibles, unitPrice, stoveOf, ed, initEdibles,
} from '../src/sim/edibles.js';

const X = CONFIG.edibles;
const at = (s, day, hour) => { s.time.day = day; s.time.hour = hour; hs(s).lastHour = hour; };
const bud = (grams, quality, extra = {}) => ({ strainName: 'Widow Kush', quality, grams, wet: false, dryHoursLeft: 0, where: 'inv', rackId: null, ...extra });

function game(licensed = true) {
  const s = newGame(7);
  s.player.cash = 5000;
  at(s, 40, 10);
  if (licensed) s.license.granted = { day: 30 };
  return s;
}
function withStove(s) {
  const o = { id: s.nextId++, kind: 'stove', x: 10, y: 10, cook: null };
  s.objects.push(o);
  return o;
}
function cooked(s, recipe = 'brownies', q = 60, extra = {}) {
  const stove = stoveOf(s) || withStove(s);
  const b = bud(50, q, extra);
  s.product.push(b);
  assert.ok(startCook(s, stove, recipe, b).ok);
  stove.cook.left = 0;
  assert.ok(collectCook(s, stove).ok);
}
const cell = (s) => {
  for (let x = CONFIG.world.zones.lotX0; x < CONFIG.world.zones.lotX1; x++) {
    const y = s.surface[x] - 1;
    if (!s.objects.some((o) => o.x === x && o.y === y)) return [x, y];
  }
};
const trust = (s, key, level) => {
  const b = s.economy.buyers[key];
  b.known = true; b.pts = level ? CONFIG.economy.trust.thresholds[level - 1] : 0;
};
const present = (s, key) => { const d = CONFIG.economy.buyers[key]; at(s, 41, d.open + 1); };

test('without a license the stove is not sold and recipes are refused', () => {
  const s = game(false);
  assert.ok(!shopStock('hardware', s).some((e) => e.key === 'stove'));
  assert.equal(buyItem(s, 'stove').ok, false);
  const stove = withStove(s);
  const b = bud(20, 50); s.product.push(b);
  assert.equal(startCook(s, stove, 'brownies', b).ok, false);
  assert.equal(b.grams, 20);
});

test('the stove costs $1,500, is bought with a license and placed one per lot', () => {
  const s = game();
  at(s, 40, 10);
  assert.equal(shopStock('hardware', s).find((e) => e.key === 'stove').price, 1500);
  s.player.cash = 1000; s.player.bank = 1000;
  assert.ok(buyItem(s, 'stove').ok);
  assert.equal(s.player.cash + s.player.bank, 500, 'cash first then bank');
  assert.equal(buyItem(s, 'stove').ok, false, 'one per lot');
  const [x, y] = cell(s);
  assert.ok(placeObject(s, 'stove', x, y));
  assert.equal(stoveOf(s).kind, 'stove');
  s.player.inv.stove = 1;
  assert.equal(placeObject(s, 'stove', x + 1, s.surface[x + 1] - 1), false, 'second stove refused');
});

test('each recipe consumes bud and ingredients, cooks the stated hours, yields the stated units at bud quality', () => {
  for (const [k, r] of Object.entries(X.recipes)) {
    const s = game();
    const stove = withStove(s);
    const b = bud(30, 64.5); s.product.push(b);
    s.player.cash = 100; s.player.bank = 0;
    assert.ok(startCook(s, stove, k, b).ok);
    assert.equal(b.grams, 30 - r.grams);
    assert.equal(s.player.cash, 100 - r.cost);
    assert.equal(startCook(s, stove, k, b).ok, false, 'one batch at a time');
    let ticks = 0;
    while (stove.cook.left > 0) { stepSim(s, 0.5); ticks++; }
    const hours = ticks * 0.5 / CONFIG.clock.secPerGh;
    assert.ok(Math.abs(hours - r.gh) <= 0.5 / CONFIG.clock.secPerGh + 1e-9, `${k} cooked ${hours} gh`);
    assert.equal(startCook(s, stove, k, b).ok, false, 'finished batch must be collected first');
    assert.ok(collectCook(s, stove).ok);
    assert.deepEqual([ed(s).batches[0].units, ed(s).batches[0].quality, ed(s).batches[0].product], [r.units, 64.5, k]);
    assert.equal(stove.cook, null);
  }
});

test('wet bud is refused, a short batch is refused, equal batches merge', () => {
  const s = game();
  const stove = withStove(s);
  const wet = bud(20, 50, { wet: true }); s.product.push(wet);
  assert.equal(startCook(s, stove, 'brownies', wet).ok, false);
  const small = bud(3, 50); s.product.push(small);
  assert.equal(startCook(s, stove, 'brownies', small).ok, false);
  s.product.length = 0;
  cooked(s, 'brownies', 60); cooked(s, 'brownies', 60); cooked(s, 'brownies', 61);
  assert.deepEqual(ed(s).batches.map((b) => b.units), [20, 10]);
});

test('cooking continues while asleep (sleep runs the sim)', () => {
  const s = game();
  const stove = withStove(s);
  const b = bud(10, 50); s.product.push(b);
  startCook(s, stove, 'gummies', b);
  s.sleeping = true;
  const secs = X.recipes.gummies.gh * CONFIG.clock.secPerGh + 1;
  for (let t = 0; t < secs; t += 0.5) stepSim(s, 0.5);
  assert.equal(stove.cook.left, 0);
});

test('unit price follows base x (0.5 + q/100) x channel x named bonus', () => {
  const s = game();
  const b = { product: 'chocolate', quality: 80, units: 1, strainName: 'X', lineId: null };
  assert.ok(Math.abs(unitPrice(s, b, 'dispensary') - 18 * 1.3) < 1e-9);
  trust(s, 'skeet', 3);
  assert.ok(Math.abs(unitPrice(s, b, 'skeet') - 18 * 1.3 * 1.25) < 1e-9);
});

test('the dispensary pays the Bank, no heat, open 9-17, 40 units a day', () => {
  const s = game();
  cooked(s, 'gummies', 50); cooked(s, 'gummies', 50); cooked(s, 'gummies', 50); // 60 units
  const heat = s.heat, cash = s.player.cash, bank = s.player.bank || 0;
  at(s, 41, 20);
  assert.equal(sellEdibles(s, 'dispensary', 'gummies', 1).ok, false, 'closed');
  at(s, 41, 10);
  const r = sellEdibles(s, 'dispensary', 'gummies', 25);
  assert.ok(r.ok);
  assert.ok(Math.abs(r.value - 25 * 5 * 1.0) < 1e-9);
  assert.equal(s.player.cash, cash);
  assert.ok(Math.abs(s.player.bank - bank - 125) < 1e-9);
  assert.equal(s.heat, heat);
  assert.equal(sellEdibles(s, 'dispensary', 'gummies', 25).count, 15, 'capped at 40 a day');
  assert.equal(sellEdibles(s, 'dispensary', 'gummies', 1).ok, false);
  at(s, 42, 10);
  assert.equal(sellEdibles(s, 'dispensary', 'gummies', 10).count, 10, 'the cap resets next day');
});

test('buyers: dirty cash, +1 heat per sale, trust 2+, present, 10 a day each', () => {
  const s = game();
  cooked(s, 'gummies', 50); cooked(s, 'gummies', 50);
  trust(s, 'skeet', 1); present(s, 'skeet');
  assert.equal(sellEdibles(s, 'skeet', 'gummies', 1).ok, false, 'trust 1 refused');
  trust(s, 'skeet', 2);
  at(s, 41, 3);
  assert.equal(sellEdibles(s, 'skeet', 'gummies', 1).ok, false, 'not at their spot');
  present(s, 'skeet');
  s.heat = 0; hs(s).log = [];
  const cash = s.player.cash, bank = s.player.bank || 0;
  const r = sellEdibles(s, 'skeet', 'gummies', 4);
  assert.ok(r.ok);
  assert.ok(Math.abs(s.player.cash - cash - 4 * 5 * 1.0 * 1.25) < 1e-9);
  assert.equal(s.player.bank || 0, bank);
  assert.equal(s.heat, 1);
  assert.deepEqual(hs(s).log.map((e) => e.label), ['edibleSale']);
  assert.equal(sellEdibles(s, 'skeet', 'gummies', 10).count, 6, '10 a day');
  assert.equal(sellEdibles(s, 'skeet', 'gummies', 1).ok, false);
  assert.equal(s.heat, 2, 'one heat per sale');
  const lic = s.license.granted; s.license.granted = null;
  present(s, 'skeet');
  assert.equal(sellEdibles(s, 'skeet', 'gummies', 1).ok, false);
  s.license.granted = lic;
});

test('named strain bonus: +15% at the dispensary, at buyers only from trust 3', () => {
  const s = game();
  s.player.lines = { L1: { id: 'L1', name: 'Frosty', stability: 1 } };
  const b = { product: 'brownies', quality: 50, units: 1, strainName: 'Frosty', lineId: 'L1' };
  const plain = { ...b, lineId: null };
  assert.ok(Math.abs(unitPrice(s, b, 'dispensary') / unitPrice(s, plain, 'dispensary') - 1.15) < 1e-9);
  trust(s, 'skeet', 2);
  assert.ok(Math.abs(unitPrice(s, b, 'skeet') / unitPrice(s, plain, 'skeet') - 1) < 1e-9);
  trust(s, 'skeet', 3);
  assert.ok(Math.abs(unitPrice(s, b, 'skeet') / unitPrice(s, plain, 'skeet') - 1.15) < 1e-9);
});

test('raids and patrol stops leave edibles alone; edibles add no product grams', () => {
  const s = game();
  cooked(s, 'brownies', 60);
  const stove = stoveOf(s);
  const b = bud(10, 50); s.product.push(b);
  startCook(s, stove, 'gummies', b);
  const found = searchLot(s, createRng(1));
  assert.ok(!found.batches.some((x) => x.product));
  applyRaid(s, { plants: [], batches: s.product.filter((x) => x.where === 'inv'), containers: [], carried: true });
  assert.equal(ed(s).batches[0].units, 10);
  assert.ok(stoveOf(s).cook, 'the stove and its cook survive');
});

test('save/load round-trips a cook in progress and the edible stock; old saves default empty', () => {
  const s = game();
  cooked(s, 'chocolate', 77);
  const stove = stoveOf(s);
  const b = bud(10, 55); s.product.push(b);
  startCook(s, stove, 'brownies', b);
  for (let i = 0; i < 10; i++) stepSim(s, 0.5);
  const left = stove.cook.left;
  const t = deserializeState(serializeState(s));
  assert.equal(stoveOf(t).cook.left, left);
  assert.deepEqual(t.edibles, s.edibles);
  for (let i = 0; i < 2000 && stoveOf(t).cook.left > 0; i++) stepSim(t, 0.5);
  assert.equal(stoveOf(t).cook.left, 0);
  const o = JSON.parse(serializeState(s)); delete o.edibles;
  assert.deepEqual(deserializeState(JSON.stringify(o)).edibles, initEdibles());
});
