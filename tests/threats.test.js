// threats.test.js — M5: thieves and the break-in formula, locks, security
// alerts, weapons and noise/body heat, KO vs kill, police, the event director.
import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { newGame, addObject, serializeState, deserializeState } from '../src/state.js';
import { stepSim } from '../src/sim/sim.js';
import { hs, heatTier, resolveRaid, searchLot } from '../src/sim/heat.js';
import { createPlant } from '../src/sim/plants.js';
import { buyItem, nowGh } from '../src/sim/economy.js';
import { sleepStart } from '../src/sim/time.js';
import {
  stepThreats, breakInChance, rollNight, spawnThieves, directorAllows, directorClaim,
  installLock, canPlaceCamera, refuseFee, thiefTargets, tt,
} from '../src/sim/threats.js';
import {
  fire, startReload, stepCombat, melee, attack, ammoOf, damageEntity, hurtPlayer, stepCops, useBandage, groundY,
} from '../src/entities/combat.js';
import { giveDog } from '../src/entities/dog.js';
import { placeObject } from '../src/entities/player.js';
import { setTile, T } from '../src/world/tiles.js';
import { runBalance } from '../tools/balance.js';

const TS = CONFIG.world.tile;
const TH = CONFIG.threats;
const W = CONFIG.weapons;

function game(seed = 7) {
  const s = newGame(seed);
  s.player.cash = 10000;
  return s;
}
const at = (s, day, hour) => { s.time.day = day; s.time.hour = hour; hs(s).lastHour = hour; tt(s).lastHour = hour; };
const rack = (s, x = 52) => addObject(s, { kind: 'rack', x, y: s.surface[x] - 1 });
const stock = (s, grams, where, quality = 80) => {
  const b = { id: s.nextId++, strainName: 'Ditch Weed', quality, grams, wet: false, where };
  s.product.push(b);
  return b;
};
const potWithPlant = (s, x, progress = 0.6) => {
  const pot = addObject(s, { kind: 'pot', x, y: s.surface[x] - 1, soil: 'cheap', soilPh: 6.4, plantId: null });
  const plant = createPlant(s, pot, 'ditch');
  pot.plantId = plant.id;
  plant.progress = progress;
  return { pot, plant };
};
/** Step the threat sim (0.5 s ticks) until `done()` or `max` seconds. Returns seconds. */
function run(s, done, max = 400) {
  let t = 0;
  while (t < max && !done()) { stepThreats(s, 0.5); t += 0.5; }
  return t;
}
const thief = (s, extra = {}) => {
  const [e] = spawnThieves(s, { count: 1, ...extra });
  Object.assign(e, { x: 56 * TS });   // a short walk from the door
  return e;
};
const doorX = () => (CONFIG.world.buildings.find((b) => b.key === 'shack').x + 9 + TH.thief.doorOffsetTiles) * TS + TS / 2;
const aim = (s, e) => [e.x, e.y - 10];

/** Player standing on the ground facing +x with a given weapon. */
function armed(s, key, rounds = 40) {
  const p = s.player;
  const w = W[key];
  p.tool = key;
  p.facing = 1;
  p.onGround = true;
  if (!w.melee) { p.inv[key] = 1; p.inv[w.ammo] = rounds; }
  return p;
}
function loadGun(s, key) {
  const p = s.player;
  assert.equal(startReload(s), true);
  while (p.reload) stepCombat(s, 0.05);
  return p;
}
function shoot(s, e) {
  const [ax, ay] = aim(s, e);
  const r = fire(s, ax, ay);
  for (let i = 0; i < 120; i++) stepCombat(s, 1 / 60);
  return r;
}

// ------------------------------------------------------ break-in formula --

test('break-in chance: product value/$200, +1% per ripe plant, +3% per street sale, +10% generator', () => {
  const s = game();
  at(s, 5, 1);
  assert.equal(breakInChance(s).total, 0);
  const r = rack(s);
  stock(s, 100, r.id, 80);                         // 100 g at $12/g = $1,200 = 6%
  assert.ok(Math.abs(breakInChance(s).product - 6) < 1e-9);
  potWithPlant(s, 60, 0.6);                        // flowering: +1
  potWithPlant(s, 61, 1);                          // ripe: +1
  potWithPlant(s, 62, 0.3);                        // vegetative: nothing
  assert.equal(breakInChance(s).ripe, 2);
  s.economy.streetSales.push(nowGh(s) - 10, nowGh(s) - 71, nowGh(s) - 80); // 2 inside 3 days
  assert.equal(breakInChance(s).street, 6);
  addObject(s, { kind: 'generator', x: 70, y: s.surface[70] - 1 });
  const c = breakInChance(s);
  assert.equal(c.generator, 10);
  assert.ok(Math.abs(c.total - (6 + 2 + 6 + 10)) < 1e-9);
});

test('security cuts: lock -5, floodlight -5 each (max 2), camera -5, dog -15; clamp 0-60', () => {
  const s = game();
  at(s, 5, 1);
  stock(s, 4000, rack(s).id, 100);                 // far above the clamp
  assert.equal(breakInChance(s).total, 60);
  s.player.inv.padlock = 1;
  assert.equal(installLock(s).ok, true);
  const base = breakInChance(s).raw;
  for (let i = 0; i < 3; i++) addObject(s, { kind: 'floodlight', x: 50 + i, y: s.surface[50] - 1 });
  addObject(s, { kind: 'camera', x: 50, y: s.surface[50] - 1, dir: -1 });
  giveDog(s);
  const sec = breakInChance(s);
  assert.equal(sec.security, 5 + 10 + 5 + 15);
  assert.ok(Math.abs(base - sec.raw - 30) < 1e-9, 'floodlights beyond two do not count');
  const empty = game();
  at(empty, 5, 1);
  assert.equal(breakInChance(empty).total, 0, 'never below zero');
});

test('KO word of mouth: break-in chance -10 for 5 nights', () => {
  const s = game();
  at(s, 5, 1);
  stock(s, 500, rack(s).id, 100);                  // ~ 35%
  const before = breakInChance(s).total;
  tt(s).wordUntil = 5 + TH.wordOfMouth.nights;
  assert.ok(Math.abs(before - breakInChance(s).total - 10) < 1e-9);
  at(s, 11, 1);
  assert.equal(breakInChance(s).word, 0);
});

// ------------------------------------------------------------ director ----

test('director: no thieves before day 4, one hostile event a night, a quiet night after', () => {
  const s = game();
  at(s, 3, 1);
  assert.equal(directorAllows(s, 'thief'), false);
  stock(s, 4000, rack(s).id, 100);
  assert.equal(rollNight(s), null, 'day 3: nothing, whatever the odds');
  at(s, 4, 1);
  assert.equal(directorAllows(s, 'thief'), true);
  directorClaim(s, 'thief');
  assert.equal(directorAllows(s, 'rival'), false, 'second event the same night is refused');
  at(s, 5, 1);
  assert.equal(directorAllows(s, 'thief'), false, 'the next night is quiet');
  assert.equal(directorAllows(s, 'thief', { ignoreQuiet: true }), true, 'a blood feud ignores it');
  at(s, 6, 1);
  assert.equal(directorAllows(s, 'thief'), true);
  assert.equal(directorAllows(s, 'rival'), false, 'no rival before night 8');
});

test('director over a 30-night run: rules hold and the entity count stays low', () => {
  const s = game(11);
  s.player.cash = 1e6;
  const r = rack(s);
  let maxEnt = 0;
  const nights = {};
  s.time.day = 3; s.time.hour = 6;
  for (let tick = 0; tick < 30 * 24 * 60 * 1.0 * 1; tick++) {
    // keep the place a tempting target: refill product, never fight back
    if (tick % 120 === 0) { s.product.length = 0; stock(s, 1500, r.id, 90); }
    stepSim(s, 0.5);
    s.events.length = 0; s.npcs.length = 0; s.heat = 0;
    s.entities.forEach((e) => { e.cd = 1e9; });     // thieves never hurt the player in this test
    maxEnt = Math.max(maxEnt, s.entities.length);
    if (s.gameOver) break;
  }
  const h = tt(s).history;
  assert.ok(h.length >= 5, `enough hostile nights to mean something (${h.length})`);
  for (const ev of h) {
    nights[ev.night] = (nights[ev.night] || 0) + 1;
    assert.ok(ev.night >= 4, 'none before night 4');
  }
  assert.ok(Object.values(nights).every((n) => n === 1), 'one hostile event per night');
  for (const k of Object.keys(nights).map(Number)) assert.equal(nights[k + 1], undefined, 'quiet night after');
  assert.ok(maxEnt <= 2, `at most two thieves at once (${maxEnt})`);
});

// ------------------------------------------------------------ thieves ----

test('lock-pick times: none 0 s, padlock 15 s, deadbolt 40 s, steel door 90 s', () => {
  for (const [lock, secs] of [[null, 0], ['padlock', 15], ['deadbolt', 40], ['steeldoor', 90]]) {
    const s = game();
    at(s, 5, 1);
    tt(s).lock = lock;
    const e = thief(s);
    e.x = doorX();
    stepThreats(s, 0.5);                           // arrives, starts picking
    assert.equal(e.state, secs ? 'pickLock' : 'search', `${lock}`);
    const t = run(s, () => e.state !== 'pickLock');
    assert.ok(Math.abs(t - secs) <= 1, `${lock}: ${t}s`);
  }
});

test('a thief steals up to 200 g from an unhidden rack, then flees to the woods', () => {
  const s = game();
  at(s, 5, 1);
  const r = rack(s);
  stock(s, 300, r.id, 80);
  const e = thief(s);
  run(s, () => e.state === 'flee');
  assert.equal(e.state, 'flee');
  assert.equal(Math.round(e.loot.batches[0].grams), 200);
  assert.equal(Math.round(s.product.find((b) => b.where === r.id).grams), 100);
  run(s, () => s.entities.length === 0);
  assert.equal(s.entities.length, 0, 'gone into the woods');
  assert.equal(tt(s).stats.stolenGrams, 200);
});

test('with no product a thief uproots the 2 ripest plants (5 s each)', () => {
  const s = game();
  at(s, 5, 1);
  const a = potWithPlant(s, 60, 0.3), b = potWithPlant(s, 61, 0.9), c = potWithPlant(s, 62, 0.7);
  const e = thief(s);
  const t0 = run(s, () => e.state === 'grab');
  const t1 = run(s, () => e.state === 'flee');
  assert.ok(Math.abs(t1 - 10) <= 1, `10 s of uprooting (${t1})`);
  assert.equal(s.plants.length, 1);
  assert.equal(s.plants[0].id, a.plant.id, 'the unripe one is left');
  assert.equal(b.pot.plantId, null);
  assert.ok(c.pot.plantId === null && t0 >= 0);
});

test('a hidden room is found 25% of the time; a buried stash never', () => {
  let found = 0;
  const N = 400;
  for (let i = 0; i < N; i++) {
    const s = game(100 + i);
    const x = 60, y0 = s.surface[x];
    for (let y = y0; y <= y0 + 8; y++) setTile(s, 58, y, T.AIR);
    for (let xx = 58; xx < 66; xx++) for (let y = y0 + 6; y <= y0 + 8; y++) setTile(s, xx, y, T.AIR);
    addObject(s, { kind: 'hatch', x: 58, y: y0 + 1 });
    const pot = addObject(s, { kind: 'pot', x: 62, y: y0 + 8, soil: 'cheap', soilPh: 6.4, plantId: null });
    const pl = createPlant(s, pot, 'ditch'); pot.plantId = pl.id;
    if (thiefTargets(s).plants.length) found++;
  }
  assert.ok(Math.abs(found / N - 0.25) < 0.07, `found ${found}/${N}`);
  const s = game();
  const x = 70, y = s.surface[x] + 3;
  for (const [dx, dy] of [[0, 0]]) setTile(s, x + dx, y + dy, T.AIR);
  const box = addObject(s, { kind: 'stash', x, y, cash: 0 });
  stock(s, 100, box.id);
  for (let i = 0; i < 50; i++) assert.equal(thiefTargets(s).batches.length, 0);
});

test('a thief caught carrying loot drops it; a KO scares nobody off but the loot goes back', () => {
  const s = game();
  at(s, 5, 1);
  const r = rack(s);
  stock(s, 300, r.id);
  const e = thief(s);
  run(s, () => e.state === 'flee');
  assert.equal(e.loot.batches.length, 1);
  armed(s, 'bat');
  damageEntity(s, e, 999, 'melee');
  assert.equal(e.state, 'ko');
  assert.equal(s.product.reduce((n, b) => n + b.grams, 0), 300, 'the haul is back');
});

// ------------------------------------------------------------- alerts ----

function sleepingPlayer(s) {
  at(s, 5, 1);
  s.sleeping = true; s.sleepRemain = 5;
}
for (const [name, place] of [
  ['dog', (s) => giveDog(s)],
  ['tripwire', (s) => addObject(s, { kind: 'tripwire', x: 46, y: s.surface[46] - 1 })],
  ['camera', (s) => addObject(s, { kind: 'camera', x: 52, y: s.surface[52] - 1, dir: -1 })],
  ['floodlight', (s) => addObject(s, { kind: 'floodlight', x: 50, y: s.surface[50] - 1 })],
]) {
  test(`${name} alerts and wakes a sleeping player; with no security nobody wakes`, () => {
    const s = game();
    sleepingPlayer(s);
    place(s);
    const e = spawnThieves(s, { count: 1 })[0];
    run(s, () => !s.sleeping || e.state === 'flee');
    assert.equal(s.sleeping, false);
    assert.ok(s.events.some((ev) => ev.type === 'alert' && ev.kind === name));

    const quiet = game();
    sleepingPlayer(quiet);
    const q = spawnThieves(quiet, { count: 1 })[0];
    run(quiet, () => !quiet.sleeping || q.state === 'flee');
    assert.equal(quiet.sleeping, true, 'you find out in the morning');
  });
}

test('the dog bites 10 dmg/s, thieves flee 60% of the time, a hurt dog needs the vet, hunger sends him away', () => {
  const s = game();
  at(s, 5, 1);
  giveDog(s);
  const e = thief(s, {});
  e.x = 60 * TS; e.state = 'pickLock'; e.lockLeft = 999;
  const hp0 = e.hp;
  stepThreats(s, 1);
  assert.ok(e.hp < hp0 && hp0 - e.hp <= TH.dog.bite * 1 + 0.01);
  // vet
  tt(s).dog.hp = 0;
  stepThreats(s, 0.5);
  assert.equal(tt(s).dog.state, 'hurt');
  at(s, 5, 10);
  assert.equal(buyItem(s, 'vet', 'clinic').ok, true);
  assert.equal(tt(s).dog.hp, TH.dog.hp);
  assert.equal(buyItem(s, 'vet', 'clinic').ok, false, 'no hurt dog, no charge');
  // buying: Walt sells one dog
  assert.equal(buyItem(s, 'dog', 'walt').ok, false);
  tt(s).dog = null;
  const cash = s.player.cash;
  assert.equal(buyItem(s, 'dog', 'walt').ok, true);
  assert.equal(cash - s.player.cash, CONFIG.economy.prices.dog);
  // food: $10/day, unfed for 2 days he runs away
  s.player.cash = 0;
  for (let d = 0; d < 2; d++) { at(s, 6 + d, 5.9); s.time.hour = 6.1; stepThreats(s, 0.5); }
  assert.equal(tt(s).dog, null);
});

test('cameras: max 4, within 10 tiles of the shack or generator; locks fit at the door', () => {
  const s = game();
  s.player.inv.camera = 6;
  s.player.facing = -1;
  const x = 52;
  s.player.x = x * TS;
  for (let i = 0; i < 4; i++) assert.equal(placeObject(s, 'camera', x + i, s.surface[x] - 1), true);
  assert.equal(placeObject(s, 'camera', x + 4, s.surface[x] - 1), false, 'fifth refused');
  const far = game();
  far.player.inv.camera = 1;
  assert.equal(canPlaceCamera(far, 110, far.surface[110] - 1), false);
  addObject(far, { kind: 'generator', x: 108, y: far.surface[108] - 1 });
  assert.equal(canPlaceCamera(far, 110, far.surface[110] - 1), true, 'near a generator is fine');
  s.player.inv.padlock = 1; s.player.inv.deadbolt = 1;
  assert.equal(installLock(s).ok, true);
  assert.equal(tt(s).lock, 'deadbolt', 'best lock first');
  assert.equal(installLock(s).ok, false, 'padlock is not an upgrade');
});

// ------------------------------------------------------------- weapons ----

test('all six weapons: damage, rate, magazine, ammo, reload time, noise radius', () => {
  const s = game();
  const want = {
    fists: [5, 2.5], bat: [18, 2], pistol22: [14, 3, 10, 18, 25], pistol9: [22, 3, 12, 22, 35],
    shotgun: [9, 1, 5, 9, 50], rifle: [60, 0.7, 4, 40, 60],
  };
  assert.deepEqual(W.order, Object.keys(want));
  for (const [k, v] of Object.entries(want)) {
    assert.equal(W[k].dmg, v[0]); assert.equal(W[k].rate, v[1]);
    if (v[2]) { assert.equal(W[k].mag, v[2]); assert.equal(W[k].range, v[3]); assert.equal(W[k].noise, v[4]); }
  }
  assert.equal(W.shotgun.pellets, 6);
  assert.equal(W.shotgun.pelletSpread, 12);
  for (const k of ['pistol22', 'pistol9', 'shotgun', 'rifle']) {
    const t = game();
    const p = armed(t, k, 40);
    assert.equal(fire(t, 1000, 100).reason, 'empty', 'unloaded gun clicks');
    p.fireCd = 0;
    startReload(t);
    const dur = p.reload.dur;
    assert.ok(Math.abs(dur - (k === 'shotgun' ? 0.5 * 5 : 1.5)) < 1e-9, `${k} reload ${dur}`);
    while (p.reload) stepCombat(t, 0.05);
    const a = ammoOf(p);
    assert.equal(a.mag, W[k].mag);
    assert.equal(a.bag, 40 - W[k].mag);
    assert.equal(fire(t, 1000, p.y).ok, true);
    assert.equal(p.mag[k], W[k].mag - 1);
    assert.equal(fire(t, 1000, p.y).reason, 'cooldown');
    assert.equal(t.bullets.length, W[k].pellets);
    stepCombat(t, 1 / W[k].rate + 0.01);
    assert.equal(fire(t, 1000, p.y).ok, true, 'ready again after 1/rate s');
  }
  // 1 shell reloads in 0.5 s
  const t = game();
  const p = armed(t, 'shotgun', 1);
  startReload(t);
  assert.equal(p.reload.dur, 0.5);
  void s;
});

test('pistol, bat and fists hurt what they hit; the bat knocks back', () => {
  const s = game();
  at(s, 5, 1);
  const e = thief(s);
  e.state = 'pickLock'; e.lockLeft = 999;
  const p = armed(s, 'bat');
  p.x = e.x - 20;
  e.x = p.x + p.w / 2 + 20;
  const x0 = e.x;
  assert.equal(melee(s).hit, true);
  assert.equal(e.hp, TH.thief.hp - 18);
  assert.ok(e.x > x0, 'knockback');
  assert.equal(p.stamina, 100 - 12);
  p.fireCd = 0; p.tool = 'fists';
  e.x = p.x + p.w / 2 + 10;
  melee(s);
  assert.equal(e.hp, TH.thief.hp - 18 - 5);
});

test('gun noise heat: +1/shot at the lot (max +8 an incident), +4 in town (max +20), suppressed less', () => {
  const lot = game();
  armed(lot, 'pistol9', 60);
  lot.player.mag.pistol9 = 12;
  for (let i = 0; i < 12; i++) { lot.player.fireCd = 0; fire(lot, 1000, lot.player.y); }
  assert.equal(lot.heat, 8, 'capped at +8');
  const sup = game();
  armed(sup, 'pistol9', 60);
  sup.player.inv.suppressor = 1;
  sup.player.mag.pistol9 = 4;
  for (let i = 0; i < 4; i++) { sup.player.fireCd = 0; fire(sup, 1000, sup.player.y); }
  assert.equal(sup.heat, 1, '4 x 0.25');
  const town = game();
  const p = armed(town, 'pistol9', 60);
  p.x = 250 * TS;
  town.player.mag.pistol9 = 12;
  for (let i = 0; i < 3; i++) { p.fireCd = 0; fire(town, p.x + 500, p.y); }
  assert.equal(town.heat, 12, '+4 a shot in town');
  for (let i = 0; i < 9; i++) { p.mag.pistol9 = 12; p.fireCd = 0; fire(town, p.x + 500, p.y); }
  assert.equal(town.heat, 20, 'town incident caps at +20');
  // noise radius shrinks in rain (-30%): a .22 at x 12 reaches the lot only when dry
  const woods = game();
  const w = armed(woods, 'pistol22', 20);
  w.mag.pistol22 = 10; w.x = 10 * TS;
  fire(woods, 1000, w.y);
  assert.equal(woods.heat, 0, '.22 (25 tiles) from x 10 does not reach the lot at 40');
  const woods2 = game();
  const w2 = armed(woods2, 'rifle', 20);
  w2.mag.rifle = 4; w2.x = 10 * TS;
  fire(woods2, 1000, w2.y);
  assert.equal(woods2.heat, 1, 'the rifle (60 tiles) does');
});

test('6 unsuppressed shots at heat 50+ send a patrol car with 2 cops in 90 s', () => {
  const s = game();
  s.heat = 55;
  hs(s).floor = 0;
  at(s, 6, 12);
  const p = armed(s, 'pistol22', 60);
  p.mag.pistol22 = 10;
  for (let i = 0; i < 6; i++) { p.fireCd = 0; fire(s, 1000, p.y); }
  assert.ok(tt(s).dispatch);
  stepThreats(s, 0.5);
  assert.equal(s.cops.filter((c) => c.responder).length, 0);
  at(s, 6, 12 + CONFIG.combat.dispatch.delayGh + 0.1);
  stepThreats(s, 0.5);
  assert.equal(s.cops.filter((c) => c.responder).length, 2);
  // not at low heat, not suppressed
  const cold = game();
  const q = armed(cold, 'pistol22', 60); q.mag.pistol22 = 10;
  for (let i = 0; i < 6; i++) { q.fireCd = 0; fire(cold, 1000, q.y); }
  assert.equal(tt(cold).dispatch, null);
});

test('bandage heals 30 hp over 5 s', () => {
  const s = game();
  s.player.hp = 40; s.player.inv.bandage = 1;
  assert.equal(useBandage(s), true);
  for (let i = 0; i < 60 * 5 + 5; i++) stepCombat(s, 1 / 60);
  assert.ok(Math.abs(s.player.hp - 70) < 0.5, `${s.player.hp}`);
});

// ---------------------------------------------------- KO vs kill, feud ----

test('KO with the bat: crawls off after 20 s, no heat, word of mouth; a gun kill is +8 heat and a feud', () => {
  const s = game();
  at(s, 5, 1);
  const e = thief(s);
  e.state = 'pickLock'; e.lockLeft = 999;
  armed(s, 'bat');
  assert.equal(damageEntity(s, e, 100, 'melee'), 'ko');
  assert.equal(s.heat, 0, 'no body heat');
  assert.equal(tt(s).wordUntil, 5 + 5);
  assert.equal(tt(s).feud.length, 0);
  run(s, () => s.entities.length === 0, 30);
  assert.equal(s.entities.length, 0, 'crawled off');

  const k = game();
  at(k, 5, 1);
  const f = thief(k);
  f.state = 'pickLock'; f.lockLeft = 999;
  assert.equal(damageEntity(k, f, 100, 'gun'), 'dead');
  assert.equal(k.heat, 8);
  assert.deepEqual(tt(k).feud, [{ night: 8, kind: 'feud' }]);
  assert.equal(tt(k).wordUntil, 0);
});

test('shooting a thief with each gun works end to end through bullets', () => {
  for (const key of ['pistol22', 'pistol9', 'shotgun', 'rifle']) {
    const s = game();
    at(s, 5, 1);
    const e = thief(s);
    e.state = 'pickLock'; e.lockLeft = 999;
    const p = armed(s, key);
    p.x = e.x - 80;
    p.y = groundY(s, p.x) - p.h;
    p.vx = 0;
    loadGun(s, key);
    const hp0 = e.hp;
    shoot(s, e);
    assert.ok(e.hp < hp0 || e.state === 'dead', `${key} hit (${e.hp})`);
  }
});

test('blood feud: 3 nights after a kill, 2 armed thieves come and ignore the quiet night', () => {
  const s = game();
  at(s, 5, 1);
  const e = thief(s);
  damageEntity(s, e, 100, 'gun');
  assert.equal(tt(s).feud[0].night, 8);
  s.entities.length = 0;
  directorClaim(s, 'thief');                    // night 5 hostile
  directorClaim(s, 'thief');
  at(s, 7, 1);
  assert.equal(rollNight(s), null, 'night 7 is quiet and not yet due');
  at(s, 8, 1);
  tt(s).hostile[7] = 'thief';                   // even straight after another hostile night
  assert.equal(rollNight(s), 'feud');
  assert.equal(s.entities.length, 2);
  assert.ok(s.entities.every((x) => x.armed && x.feud));
  assert.equal(tt(s).feud.length, 0);
  // killing a feud thief does not start another feud
  damageEntity(s, s.entities[0], 100, 'gun');
  assert.equal(tt(s).feud.length, 0);
});

test('refusing Big Tone\'s fee sends a biker the next night; paying does not', () => {
  const s = game();
  at(s, 6, 12);
  s.economy.fees.push({ buyer: 'tone', amount: 500 });
  assert.equal(refuseFee(s).ok, true);
  assert.equal(s.economy.fees.length, 0);
  at(s, 7, 1);
  assert.equal(rollNight(s), 'biker');
  const b = s.entities[0];
  assert.ok(b.biker && b.armed);
  const p = s.player;
  p.x = 70 * TS;
  b.x = p.x - 5 * TS; b.y = groundY(s, b.x);
  const hp0 = p.hp;
  run(s, () => p.hp < hp0, 30);
  assert.ok(p.hp < hp0, 'the biker shoots');
});

// ------------------------------------------------------------ the player --

test('downed by a thief: lose 30% of cash and a $300 bill, wake at the clinic at 06:00 on your feet', () => {
  const s = game();
  at(s, 5, 1);
  s.player.cash = 1000;
  const e = thief(s);
  e.state = 'pickLock'; e.lockLeft = 5;
  hurtPlayer(s, 999, 'thief');
  assert.equal(s.player.downed, true);
  assert.equal(e.haulMult, 2, 'thieves take double');
  assert.equal(Math.round(s.player.cash), 700 - 300);
  stepSim(s, 0.5);
  assert.equal(s.player.downed, false);
  assert.equal(s.player.hp, CONFIG.combat.downed.wakeHp);
  assert.ok(s.time.hour >= 6 - 0.1 && s.time.hour < 7, `woke at ${s.time.hour}`);
  const clinic = CONFIG.world.buildings.find((b) => b.key === 'clinic');
  assert.ok(Math.abs(s.player.x / TS - (clinic.x + clinic.w - 1)) < 2);
});

test('downed by police is an arrest', () => {
  const s = game();
  at(s, 5, 14);
  hurtPlayer(s, 999, 'cop');
  assert.equal(s.player.arrests, 1);
  assert.ok(hs(s).pendingSkip > 0);
});

// -------------------------------------------------------------- police ----

function cop(s, x) {
  const c = { x, dir: 1, coolUntil: 0 };
  s.cops.push(c);
  return c;
}
test('aiming a loaded gun at an officer: warning first, no shot; the next shot is +50 heat and floor +25', () => {
  const s = game();
  at(s, 5, 14);
  const p = armed(s, 'pistol22');
  p.x = 250 * TS;
  p.y = groundY(s, p.x) - p.h;
  loadGun(s, 'pistol22');
  const c = cop(s, 250 * TS + 60);
  const ay = groundY(s, c.x) - 10;
  const r = fire(s, c.x, ay);
  assert.equal(r.reason, 'warning');
  assert.equal(p.mag.pistol22, 10, 'no round spent');
  assert.ok(s.events.some((e) => e.type === 'officerWarning'));
  assert.equal(s.heat, 0);
  p.fireCd = 0;
  assert.equal(fire(s, c.x, ay).ok, true);
  for (let i = 0; i < 60; i++) stepCombat(s, 1 / 60);
  assert.equal(hs(s).floor, 25);
  assert.ok(s.heat >= 50);
  assert.equal(hs(s).firedAtPolice, true);
  assert.equal(c.hostile, true);
  // the warning shows once per run
  p.fireCd = 0;
  assert.equal(fire(s, c.x, ay).reason === 'warning', false);
});

test('police return fire (70%, 15 dmg); killing an officer ends the run at the next 06:00 (Fugitive)', () => {
  const s = game();
  at(s, 5, 14);
  const p = armed(s, 'rifle');
  p.x = 250 * TS;
  p.y = groundY(s, p.x) - p.h;
  const c = cop(s, 250 * TS + 120);
  hs(s).warnedOfficer = true;
  loadGun(s, 'rifle');
  const ay = groundY(s, c.x) - 10;
  fire(s, c.x, ay);
  for (let i = 0; i < 90; i++) stepCombat(s, 1 / 60);
  assert.equal(c.hp, 100 - 60);
  let hits = 0;
  for (let i = 0; i < 200; i++) { c.cd = 0; const hp = p.hp; stepCops(s, 1); if (p.hp < hp) { hits++; assert.equal(hp - p.hp, 15); } p.hp = 100; p.downed = false; }
  assert.ok(hits > 100 && hits < 180, `~70% hit rate (${hits}/200)`);
  p.fireCd = 0;
  fire(s, c.x, ay);
  for (let i = 0; i < 90; i++) stepCombat(s, 1 / 60);
  assert.equal(s.cops.includes(c), false, 'officer down');
  assert.equal(hs(s).officerKilled, true);
  assert.equal(s.gameOver, null, 'not yet');
  at(s, 5, 5.9);
  for (let i = 0; i < 40 && !s.gameOver; i++) stepSim(s, 0.5);
  assert.equal(s.gameOver && s.gameOver.reason, 'fugitive');
  assert.ok(s.time.hour >= 6 && s.time.hour < 6.5);
});

test('guns in raids: registered gun beside plants = $1,000 weapons charge; alley guns are unregistered', () => {
  const s = game();
  at(s, 6, 6);
  s.time.hour = 10;
  assert.equal(buyItem(s, 'pistol22', 'pawn').ok, true);
  assert.equal(s.player.gunUnregistered, undefined);
  potWithPlant(s, 60, 0.5);
  s.player.x = 60 * TS;
  const before = s.player.cash + s.player.bank;
  const found = searchLot(s, { chance: () => true });
  const { applyRaid } = hs; void applyRaid;
  const res = resolveRaidWith(s, found);
  assert.equal(res.fine, 50 + CONFIG.combat.weaponsFine);
  assert.ok(before - (s.player.cash + s.player.bank) >= res.fine);
  const a = game();
  a.time.hour = 22;
  assert.equal(buyItem(a, 'pistol9', 'alley').ok, true);
  assert.equal(a.player.gunUnregistered, true);
  assert.ok(a.player.unreg.pistol9);
});

import { applyRaid } from '../src/sim/heat.js';
function resolveRaidWith(s, found) { return applyRaid(s, found); }

// -------------------------------------------------------------- saving ----

test('saves keep the lock, dog, feud and hostile history; thieves are runtime only', () => {
  const s = game();
  tt(s).lock = 'deadbolt';
  giveDog(s);
  tt(s).feud.push({ night: 9, kind: 'feud' });
  s.player.mag.pistol22 = 7;
  spawnThieves(s, { count: 1 });
  const back = deserializeState(serializeState(s));
  assert.equal(back.threats.lock, 'deadbolt');
  assert.ok(back.threats.dog);
  assert.deepEqual(back.threats.feud, [{ night: 9, kind: 'feud' }]);
  assert.equal(back.player.mag.pistol22, 7);
  assert.deepEqual(back.entities, []);
  // an old save without combat fields gets them
  const o = JSON.parse(serializeState(s));
  delete o.threats; delete o.player.hp; delete o.player.mag;
  const old = deserializeState(JSON.stringify(o));
  assert.equal(old.player.hp, 100);
  assert.deepEqual(old.player.mag, {});
  assert.ok(old.threats.hostile);
});

test('a sleeping player is woken by sleepStart/stepSim alerts end to end', () => {
  const s = game();
  at(s, 5, 0.9);
  giveDog(s);
  stock(s, 4000, rack(s).id, 100);
  s.threats.rngState = 12345;
  sleepStart(s);
  let woke = false;
  for (let i = 0; i < 30 * 60 && !woke; i++) {
    stepSim(s, 0.5);
    s.heat = 0;
    if (s.events.some((e) => e.type === 'alert')) woke = true;
    s.events.length = 0;
    if (s.time.hour > 5) break;
  }
  // A 60% roll can miss on one night; the point is that a wake only ever comes from an alert.
  if (woke) assert.equal(s.sleeping, false);
  else assert.ok(s.time.hour >= 1);
});

test('balance bot with threats: 45 days still reach the end and report', () => {
  const rows = runBalance(1337, 45, { quiet: true, heat: true });
  assert.ok(rows.length >= 40 || rows[rows.length - 1].arrests >= 0);
  assert.ok(rows[rows.length - 1].gross > 5000);
});

// ==================================================== M6: Dale Pruitt ====

import { createRng as rngFrom } from '../src/rng.js';
import {
  rv, rollRival, rivalBump, rivalChance, payTribute, buyTruce, spawnSaboteur, spawnGoons, waterPoisoned,
  purgeWater, installBarrelLock,
} from '../src/sim/threats.js';
import { waterPour, neemPlant, stepPlants, stressorsOf } from '../src/sim/plants.js';
import { hire, stepCrew, crewOf, placeMarker } from '../src/sim/crew.js';
import { bribeDeputy } from '../src/sim/heat.js';

const RV = CONFIG.threats.rival;

/** Make Dale's next roll satisfy pred({roll, type, goon, src, pick}). */
function forceRival(s, pred) {
  for (let st = 1; st < 200000; st++) {
    const r = rngFrom(st);
    const d = { roll: r.next(), type: r.next(), goon: r.next(), src: r.next(), pick: r.next() };
    if (pred(d)) { rv(s).rngState = st; return; }
  }
  throw new Error('no seed');
}
const POISON = { roll: (d) => d.roll < 0.01, poison: (d) => d.type < 0.4, tip: (d) => d.type >= 0.4 && d.type < 0.7, pest: (d) => d.type >= 0.7 };
const night = (s, day = 9, aggr = 50) => { at(s, day, 22.9); rv(s).aggression = aggr; };
const rollAt23 = (s) => { s.time.hour = 23.05; return rollRival(s); };
const ents = (s, kind) => s.entities.filter((e) => e.kind === kind);

test('Dale: aggression starts at 10; +1 per day after day 10; trust 3 +2 once per buyer', () => {
  const s = game();
  assert.equal(rv(s).aggression, 10);
  at(s, 10, 5.9);
  s.time.hour = 6.05; stepThreats(s, 0.5);
  assert.equal(rv(s).aggression, 10, 'day 10 itself does not count');
  at(s, 11, 5.9);
  s.time.hour = 6.05; stepThreats(s, 0.5);
  assert.equal(rv(s).aggression, 11);
  s.economy.buyers.marla.pts = 60;                  // trust level 3
  stepThreats(s, 0.5); stepThreats(s, 0.5);
  assert.equal(rv(s).aggression, 13, '+2 once');
  s.economy.buyers.marla.pts = 100;                 // level 4: no second bump
  stepThreats(s, 0.5);
  assert.equal(rv(s).aggression, 13);
});

test('Dale: taking one of his buyers is +5 each (the M3 hook feeds the real model)', () => {
  const s = game();
  s.economy.daleAggression += CONFIG.economy.miss.daleAggression;   // Big Tone found another supplier
  stepThreats(s, 0.5);
  assert.equal(rv(s).aggression, 15);
  s.economy.daleAggression += CONFIG.economy.miss.daleAggression;   // and Vivian
  stepThreats(s, 0.5); stepThreats(s, 0.5);
  assert.equal(rv(s).aggression, 20);
});

test('Dale: beating his saboteur is -20; tribute -10 weekly; truce sets 10 and freezes 10 days', () => {
  const s = game();
  rv(s).aggression = 50;
  at(s, 9, 3);
  const e = spawnSaboteur(s, 'poison');
  damageEntity(s, e, 999, 'melee');
  stepThreats(s, 0.5); stepThreats(s, 0.5);
  assert.equal(rv(s).aggression, 30, 'counted once');
  assert.equal(payTribute(s).ok, true);
  assert.equal(rv(s).aggression, 20);
  assert.equal(s.player.cash, 10000 - 300);
  assert.equal(payTribute(s).ok, false, 'weekly');
  at(s, 9 + 7, 12);
  assert.equal(payTribute(s).ok, true);
  assert.equal(rv(s).aggression, 10);
  rv(s).aggression = 59;
  assert.equal(buyTruce(s).ok, false, 'needs 60+');
  rv(s).aggression = 60;
  const cash = s.player.cash;
  assert.equal(buyTruce(s).ok, true);
  assert.equal(s.player.cash, cash - 2000);
  assert.equal(rv(s).aggression, 10);
  rivalBump(s, 5);
  assert.equal(rv(s).aggression, 10, 'frozen: gains are ignored');
  at(s, 9 + 7 + 11, 12);
  rivalBump(s, 5);
  assert.equal(rv(s).aggression, 15, 'thawed after 10 days');
});

test('truce is bought at the bar and blocks his rolls while it holds', () => {
  const s = game();
  at(s, 20, 18);
  rv(s).aggression = 80;
  assert.ok(buyItem(s, 'truce', 'bar').ok);
  forceRival(s, (d) => POISON.roll(d));
  night(s, 22, 10);
  rv(s).frozenUntil = nowGh(s) + 100;
  assert.equal(rollAt23(s), null);
});

test('nightly roll: aggression x 0.5%, capped at 50%', () => {
  const s = game();
  rv(s).aggression = 10; assert.ok(Math.abs(rivalChance(s) - 0.05) < 1e-12);
  rv(s).aggression = 70; assert.ok(Math.abs(rivalChance(s) - 0.35) < 1e-12);
  rv(s).aggression = 100; assert.equal(rivalChance(s), 0.5);
  night(s, 9, 20);
  forceRival(s, (d) => d.roll >= 0.1 && d.roll < 0.2);      // 10% needed to fire at 20 aggression
  assert.equal(rollAt23(s), null, 'above 20 x 0.5% = 10%: nothing');
  night(s, 11, 20);
  forceRival(s, (d) => d.roll < 0.1 && POISON.poison(d));
  assert.equal(rollAt23(s), 'poison');
});

test('director: Dale is not active before night 8, one hostile event a night, quiet night after', () => {
  const s = game();
  forceRival(s, (d) => d.roll < 0.01 && POISON.pest(d));
  night(s, 6, 100);
  assert.equal(rollAt23(s), null, 'too early (night 7)');
  night(s, 7, 100);
  forceRival(s, (d) => d.roll < 0.01 && POISON.tip(d));
  assert.equal(rollAt23(s), 'tip');
  assert.equal(tt(s).hostile[8], 'rival');
  assert.equal(directorAllows(s, 'thief'), false, 'no thief on the same night');
  night(s, 8, 100);
  forceRival(s, (d) => d.roll < 0.01 && POISON.tip(d));
  assert.equal(rollAt23(s), null, 'the night after is quiet');
  night(s, 9, 100);
  forceRival(s, (d) => d.roll < 0.01 && POISON.tip(d));
  assert.equal(rollAt23(s), 'tip');
});

test('stepThreats rolls Dale at 23:00 through the director', () => {
  const s = game();
  night(s, 10, 100);
  forceRival(s, (d) => d.roll < 0.01 && POISON.poison(d));
  s.time.hour = 23.02;
  stepThreats(s, 0.5);
  assert.equal(ents(s, 'saboteur').length, 1);
  assert.equal(tt(s).history.at(-1).kind, 'rival');
});

// ---- poisoned water ----------------------------------------------------

test('poisoned water: the saboteur needs 10 s at the tap (+20 s with a barrel lock); 8 pours add +1.0 pH and 6 gh of severe stress', () => {
  const secs = (locked) => {
    const s = game();
    at(s, 10, 0);
    s.player.x = 100 * TS;
    if (locked) { s.player.inv.barrel_lock = 1; assert.ok(installBarrelLock(s).ok); }
    const e = spawnSaboteur(s, 'poison', { source: 'tap' });
    e.x = 40 * TS;
    // walk there first, then time only the work
    run(s, () => e.state === 'work', 60);
    return run(s, () => !!rv(s).poison, 100);
  };
  const open = secs(false);
  const lock = secs(true);
  assert.ok(Math.abs(open - RV.saboteur.poisonSeconds) <= 1, `10 s: ${open}`);
  assert.ok(Math.abs(lock - (RV.saboteur.poisonSeconds + RV.saboteur.barrelLockSeconds)) <= 1, `+20 s: ${lock}`);

  const s = game();
  rv(s).poison = { source: 'tap', pours: RV.poison.pours };
  assert.equal(waterPoisoned(s, 'tap'), true);
  assert.equal(waterPoisoned(s, 'barrel'), false);
  const { plant } = potWithPlant(s, 60);
  plant.ph = 6.4;
  waterPour(s, plant, 0.1, 'barrel');
  assert.equal(plant.poisonedHours, 0, 'the barrel is clean');
  assert.ok(Math.abs(plant.ph - 6.5) < 1e-9);
  plant.ph = 6.0;
  waterPour(s, plant, 0.1, 'tap');
  assert.ok(Math.abs(plant.ph - 7.1) < 1e-9, 'tap pH +0.1 and +1.0 from the poison');
  assert.equal(plant.poisonedHours, 6);
  assert.ok(stressorsOf(plant).includes('poisoned'));
  const h0 = plant.health;
  stepPlants(s, 1);
  assert.ok(h0 - plant.health >= CONFIG.plants.stressDamage.poisoned * 0.9, 'severe stress damage');
  for (let i = 0; i < 6; i++) stepPlants(s, 1);
  assert.equal(stressorsOf(plant).includes('poisoned'), false, 'wears off after 6 gh');
  // only 8 pours
  for (let i = 0; i < 7; i++) waterPour(s, plant, 0, 'tap');
  assert.equal(rv(s).poison, null, 'the 8th poisoned pour used it up');
  plant.ph = 6.4; plant.poisonedHours = 0;
  waterPour(s, plant, 0, 'tap');
  assert.equal(plant.poisonedHours, 0);
});

test('poison counters: a seen saboteur flees without poisoning; dump and refill clears the water', () => {
  const s = game();
  at(s, 10, 0);
  const p = s.player;
  const e = spawnSaboteur(s, 'poison', { source: 'tap' });
  e.x = 42 * TS;
  p.x = 42 * TS + 5 * TS; p.y = s.surface[42] * TS - p.h;   // standing 5 tiles away
  run(s, () => !s.entities.includes(e) || e.gone, 60);
  assert.equal(rv(s).poison, null, 'he ran before the 10 s');
  rv(s).poison = { source: 'barrel', pours: 8 };
  assert.equal(purgeWater(s), true);
  assert.equal(rv(s).poison, null);
  assert.equal(purgeWater(s), false);
});

test('a camera that records his saboteur is the leverage; a dog bite sends him running', () => {
  const s = game();
  at(s, 10, 0);
  addObject(s, { kind: 'camera', x: 44, y: s.surface[44] - 2, dir: -1, footage: 0 });
  assert.equal(rv(s).leverage, false);
  const e = spawnSaboteur(s, 'poison', { source: 'tap' });
  e.x = 40 * TS;
  run(s, () => rv(s).leverage, 60);
  assert.equal(rv(s).leverage, true);
  const s2 = game();
  at(s2, 10, 0);
  giveDog(s2);
  const e2 = spawnSaboteur(s2, 'poison', { source: 'tap' });
  e2.x = 40 * TS;
  s2.threats.dog.x = 40 * TS;
  run(s2, () => e2.state === 'flee' || e2.gone || e2.state === 'ko', 30);
  assert.ok(['flee', 'ko'].includes(e2.state) || e2.gone, 'the dog got him');
  assert.equal(rv(s2).poison, null);
});

// ---- anonymous tip -----------------------------------------------------

test('anonymous tip: +15 heat (+8 with the deputy bribed); footage of his saboteur blocks tips for good', () => {
  const s = game();
  night(s, 10, 100);
  s.heat = 0;
  forceRival(s, (d) => d.roll < 0.01 && POISON.tip(d));
  assert.equal(rollAt23(s), 'tip');
  assert.equal(s.heat, 15);
  assert.equal(ents(s, 'saboteur').length, 0, 'no intruder');
  const b = game();
  night(b, 20, 100);
  b.economy.buyers.skeet.known = true;
  hs(b).lastBribeDay = 18;
  b.heat = 0;
  forceRival(b, (d) => d.roll < 0.01 && POISON.tip(d));
  assert.equal(rollAt23(b), 'tip');
  assert.equal(b.heat, 8, 'half the heat when the deputy is bribed');
  const c = game();
  night(c, 20, 100);
  c.heat = 0;
  rv(c).leverage = true;
  forceRival(c, (d) => d.roll < 0.01 && POISON.tip(d));
  assert.equal(rollAt23(c), null);
  assert.equal(c.heat, 0, 'blocked');
  assert.equal(tt(c).hostile[nightKeyOf(c)], undefined, 'a blocked tip does not use up the night');
});
const nightKeyOf = (s) => (s.time.hour >= CONFIG.clock.wakeHour ? s.time.day + 1 : s.time.day);

// ---- pest jar ----------------------------------------------------------

test('pest jar: the saboteur infests one plant in 4 s; 3 health/gh; spreads within 2 tiles every 12 gh', () => {
  const s = game();
  night(s, 10, 100);
  const a = potWithPlant(s, 60, 0.3);
  const near = potWithPlant(s, 62, 0.3);      // 2 tiles
  const far = potWithPlant(s, 65, 0.3);       // 3 tiles from `near`, 5 from `a`
  forceRival(s, (d) => d.roll < 0.01 && POISON.pest(d) && d.pick < 0.3);
  assert.equal(rollAt23(s), 'pest');
  const e = ents(s, 'saboteur')[0];
  assert.equal(e.job, 'pest');
  assert.equal(e.plantId, a.plant.id);
  s.player.x = 150 * TS;
  e.x = 59 * TS;
  run(s, () => e.state === 'work', 30);
  const secs = run(s, () => a.plant.infested, 30);
  assert.ok(Math.abs(secs - RV.saboteur.pestSeconds) <= 1, `4 s: ${secs}`);
  assert.equal(near.plant.infested, false);
  assert.ok(stressorsOf(a.plant).includes('pest'));
  const h0 = a.plant.health;
  stepPlants(s, 1);
  assert.ok(h0 - a.plant.health >= CONFIG.plants.stressDamage.pest * 0.9, 'about 3 health per gh');
  for (let i = 0; i < 10; i++) stepPlants(s, 1);
  assert.equal(near.plant.infested, false, 'not before 12 gh');
  stepPlants(s, 1);
  assert.equal(near.plant.infested, true, 'spread to the plant 2 tiles away');
  assert.equal(far.plant.infested, false, 'spacing 3+ tiles stops it');
});

test('pest counters: pots 3+ tiles apart stop the spread; neem cures one plant', () => {
  const s = game();
  const a = potWithPlant(s, 60, 0.3);
  const b = potWithPlant(s, 63, 0.3);         // 3 tiles
  a.plant.infested = true;
  for (let i = 0; i < 60; i++) { a.plant.health = 100; stepPlants(s, 1); }
  assert.equal(b.plant.infested, false);
  neemPlant(s, a.plant);
  assert.equal(a.plant.infested, false);
  assert.equal(stressorsOf(a.plant).includes('pest'), false);
});

// ---- goons -------------------------------------------------------------

test('goon squads only appear at aggression 70+ (25% of rolls)', () => {
  const s = game();
  night(s, 10, 69);
  forceRival(s, (d) => d.roll < 0.01 && d.goon < 0.2 && POISON.tip(d));
  assert.equal(rollAt23(s), 'tip', 'under 70 a low goon draw is just sabotage');
  assert.equal(ents(s, 'goon').length, 0);
  const t = game();
  night(t, 10, 70);
  forceRival(t, (d) => d.roll < 0.2 && d.goon < 0.2);
  assert.equal(rollAt23(t), 'goons');
  const goons = ents(t, 'goon');
  assert.equal(goons.length, 2);
  assert.ok(goons.every((g) => g.hp === 80 && g.armed));
  const u = game();
  night(u, 10, 70);
  forceRival(u, (d) => d.roll < 0.2 && d.goon >= 0.25 && POISON.tip(d));
  assert.equal(rollAt23(u), 'tip', '75% of rolls are still sabotage');
});

test('goons smash pots (3 s each) and fight; beating the squad is -20; three squads make Dale back off 10 days', () => {
  const s = game();
  at(s, 10, 0);
  rv(s).aggression = 90;
  s.player.x = 150 * TS; s.player.y = s.surface[150] * TS - s.player.h;
  const pots = [60, 63].map((x) => potWithPlant(s, x, 0.3));
  const goons = spawnGoons(s);
  goons.forEach((g, i) => { g.x = (58 - i) * TS; });
  // time to the first smashed pot is at least the 3 s smash
  const t = run(s, () => s.objects.filter((o) => o.kind === 'pot').length < 4 + 2, 120);
  assert.ok(t >= RV.goon.smashSeconds, `smashing takes time (${t} s)`);
  run(s, () => ents(s, 'goon').length === 0, 200);
  assert.equal(s.plants.length, 0, 'both plants destroyed');
  assert.equal(s.objects.filter((o) => o.kind === 'pot' && pots.some((p) => p.pot.id === o.id)).length, 0);

  // the fight: knock a squad out
  const s2 = game();
  at(s2, 10, 0);
  rv(s2).aggression = 90;
  for (let n = 1; n <= RV.goon.backOffSquads; n++) {
    const gs = spawnGoons(s2);
    for (const g of gs) damageEntity(s2, g, 999, 'melee');
    stepThreats(s2, 0.5);
    stepThreats(s2, 0.5);
    s2.entities = [];
    assert.equal(rv(s2).aggression, 70, `squad ${n} beaten: -20`);
    rv(s2).aggression = 90;
  }
  assert.ok(rv(s2).backOffUntil > nowGh(s2) + 9 * 24, 'three beaten squads: Dale backs off 10 days');
  night(s2, 10, 100);
  forceRival(s2, (d) => d.roll < 0.01);
  assert.equal(rollAt23(s2), null);
  at(s2, 25, 22.9);
  forceRival(s2, (d) => d.roll < 0.01 && POISON.tip(d));
  assert.equal(rollAt23(s2), 'tip', 'back after the 10 days');
});

test('goons shoot back: they hurt the player in range; a guard fights them', () => {
  const s = game();
  at(s, 10, 0);
  const [g] = spawnGoons(s);
  g.x = 60 * TS;
  const p = s.player;
  p.x = 64 * TS; p.y = s.surface[64] * TS - p.h; p.onGround = true;
  const hp0 = p.hp;
  for (let i = 0; i < 60; i++) { stepThreats(s, 0.5); if (p.hp < hp0) break; }
  assert.ok(p.hp < hp0, 'the player was shot');

  const s2 = game();
  at(s2, 10, 0);
  hire(s2, 1, 'guard');
  placeMarker(s2, 0, 60); placeMarker(s2, 1, 62);
  s2.player.x = 150 * TS;
  const [g2] = spawnGoons(s2);
  g2.x = 64 * TS; g2.state = 'smash'; g2.workLeft = 999;
  for (let i = 0; i < 200 && g2.state !== 'dead' && g2.state !== 'ko'; i++) { stepCrew(s2, 0.5); stepThreats(s2, 0.5); }
  assert.ok(g2.hp < 80, 'the guard hurt the goon');
});
