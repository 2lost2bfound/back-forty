// allies.test.js — M9: friendship from favors/gifts/drinks, calling allies,
// ally combat and healing, the four ways it goes wrong (hurt, killed,
// arrested, estranged), Benny's loan, and 4-heart allies on their own.
import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { createRng } from '../src/rng.js';
import { newGame, addObject, serializeState, deserializeState } from '../src/state.js';
import { stepSim, skipDays } from '../src/sim/sim.js';
import { hs, searchLot } from '../src/sim/heat.js';
import { createPlant, careOf } from '../src/sim/plants.js';
import { shopStock, buyItem, nowGh } from '../src/sim/economy.js';
import { tt, spawnThieves, breakInChance } from '../src/sim/threats.js';
import { crewOf } from '../src/sim/crew.js';
import { sleepStart } from '../src/sim/time.js';
import { addOf, useSubstance, tendMult } from '../src/sim/addiction.js';
import { hurtPlayer } from '../src/entities/combat.js';
import {
  ALLY_KEYS, allyOf, alOf, hearts, gain, giftOptions, giveGift, drinkTogether, acceptFavor, completeFavor,
  callAlly, canCall, arrivalSeconds, strikeAlly, reviveAlly, payBill, bailAlly, leaveInJail, answerLoan,
  shopBlocked, priceMult, pickFlowers, spotsNow, describeFavor,
} from '../src/sim/allies.js';

const A = CONFIG.allies;
const G = A.gains;
const TS = CONFIG.world.tile;
const DT = 1 / CONFIG.loop.simHz;

function at(s, day, hour) {
  s.time.day = day; s.time.hour = hour;
  hs(s).lastHour = hour; tt(s).lastHour = hour; crewOf(s).lastHour = hour; alOf(s).lastHour = hour;
}
function game(seed = 7) {
  const s = newGame(seed);
  s.player.cash = 100000;
  s.heat = 0;
  at(s, 20, 12);
  return s;
}
const run = (s, ticks) => { for (let i = 0; i < ticks; i++) stepSim(s, DT); };
const setPts = (s, id, n) => { const a = allyOf(s, id); a.pts = n; a.peakPts = Math.max(a.peakPts, n); return a; };
const entOf = (s, id) => s.entities.find((e) => e.kind === 'ally' && e.ally === id);
/** Call an ally and step until they stand on the lot. */
function summon(s, id, pts = 60) {
  setPts(s, id, pts);
  const r = callAlly(s, id);
  assert.ok(r.ok, r.msg);
  run(s, Math.ceil(r.eta / DT) + 2);
  const e = entOf(s, id);
  assert.ok(e, `${id} arrived`);
  return e;
}
/** A thief that stands still at the shack door (picking a very long lock). */
function stillThief(s, hp) {
  const t = spawnThieves(s, { count: 1 })[0];
  t.x = 58 * TS; t.state = 'pickLock'; t.lockLeft = 1e9; t.armed = false;
  if (hp) t.hp = hp;
  return t;
}
/** Set the allies PRNG so its next draws satisfy pred(first, second). */
function forceDraws(s, pred) {
  for (let st = 1; st < 100000; st++) {
    const r = createRng(st);
    if (pred(r.next(), r.next())) { alOf(s).rngState = st; return; }
  }
  throw new Error('no seed found');
}
const outdoorPlant = (s, x) => {
  const pot = addObject(s, { kind: 'pot', x, y: s.surface[x] - 1, soil: 'cheap', soilPh: 6.4, plantId: null });
  const p = createPlant(s, pot, 'ditch');
  pot.plantId = p.id;
  return p;
};

// ----------------------------------------------------------- friendship --

test('gifts: loved +8, liked +5, neutral +1, disliked -3, one per ally per day', () => {
  const s = game();
  Object.assign(s.player.inv, { whiskey: 5, beer: 5, coffee: 5, bike_parts: 5, flowers: 5, crank: 5, blues: 5, wood: 25, bandage: 5 });
  const give = (id, key) => { const before = allyOf(s, id).pts; const r = giveGift(s, id, key); return { r, d: allyOf(s, id).pts - before }; };
  setPts(s, 'walt', 30);
  assert.equal(give('walt', 'whiskey').d, G.loved);
  assert.equal(give('walt', 'wood').r.ok, false, 'one gift per day');
  const nextDay = () => { s.time.day++; };
  nextDay();
  assert.equal(give('walt', 'wood').d, G.liked, 'firewood is liked');
  assert.equal(s.player.inv.wood, 15, 'firewood is 10 wood');
  nextDay();
  assert.equal(give('walt', 'crank').d, G.disliked);
  nextDay();
  assert.equal(give('walt', 'bandage').d, G.neutral);
  assert.equal(give('benny', 'beer').d, G.loved);
  nextDay();
  assert.equal(give('benny', 'bike_parts').d, G.liked);
  assert.equal(give('rosa', 'flowers').d, G.loved);
  nextDay();
  assert.equal(give('rosa', 'coffee').d, G.liked);
  nextDay();
  assert.equal(give('rosa', 'blues').d, G.disliked);
  assert.equal(give('june', 'coffee').d, G.liked);
  nextDay();
  assert.equal(give('june', 'beer').d, G.neutral);
  assert.equal(give('june', 'nothing').r.ok, false);
});

test('June loves quality 60+ bud (5 g); weaker bud is only neutral', () => {
  const s = game();
  s.product.push({ id: s.nextId++, strainName: 'Ditch Weed', quality: 50, grams: 20, wet: false, where: 'inv' });
  assert.equal(giftOptions(s, 'june').find((o) => o.key === 'bud'), undefined);
  const good = { id: s.nextId++, strainName: 'Blue Haze', quality: 70, grams: 20, wet: false, where: 'inv' };
  s.product.push(good);
  assert.equal(giftOptions(s, 'june').find((o) => o.key === 'bud').react, 'loved');
  assert.equal(giveGift(s, 'june', 'bud').ok, true);
  assert.equal(allyOf(s, 'june').pts, G.loved);
  assert.equal(good.grams, 15);
});

test('drinking together +3 and costs a Booze use; Booze makes gains x1.5', () => {
  const s = game();
  const before = addOf(s).subs.booze.d;
  assert.ok(drinkTogether(s, 'walt').ok);
  assert.equal(allyOf(s, 'walt').pts, G.drink);
  assert.ok(addOf(s).subs.booze.d > before, 'a Booze use');
  assert.equal(drinkTogether(s, 'walt').ok, false, 'once a day');
  // The buzz is still on: the next gift counts x1.5.
  s.player.inv.whiskey = 1;
  giveGift(s, 'walt', 'whiskey');
  assert.equal(allyOf(s, 'walt').pts, G.drink + G.loved * 1.5);
});

test('favors: one offered per ally every 3 days, +12 and -1 heat, four kinds', () => {
  const s = game();
  run(s, 2);
  for (const id of ALLY_KEYS) assert.ok(allyOf(s, id).favor, `${id} offers a favor`);
  const a = allyOf(s, 'june');
  const first = a.favor;
  assert.ok(describeFavor('june', first));
  assert.equal(completeFavor(s, 'june').ok, false, 'must accept first');
  a.nextFavorAt = nowGh(s) + 1000;

  // fetch
  a.favor = { kind: 'fetch', since: nowGh(s), accepted: false };
  assert.ok(acceptFavor(s, 'june').ok);
  assert.equal(completeFavor(s, 'june').ok, false, 'no item yet');
  s.player.inv[A.favors.fetch.june] = 1;
  s.heat = 10;
  hs(s).floor = 0;
  assert.ok(completeFavor(s, 'june').ok);
  assert.equal(a.pts, G.favor);
  assert.equal(s.heat, 9, '-1 heat');
  assert.equal(a.favor, null);

  // deliver a package across town
  a.favor = { kind: 'deliver', since: nowGh(s), accepted: false };
  acceptFavor(s, 'june');
  assert.equal(s.player.inv.package, 1);
  s.player.x = A.defs.june.deliverTo * TS;
  run(s, 1);
  assert.equal(a.pts, 2 * G.favor, 'delivering is automatic');
  assert.equal(s.player.inv.package, 0);

  // walk them home at night
  a.favor = { kind: 'walk', since: nowGh(s), accepted: false };
  acceptFavor(s, 'june');
  s.player.x = A.defs.june.home * TS;
  run(s, 1);
  assert.equal(a.pts, 2 * G.favor, 'not at noon');
  at(s, 20, 23);
  run(s, 1);
  assert.equal(a.pts, 3 * G.favor, 'at night');

  // fix a fence with 6 wood
  a.favor = { kind: 'fence', since: nowGh(s), accepted: false };
  acceptFavor(s, 'june');
  s.player.inv.wood = 5;
  s.player.x = 60 * TS;
  assert.equal(completeFavor(s, 'june').ok, false);
  s.player.inv.wood = 6;
  assert.ok(completeFavor(s, 'june').ok);
  assert.equal(s.player.inv.wood, 0);

  // an ignored offer lapses; the next comes 3 days after the first
  const b = allyOf(s, 'walt');
  const offered = b.favor.since;
  at(s, 20 + 3, 13);
  run(s, 2);
  assert.ok(b.favor && b.favor.since > offered, 'a new offer after 3 days');
});

test('shared history: fought beside you +10, hospital bill +15, bail +15; no contact 5 days -2 a day', () => {
  const s = game();
  const w = setPts(s, 'walt', 40);
  const e = summon(s, 'walt', 40);
  e.fought = true;
  e.state = 'leave';
  run(s, 400);
  assert.equal(entOf(s, 'walt'), undefined, 'left');
  assert.equal(w.pts, 40 + G.fought);

  const j = setPts(s, 'june', 20);
  j.status = 'hospital'; j.bill = true; j.until = nowGh(s) + 72;
  assert.ok(payBill(s, 'june').ok);
  assert.equal(j.pts, 20 + G.paidBill);
  j.status = 'jailed'; j.bailBy = nowGh(s) + 24; j.until = nowGh(s) + 144;
  assert.ok(bailAlly(s, 'june').ok);
  assert.equal(j.pts, 20 + G.paidBill + G.bail);

  const r = setPts(s, 'rosa', 30);
  r.lastContact = nowGh(s) - 6 * 24;
  at(s, s.time.day, 5.99);
  run(s, 2);
  assert.equal(r.pts, 30 + G.noContact, 'six days without contact');
  assert.equal(allyOf(s, 'benny').pts, 0, 'floor at 0');
});

test('witnessing hard-drug use costs -3 from allies close by only', () => {
  const s = game();
  setPts(s, 'walt', 50); setPts(s, 'june', 50); setPts(s, 'rosa', 50);
  s.player.inv.crank = 5;
  const e = summon(s, 'walt', 50);
  s.player.x = 100 * TS;            // nobody else is within 10 tiles
  e.x = s.player.x + 2 * TS;
  useSubstance(s, 'crank');
  stepSim(s, DT);
  assert.equal(allyOf(s, 'walt').pts, 50 + G.hardDrug, 'Walt is next to you');
  assert.equal(allyOf(s, 'june').pts, 50, 'June is at the hardware store');
  s.player.x = 252 * TS;            // June is 2 tiles away at her stall
  e.x = 100 * TS;
  useSubstance(s, 'crank');
  stepSim(s, DT);
  assert.equal(allyOf(s, 'june').pts, 50 + G.hardDrug);
  assert.equal(allyOf(s, 'rosa').pts, 50, 'Rosa is across town');
});

test('hearts 0-5 at 20 points each; allies stand at their spots and the park has flowers', () => {
  const s = game();
  const w = allyOf(s, 'walt');
  for (const [pts, h] of [[0, 0], [19, 0], [20, 1], [59, 2], [60, 3], [100, 5]]) { w.pts = pts; assert.equal(hearts(s, 'walt'), h); }
  s.time.hour = 12;
  assert.deepEqual(spotsNow(s).map((x) => x.id).sort(), ['benny', 'june', 'rosa', 'walt']);
  s.time.hour = 3;
  assert.equal(spotsNow(s).length, 0, 'asleep');
  assert.ok(pickFlowers(s).ok);
  assert.equal(s.player.inv.flowers, 1);
  assert.equal(pickFlowers(s).ok, false, 'one bunch a day');
});

// -------------------------------------------------------------- perks ----

test('perks: June -15% and Rosa half-price taper at 3 hearts, Walt warns of patrol cars, sponsor, Benny drives pots away', () => {
  const s = game();
  const seeds = () => shopStock('hardware', s).find((x) => x.key === 'seeds').price;
  const taper = () => shopStock('clinic', s).find((x) => x.key === 'taper').price;
  assert.equal(seeds(), 20); assert.equal(taper(), 100);
  setPts(s, 'june', 60); setPts(s, 'rosa', 60);
  assert.equal(seeds(), 17);
  assert.equal(taper(), 50);
  setPts(s, 'june', 59);
  assert.equal(seeds(), 20);

  // Walt
  setPts(s, 'walt', 60);
  s.patrolCar = { x: 0, dir: 1 };
  run(s, 1);
  assert.ok(s.events.some((e) => e.type === 'toast' && /Walt/.test(e.msg)));

  // Sponsor flag comes from a real 3-heart ally.
  assert.equal(addOf(s).sponsor, true);
  for (const id of ALLY_KEYS) setPts(s, id, 59);
  run(s, 1);
  assert.equal(addOf(s).sponsor, false);

  // Benny at 5 hearts: 4 pots leave before the raid.
  const plants = [];
  for (let i = 0; i < 6; i++) plants.push(outdoorPlant(s, 60 + i));
  setPts(s, 'benny', 100);
  s.events.push({ type: 'raidWarning', source: 'deputy', gh: 8 });
  run(s, 1);
  assert.equal(plants.filter((p) => p.away).length, 4);
  const found = searchLot(s, createRng(1));
  assert.equal(found.plants.length, 2, 'the search only finds the pots left behind');
  at(s, 20, 12 + 13);
  run(s, 2);
  assert.equal(plants.filter((p) => p.away).length, 0, 'brought back');
});

// ------------------------------------------------------------- calling ---

test('calling: 2+ hearts, arrival (6 - hearts) x 20 s, +20 s at night, max 2, 2-day cooldown', () => {
  const s = game();
  assert.equal(canCall(s, 'walt').ok, false, '0 hearts');
  setPts(s, 'walt', 39);
  assert.equal(canCall(s, 'walt').ok, false, '1 heart');
  setPts(s, 'walt', 40);
  assert.equal(arrivalSeconds(s, 'walt'), 80);
  for (const [pts, secs] of [[40, 80], [60, 60], [80, 40], [100, 20]]) { setPts(s, 'walt', pts); assert.equal(arrivalSeconds(s, 'walt'), secs); }
  s.time.hour = 23;
  assert.equal(arrivalSeconds(s, 'walt'), 40, 'night');
  s.time.hour = 12;

  setPts(s, 'walt', 100);
  const r = callAlly(s, 'walt');
  assert.equal(r.eta, 20);
  run(s, 38);
  assert.equal(entOf(s, 'walt'), undefined, 'not yet at 19 s');
  run(s, 3);
  assert.ok(entOf(s, 'walt'), 'there by 20 s');
  assert.equal(callAlly(s, 'walt').ok, false, 'already here');

  setPts(s, 'june', 100); setPts(s, 'benny', 100);
  assert.ok(callAlly(s, 'june').ok);
  assert.equal(callAlly(s, 'benny').ok, false, 'max 2 on the lot (one here, one on the way)... a third is refused');

  // After a fight: 2-day cooldown.
  const e = entOf(s, 'walt');
  e.fought = true; e.state = 'leave';
  run(s, 600);
  assert.equal(entOf(s, 'walt'), undefined);
  assert.equal(canCall(s, 'walt').ok, false, 'cooldown');
  assert.equal(allyOf(s, 'walt').cooldownUntil - nowGh(s) > 30, true);
  at(s, s.time.day + 2, 14);
  assert.equal(canCall(s, 'walt').ok, true);
  assert.equal(canCall(s, 'benny').ok, true, 'a slot is free again');
});

test('a call with no trouble ends after the idle time, with no cooldown', () => {
  const s = game();
  const e = summon(s, 'june', 60);
  run(s, Math.ceil(A.idleLeaveS / DT) + 400);
  assert.equal(entOf(s, 'june'), undefined);
  assert.equal(allyOf(s, 'june').cooldownUntil, 0);
  assert.ok(e);
});

// -------------------------------------------------------------- combat ---

test('Walt: rifle 40 dmg kills a thief; June: shotgun kills; Benny: bat is KO only', () => {
  for (const [id, expect] of [['walt', 'dead'], ['june', 'dead'], ['benny', 'ko']]) {
    const s = game();
    summon(s, id, 80);
    const t = stillThief(s);
    for (let i = 0; i < 600 && t.state !== expect; i++) {
      stepSim(s, DT);
      if (t.state === 'flee') { t.state = 'pickLock'; t.x = 58 * TS; } // keep it in reach; this test is about the weapon
    }
    assert.equal(t.state, expect, `${id} vs thief`);
  }
  // stats from the plan
  assert.equal(A.defs.walt.hp, 90); assert.equal(A.defs.walt.dmg, 40); assert.equal(A.defs.walt.acc, 0.8); assert.equal(A.defs.walt.speed, 70);
  assert.equal(A.defs.benny.hp, 130); assert.equal(A.defs.benny.dmg, 18); assert.equal(A.defs.benny.speed, 120);
  assert.equal(A.defs.june.hp, 70); assert.equal(A.defs.june.acc, 0.6);
  assert.equal(A.defs.rosa.hp, 60); assert.equal(A.defs.rosa.weapon, null);
});

test('allies hit as often as their accuracy says (Walt 80%)', () => {
  let hits = 0; let shots = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const s = game(seed);
    summon(s, 'walt', 100);
    const e = entOf(s, 'walt');
    const t = stillThief(s, 1e9);
    e.x = t.x + 10 * TS; s.player.x = e.x;
    for (let i = 0; i < 20; i++) {
      const hp = t.hp;
      stepSim(s, DT);
      if (e.cd > 1 / A.defs.walt.rate - 1e-9) { shots++; if (t.hp < hp) hits++; } // a shot was just taken
      t.state = 'pickLock'; t.attacked = false;
    }
  }
  assert.ok(shots > 100, `shots ${shots}`);
  assert.ok(Math.abs(hits / shots - 0.8) < 0.08, `accuracy ${hits / shots}`);
});

test('in a fight they stay within 10 tiles of you, and retreat at 25% hp', () => {
  const s = game();
  const e = summon(s, 'walt', 80);
  const t = stillThief(s, 1e9);
  s.player.x = 70 * TS;
  for (let i = 0; i < 60; i++) { stepSim(s, DT); t.state = 'pickLock'; t.attacked = false; }
  assert.ok(Math.abs(e.x - s.player.x) <= (A.followTiles + 2) * TS, `${(e.x - s.player.x) / TS} tiles away`);
  assert.ok(e.fought, 'and still fighting');
  e.hp = e.maxHp * 0.24;
  run(s, 2);
  assert.ok(e.state === 'retreat' || entOf(s, 'walt') === undefined);
  run(s, 400);
  assert.equal(entOf(s, 'walt'), undefined, 'gone');
});

test('Rosa does not fight; heals 5 hp/s within 3 tiles', () => {
  const s = game();
  const e = summon(s, 'rosa', 60);
  const t = stillThief(s);
  e.x = s.player.x + TS;
  s.player.hp = 50;
  const hp0 = t.hp;
  run(s, 4); // 2 s
  assert.ok(Math.abs(s.player.hp - 60) < 1, `healed ${s.player.hp}`);
  run(s, 60);
  assert.equal(t.hp, hp0, 'Rosa never hits anybody');
  assert.equal(t.state, 'pickLock');
});

test('allies take fire from thieves; a goon squad hits them too', () => {
  const s = game();
  const e = summon(s, 'benny', 60);
  const t = stillThief(s);
  t.armed = true; t.attacked = true; t.state = 'fight';
  e.x = t.x + 3 * TS; s.player.x = e.x;
  const hp = e.hp;
  run(s, 40);
  assert.ok(e.hp < hp || e.state === 'downed' || t.state === 'ko', 'something happened to the ally or the thief');
});

// -------------------------------------------------------- things go wrong --

test('hurt: downed at 0 hp, you hold E 5 s (60 s window) and they are up at 30 hp', () => {
  const s = game();
  const e = summon(s, 'walt', 60);
  strikeAlly(s, e, 1000, 1, false);
  assert.equal(e.state, 'downed');
  assert.equal(e.downedLeft, A.downed.windowS);
  assert.ok(addOf(s).recovery === null);
  run(s, 20);
  assert.ok(reviveAlly(s, e.id));
  assert.equal(e.state, 'defend');
  assert.equal(e.hp, A.downed.reviveHp);
});

test('hurt: ally hurt is a stress trigger for recovery cravings, a sponsor stops it', () => {
  const s = game();
  addOf(s).recovery = { start: nowGh(s) };
  const e = summon(s, 'walt', 40); // 2 hearts: not a sponsor
  strikeAlly(s, e, 1000, 1, false);
  assert.ok(addOf(s).cravingUntil > nowGh(s), 'craving');
  const t = game();
  addOf(t).recovery = { start: nowGh(t) };
  const f = summon(t, 'walt', 60); // 3 hearts: a sponsor
  strikeAlly(t, f, 1000, 1, false);
  assert.equal(addOf(t).sponsor, true);
  assert.ok(addOf(t).cravingUntil <= nowGh(t), 'no stress craving with a sponsor');
});

test('hurt: Rosa revives a downed ally in 5 s', () => {
  const s = game();
  const w = summon(s, 'walt', 60);
  const r = summon(s, 'rosa', 60);
  strikeAlly(s, w, 1000, 1, false);
  r.x = w.x + TS; s.player.x = w.x;
  run(s, 8);
  assert.equal(w.state, 'downed', 'not before 5 s');
  run(s, 6);
  assert.equal(w.state, 'defend');
  assert.ok(w.hp >= A.downed.reviveHp, 'up at 30 hp (and Rosa is healing them)');
});

test('hurt: nobody comes in 60 s, hospital for 3 days; $400 bill paid +15, unpaid -20', () => {
  for (const pay of [true, false]) {
    const s = game();
    const e = summon(s, 'june', 60);
    const a = allyOf(s, 'june');
    strikeAlly(s, e, 1000, 1, false);
    run(s, Math.ceil(A.downed.windowS / DT) + 2);
    assert.equal(a.status, 'hospital');
    assert.equal(entOf(s, 'june'), undefined);
    assert.equal(canCall(s, 'june').ok, false);
    assert.ok(Math.abs(a.until - nowGh(s) - 72) < 1, '3 days');
    const cash = s.player.cash;
    if (pay) {
      assert.ok(payBill(s, 'june').ok);
      assert.equal(s.player.cash, cash - 400);
      assert.equal(a.pts, 60 + G.paidBill);
    }
    a.until = nowGh(s);
    run(s, 2);
    assert.equal(a.status, 'ok');
    assert.equal(a.pts, pay ? 60 + G.paidBill : 60 + G.unpaidBill);
  }
});

test('hurt: Rosa gets to you in time and you skip the clinic; without her it is the clinic', () => {
  const s = game();
  const r = summon(s, 'rosa', 60);
  r.x = s.player.x + 3 * TS;
  s.player.cash = 1000;
  hurtPlayer(s, 1000, 'thief');
  assert.equal(s.player.downed, true);
  assert.equal(s.player.cash, 1000, 'no clinic penalty yet');
  run(s, 12);
  assert.equal(s.player.downed, false);
  assert.ok(s.player.hp >= A.downed.reviveHp);
  assert.equal(s.player.cash, 1000);

  const s2 = game();
  s2.player.cash = 1000;
  hurtPlayer(s2, 1000, 'thief');
  stepSim(s2, DT);
  assert.ok(s2.player.cash < 1000, 'the clinic bill and cash loss');
  assert.equal(s2.player.downed, false);
});

test('killed: a downed ally hit again by gunfire has 10%; permanent, others -10, grief x1.1 for 3 days', () => {
  const s = game();
  for (const id of ['benny', 'rosa']) setPts(s, id, 50);
  const e = summon(s, 'walt', 60);
  strikeAlly(s, e, 1000, 1, false);
  forceDraws(s, (a, b) => b >= 0.1);
  strikeAlly(s, e, 10, 1, true);
  assert.equal(allyOf(s, 'walt').status, 'ok', '90%: lives');
  assert.equal(e.state, 'downed');
  strikeAlly(s, e, 10, 1, false);
  assert.equal(allyOf(s, 'walt').status, 'ok', 'knives never kill');
  forceDraws(s, (a, b) => b < 0.1);
  const tend = tendMult(s);
  strikeAlly(s, e, 10, 1, true);
  const w = allyOf(s, 'walt');
  assert.equal(w.status, 'dead');
  assert.equal(entOf(s, 'walt'), undefined);
  assert.equal(allyOf(s, 'benny').pts, 50 + G.killedOthers);
  assert.equal(allyOf(s, 'rosa').pts, 50 + G.killedOthers);
  assert.ok(Math.abs(tendMult(s) / tend - A.grief.tendMult) < 1e-9, 'Grief');
  assert.equal(hearts(s, 'walt'), 0);
  assert.equal(canCall(s, 'walt').ok, false);
  at(s, s.time.day + 4, 12);
  assert.ok(Math.abs(tendMult(s) - tend) < 1e-9, 'grief over after 3 days');
  gain(s, w, 50);
  assert.equal(w.pts, 60, 'the dead stay as they were');
});

test('arrested: a patrol answers gunfire and an armed ally there is arrested 50%; bail $600 +15, or -40 and 6 days', () => {
  const trial = (draw, choice) => {
    const s = game();
    const e = summon(s, 'walt', 60);
    run(s, 2);
    s.cops.push({ x: 138 * TS, dir: 0, coolUntil: 0, responder: true, until: nowGh(s) + 6 });
    forceDraws(s, (a) => (draw ? a < 0.5 : a >= 0.5));
    run(s, 1);
    const w = allyOf(s, 'walt');
    if (!draw) {
      assert.equal(w.status, 'ok');
      run(s, 400);
      assert.equal(entOf(s, 'walt'), undefined, 'allies never fight police: they leave');
      return s;
    }
    assert.equal(w.status, 'jailed');
    assert.equal(entOf(s, 'walt'), undefined);
    const cash = s.player.cash;
    if (choice === 'bail') {
      assert.ok(bailAlly(s, 'walt').ok);
      assert.equal(s.player.cash, cash - A.arrest.bail);
      assert.equal(w.pts, 60 + G.bail);
      run(s, 60 * 60); // to the next dawn
      assert.equal(w.status, 'ok');
    } else {
      assert.ok(leaveInJail(s, 'walt').ok);
      assert.equal(w.pts, 60 + G.leftInJail);
      assert.equal(bailAlly(s, 'walt').ok, false);
      at(s, s.time.day + 5, 12);
      run(s, 1);
      assert.equal(w.status, 'jailed', 'still unavailable at day 5');
      at(s, s.time.day + 2, 12);
      run(s, 1);
      assert.equal(w.status, 'ok', 'back after 6 days');
    }
    assert.ok(e);
    return s;
  };
  trial(true, 'bail');
  trial(true, 'leave');
  trial(false);
});

test('a raid van arriving sends the allies away; an unattended arrest window leaves them in', () => {
  const s = game();
  summon(s, 'june', 60);
  hs(s).raid = { t: -1e6, cops: 2, path: [[100, 10]] };
  run(s, 2);
  assert.equal(entOf(s, 'june').state, 'leave');
  assert.equal(canCall(s, 'walt').ok, false);
  hs(s).raid = null;

  const j = allyOf(s, 'rosa');
  j.pts = 50; j.status = 'jailed'; j.bailBy = nowGh(s) + 1; j.until = nowGh(s) + 144; j.bailed = false; j.decided = false;
  at(s, s.time.day, s.time.hour + 2);
  run(s, 1);
  assert.equal(j.decided, true, 'auto leave-in after the bail window');
  assert.equal(j.pts, 50 + G.leftInJail);
});

test('estranged: 60+ then below 20 turns them, once; each does one hostile thing', () => {
  const turn = (id) => {
    const s = game();
    const a = setPts(s, id, 70);
    gain(s, a, -55);
    assert.equal(a.estranged, true, `${id} estranged`);
    assert.equal(a.pts, 0);
    assert.equal(hearts(s, id), 0);
    return { s, a };
  };
  // Never 60: no estrangement.
  const q = game();
  const w0 = setPts(q, 'walt', 59);
  gain(q, w0, -50);
  assert.equal(w0.estranged, false);

  let { s } = turn('walt');
  assert.equal(s.heat, 15, 'Walt reports you: +15 heat');

  ({ s } = turn('benny'));
  assert.equal(tt(s).selloutUntil >= 20 + A.hostileAct.benny.breakInDays, true);
  assert.equal(breakInChance(s).sellout, CONFIG.crew.quit.breakIn, 'break-ins +15%');
  assert.equal(alOf(s).hatchKnown, true, 'thieves find the hatch next time');

  ({ s } = turn('june'));
  assert.ok(shopBlocked(s, 'hardware'));
  assert.equal(buyItem(s, 'seeds', 'hardware').ok, false);
  at(s, 20 + 6, 12);
  assert.equal(shopBlocked(s, 'hardware'), null, 'ban is 5 days');
  assert.equal(priceMult(s, 'hardware', 'seeds'), 1.2, '+20% for 10 days');
  at(s, 20 + 11, 12);
  assert.equal(priceMult(s, 'hardware', 'seeds'), 1);

  ({ s } = turn('rosa'));
  s.time.hour = 10;
  assert.equal(buyItem(s, 'taper', 'clinic').ok, false, 'clinic refuses');
  at(s, 20 + 11, 10);
  assert.notEqual(shopBlocked(s, 'clinic'), 'x');
  assert.equal(shopBlocked(s, 'clinic'), null, 'after 10 days');
});

test('estranged: gifts are refused, favors win them back from 0, and it never repeats the hostile act', () => {
  const s = game();
  const a = setPts(s, 'walt', 70);
  gain(s, a, -60);
  s.player.inv.whiskey = 3;
  assert.equal(giveGift(s, 'walt', 'whiskey').ok, false);
  assert.equal(drinkTogether(s, 'walt').ok, false);
  const heat = s.heat;
  for (let i = 0; i < 2; i++) {
    a.favor = { kind: 'fetch', since: nowGh(s), accepted: false };
    acceptFavor(s, 'walt');
    s.player.inv[A.favors.fetch.walt] = 1;
    assert.ok(completeFavor(s, 'walt').ok);
  }
  assert.equal(a.estranged, false, '2 favors = 24 points');
  assert.ok(a.pts >= 20);
  assert.equal(giveGift(s, 'walt', 'whiskey').ok, true);
  gain(s, a, -100);
  assert.equal(a.estranged, false, 'peak was reset: not estranged at once');
  setPts(s, 'walt', 80);
  gain(s, a, -70);
  assert.equal(a.estranged, true);
  assert.ok(s.heat <= heat + 1, 'no second report');
});

test("Benny's loan: after day 15 he asks $1,000; lend +15 and 70% repaid in 10 days; refuse -15", () => {
  const ask = (day) => {
    const s = game();
    at(s, day, 5.99);
    run(s, 2);
    return s;
  };
  assert.equal(ask(15).allies.loan, null, 'not before day 16');
  const s = ask(16);
  assert.equal(s.allies.loan.status, 'asked');
  assert.ok(s.events.some((e) => e.type === 'notice' && /Benny/.test(e.title)));
  const cash = s.player.cash;
  assert.ok(answerLoan(s, true).ok);
  assert.equal(s.player.cash, cash - 1000);
  assert.equal(allyOf(s, 'benny').pts, G.loanLend);
  assert.equal(s.allies.loan.repayAt - nowGh(s), 240);
  s.allies.loan.willRepay = true;
  s.allies.loan.repayAt = nowGh(s);
  run(s, 1);
  assert.equal(s.player.cash, cash);
  assert.equal(s.allies.loan.status, 'repaid');
  s.allies.loan = { status: 'lent', repayAt: nowGh(s), willRepay: false };
  run(s, 1);
  assert.equal(s.allies.loan.status, 'defaulted');
  assert.equal(s.player.cash, cash);

  const r = ask(20);
  setPts(r, 'benny', 30);
  answerLoan(r, false);
  assert.equal(allyOf(r, 'benny').pts, 30 + G.loanRefuse);
  assert.equal(answerLoan(r, true).ok, false, 'only asked once');

  let repaid = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const g = ask(16);
    g.seed = seed; g.allies.rngState = (seed * 2654435761) >>> 0;
    answerLoan(g, true);
    if (g.allies.loan.willRepay) repaid++;
  }
  assert.ok(repaid / 300 > 0.62 && repaid / 300 < 0.78, `repay rate ${repaid / 300}`);
});

// -------------------------------------------------- 4-heart allies --------

test('4 hearts: an ally comes on their own when a dog or camera alert fires and you are away or asleep', () => {
  const alert = (s, kind) => s.events.push({ type: 'alert', kind, msg: 'x' });
  // Away in town.
  let s = game();
  setPts(s, 'walt', 80); setPts(s, 'june', 60);
  s.player.x = 250 * TS;
  alert(s, 'dog');
  run(s, 1);
  assert.equal(alOf(s).calls.length, 1, 'only the 4-heart ally');
  assert.equal(alOf(s).calls[0].id, 'walt');
  assert.ok(alOf(s).calls[0].auto);
  run(s, Math.ceil(40 / DT) + 2);
  assert.ok(entOf(s, 'walt'));

  // Asleep at home.
  s = game();
  setPts(s, 'benny', 100);
  sleepStart(s);
  alert(s, 'camera');
  run(s, 1);
  assert.equal(alOf(s).calls.length, 1);

  // Awake at home: you handle it. Tripwire: not theirs to answer.
  s = game();
  setPts(s, 'benny', 100);
  alert(s, 'camera');
  run(s, 1);
  assert.equal(alOf(s).calls.length, 0);
  s.player.x = 250 * TS;
  alert(s, 'tripwire');
  run(s, 1);
  assert.equal(alOf(s).calls.length, 0);
  // Not at 3 hearts.
  setPts(s, 'benny', 79);
  alert(s, 'dog');
  run(s, 1);
  assert.equal(alOf(s).calls.length, 0);
});

test('4 hearts: an ally waters your plants in jail or detox (care held at 0.7)', () => {
  const live = (ally) => {
    const s = game();
    const p = outdoorPlant(s, 60);
    if (ally) setPts(s, 'rosa', 80);
    at(s, 20, 10);
    skipDays(s, 2);
    return p;
  };
  const alone = live(false);
  assert.equal(alone.dead, true, 'unwatered plants die');
  const covered = live(true);
  assert.equal(covered.dead, false, 'alive after two days away');
  assert.ok(careOf(covered) <= A.coverCareCap + 0.01, `care ${careOf(covered)}`);

  // 3 hearts is not enough.
  const s = game();
  const p = outdoorPlant(s, 60);
  setPts(s, 'rosa', 79);
  skipDays(s, 2);
  assert.equal(p.dead, true);
});

test('4-heart cover also holds when the clinic or a cell takes you (bail, detox share skipDays)', () => {
  const s = game();
  const p = outdoorPlant(s, 60);
  setPts(s, 'walt', 80);
  hs(s).pendingSkip = 1;
  run(s, 1);
  assert.equal(p.dead, false);
});

// ----------------------------------------------------------------- save ---

test('allies round-trip through save/load and old saves get a fresh block', () => {
  const s = game();
  setPts(s, 'june', 66);
  allyOf(s, 'june').status = 'hospital';
  allyOf(s, 'june').until = nowGh(s) + 50;
  alOf(s).loan = { status: 'asked' };
  run(s, 2);
  const back = deserializeState(serializeState(s));
  assert.equal(allyOf(back, 'june').pts, 66);
  assert.equal(allyOf(back, 'june').status, 'hospital');
  assert.equal(back.allies.loan.status, 'asked');
  assert.equal(back.allies.rngState, s.allies.rngState);
  const old = JSON.parse(serializeState(s));
  delete old.allies;
  assert.equal(deserializeState(JSON.stringify(old)).allies.list.length, 4);
  // The sim continues identically after a reload.
  const a = deserializeState(serializeState(s));
  const b = deserializeState(serializeState(s));
  run(a, 200); run(b, 200);
  assert.equal(JSON.stringify(a.allies), JSON.stringify(b.allies));
});
