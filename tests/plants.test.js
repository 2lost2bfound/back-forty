// plants.test.js — M2: grow sim (plan §A4) driven through the real sim steps.
import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { newGame } from '../src/state.js';
import { stepTime } from '../src/sim/time.js';
import { stepPlants, plantSeed, harvestPlant, stageOf, careOf } from '../src/sim/plants.js';
import { stepEconomy, sellBatch, pricePerGram } from '../src/sim/economy.js';
import { stepPlayer } from '../src/entities/player.js';

const DT = 0.5;                         // one sim tick, real seconds
const GH = DT / CONFIG.clock.secPerGh;

function setup() {
  const s = newGame(7);
  const pot = s.objects.find((o) => o.kind === 'pot');
  const plant = plantSeed(s, pot, 'ditch');
  return { s, pot, plant };
}

/** Run until `stop(plant)`; tend(s, plant) is called every tick. */
function run(s, plant, tend, stop, maxDays = 12) {
  const max = maxDays * 24 / GH;
  for (let i = 0; i < max && !stop(plant); i++) {
    tend(s, plant);
    stepTime(s, DT);
    stepPlants(s, GH);
    stepEconomy(s, GH);
  }
}

const ideal = (s, p) => {
  if (p.moisture < 50) p.moisture = 60;
  if (p.nutrients < 50) p.nutrients = 60;
  p.ph = 6.4;
};

test('ideally tended Ditch Weed: 38-41 g at quality 38-42 in 5 days', () => {
  const { s, plant } = setup();
  const day0 = s.time.day, hour0 = s.time.hour;
  run(s, plant, ideal, (p) => p.progress >= 1);
  const days = (s.time.day - day0) + (s.time.hour - hour0) / 24;
  assert.ok(Math.abs(days - 5) < 0.6, `ripened after ${days} days`);
  assert.equal(stageOf(plant), 'ripe');
  const batch = harvestPlant(s, plant);
  assert.ok(batch.grams >= 38 && batch.grams <= 41, `grams ${batch.grams}`);
  assert.ok(batch.quality >= 38 && batch.quality <= 42, `quality ${batch.quality}`);
  assert.ok(careOf({ ticks: 0 }) === 1);
});

test('an unwatered plant dies', () => {
  const { s, plant } = setup();
  run(s, plant, () => {}, (p) => p.dead);
  assert.equal(plant.dead, true);
  assert.ok(s.events.some((e) => e.type === 'plantDied'));
});

test('neglect lowers yield and quality', () => {
  const a = setup(), b = setup();
  run(a.s, a.plant, ideal, (p) => p.progress >= 1);
  // Neglected: never fed or pH-corrected, only watered.
  run(b.s, b.plant, (s, p) => { if (p.moisture < 50) p.moisture = 60; }, (p) => p.progress >= 1 || p.dead);
  const good = harvestPlant(a.s, a.plant);
  assert.ok(b.plant.dead || stageOf(b.plant) !== 'ripe' || harvestPlant(b.s, b.plant).grams < good.grams);
});

test('drying takes 24 gh then sells at full price', () => {
  const { s, plant } = setup();
  run(s, plant, ideal, (p) => p.progress >= 1);
  const batch = harvestPlant(s, plant);
  assert.equal(batch.wet, true);
  const wetPrice = pricePerGram(batch);
  batch.where = 'rack1';
  s.product.push(batch);
  for (let i = 0; i < 24 / GH + 5; i++) stepEconomy(s, GH);
  assert.equal(batch.wet, false);
  assert.ok(pricePerGram(batch) > wetPrice * 1.9);
  const cash = s.player.cash;
  const v = sellBatch(s, batch);
  assert.equal(s.player.cash, cash + v);
});

test('pH kit: left click lowers pH, right click raises it (browser-check bug)', () => {
  const { s, pot, plant } = setup();
  const p = s.player;
  p.tool = 'phkit';
  p.inv.phkit = 5;
  const aim = { aimX: pot.x * CONFIG.world.tile + 8, aimY: pot.y * CONFIG.world.tile + 8 };
  const click = (key) => {
    const inp = { left: false, right: false, up: false, down: false, sprint: false, jumpPressed: false,
      digHeld: false, placePressed: false, select: 0, ...aim, [key]: true };
    stepPlayer(s, inp, 1 / 60);
    const idle = { ...inp, tendPressed: false, placePressed: false };
    for (let i = 0; i < 600 && p.action; i++) stepPlayer(s, idle, 1 / 60);
  };
  plant.ph = 7.0;
  click('tendPressed');
  assert.ok(Math.abs(plant.ph - (7.0 - CONFIG.plants.phDose)) < 1e-9, `left click should lower pH, got ${plant.ph}`);
  click('placePressed');
  assert.ok(Math.abs(plant.ph - 7.0) < 1e-9, `right click should raise pH back, got ${plant.ph}`);
  assert.equal(p.inv.phkit, 3, 'each adjustment uses one dose');
});
