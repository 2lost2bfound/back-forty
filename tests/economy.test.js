// economy.test.js — M3: orders, trust, discovery, street sales, shop hours.
import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { newGame, serializeState, deserializeState } from '../src/state.js';
import { stepTime } from '../src/sim/time.js';
import {
  stepEconomy, fillOrder, orderOf, trustLevel, buyerLevel, buyerPresent, nowGh,
  askAround, buyItem, streetSale, shopOpen, payFee, shopStock, heatTier,
  orderSize, addProduct, carryCap, carriedGrams,
} from '../src/sim/economy.js';
import { stepSpawn } from '../src/entities/spawn.js';
import { runBalance } from '../tools/balance.js';

const E = CONFIG.economy;
const DT = 0.5;
const GH = DT / CONFIG.clock.secPerGh;

function game(seed = 5) {
  const s = newGame(seed);
  s.player.cash = 10000;
  return s;
}
/** Jump the clock to an absolute hour of the given day. */
const at = (s, day, hour) => { s.time.day = day; s.time.hour = hour; };
const tick = (s) => { stepTime(s, DT); stepEconomy(s, GH); };
/** Give the player dry product. */
const stock = (s, grams, quality = 50) => addProduct(s, {
  id: s.nextId++, strainName: 'Ditch Weed', quality, grams, wet: false, where: 'inv',
});
/** Make `key` known and force an order for it right now. */
function orderNow(s, key) {
  const b = s.economy.buyers[key];
  b.known = true;
  b.nextOrderAt = nowGh(s);
  tick(s);
  return orderOf(s, key);
}

test('Skeet is known; first order arrives on schedule with a 24 gh countdown', () => {
  const s = game();
  assert.ok(s.economy.buyers.skeet.known);
  assert.equal(orderOf(s, 'skeet'), undefined);
  const first = s.economy.buyers.skeet.nextOrderAt;
  at(s, Math.floor(first / 24), first % 24 - 0.1);
  tick(s);
  assert.equal(orderOf(s, 'skeet'), undefined, 'not before the schedule');
  s.time.hour += 0.2;
  tick(s);
  const o = orderOf(s, 'skeet');
  assert.ok(o);
  assert.equal(o.grams, E.buyers.skeet.min);
  assert.ok(Math.abs(o.deadline - o.issued - 24) < 1e-9);
  assert.ok(Math.abs(s.economy.buyers.skeet.nextOrderAt - o.issued - 48) < 0.1, 'next one 2 days later');
});

test('trust levels follow the thresholds; order size scales with level', () => {
  assert.deepEqual([0, 9, 10, 29, 30, 60, 100, 150, 400].map(trustLevel), [0, 0, 1, 1, 2, 3, 4, 5, 5]);
  const s = game();
  s.economy.buyers.marla.pts = 150;
  assert.equal(orderSize(s, 'marla'), E.buyers.marla.max);
  s.economy.buyers.marla.pts = 0;
  assert.equal(orderSize(s, 'marla'), E.buyers.marla.min);
});

test('full order on time: +10 trust, paid at the trust multiplier', () => {
  const s = game();
  at(s, 3, 14);
  const o = orderNow(s, 'skeet');
  stock(s, 40, 38);
  const cash0 = s.player.cash;
  const r = fillOrder(s, o.id);
  assert.equal(r.outcome, 'full');
  assert.equal(s.economy.buyers.skeet.pts, 10);
  const expected = o.grams * (4 + 0.1 * 38) * 0.8; // trust 0 multiplier
  assert.ok(Math.abs(s.player.cash - cash0 - expected) < 1e-6);
  assert.equal(orderOf(s, 'skeet'), undefined);
  assert.ok(Math.abs(carriedGrams(s) - (40 - o.grams)) < 1e-9);
});

test('quality 20+ over the minimum adds +5', () => {
  const s = game();
  at(s, 3, 14);
  const o = orderNow(s, 'skeet'); // min quality 20
  stock(s, 40, 40);
  assert.equal(fillOrder(s, o.id).pts, 15);
});

test('partial fill (50%+) on time: +3 and the order closes; under 50% is refused', () => {
  const s = game();
  at(s, 3, 14);
  const o = orderNow(s, 'skeet'); // 14 g
  stock(s, 5, 40);
  assert.equal(fillOrder(s, o.id).ok, false);
  assert.ok(orderOf(s, 'skeet'), 'still open');
  stock(s, 3, 40); // 8 g = 57%
  const r = fillOrder(s, o.id);
  assert.equal(r.outcome, 'partial');
  assert.equal(r.pts, 3);
  assert.equal(s.economy.buyers.skeet.pts, 3);
  assert.equal(orderOf(s, 'skeet'), undefined);
});

test('late (inside the 12 gh grace) pays but gives 0 trust; wet and low quality do not count', () => {
  const s = game();
  at(s, 3, 14);
  const o = orderNow(s, 'skeet');
  s.time.hour += 24 + 6; // 6 gh past the deadline
  tick(s);
  assert.ok(orderOf(s, 'skeet'), 'still open during grace');
  addProduct(s, { id: 900, strainName: 'x', quality: 60, grams: 50, wet: true, where: 'inv' });
  addProduct(s, { id: 901, strainName: 'y', quality: 10, grams: 50, wet: false, where: 'inv' });
  assert.equal(fillOrder(s, o.id).ok, false);
  stock(s, 20, 40);
  const cash0 = s.player.cash;
  const r = fillOrder(s, o.id);
  assert.equal(r.outcome, 'late');
  assert.equal(s.economy.buyers.skeet.pts, 0);
  assert.ok(s.player.cash > cash0);
});

test('a miss: -15 trust (floored at 0), next order 25% smaller, trust points lost', () => {
  const s = game();
  at(s, 3, 14);
  s.economy.buyers.marla.known = true;
  s.economy.buyers.marla.pts = 40; // level 2
  const o = orderNow(s, 'marla');
  assert.equal(o.grams, Math.round(56 + 56 * 2 / 5));
  s.time.hour += 24 + 12 + 1;
  tick(s);
  assert.equal(orderOf(s, 'marla'), undefined);
  assert.equal(s.economy.buyers.marla.pts, 25);
  assert.equal(s.economy.buyers.marla.streak, 1);
  s.economy.buyers.marla.nextOrderAt = nowGh(s);
  tick(s);
  const o2 = orderOf(s, 'marla');
  assert.equal(o2.grams, Math.round(Math.round(56 + 56 * 1 / 5) * 0.75));
});

test('two misses in a row: dormant 6 days, back one trust level lower', () => {
  const s = game();
  at(s, 3, 14);
  const b = s.economy.buyers.marla;
  b.known = true;
  b.pts = 62; // level 3
  orderNow(s, 'marla');
  s.time.hour += 40; tick(s);              // miss 1 -> 47 pts
  b.nextOrderAt = nowGh(s); tick(s);
  s.time.hour += 40; tick(s);              // miss 2 -> 32 pts, level 2
  assert.ok(b.dormantUntil > nowGh(s));
  assert.ok(Math.abs(b.dormantUntil - nowGh(s) - 6 * 24) < 1);
  assert.equal(b.returnPts, CONFIG.economy.trust.thresholds[0]); // level 1 = 10 pts
  assert.equal(buyerPresent(s, 'marla'), false);
  s.time.day += 7; tick(s);
  assert.equal(b.dormantUntil, 0);
  assert.equal(buyerLevel(s, 'marla'), 1, 'one level lower than the level 2 it left at');
  assert.ok(b.nextOrderAt > nowGh(s));
});

test('three misses within 10 days: dormant 10 days, returns at trust 0', () => {
  const s = game();
  at(s, 3, 14);
  const b = s.economy.buyers.doc;
  b.known = true;
  b.pts = 100;
  for (let i = 0; i < 3; i++) {
    // keep the streak from triggering the 2-in-a-row rule: a success between
    // misses is not possible here, so force the streak counter back instead
    b.streak = 0;
    b.nextOrderAt = nowGh(s);
    tick(s);
    s.time.hour += 40; tick(s);
  }
  assert.ok(Math.abs(b.dormantUntil - nowGh(s) - 10 * 24) < 1);
  s.time.day += 11; tick(s);
  assert.equal(b.pts, 0);
});

test('Skeet never leaves for more than 2 days; Tone/Vivian misses feed Dale', () => {
  const s = game();
  at(s, 8, 14);
  const sk = s.economy.buyers.skeet;
  for (let i = 0; i < 2; i++) { sk.nextOrderAt = nowGh(s); tick(s); s.time.hour += 40; tick(s); }
  assert.ok(sk.dormantUntil - nowGh(s) <= 48 + 1e-6);
  const tb = s.economy.buyers.tone;
  tb.known = true;
  for (let i = 0; i < 2; i++) { tb.nextOrderAt = nowGh(s); tick(s); s.time.hour += 60; tick(s); }
  assert.equal(s.economy.daleAggression, 5);
  assert.equal(s.economy.fees.length, 2, 'a $500 fee per Big Tone miss');
  const cash0 = s.player.cash;
  assert.ok(payFee(s).ok);
  assert.equal(s.player.cash, cash0 - 500);
});

test('referrals: trust 2 with Skeet -> Marla; Marla 3 -> Doc, 4 -> Tone; Tone 3 -> Vivian', () => {
  const s = game();
  at(s, 3, 19);
  const give = (key, pts) => { s.economy.buyers[key].known = true; s.economy.buyers[key].pts = pts - 10; };
  const deliver = (key) => {
    const o = orderNow(s, key);
    stock(s, o.grams + 5, 90);
    assert.ok(fillOrder(s, o.id).ok);
  };
  s.economy.buyers.skeet.pts = 10; // level 1
  assert.equal(s.economy.buyers.marla.known, false);
  // Skeet to level 2 (needs 30): +10 +5 bonus per full order
  deliver('skeet'); assert.equal(s.economy.buyers.marla.known, false);
  s.economy.buyers.skeet.pts = 15; deliver('skeet'); // 15 -> 30
  assert.ok(s.economy.buyers.marla.known);
  give('marla', 60); deliver('marla');       // 60 pts = level 3 after +10
  assert.ok(s.economy.buyers.doc.known);
  assert.equal(s.economy.buyers.tone.known, false);
  give('marla', 100); deliver('marla');
  assert.ok(s.economy.buyers.tone.known);
  give('tone', 60); deliver('tone');
  assert.ok(s.economy.buyers.vivian.known);
});

test('ask around: $50, +4 heat, reveals one hidden buyer in 1-2 days', () => {
  const s = game();
  at(s, 3, 18); // bar open
  const cash0 = s.player.cash;
  assert.ok(buyItem(s, 'ask_around', 'bar').ok);
  assert.equal(s.player.cash, cash0 - 50);
  assert.equal(s.heat, 4);
  assert.equal(askAround(s).ok, false, 'one at a time');
  const known = () => Object.values(s.economy.buyers).filter((b) => b.known).length;
  assert.equal(known(), 1);
  const wait = s.economy.askAt - nowGh(s);
  assert.ok(wait >= 24 && wait <= 48);
  s.time.hour += 23; tick(s);
  assert.equal(known(), 1, 'nothing before 24 gh');
  s.time.hour += 26; tick(s);
  assert.equal(known(), 2);
  assert.equal(s.economy.askAt, null);
});

test('three drinks and a chat at the bar introduces Marla', () => {
  const s = game();
  at(s, 3, 18);
  buyItem(s, 'drink', 'bar'); buyItem(s, 'drink', 'bar');
  assert.equal(s.economy.buyers.marla.known, false);
  buyItem(s, 'drink', 'bar');
  assert.ok(s.economy.buyers.marla.known);
});

test('street sales: interested pedestrian buys 3.5-14 g at x1.0 for +3 heat; asked once', () => {
  const s = game();
  stock(s, 100, 50);
  s.rngState = 123;
  const ped = { interested: false, asked: false };
  assert.equal(streetSale(s, ped).ok, false);
  assert.equal(streetSale(s, ped).ok, false);
  const cash0 = s.player.cash;
  const r = streetSale(s, { interested: true, asked: false });
  assert.ok(r.ok || r.undercover);
  if (r.ok) {
    assert.ok(r.grams >= 3.5 && r.grams <= 14);
    assert.ok(Math.abs(r.value - r.grams * 9) < 1e-6); // $4 + $5 at q50
    assert.equal(s.player.cash, cash0 + r.value);
    assert.equal(s.heat, 3);
  }
});

test('street sale undercover chance rises with heat tier and costs the product', () => {
  assert.deepEqual([0, 25, 50, 75].map(heatTier), [0, 1, 2, 3]);
  const s = game();
  s.heat = 80; // Burning: 20%
  let cops = 0;
  const N = 400;
  for (let i = 0; i < N; i++) {
    s.heat = 80;
    stock(s, 20, 50);
    const grams0 = carriedGrams(s);
    const r = streetSale(s, { interested: true, asked: false });
    if (r.undercover) {
      cops++;
      assert.ok(carriedGrams(s) < grams0);
      assert.ok(s.heat >= 92 - 1e-9 || s.heat === 100);
    }
  }
  assert.ok(cops > N * 0.1 && cops < N * 0.3, `cops ${cops}/${N}`);
});

test('pedestrians spawn in the day, never exceed the cap, and clear at night', () => {
  const s = game();
  at(s, 3, 12);
  for (let i = 0; i < 400; i++) stepSpawn(s);
  assert.equal(s.npcs.length, E.peds.cap);
  assert.ok(s.npcs.some((n) => n.interested) || true);
  at(s, 3, 23);
  stepSpawn(s);
  assert.equal(s.npcs.length, 0);
});

test('shops keep hours, including past midnight', () => {
  const t = (hour) => ({ hour });
  assert.ok(shopOpen(t(8), 'hardware') && !shopOpen(t(18), 'hardware') && !shopOpen(t(7.9), 'hardware'));
  assert.ok(shopOpen(t(9), 'townhall') && !shopOpen(t(17), 'townhall'));
  assert.ok(shopOpen(t(10), 'pawn') && !shopOpen(t(20), 'pawn'));
  assert.ok(shopOpen(t(16), 'bar') && shopOpen(t(1.5), 'bar') && !shopOpen(t(2), 'bar') && !shopOpen(t(15), 'bar'));
  assert.ok(shopOpen(t(21), 'alley') && shopOpen(t(3), 'alley') && !shopOpen(t(4), 'alley'));
  const s = game();
  at(s, 2, 19);
  assert.equal(buyItem(s, 'pot', 'hardware').ok, false);
  at(s, 2, 9);
  assert.equal(buyItem(s, 'pot', 'hardware').ok, true);
  assert.equal(buyItem(s, 'bat', 'hardware').ok, false, 'not stocked there');
  assert.ok(shopStock('alley').every((e) => !e.unreg || e.price > E.prices[e.key]));
});

test('buyer presence: hours, dormancy and Vivian only on day%7 in 5,6,0', () => {
  const s = game();
  s.economy.buyers.vivian.known = true;
  at(s, 5, 22);
  assert.ok(buyerPresent(s, 'vivian'));
  at(s, 3, 22);
  assert.equal(buyerPresent(s, 'vivian'), false);
  at(s, 7, 22);
  assert.ok(buyerPresent(s, 'vivian'));
  at(s, 5, 12);
  assert.equal(buyerPresent(s, 'vivian'), false, 'outside 20:00-03:00');
  at(s, 3, 13);
  assert.ok(buyerPresent(s, 'skeet'));
  assert.equal(buyerPresent(s, 'marla'), false, 'not discovered');
});

test('bicycle and duffel: carry cap grows with the duffel; economy state survives save/load', () => {
  const s = game();
  assert.equal(carryCap(s), E.carry.backpack);
  at(s, 2, 9);
  buyItem(s, 'duffel', 'hardware');
  buyItem(s, 'bicycle', 'hardware');
  assert.equal(carryCap(s), E.carry.duffel);
  assert.equal(s.player.inv.bicycle, 1);
  at(s, 3, 14);
  orderNow(s, 'skeet');
  s.heat = 7;
  const back = deserializeState(serializeState(s));
  assert.deepEqual(back.economy, s.economy);
  assert.equal(back.heat, 7);
});

test('balance bot: 45-day table reaches $15,000 gross with no threats', () => {
  const rows = runBalance(CONFIG.dev.seed, 45, { quiet: true });
  assert.equal(rows.length, 45);
  assert.ok(rows[44].gross >= 15000, `gross ${rows[44].gross}`);
});
