// license.test.js — M10: dirty cash vs clean bank, the farm-stand front and
// laundering, the license requirements/review/win, Legacy mode, all four lose
// conditions, difficulty, save round-trip, and the balance gate (plan §D4 M10).
import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { newGame, serializeState, deserializeState } from '../src/state.js';
import { stepSim } from '../src/sim/sim.js';
import {
  addHeat, hs, applyRaid, arrestPlayer, dailyHeat, payFine,
} from '../src/sim/heat.js';
import { buyItem, addProduct, streetSale } from '../src/sim/economy.js';
import { createPlant } from '../src/sim/plants.js';
import {
  lic, launder, launderRoom, upgradeFront, buyFront, licenseReqs, submitSample, applyLicense,
  enterLegacy, checkLose, isBroke, difficultyMult,
} from '../src/sim/license.js';
import { breakInChance, rollNight } from '../src/sim/threats.js';
import { sweep } from '../tools/balance.js';

const L = CONFIG.license;

function game(seed = 7) {
  const s = newGame(seed);
  s.player.cash = 0;
  return s;
}
const at = (s, day, hour) => { s.time.day = day; s.time.hour = hour; hs(s).lastHour = hour; };
const dry = (grams, quality) => ({ strainName: 'Widow Kush', quality, grams, wet: false, dryHoursLeft: 0, where: 'inv', rackId: null });

/** A state that satisfies every license requirement on day 40, 10:00. */
function ready(seed = 7) {
  const s = game(seed);
  at(s, 40, 10);
  s.player.bank = L.bankRequired;
  s.player.level = L.level;
  s.heat = 10;
  const l = lic(s);
  l.frontOwned = true; l.launderCap = L.front.cap; l.sampleOk = true;
  return s;
}
/** Run sim ticks until a predicate holds or `maxTicks` pass. */
function runUntil(s, pred, maxTicks = 20000) {
  for (let i = 0; i < maxTicks && !pred(s); i++) stepSim(s, 0.5);
}

// -------------------------------------------------- dirty vs clean money --

test('raids seize cash on the lot but never the bank; fines come from the bank first', () => {
  const s = game();
  s.player.cash = 4000;
  s.player.bank = 6000;
  const r = applyRaid(s, { plants: [], batches: [], containers: [], carried: true });
  assert.equal(r.cashSeized, 4000 * CONFIG.heat.raid.cashSeize);
  assert.equal(s.player.cash, 2000);
  assert.equal(s.player.bank, 6000, 'the bank is untouched by a raid');
  const f = game();
  f.player.cash = 500; f.player.bank = 300;
  const paid = payFine(f, 700);
  assert.deepEqual([f.player.bank, f.player.cash, paid.debt], [0, 100, 0], 'bank first, then cash');
  payFine(f, 400);
  assert.equal(f.player.debt, 300, 'a shortfall becomes debt');
});

test('purchases pay cash first, then bank; only dirty cash feeds flashy-spending heat', () => {
  const s = game();
  at(s, 3, 10);
  s.player.cash = 100;
  s.player.bank = 5000;
  const before = s.heat;
  assert.equal(buyItem(s, 'camera').ok, true, '$250 camera: $100 cash + $150 bank');
  assert.deepEqual([s.player.cash, s.player.bank], [0, 4850]);
  assert.equal(s.heat, before, 'bank money is clean: no flashy heat');
  s.player.cash = 2500;
  s.player.bank = 0;
  buyItem(s, 'steeldoor'); // $800
  buyItem(s, 'pistol22', 'pawn'); // dirty spend passes $2,000 only once more is spent
  buyItem(s, 'drip'); // $400
  buyItem(s, 'generator'); // $900
  assert.ok(hs(s).flashyDone || s.heat >= before, 'dirty cash over $2,000 in a day is flashy');
  assert.equal(buyItem(game(), 'camera').ok, false, 'no money at all fails');
});

test('sales pay dirty cash, not the bank', () => {
  const s = game();
  at(s, 12, 13);
  addProduct(s, dry(100, 80));
  const ped = { interested: true, asked: false };
  const cash = s.player.cash;
  streetSale(s, ped);
  assert.ok(s.player.cash > cash);
  assert.equal(s.player.bank || 0, 0);
});

// -------------------------------------------------------- the front -------

test('the $3,000 permit builds the farm stand; laundering is capped per day at a 15% fee', () => {
  const s = game();
  at(s, 20, 10);
  s.player.cash = 3000;
  assert.equal(buyItem(s, 'permit', 'townhall').ok, true);
  assert.equal(lic(s).frontOwned, true);
  assert.ok(s.objects.some((o) => o.kind === 'farmstand'), 'the stand stands on the lot road edge');
  assert.equal(s.player.cash, 0);
  assert.equal(buyItem(s, 'permit', 'townhall').ok, false, 'only one stand');

  s.player.cash = 10000;
  const a = launder(s, Infinity);
  assert.equal(a.amount, L.front.cap);
  assert.equal(s.player.bank, L.front.cap * (1 - L.front.fee), '$2,500 in, 15% fee out');
  assert.equal(s.player.cash, 10000 - L.front.cap);
  assert.equal(launder(s, 100).ok, false, 'cap reached for today');
  at(s, 21, 10);
  assert.equal(launderRoom(s), L.front.cap, 'the cap resets the next day');
  assert.equal(launder(s, 1000).amount, 1000);
});

test('the $4,000 upgrade doubles the daily cap; heat decays 1 extra per day with the front', () => {
  const s = game();
  s.player.cash = 3000;
  buyFront(s);
  assert.equal(upgradeFront(s).ok, false, 'cannot afford it yet');
  s.player.cash = 4000;
  assert.equal(upgradeFront(s).ok, true);
  assert.equal(lic(s).launderCap, L.front.upgradeCap);
  const t = game();
  t.heat = 30;
  dailyHeat(t);
  const withoutFront = t.heat;
  const u = game();
  u.heat = 30;
  lic(u).frontOwned = true;
  dailyHeat(u);
  assert.equal(withoutFront - u.heat, CONFIG.heat.farmStandDecay);
});

// ---------------------------------------------------- requirements --------

test('every license requirement blocks the application on its own', () => {
  const cases = {
    bank: (s) => { s.player.bank = L.bankRequired - 1; },
    front: (s) => { lic(s).frontOwned = false; },
    level: (s) => { s.player.level = L.level - 1; },
    sample: (s) => { lic(s).sampleOk = false; },
    heat: (s) => { s.heat = L.heatMax + 1; },
    arrest: (s) => { lic(s).lastArrestDay = s.time.day - L.arrestFreeDays; },
    debt: (s) => { s.player.debt = 50; },
  };
  for (const [name, spoil] of Object.entries(cases)) {
    const s = ready();
    spoil(s);
    const r = applyLicense(s);
    assert.equal(r.ok, false, name);
    assert.equal(lic(s).applied, null, name);
  }
  const s = ready();
  assert.equal(licenseReqs(s).every((r) => r.ok), true);
  s.time.hour = 20; // town hall closed
  assert.equal(applyLicense(s).ok, false);
  s.time.hour = 10;
  assert.equal(applyLicense(s).ok, true);
});

test('the sample needs 28 g of quality 70+ dry product', () => {
  const s = game();
  addProduct(s, dry(27, 90));
  assert.equal(submitSample(s).ok, false, 'not enough grams');
  s.product.length = 0;
  addProduct(s, dry(60, 69));
  assert.equal(submitSample(s).ok, false, 'quality too low');
  s.product.length = 0;
  addProduct(s, dry(60, 71));
  assert.equal(submitSample(s).ok, true);
  assert.equal(lic(s).sampleOk, true);
  assert.equal(s.product[0].grams, 32, '28 g handed over');
});

// ---------------------------------------------------- review and win -------

test('review: an inspector walks the lot on day 3 at 12:00, then the license is granted (win)', () => {
  const s = ready();
  s.sleeping = false;
  applyLicense(s);
  const day = s.time.day;
  const wins = [];
  let inspectorAt = null;
  for (let i = 0; i < 40000 && !s.won && !s.gameOver; i++) {
    stepSim(s, 0.5);
    s.heat = Math.min(s.heat, 10);       // keep the review clean: this test is about the timeline
    s.player.bank = Math.max(s.player.bank, L.bankRequired);
    for (const e of s.events.splice(0)) {
      if (e.type === 'inspector') inspectorAt = s.time.day * 24 + s.time.hour;
      if (e.type === 'win') wins.push(e);
    }
  }
  assert.ok(s.won, 'granted');
  assert.equal(wins.length, 1);
  assert.equal(lic(s).granted.day, s.time.day);
  assert.ok(Math.abs(inspectorAt - ((day + L.reviewDays) * 24 + L.inspectHour)) < 0.1, 'inspector at day+3, 12:00');
  assert.ok(s.time.day * 24 + s.time.hour - inspectorAt >= L.inspectGh - 0.05, 'the walk takes 60 s (2 gh)');
  assert.deepEqual(Object.keys(s.won).sort(), ['arrests', 'bank', 'day', 'fees', 'gross', 'heat', 'laundered', 'level', 'overdoses']);
});

test('review fails if heat rises, you are arrested, fines go unpaid or the bank dips', () => {
  const spikes = {
    heat: (s) => { s.heat = L.heatMax + 5; },
    arrest: (s) => { s.player.arrests = 1; lic(s).lastArrestDay = s.time.day; },
    debt: (s) => { s.player.debt = 100; },
    bank: (s) => { s.player.bank = L.bankRequired - 100; },
  };
  for (const [name, spike] of Object.entries(spikes)) {
    const s = ready();
    applyLicense(s);
    assert.ok(lic(s).applied, name);
    spike(s);
    stepSim(s, 0.5);
    assert.equal(lic(s).applied, null, `${name} rejects the application`);
    assert.equal(s.won, null);
    assert.equal(lic(s).rejections, 1);
  }
});

// -------------------------------------------------------------- Legacy ----

test('Legacy continues after the win: no heat from growing or selling; thieves and Dale remain', () => {
  const s = ready(11);
  applyLicense(s);
  s.heat = 10;
  for (let i = 0; i < 40000 && !s.won; i++) { stepSim(s, 0.5); s.heat = Math.min(s.heat, 10); s.player.bank = L.bankRequired; }
  assert.ok(s.won);
  assert.equal(s.gameOver, null, 'a win is not a game over');
  assert.equal(enterLegacy(s), true);
  assert.equal(s.legacy, true);
  assert.equal(enterLegacy(game()), false, 'no Legacy without a win');

  // Growing: 20 plants in the open would normally add visible/smell/big-grow heat.
  const pots = s.objects.filter((o) => o.kind === 'pot');
  for (let i = 0; i < 20; i++) {
    const pot = pots[i % pots.length];
    pot.plantId = null;
    const x = 70 + i;
    const extra = { id: s.nextId++, kind: 'pot', x, y: s.surface[x] - 1, soil: 'cheap', soilPh: 6.4, plantId: null };
    s.objects.push(extra);
    createPlant(s, extra, 'ditch', null);
  }
  s.heat = 10;
  dailyHeat(s);
  assert.ok(s.heat < 10, 'only decay applies');
  // Selling: no sale heat.
  s.heat = 10;
  addProduct(s, dry(200, 80));
  streetSale(s, { interested: true, asked: false });
  assert.equal(s.heat, 10, 'selling is quiet in Legacy');
  // The sim keeps running for days and thieves still roll.
  const day = s.time.day;
  s.sleeping = false;
  runUntil(s, (x) => x.time.day >= day + 3);
  assert.equal(s.gameOver, null);
  assert.ok(breakInChance(s).total >= CONFIG.threats.breakIn.min, 'thieves still roll');
  assert.equal(typeof rollNight, 'function');
});

// ------------------------------------------------------ lose conditions ----

test('lose 1, Prison: the third arrest', () => {
  const s = game();
  arrestPlayer(s, 'raid'); arrestPlayer(s, 'raid');
  assert.equal(s.gameOver, null);
  assert.equal(arrestPlayer(s, 'raid').gameOver, true);
  assert.equal(s.gameOver.reason, 'prison');
});

test('lose 2, Fugitive: an officer killed ends the run at the next 06:00', () => {
  const s = game();
  hs(s).officerKilled = true;
  at(s, 9, 5.9);
  runUntil(s, (x) => x.gameOver, 200);
  assert.equal(s.gameOver.reason, 'fugitive');
});

test('lose 3, Overdose: the third overdose', () => {
  const s = game();
  s.addiction.overdoses = CONFIG.addiction.overdose.fatal - 1;
  checkLose(s);
  assert.equal(s.gameOver, null);
  s.addiction.overdoses = CONFIG.addiction.overdose.fatal;
  checkLose(s);
  assert.equal(s.gameOver.reason, 'overdose');
});

/** Strip the run bare: no money, plants, product or seeds. */
function broke() {
  const s = game();
  s.plants.length = 0;
  s.product.length = 0;
  for (const k of ['seeds', 'seeds_blue', 'seeds_widow']) s.player.inv[k] = 0;
  s.player.cuttings = [];
  s.player.cash = 5;
  return s;
}

test('lose 4, Washed out: broke with nothing to grow for 2 days; Skeet rescues once, the second time is game over', () => {
  const s = broke();
  assert.equal(isBroke(s), true);
  at(s, 15, 10);
  runUntil(s, (x) => lic(x).rescued || x.gameOver, 4000);
  assert.equal(lic(s).rescued, true, 'the first time Skeet fronts two seeds');
  assert.equal(s.player.inv.seeds, L.washed.rescueSeeds);
  assert.equal(s.gameOver, null);
  assert.ok(s.time.day * 24 + s.time.hour >= 15 * 24 + 10 + L.washed.hours - 0.1, 'only after 2 full days');
  // Lose the seeds again: the second time is final.
  s.player.inv.seeds = 0;
  s.player.cash = 5;
  runUntil(s, (x) => x.gameOver, 4000);
  assert.equal(s.gameOver.reason, 'washedout');
});

test('washed-out clock resets when you have money, seeds, plants or product', () => {
  for (const fix of [
    (s) => { s.player.bank = 500; },
    (s) => { s.player.inv.seeds = 1; },
    (s) => { addProduct(s, dry(5, 50)); },
  ]) {
    const s = broke();
    fix(s);
    assert.equal(isBroke(s), false);
    runUntil(s, (x) => x.time.day >= 6, 4000);
    assert.equal(lic(s).rescued, false);
    assert.equal(s.gameOver, null);
  }
});

// ----------------------------------------------------------- difficulty ----

test('difficulty presets multiply heat gains and threat chances by 0.7 / 1.0 / 1.3', () => {
  const gain = (d) => { const s = newGame(3, { difficulty: d }); s.heat = 0; addHeat(s, 10, 'x'); return s.heat; };
  assert.equal(gain('relaxed'), 7);
  assert.equal(gain('standard'), 10);
  assert.equal(gain('harsh'), 13);
  const s = newGame(3, { difficulty: 'harsh' });
  assert.equal(difficultyMult(s), 1.3);
  const t = newGame(3);
  assert.ok(Math.abs(breakInChance(s).total - breakInChance(t).total * 1.3) < 1e-9);
  s.heat = 20;
  addHeat(s, -5, 'x');
  assert.equal(s.heat, 15, 'decay is not multiplied');
});

// ---------------------------------------------------------- saving ---------

test('license, Legacy, difficulty and tips survive a save; old saves load with defaults', () => {
  const s = ready(5);
  s.difficulty = 'relaxed';
  s.legacy = true;
  s.won = { day: 3 };
  s.tipsSeen = { start: true };
  const r = deserializeState(serializeState(s));
  assert.deepEqual([r.difficulty, r.legacy, r.won.day, r.tipsSeen.start], ['relaxed', true, 3, true]);
  assert.deepEqual(r.license, s.license);
  const old = JSON.parse(serializeState(s));
  for (const k of ['license', 'difficulty', 'won', 'legacy', 'tipsSeen']) delete old[k];
  const o = deserializeState(JSON.stringify(old));
  assert.equal(o.difficulty, 'standard');
  assert.equal(o.license.frontOwned, false);
  assert.equal(o.legacy, false);
});

// ------------------------------------------------------- balance gate ------

test('balance gate: standard reaches the license on day 30-50 in 6 of 10 seeds; careless is raided before day 20', { timeout: 600000 }, () => {
  const B = CONFIG.balance;
  const r = sweep();
  const rows = r.standard.map((a, i) => `${a.seed}: license ${a.licenseDay}, careless raid ${r.careless[i].firstRaidDay}`);
  console.log(rows.join('\n'));
  assert.ok(r.licenseOk >= B.needLicense, `license in ${B.licenseFrom}-${B.licenseTo} on ${r.licenseOk}/10 seeds`);
  assert.equal(r.carelessOk, B.sweepSeeds.length, 'every careless run is raided before day 20');
});
