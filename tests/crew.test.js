// crew.test.js — M6: hiring, wages and loyalty, runners (deliver, bust, late,
// robbed, skim, quit), the guard, the gardener and its 0.85 care cap.
import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { createRng } from '../src/rng.js';
import { newGame, addObject, serializeState, deserializeState } from '../src/state.js';
import { stepSim, skipDays } from '../src/sim/sim.js';
import { hs } from '../src/sim/heat.js';
import { createPlant, careOf, stageOf } from '../src/sim/plants.js';
import { nowGh, buyerLevel } from '../src/sim/economy.js';
import { tt, breakInChance, spawnThieves } from '../src/sim/threats.js';
import {
  stepCrew, crewOf, hire, fire, giveBonus, bailOut, dockPay, threaten, toggleOutgoing, boardCandidates,
  describe, runnerOdds, placeMarker,
} from '../src/sim/crew.js';

const C = CONFIG.crew;
const TS = CONFIG.world.tile;

function game(seed = 7) {
  const s = newGame(seed);
  s.player.cash = 10000;
  return s;
}
const at = (s, day, hour) => {
  s.time.day = day; s.time.hour = hour;
  hs(s).lastHour = hour; tt(s).lastHour = hour; crewOf(s).lastHour = hour;
};
/** Hire candidate #i as `role` with exact stats. */
function hireAs(s, role, stats = {}, i = 1) {
  const r = hire(s, i, role);
  assert.ok(r.ok, r.msg);
  return Object.assign(r.member, stats);
}
/** Make the crew PRNG's next draws satisfy `pred(a, b, c)` (bust, rob, late). */
function forceDraws(s, pred) {
  for (let st = 1; st < 100000; st++) {
    const r = createRng(st);
    if (pred(r.next(), r.next(), r.next())) { crewOf(s).rngState = st; return; }
  }
  throw new Error('no seed found');
}
const outgoingRack = (s, grams = 100, quality = 80) => {
  const rack = addObject(s, { kind: 'rack', x: 52, y: s.surface[52] - 1 });
  toggleOutgoing(s, rack.id);
  s.product.push({ id: s.nextId++, strainName: 'Ditch Weed', quality, grams, wet: false, where: rack.id });
  return rack;
};
/** An open Skeet order for `grams`, with Skeet at the park (13:00). */
function skeetOrder(s, grams = 20) {
  at(s, 3, 13);
  const now = nowGh(s);
  const o = { id: s.economy.nextOrderId++, buyer: 'skeet', grams, minQ: 20, issued: now, deadline: now + 24 };
  s.economy.orders.push(o);
  s.economy.buyers.skeet.nextOrderAt = now + 1000;
  return o;
}
/** Dispatch the runner, then walk the clock to his arrival and step once. */
function sendRunner(s, m) {
  stepCrew(s, 0.5);
  assert.ok(m.trip, 'runner set off');
  s.time.hour += m.trip.leg + 0.01;
  stepCrew(s, 0.5);
}

// ------------------------------------------------------------- hiring ---

test('six candidates at new game; the board shows two and rotates every 3 days', () => {
  const s = game();
  const c = crewOf(s);
  assert.equal(c.candidates.length, C.candidates);
  assert.equal(new Set(c.candidates.map((x) => x.name)).size, C.candidates);
  at(s, 1, 8);
  const a = boardCandidates(s).map((x) => x.id);
  assert.equal(a.length, C.boardVisible);
  at(s, 2, 8);
  assert.deepEqual(boardCandidates(s).map((x) => x.id), a);
  at(s, 1 + C.boardRotateDays, 8);
  assert.notDeepEqual(boardCandidates(s).map((x) => x.id), a);
});

test('you can hire up to 4, not a fifth; hired candidates leave the pool', () => {
  const s = game();
  for (let i = 1; i <= 4; i++) assert.ok(hire(s, i, 'runner').ok);
  assert.equal(hire(s, 5, 'guard').ok, false);
  assert.equal(crewOf(s).members.length, C.max);
  assert.equal(crewOf(s).candidates.length, C.candidates - 4);
  assert.equal(hire(s, 1, 'guard').ok, false, 'already hired');
  assert.equal(hire(s, 5, 'pilot').ok, false, 'no such role');
});

test('before hiring you see adjectives; after 3 days of work, the numbers', () => {
  const s = game();
  at(s, 1, 8);
  const cand = crewOf(s).candidates[0];
  cand.rel = 90; cand.disc = 20; cand.greed = 80; cand.nerve = 10;
  assert.deepEqual(describe(s, cand), { known: false, rel: 'dependable', disc: 'chatty', greed: 'hungry', nerve: 'jumpy' });
  const m = hire(s, cand.id, 'runner').member;
  assert.equal(describe(s, m).known, false);
  at(s, 1 + C.revealDays, 8);
  assert.deepEqual(describe(s, m), { known: true, rel: 90, disc: 20, greed: 80, nerve: 10 });
});

test('wages at 20:00: paid +2 loyalty, unpaid -15; $100 bonus +5 once per 3 days', () => {
  const s = game();
  const g = hireAs(s, 'guard');
  const r = hireAs(s, 'runner', {}, 2);
  at(s, 2, 19.9);
  const cash0 = s.player.cash;
  s.time.hour = 20.05;
  stepCrew(s, 0.5);
  assert.equal(s.player.cash, cash0 - C.wage.guard - C.wage.runner);
  assert.equal(g.loyalty, 52);
  at(s, 3, 19.9);
  s.player.cash = 10; s.time.hour = 20.05;
  stepCrew(s, 0.5);
  assert.equal(g.loyalty, 52 - 15);
  assert.equal(r.loyalty, 52 - 15);
  s.player.cash = 1000;
  assert.ok(giveBonus(s, g.id).ok);
  assert.equal(g.loyalty, 52 - 15 + 5);
  assert.equal(s.player.cash, 900);
  assert.equal(giveBonus(s, g.id).ok, false, 'once per 3 days');
  at(s, 3 + C.bonus.everyDays + 1, 9);
  assert.ok(giveBonus(s, g.id).ok);
});

test('a raid costs every crew member 5 loyalty; withdrawal 10 at payday', () => {
  const s = game();
  const g = hireAs(s, 'guard');
  at(s, 8, 4);
  hs(s).raid = { t: 0, cops: 4, path: [] };
  stepCrew(s, 0.5);
  stepCrew(s, 0.5);
  assert.equal(g.loyalty, 45, 'once per raid');
  hs(s).raid = null;
  hs(s).withdrawal = true;
  at(s, 8, 19.9); s.time.hour = 20.05;
  stepCrew(s, 0.5);
  assert.equal(g.loyalty, 45 + 2 - 10);
});

// ------------------------------------------------------------- runners ---

test('runner odds follow the plan formulas', () => {
  const s = game();
  const m = hireAs(s, 'runner', { disc: 60, rel: 80, greed: 10, loyalty: 50 });
  s.heat = 50;
  const o = runnerOdds(s, m, 100);
  assert.ok(Math.abs(o.bust - (1 + 5 * (1 - 60 / 150)) / 100) < 1e-9);          // 1% + (heat/10)% x (1 - Disc/150)
  assert.ok(Math.abs(runnerOdds(s, m, 250).bust - o.bust * 1.5) < 1e-9);       // x1.5 over 200 g
  assert.equal(o.rob, 0);
  assert.equal(runnerOdds(s, m, 350).rob, 0.05);                                // over 300 g
  assert.ok(Math.abs(o.late - 0.05) < 1e-9);                                    // (100 - Rel)/4 %
  assert.equal(o.skimming, false);
  m.greed = 60;                                                                 // Greed > loyalty
  assert.equal(runnerOdds(s, m, 100).skimming, true);
});

test('a runner takes product from the outgoing shelf, delivers, returns the cash and earns 5%', () => {
  const s = game();
  const m = hireAs(s, 'runner', { disc: 90, rel: 100, greed: 0 });
  const rack = outgoingRack(s, 100);
  const order = skeetOrder(s, 20);
  s.heat = 0;
  forceDraws(s, (a, b) => a > 0.5 && b > 0.5);
  const cash0 = s.player.cash;
  stepCrew(s, 0.5);
  assert.equal(order.runnerId, m.id);
  assert.equal(s.product.find((b) => b.where === rack.id).grams, 80, 'taken from the shelf');
  assert.ok(m.trip.leg > 1 && m.trip.leg < 2, `distance / 90 px/s: ${m.trip.leg}`);
  assert.equal(s.economy.orders.length, 1, 'not yet delivered');
  s.time.hour += m.trip.leg + 0.01;
  stepCrew(s, 0.5);
  assert.equal(s.economy.orders.length, 0, 'order filled');
  const pay = 20 * (CONFIG.economy.priceBase + CONFIG.economy.pricePerQuality * 80) * 0.8; // trust 0 price
  assert.ok(Math.abs(s.player.cash - cash0 - pay) < 1e-6, 'full payment (no skim)');
  assert.ok(Math.abs(m.owed - pay * C.runnerCut) < 1e-6, '5% of the delivered value');
  assert.equal(s.economy.buyers.skeet.pts, CONFIG.economy.trust.full + CONFIG.economy.trust.qualityBonus, 'on time, 20+ over the minimum');
  assert.ok(s.heatState.log.some((e) => e.label === 'Runner delivery'));
  assert.equal(s.economy.buyers.skeet.personal, undefined, 'you have not sold to him yourself');
  s.time.hour += m.trip.leg + 0.01;
  stepCrew(s, 0.5);
  assert.equal(m.trip, null, 'back home');
});

test('a runner will not leave without enough good product on an outgoing shelf', () => {
  const s = game();
  const m = hireAs(s, 'runner');
  const rack = outgoingRack(s, 100, 10);       // below the order's min quality
  skeetOrder(s, 20);
  stepCrew(s, 0.5);
  assert.equal(m.trip, null);
  rack.outgoing = false;                        // not marked
  s.product[0].quality = 80;
  stepCrew(s, 0.5);
  assert.equal(m.trip, null);
});

test('busted: product lost, +10 heat; loyalty under 40 snitches (+20 heat, search +30%); bail $800', () => {
  const s = game();
  const m = hireAs(s, 'runner', { loyalty: 30, disc: 0, rel: 100 });
  outgoingRack(s, 100);
  skeetOrder(s, 20);
  s.heat = 0;
  forceDraws(s, (a) => a < 0.005);                // under the 1% base chance
  sendRunner(s, m);
  assert.equal(m.status, 'jailed');
  assert.equal(s.product.filter((b) => b.where === 'runner:' + m.id).length, 0, 'product gone');
  assert.equal(s.economy.orders.length, 1, 'order still open, unfilled');
  const log = s.heatState.log.map((e) => e.label + ':' + e.amount);
  assert.ok(log.includes('runnerBusted:10'), log.join());
  assert.ok(log.includes('runnerSnitch:20'), log.join());
  assert.equal(hs(s).snitched, true);
  const cash = s.player.cash;
  assert.ok(bailOut(s, m.id).ok);
  assert.equal(s.player.cash, cash - 800);
  assert.equal(m.loyalty, 40, 'bail +10 loyalty');
  s.time.day += 1; s.time.hour = 6.1;               // next dawn
  stepCrew(s, 0.5);
  assert.equal(m.status, 'active', 'back next day');
});

test('a loyal runner who is busted does not snitch', () => {
  const s = game();
  const m = hireAs(s, 'runner', { loyalty: 60, disc: 0 });
  outgoingRack(s, 100);
  skeetOrder(s, 20);
  forceDraws(s, (a) => a < 0.005);
  sendRunner(s, m);
  assert.equal(m.status, 'jailed');
  assert.equal(hs(s).snitched, false);
  assert.equal(s.heat, 10);
});

test('unbailed: back after 5 days at -30 loyalty; gone for good if that leaves him under 20; crew -8', () => {
  const s = game();
  const m = hireAs(s, 'runner', { loyalty: 60 });
  const other = hireAs(s, 'guard', { loyalty: 50 }, 2);
  const m2 = hireAs(s, 'gardener', { loyalty: 40 }, 3);
  at(s, 3, 10);
  m.status = 'jailed'; m.backAt = nowGh(s) + 5 * 24;
  m2.status = 'jailed'; m2.backAt = nowGh(s) + 5 * 24;
  s.time.day += 4; stepCrew(s, 0.5);
  assert.equal(m.status, 'jailed', 'still inside after 4 days');
  s.time.day += 1; s.time.hour += 0.01; stepCrew(s, 0.5);
  assert.equal(m.status, 'active');
  assert.equal(m.loyalty, 60 - 30 - 8, 'a crewmate gone unbailed costs the others 8');
  assert.ok(!crewOf(s).members.includes(m2), 'loyalty 10 after -30: gone for good');
  assert.equal(other.loyalty, 50 - 8 * 2, 'each unbailed crewmate costs the others 8');
});

test('late runner: the order counts as late (0 trust points)', () => {
  const s = game();
  const m = hireAs(s, 'runner', { rel: 0, disc: 100 });  // (100-0)/4 = 25% late
  outgoingRack(s, 100);
  skeetOrder(s, 20);
  s.heat = 0;
  forceDraws(s, (a, b, c) => a > 0.5 && b > 0.5 && c < 0.2);
  sendRunner(s, m);
  assert.equal(s.economy.orders.length, 0, 'still delivered');
  assert.equal(s.economy.buyers.skeet.pts, CONFIG.economy.trust.late);
  assert.equal(s.economy.ledger.at(-1).text.includes('late'), true);
});

test('robbed carrying over 300 g: product gone, runner out 2 days', () => {
  const s = game();
  const m = hireAs(s, 'runner', { disc: 100 });
  outgoingRack(s, 400);
  skeetOrder(s, 350);
  s.heat = 0;
  forceDraws(s, (a, b) => a > 0.5 && b < 0.04);
  sendRunner(s, m);
  assert.equal(m.status, 'hurt');
  assert.ok(Math.abs(m.backAt - (nowGh(s) + 2 * 24)) < 1);
  assert.equal(s.economy.orders.length, 1);
  assert.equal(s.product.reduce((n, b) => n + b.grams, 0), 50, 'only the unshipped 50 g remain');
  at(s, 5, 14);
  s.time.hour = 14.1; s.time.day = 6;
  stepCrew(s, 0.5);
  assert.equal(m.status, 'active');
});

test('skimming: Greed > loyalty keeps 5-15% of each payment; ledger shows expected once you sold yourself', () => {
  const s = game();
  const m = hireAs(s, 'runner', { greed: 90, loyalty: 50, rel: 100, disc: 100 });
  outgoingRack(s, 100);
  skeetOrder(s, 20);
  s.heat = 0;
  forceDraws(s, (a, b) => a > 0.5 && b > 0.5);
  const cash0 = s.player.cash;
  sendRunner(s, m);
  const full = 20 * (4 + 8) * 0.8;
  const got = s.player.cash - cash0;
  assert.ok(got < full * 0.95 + 1e-9 && got >= full * 0.85 - 1e-9, `kept 5-15%: got ${got} of ${full}`);
  const e = s.economy.ledger.filter((x) => x.buyer === 'skeet').at(-1); // a referral line may follow the sale
  assert.ok(Math.abs(e.amount - got) < 1e-9, 'ledger shows received');
  assert.ok(Math.abs(e.expected - full) < 1e-9, 'and expected');
  assert.ok(m.skimmed > 0);
});

test('dock pay stops the skimming (-10 loyalty); threatening stops it 10 days (-20, 20% quits)', () => {
  const s = game();
  const m = hireAs(s, 'runner', { greed: 90, loyalty: 50 });
  assert.equal(runnerOdds(s, m, 10).skimming, true);
  assert.ok(dockPay(s, m.id).ok);
  assert.equal(m.loyalty, 40);
  assert.equal(runnerOdds(s, m, 10).skimming, false);
  const m2 = hireAs(s, 'runner', { greed: 90, loyalty: 50 }, 2);
  // 20% quits on the spot: force the no-quit draw first
  for (let st = 1; st < 1000; st++) { if (createRng(st).next() >= 0.2) { crewOf(s).rngState = st; break; } }
  at(s, 3, 10);
  assert.ok(threaten(s, m2.id).ok);
  assert.equal(m2.loyalty, 30);
  assert.equal(runnerOdds(s, m2, 10).skimming, false);
  at(s, 3 + 10, 10.5);
  assert.equal(runnerOdds(s, m2, 10).skimming, true, 'it starts again after 10 days');
  const m3 = hireAs(s, 'guard', { loyalty: 50 }, 3);
  for (let st = 1; st < 1000; st++) { if (createRng(st).next() < 0.2) { crewOf(s).rngState = st; break; } }
  threaten(s, m3.id);
  assert.ok(!crewOf(s).members.includes(m3), 'quit on the spot');
});

test('quitting: loyalty under 20 is 25% a day; a quitter sells you out 30% of the time', () => {
  const s = game();
  const m = hireAs(s, 'guard', { loyalty: 19 });
  const ok = hireAs(s, 'runner', { loyalty: 30 }, 2);
  at(s, 5, 5.9);
  for (let st = 1; st < 1000; st++) { if (createRng(st).next() >= 0.25) { crewOf(s).rngState = st; break; } }
  s.time.hour = 6.05; stepCrew(s, 0.5);
  assert.ok(crewOf(s).members.includes(m), 'survived the 25% roll');
  at(s, 6, 5.9);
  for (let st = 1; st < 1000; st++) {
    const r = createRng(st);
    if (r.next() < 0.25 && r.next() < 0.3 && r.next() < 0.5) { crewOf(s).rngState = st; break; }
  }
  const agg0 = tt(s).rival.aggression;
  s.time.hour = 6.05; stepCrew(s, 0.5);
  assert.ok(!crewOf(s).members.includes(m), 'quit');
  assert.ok(crewOf(s).members.includes(ok), 'a loyal one stays');
  assert.ok(tt(s).selloutUntil > 0, 'sold you out: break-in odds up');
  assert.equal(breakInChance(s).sellout, C.quit.breakIn);
  assert.equal(tt(s).rival.aggression, agg0, 'this one chose the thieves, not Dale');
});

test('a quitter can instead defect to Dale: aggression +10', () => {
  const s = game();
  const m = hireAs(s, 'guard', { loyalty: 5 });
  at(s, 5, 5.9);
  for (let st = 1; st < 100000; st++) {
    const r = createRng(st);
    if (r.next() < 0.25 && r.next() < 0.3 && r.next() >= 0.5) { crewOf(s).rngState = st; break; }
  }
  s.time.hour = 6.05; stepCrew(s, 0.5);
  assert.ok(!crewOf(s).members.includes(m));
  assert.equal(tt(s).rival.aggression, 20);
});

// --------------------------------------------------------------- guard ---

test('an active guard sets the -20 break-in cut; a downed guard does not', () => {
  const s = game();
  assert.equal(breakInChance(s).security, 0);
  const g = hireAs(s, 'guard');
  at(s, 3, 12);
  stepCrew(s, 0.5);
  assert.equal(breakInChance(s).security, CONFIG.threats.breakIn.cut.guard);
  g.hp = 0;
  stepCrew(s, 0.5);
  assert.equal(g.status, 'hurt');
  assert.equal(breakInChance(s).security, 0);
});

test('the guard patrols between his markers and fires on a thief', () => {
  const s = game();
  const g = hireAs(s, 'guard');
  placeMarker(s, 0, 50); placeMarker(s, 1, 60);
  at(s, 6, 2);
  for (let i = 0; i < 80; i++) stepCrew(s, 0.5);
  assert.ok(g.x >= 50 * TS && g.x <= 61 * TS, `patrolling: ${g.x / TS}`);
  const [t] = spawnThieves(s, { count: 1 });
  t.x = (g.x + 6 * TS);
  t.state = 'pickLock'; t.lockLeft = 999;
  let n = 0;
  while (t.hp > 0 && n++ < 80) { stepCrew(s, 0.5); }
  assert.ok(t.hp < CONFIG.threats.thief.hp, 'the guard hit him');
  assert.ok(['ko', 'dead'].includes(t.state) || t.hp <= 0, 'and put him down');
});

// ------------------------------------------------------------ gardener ---

test('the gardener keeps up to 20 plants in range; their care is capped at 0.85', () => {
  const s = game();
  s.player.inv.nutrients = 500; s.player.inv.phkit = 500;
  hireAs(s, 'gardener');
  const plants = [];
  for (let i = 0; i < 22; i++) {
    const x = 60 + i;
    const pot = addObject(s, { kind: 'pot', x, y: s.surface[x] - 1, soil: 'cheap', soilPh: 6.4, plantId: null });
    const p = createPlant(s, pot, 'ditch');
    pot.plantId = p.id;
    plants.push(p);
  }
  const DT = 1 / CONFIG.loop.simHz;
  const ticks = 2 * 24 * 60; // two game days
  for (let i = 0; i < ticks; i++) {
    stepSim(s, DT);
    s.player.cash = 5000;
  }
  const tended = plants.slice(0, 20);
  for (const p of tended) {
    assert.ok(!p.dead, 'alive');
    assert.ok(p.moisture >= 25 && p.moisture <= 85, `moisture ${p.moisture}`);
    assert.ok(careOf(p) <= C.gardener.careCap + 1e-9, `care ${careOf(p)}`);
    assert.ok(careOf(p) > 0.8, `but close to the cap: ${careOf(p)}`);
  }
  assert.ok(plants.slice(20).every((p) => careOf(p) < 0.99 || p.dead || !p.gardened), 'the 21st/22nd are not his');
  assert.equal(plants[20].gardened, false);
  assert.equal(tended[0].gardened, true);
});

test('without a gardener the same plants dry out and die', () => {
  const s = game();
  const pot = addObject(s, { kind: 'pot', x: 50, y: s.surface[50] - 1, soil: 'cheap', soilPh: 6.4, plantId: null });
  const p = createPlant(s, pot, 'ditch');
  pot.plantId = p.id;
  for (let i = 0; i < 2 * 24 * 60; i++) stepSim(s, 0.5);
  assert.equal(p.dead, true);
});

test('a gardener tends while you are in jail (skipDays)', () => {
  const s = game();
  hireAs(s, 'gardener');
  s.player.inv.nutrients = 50; s.player.inv.phkit = 50;
  const pot = addObject(s, { kind: 'pot', x: 50, y: s.surface[50] - 1, soil: 'cheap', soilPh: 6.4, plantId: null });
  const p = createPlant(s, pot, 'ditch');
  pot.plantId = p.id;
  at(s, 2, 10);
  skipDays(s, 2);
  assert.equal(p.dead, false, 'alive after 2+ days away');
});

// ---------------------------------------------------------------- save ---

test('crew round-trips through save/load', () => {
  const s = game();
  const m = hireAs(s, 'runner', { loyalty: 33 });
  const rack = outgoingRack(s, 10);
  const back = deserializeState(serializeState(s));
  assert.equal(back.crew.members[0].name, m.name);
  assert.equal(back.crew.members[0].loyalty, 33);
  assert.equal(back.crew.candidates.length, C.candidates - 1);
  assert.equal(back.objects.find((o) => o.id === rack.id).outgoing, true);
  const old = JSON.parse(serializeState(s));
  delete old.crew;
  assert.equal(deserializeState(JSON.stringify(old)).crew.candidates.length, C.candidates, 'old saves get a fresh crew block');
});

test('fire removes a member and returns his bag to the shelf', () => {
  const s = game();
  const m = hireAs(s, 'runner', { disc: 100, rel: 100 });
  const rack = outgoingRack(s, 100);
  skeetOrder(s, 20);
  stepCrew(s, 0.5);
  assert.ok(m.trip);
  assert.ok(fire(s, m.id).ok);
  assert.equal(crewOf(s).members.length, 0);
  assert.equal(s.product.reduce((n, b) => n + (b.where === rack.id ? b.grams : 0), 0), 100);
  assert.equal(s.economy.orders[0].runnerId, null);
});
