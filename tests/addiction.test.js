// addiction.test.js — M8: substances and buffs, dependence escalation, withdrawal
// (slower tending, fumbles), compulsion, overdose, the three recovery routes,
// cravings and relapse, and the third-overdose game over (plan §A12, §A15).
import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { newGame, serializeState, deserializeState } from '../src/state.js';
import { stepSim } from '../src/sim/sim.js';
import { hs } from '../src/sim/heat.js';
import { buyItem, buyerMult } from '../src/sim/economy.js';
import { plantSeed } from '../src/sim/plants.js';
import { stepPlayer, actionDuration } from '../src/entities/player.js';
import { hurtPlayer, spreadDeg } from '../src/entities/combat.js';
import {
  addOf, useSubstance, stepAddiction, tendMult, moveMult, maxHp, staminaMult, friendshipMult,
  stressEvent, status, derive, dealerPrice, rollFumble,
} from '../src/sim/addiction.js';

const A = CONFIG.addiction;
const TS = CONFIG.world.tile;

function game(seed = 5) {
  const s = newGame(seed);
  s.player.cash = 10000;
  s.player.inv.crank = 20; s.player.inv.blues = 20;
  s.time.day = 3; s.time.hour = 10;
  stepAddiction(s); // arms the day counter
  return s;
}
/** Jump the clock to absolute game hour t and run the addiction step. */
function setT(s, t) {
  s.time.day = Math.floor(t / 24); s.time.hour = t - s.time.day * 24;
  stepAddiction(s);
}
const T = (s) => s.time.day * 24 + s.time.hour;
const sub = (s, k) => addOf(s).subs[k];
/** Put a substance at dependence d, last dosed `ago` gh back. */
function hook(s, k, d, ago = 0) {
  const x = sub(s, k);
  x.d = d; x.peak = Math.max(x.peak, d); x.lastUse = T(s) - ago; x.usedToday = true;
  addOf(s).hooked = d >= A.hookedAt;
}

test('each substance gives its buff', () => {
  const s = game();
  const base = actionDuration(s, 1);
  s.player.awakeHours = 40; // Tired: +20%
  assert.ok(Math.abs(actionDuration(s, 1) - base * 1.2) < 1e-9);
  // Crank: tending x0.6, move +25%, immune to Tired, then a 4 gh crash.
  assert.ok(useSubstance(s, 'crank').ok);
  assert.equal(s.player.inv.crank, 19);
  assert.ok(Math.abs(actionDuration(s, 1) - base * 0.6) < 1e-9, 'x0.6 and no Tired penalty');
  assert.equal(moveMult(s), 1.25);
  const c = sub(s, 'crank');
  assert.ok(Math.abs(c.buffUntil - (T(s) + 8 * (1 - c.d / 200))) < 1e-9);
  assert.ok(Math.abs(c.crashUntil - c.buffUntil - 4) < 1e-9);
  s.player.awakeHours = 0;
  setT(s, c.buffUntil + 1);
  assert.ok(Math.abs(tendMult(s) - 1.3) < 1e-9 && moveMult(s) === 0.8, 'crash');
  setT(s, c.crashUntil + 1);
  assert.equal(tendMult(s), 1);
  // Blues: +20 hp now, damage x0.7 for 6 gh.
  s.player.hp = 50;
  useSubstance(s, 'blues');
  assert.equal(s.player.hp, 70);
  hurtPlayer(s, 10, 'test');
  assert.ok(Math.abs(s.player.hp - 63) < 1e-9);
  setT(s, T(s) + 7);
  hurtPlayer(s, 10, 'test');
  assert.ok(Math.abs(s.player.hp - 53) < 1e-9, 'expired');
  // Booze: friendship x1.5, aim spread x1.3 for 3 gh.
  s.player.vx = 0; s.player.onGround = true;
  const spread = spreadDeg(s);
  useSubstance(s, 'booze');
  stepAddiction(s);
  assert.equal(friendshipMult(s), 1.5);
  assert.ok(Math.abs(spreadDeg(s) - spread * 1.3) < 1e-9);
  setT(s, T(s) + 4);
  assert.equal(friendshipMult(s), 1);
  assert.equal(s.player.drunk, false);
  // Own weed: 1 g, tending x1.1, no dependence.
  assert.equal(useSubstance(s, 'weed').ok, false, 'needs product');
  s.product.push({ id: 1, strainName: 'Ditch Weed', quality: 50, grams: 5, wet: false, where: 'inv' });
  assert.ok(useSubstance(s, 'weed').ok);
  assert.equal(s.product[0].grams, 4);
  assert.ok(Math.abs(tendMult(s) - 1.1) < 1e-9);
  assert.equal(derive(s).stage, 0);
});

test('dependence climbs D += gain x (1 + D/100), tolerance shortens doses, dealer markup', () => {
  const s = game();
  useSubstance(s, 'crank');
  assert.equal(sub(s, 'crank').d, 8);
  useSubstance(s, 'crank');
  assert.ok(Math.abs(sub(s, 'crank').d - (8 + 8 * 1.08)) < 1e-9);
  hook(s, 'crank', 100);
  addOf(s).doses = [];
  useSubstance(s, 'crank');
  assert.equal(sub(s, 'crank').d, 100, 'capped');
  assert.ok(Math.abs(sub(s, 'crank').buffUntil - T(s) - 4) < 1e-9, 'half duration at D 100');
  sub(s, 'crank').d = 0;
  assert.equal(dealerPrice(s, 'crank'), 30);
  sub(s, 'crank').d = 40;
  assert.equal(dealerPrice(s, 'crank'), 36);
  sub(s, 'crank').d = 100;
  assert.equal(dealerPrice(s, 'crank'), 45);
  // Moss sells it at the dealer price (open 21:00-04:00).
  s.time.hour = 22;
  const before = s.player.cash;
  assert.ok(buyItem(s, 'blues', 'alley').ok);
  assert.equal(s.player.cash, before - 20);
});

test('Casual / Hooked / Addicted timers: 24 gh and 12 gh windows, daily falls', () => {
  const s = game();
  setT(s, 3 * 24 + 10);
  hook(s, 'blues', 20);
  sub(s, 'blues').usedToday = false;
  assert.equal(status(s).stage, 'casual');
  assert.equal(derive(s).wd, 0);
  setT(s, 4 * 24 + 6.5); // dawn: Casual with no use falls 2
  assert.equal(sub(s, 'blues').d, 18);
  hook(s, 'blues', 40, 0);
  assert.equal(derive(s).stage, 1);
  setT(s, T(s) + 23.9);
  assert.equal(derive(s).wd, 0);
  setT(s, T(s) + 0.2);
  assert.equal(derive(s).wd, 1, 'Hooked needs a dose every 24 gh');
  assert.equal(hs(s).withdrawal, true);
  hook(s, 'blues', 70, 0);
  setT(s, T(s) + 11.9);
  assert.equal(derive(s).wd, 0);
  setT(s, T(s) + 0.2);
  assert.equal(derive(s).wd, 2, 'Addicted needs a dose every 12 gh');
  assert.equal(s.player.addicted, true);
  // Hooked and still using: D does not fall at dawn.
  hook(s, 'crank', 45, 1);
  sub(s, 'crank').usedToday = false;
  const k = T(s);
  setT(s, k + 24);
  assert.equal(sub(s, 'crank').d, 45 - 8, 'unused for the day: cold turkey 8');
});

test('withdrawal slows tending (x1.5 / x2) and baseline Addicted does not', () => {
  const s = game();
  hook(s, 'crank', 40, 30); // Hooked, overdue
  assert.ok(Math.abs(tendMult(s) - 1.5) < 1e-9);
  hook(s, 'crank', 70, 20); // Addicted, overdue
  assert.ok(Math.abs(tendMult(s) - 2.0) < 1e-9);
  hook(s, 'crank', 70, 1); // Addicted, dosed
  assert.equal(tendMult(s), 1);
  hook(s, 'crank', 70, 20);
  useSubstance(s, 'weed'); // no product: nothing
  s.product.push({ id: 1, strainName: 'x', quality: 50, grams: 5, wet: false, where: 'inv' });
  useSubstance(s, 'weed');
  assert.ok(Math.abs(tendMult(s) - (1 + 0.75) * 1.1) < 1e-9, 'weed trims the penalty by 25% and adds x1.1');
});

test('withdrawal fumbles: 10% / 25% / 5%, and a fumble wrecks the plant', () => {
  const s = game();
  const rate = (n = 4000) => { let h = 0; for (let i = 0; i < n; i++) if (rollFumble(s)) h++; return h / n; };
  s.events.length = 0;
  hook(s, 'crank', 40, 30);
  assert.ok(Math.abs(rate() - 0.10) < 0.03);
  hook(s, 'crank', 70, 20);
  assert.ok(Math.abs(rate() - 0.25) < 0.04);
  hook(s, 'crank', 70, 1);
  assert.ok(Math.abs(rate() - 0.05) < 0.02);
  hook(s, 'crank', 0, 0);
  assert.equal(rate(200), 0, 'no habit, no fumbles');

  // A water action by an Addicted-in-withdrawal player: sometimes a double pour.
  hook(s, 'crank', 70, 20);
  const pot = s.objects.find((o) => o.kind === 'pot');
  const plant = plantSeed(s, pot, 'ditch');
  const pour = CONFIG.plants.pourMoisture;
  const seen = new Set();
  for (let i = 0; i < 300 && seen.size < 2; i++) {
    plant.moisture = 0; s.player.canCharges = 8; s.player.action = null;
    s.player.action = { kind: 'water', t: 0, dur: 0.001, plantId: plant.id, potId: pot.id, dir: 0 };
    stepPlayer(s, {}, 0.01);
    seen.add(plant.moisture);
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), [pour, pour * 2]);
});

test('withdrawal costs stamina and max HP; Addicted days cost permanent HP', () => {
  const s = game();
  hook(s, 'crank', 40, 30);
  assert.equal(staminaMult(s), 0.75);
  assert.equal(maxHp(s), 100);
  hook(s, 'crank', 70, 20);
  assert.equal(staminaMult(s), 0.5);
  assert.equal(maxHp(s), 80);
  hook(s, 'blues', 70, 20);
  assert.equal(maxHp(s), 70, 'Blues: -30');
  hook(s, 'blues', 0, 0);
  hook(s, 'crank', 70, 1);
  assert.equal(staminaMult(s), 0.8, 'baseline');
  stepAddiction(s);
  assert.equal(s.player.hp, 80, 'hp is clamped to the new max');
  // each day Addicted: permanent -1 (floor 60); +1 back after 5 clean days
  for (let i = 1; i <= 50; i++) { sub(s, 'crank').d = 70; sub(s, 'crank').usedToday = true; setT(s, T(s) + 24); }
  assert.equal(addOf(s).permLoss, 40, 'floor 60 hp');
  sub(s, 'crank').d = 0;
  for (let i = 0; i < 6; i++) setT(s, T(s) + 24);
  assert.equal(addOf(s).permLoss, 39);
  setT(s, T(s) + 24);
  assert.equal(addOf(s).permLoss, 38);
});

test('compulsion: a carried dose is taken after 6 gh of withdrawal; Moss pulls you in', () => {
  const s = game();
  hook(s, 'crank', 70, 12 + 5);
  stepAddiction(s);
  assert.equal(s.player.inv.crank, 20, 'not yet: only 5 gh into withdrawal');
  setT(s, T(s) + 1.5);
  assert.equal(s.player.inv.crank, 19, 'used automatically');
  // Moss: withdrawing Addicted, within 10 tiles, cash, 50% per check.
  const b = CONFIG.world.buildings.find((x) => x.key === 'alley');
  s.player.inv.crank = 0;
  s.player.x = (b.x + b.w - 1 - 5) * TS;
  s.time.day = 6; s.time.hour = 22; stepAddiction(s);
  hook(s, 'crank', 70, 30);
  const cash = s.player.cash;
  let bought = false;
  for (let i = 0; i < 40 && !bought; i++) { setT(s, T(s) + 1.1); bought = s.player.cash < cash; }
  assert.ok(bought, 'bought from Moss');
  assert.ok(s.player.locS > 0, 'brief loss of control');
  assert.ok(Math.abs(cash - s.player.cash - dealerPrice(s, 'crank')) <= 10);
  assert.ok(T(s) - sub(s, 'crank').lastUse < 0.1);
  // Far from the alley nothing happens.
  const s2 = game();
  hook(s2, 'crank', 70, 30); s2.player.inv.crank = 0;
  s2.time.hour = 22;
  for (let i = 0; i < 20; i++) setT(s2, T(s2) + 1.1);
  assert.equal(s2.player.cash, 10000);
});

test('overdose: third hard dose in 6 gh risks it; collapse costs $400, +5 heat, -5 max HP', () => {
  let ods = 0, tooEarly = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const s = game(seed);
    useSubstance(s, 'crank'); useSubstance(s, 'blues');
    if (s.player.downed) tooEarly++;
    const cash = s.player.cash, heat = s.heat;
    useSubstance(s, 'crank');
    if (s.player.downed) {
      ods++;
      assert.equal(s.player.cash, cash - 400);
      assert.equal(s.heat, heat + 5);
      assert.equal(addOf(s).odLoss, 5);
      assert.equal(addOf(s).overdoses, 1);
      assert.equal(s.threats.downed, true);
      stepSim(s, 0.5); // wakes at the clinic
      assert.equal(s.player.downed, false);
      assert.equal(maxHp(s), 95);
    }
  }
  assert.equal(tooEarly, 0, 'the first two doses are safe');
  assert.ok(ods > 6 && ods < 30, `about 25% (${ods}/60)`);
  // Booze is not a hard drug: any number is safe.
  const s = game();
  for (let i = 0; i < 6; i++) useSubstance(s, 'booze');
  assert.equal(s.player.downed, false);
  // Doses 6 gh apart do not stack.
  for (let i = 0; i < 8; i++) { setT(s, T(s) + 6.1); useSubstance(s, 'crank'); }
  assert.equal(addOf(s).overdoses, 0);
});

test('a third overdose ends the game', () => {
  const s = game();
  addOf(s).overdoses = 2;
  for (let i = 0; i < 20 && !s.gameOver; i++) { setT(s, T(s) + 0.01); useSubstance(s, 'crank'); }
  assert.deepEqual(s.gameOver, { reason: 'overdose' });
  assert.ok(s.events.some((e) => e.type === 'gameOver' && e.reason === 'overdose'));
  const t = T(s);
  stepSim(s, 0.5);
  assert.equal(T(s), t, 'the sim stops');
});

test('recovery route 1, cold turkey: D falls 8 a day with full penalties, ~4 days from 60', () => {
  const s = game();
  hook(s, 'crank', 60, 30);
  sub(s, 'crank').usedToday = false;
  addOf(s).dayKey = Math.floor((T(s) - 6) / 24);
  const t0 = Math.ceil((T(s) - 6) / 24) * 24 + 6.5;
  setT(s, t0); assert.equal(sub(s, 'crank').d, 52);
  assert.equal(derive(s).wd, 1, 'withdrawal penalties apply all the way down');
  setT(s, t0 + 24); setT(s, t0 + 48); setT(s, t0 + 72);
  assert.equal(sub(s, 'crank').d, 28);
  assert.equal(status(s).stage, 'casual');
  assert.ok(addOf(s).recovery, 'In Recovery');
  assert.ok(status(s).recovery > 13);
});

test('recovery route 2, taper kit: $100 a day, D -12, only stamina -15%, cancelled if missed', () => {
  const s = game();
  hook(s, 'crank', 70, 30);
  s.time.hour = 10; // clinic is open 8-18
  const cash = s.player.cash;
  assert.ok(buyItem(s, 'taper', 'clinic').ok);
  assert.equal(s.player.cash, cash - 100);
  assert.equal(buyItem(s, 'taper', 'clinic').ok, false, 'one a day');
  assert.equal(derive(s).wd, 0, 'no withdrawal penalties');
  assert.equal(tendMult(s), 1);
  assert.equal(staminaMult(s), 0.85);
  assert.equal(maxHp(s), 100);
  setT(s, 4 * 24 + 6.5);
  assert.equal(sub(s, 'crank').d, 58);
  setT(s, 4 * 24 + 8);
  assert.ok(buyItem(s, 'taper', 'clinic').ok, 'rebuy the next day');
  setT(s, 5 * 24 + 6.5);
  assert.equal(sub(s, 'crank').d, 46);
  // Miss a day: the kit lapses and cold turkey (and withdrawal) is back.
  setT(s, 5 * 24 + 12);
  setT(s, 6 * 24 + 6.5);
  assert.equal(derive(s).taper, false);
  assert.equal(derive(s).wd > 0, true);
  assert.equal(sub(s, 'crank').d, 38);
});

test('recovery route 3, clinic detox: $1,500, D to 15, three days away', () => {
  const s = game();
  hook(s, 'crank', 80, 5);
  hook(s, 'blues', 40, 5);
  s.time.hour = 10;
  const cash = s.player.cash;
  assert.ok(buyItem(s, 'detox', 'clinic').ok);
  assert.equal(s.player.cash, cash - 1500);
  assert.equal(sub(s, 'crank').d, 15);
  assert.equal(sub(s, 'blues').d, 15);
  assert.equal(hs(s).pendingSkip, 3);
  assert.ok(addOf(s).recovery, 'In Recovery');
  const before = T(s);
  stepSim(s, 0.5); // the skip runs
  assert.ok(T(s) - before >= 3 * 24 - 1);
});

test('recovery cravings, stress cravings, sponsor, and relapse snapback', () => {
  const s = game();
  hook(s, 'crank', 80, 0);
  sub(s, 'crank').lastUse = T(s);
  // Fall below 30 -> In Recovery for 14 days, with a craving scheduled.
  sub(s, 'crank').d = 29; sub(s, 'crank').usedToday = true;
  setT(s, 4 * 24 + 6.5);
  const a = addOf(s);
  assert.ok(a.recovery && a.cravingAt !== null, 'a random-hour craving is scheduled');
  setT(s, a.cravingAt + 0.01);
  assert.equal(derive(s).craving, true);
  assert.ok(Math.abs(tendMult(s) - 1.25) < 1e-9);
  setT(s, T(s) + 2.1);
  assert.equal(derive(s).craving, false);
  // Stress events cause a craving; a sponsor prevents them.
  stressEvent(s);
  assert.equal(derive(s).craving, true);
  setT(s, T(s) + 2.1);
  a.sponsor = true;
  stressEvent(s);
  assert.equal(derive(s).craving, false);
  a.sponsor = false;
  // Booze during recovery adds one extra craving that day (one only).
  useSubstance(s, 'booze');
  assert.equal(derive(s).craving, true);
  setT(s, T(s) + 2.1);
  useSubstance(s, 'booze');
  assert.equal(derive(s).craving, false, 'only one extra craving a day');
  // Any use in recovery snaps D to 75% of the peak (peak was ~80).
  const peak = sub(s, 'crank').peak;
  assert.ok(peak >= 80);
  useSubstance(s, 'crank');
  assert.ok(Math.abs(sub(s, 'crank').d - peak * 0.75) < 1e-9);
  assert.equal(a.recovery, null);
  // Recover again, stay clean 14 days: Clean; a later use snaps to 50%.
  sub(s, 'crank').d = 29; sub(s, 'crank').usedToday = true;
  setT(s, Math.ceil((T(s) - 6) / 24) * 24 + 6.5);
  assert.ok(a.recovery);
  const start = a.recovery.start;
  for (let i = 0; i < 15; i++) setT(s, T(s) + 24);
  assert.ok(T(s) - start > 14 * 24);
  assert.equal(a.recovery, null);
  assert.equal(status(s).clean, true);
  sub(s, 'crank').d = 0;
  useSubstance(s, 'crank');
  assert.ok(Math.abs(sub(s, 'crank').d - peak * 0.5) < 1e-9);
});

test('relapse craving near Moss (30%), halved by a sponsor', () => {
  const trial = (sponsor) => {
    let buys = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const s = game(seed);
      const b = CONFIG.world.buildings.find((x) => x.key === 'alley');
      s.player.x = (b.x + b.w - 1) * TS; s.player.inv.crank = 0;
      s.time.hour = 22; stepAddiction(s);
      const a = addOf(s);
      sub(s, 'crank').peak = 80; a.recovery = { start: T(s) }; a.sponsor = sponsor;
      a.cravingUntil = T(s) + 5; a.nextCheck = 0;
      const cash = s.player.cash;
      stepAddiction(s);
      if (s.player.cash < cash) buys++;
    }
    return buys / 200;
  };
  const free = trial(false), sponsored = trial(true);
  assert.ok(Math.abs(free - 0.3) < 0.09, `30% (${free})`);
  assert.ok(Math.abs(sponsored - 0.15) < 0.08, `halved (${sponsored})`);
});

test('social costs: crew loyalty hook, buyer price penalty, state saves', () => {
  const s = game();
  hook(s, 'crank', 70, 1);
  stepSim(s, 0.5);
  assert.equal(s.player.addicted, true, 'crew.js reads this at payday');
  hook(s, 'crank', 40, 30);
  stepSim(s, 0.5);
  assert.equal(hs(s).withdrawal, true);
  assert.equal(s.player.addicted, false);
  const clean = buyerMult(newGame(5), 'skeet');
  hook(s, 'crank', 70, 1);
  assert.ok(Math.abs(buyerMult(s, 'skeet') - clean * 0.9) < 1e-9, 'trust <= 2 pays -10%');
  const r = deserializeState(serializeState(s));
  assert.deepEqual(r.addiction, s.addiction);
});
