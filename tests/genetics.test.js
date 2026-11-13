// genetics.test.js — M7: mastery, clones, strains, journal, audio data.
import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { createRng } from '../src/rng.js';
import { newGame, serializeState, deserializeState } from '../src/state.js';
import { stepPlants, plantSeed, createPlant, harvestPlant, takeCutting, plantCutting, canCut, stageOf, plantable } from '../src/sim/plants.js';
import { cloneGenome, baseGenome } from '../src/sim/genetics.js';
import { levelFor, xpForHarvest, addXp, strainUnlocked, journalView } from '../src/sim/mastery.js';
import { shopStock, buyItem } from '../src/sim/economy.js';
import { SFX_NAMES, MUSIC_BEDS, renderSfx } from '../src/audio/audio.js';

const M = CONFIG.mastery;
const GH = 0.5 / CONFIG.clock.secPerGh;
const fresh = () => {
  const s = newGame(11);
  const pot = s.objects.find((o) => o.kind === 'pot');
  return { s, pot };
};
const ripe = (s, pot, strain = 'ditch') => {
  const pl = plantSeed(s, pot, strain);
  pl.progress = 1; pl.overHours = 0;
  return pl;
};

test('XP per harvest = grams x (0.5 + quality/100); levels follow the table', () => {
  assert.equal(xpForHarvest(40, 50), 40);
  const xp = CONFIG.mastery.levelXp; // the table (retuned in M10)
  xp.forEach((x, i) => {
    assert.equal(levelFor(x), i + 1);
    if (x > 0) assert.equal(levelFor(x - 1), i);
  });
  const { s } = fresh();
  addXp(s, 100, 50); // 100 XP -> L2
  assert.equal(s.player.level, 2);
  addXp(s, xp[4] - 100, 50); // up to exactly the L5 threshold
  assert.equal(s.player.level, 5);
  const ups = s.events.filter((e) => e.type === 'levelUp').map((e) => e.level);
  assert.deepEqual(ups, [2, 3, 4, 5]);
});

test('a real harvest awards XP and the level raises yield, quality and cuts tending time', () => {
  const { s, pot } = fresh();
  const pl = ripe(s, pot);
  const b = harvestPlant(s, pl);
  assert.ok(Math.abs(s.player.xp - xpForHarvest(b.grams, b.quality)) < 1e-9);
  const g1 = (() => { const t = fresh(); const p = ripe(t.s, t.pot); return harvestPlant(t.s, p).grams; })();
  const t10 = fresh(); t10.s.player.level = 10;
  const b10 = harvestPlant(t10.s, ripe(t10.s, t10.pot));
  assert.ok(Math.abs(b10.grams / g1 - (1 + M.yieldPerLevel * 9)) < 1e-9);
  assert.ok(Math.abs(1 - M.tendingPerLevel * 9 - 0.64) < 1e-9);
});

test('Blue Haze unlocks on day 8 or L3; Widow Kush on L5', () => {
  const { s } = fresh();
  assert.equal(strainUnlocked(s, 'ditch'), true);
  assert.equal(strainUnlocked(s, 'blue'), false);
  assert.equal(strainUnlocked(s, 'widow'), false);
  assert.ok(!shopStock('hardware', s).some((e) => e.key === 'seeds_blue'));
  assert.equal(buyItem(s, 'seeds_blue').ok, false);
  s.time.day = 8;
  assert.equal(strainUnlocked(s, 'blue'), true);
  s.time.day = 3; s.player.level = 3;
  assert.equal(strainUnlocked(s, 'blue'), true);
  assert.equal(strainUnlocked(s, 'widow'), false);
  s.player.level = 5;
  assert.equal(strainUnlocked(s, 'widow'), true);
  s.time.hour = CONFIG.economy.hardware.open; s.player.cash = 1000;
  assert.equal(buyItem(s, 'seeds_widow').ok, true);
  assert.equal(s.player.inv.seeds_widow, 1);
  assert.deepEqual(plantable(s.player), { strainKey: 'widow' });
  const pot = s.objects.find((o) => o.kind === 'pot');
  const pl = plantSeed(s, pot, 'widow');
  assert.equal(pl.strainName, 'Widow Kush');
  for (const k of ['Y', 'P', 'R', 'S']) assert.ok(Math.abs(pl.genome[k] - baseGenome('widow')[k]) <= CONFIG.genetics.seedVariance);
});

test('perk L9: ripe window is 36 gh', () => {
  const { s, pot } = fresh();
  const pl = ripe(s, pot);
  s.player.level = 9;
  stepPlants(s, GH);
  pl.overHours = 30;
  assert.equal(stageOf(pl), 'ripe');
  pl.overHours = 37;
  assert.equal(stageOf(pl), 'overripe');
  s.player.level = 8;
  stepPlants(s, GH);
  pl.overHours = 30;
  assert.equal(stageOf(pl), 'overripe');
});

test('perk L10: stress damage -20%', () => {
  const run = (level) => {
    const { s, pot } = fresh();
    s.player.level = level;
    const pl = plantSeed(s, pot, 'ditch');
    pl.moisture = 30; pl.nutrients = 10; // nutrientLow stress; moisture still ok
    pl.moisture = 90;                      // + moisture stress
    const h0 = pl.health;
    stepPlants(s, GH);
    return h0 - pl.health;
  };
  assert.ok(Math.abs(run(10) / run(9) - M.stressDamageMult) < 1e-6);
});

test('clones copy the mother, drift by care, and generation = mother + 1', () => {
  const { s, pot } = fresh();
  const mother = plantSeed(s, pot, 'blue');
  mother.progress = 0.3; // vegetative
  assert.ok(canCut(mother));
  const hp = mother.health;
  const rngBefore = s.rngState;
  const c = takeCutting(s, mother);
  assert.equal(s.rngState, rngBefore); // main PRNG stream untouched
  assert.equal(mother.health, hp - CONFIG.genetics.cloneMotherDamage);
  assert.equal(c.generation, 1);
  assert.notEqual(mother.lineId, null);
  assert.equal(c.lineId, mother.lineId);
  for (const k of ['Y', 'P', 'R', 'S']) assert.ok(Math.abs(c.genome[k] - mother.genome[k]) <= 1);
  mother.progress = 0.05; // seedlings cannot be cut
  assert.equal(takeCutting(s, mother), null);

  s.player.level = 7; // always roots
  const pot2 = { id: 9999, kind: 'pot', x: 1, y: 1, soil: 'cheap', soilPh: 6.4 };
  s.objects.push(pot2);
  const clone = plantCutting(s, pot2);
  assert.equal(clone.progress, CONFIG.genetics.cloneStartProgress);
  assert.equal(clone.generation, 1);
  assert.equal(clone.strainName, 'Blue Haze');
  assert.equal(s.player.cuttings.length, 0);
});

test('drift: care 1 only gains, care 0 only loses; ~+0.6/trait/gen at care 1', () => {
  const rng = createRng(5);
  let g = baseGenome('blue');
  const g0 = { ...g };
  for (let i = 0; i < 200; i++) { const n = cloneGenome(g, 'blue', 1, rng); for (const k in g) assert.ok(n[k] >= g[k]); g = n; }
  for (const k in g) assert.ok(g[k] <= g0[k] + CONFIG.genetics.cloneCap && g[k] > g0[k] + 10);
  let h = baseGenome('blue');
  for (let i = 0; i < 20; i++) { const n = cloneGenome(h, 'blue', 0, rng); for (const k in h) assert.ok(n[k] <= h[k]); h = n; }
  let gain = 0;
  const base = baseGenome('blue');
  for (let i = 0; i < 4000; i++) gain += cloneGenome(base, 'blue', 1, rng).Y - base.Y;
  assert.ok(Math.abs(gain / 4000 - CONFIG.genetics.cloneUpChance) < 0.05);
});

test('clone cap: +15 over the strain base, never more', () => {
  const rng = createRng(8);
  const base = baseGenome('widow');
  let g = { ...base };
  for (let i = 0; i < 100; i++) g = cloneGenome(g, 'widow', 1, rng);
  for (const k in base) assert.equal(g[k], Math.min(base[k] + 15, 100));
});

test('cuttings root 85% below L7 and always at L7+', () => {
  const tryRoot = (level, n) => {
    const { s } = fresh();
    s.player.level = level;
    let ok = 0;
    for (let i = 0; i < n; i++) {
      const pot = { id: 5000 + i, kind: 'pot', x: 1, y: 1, soil: 'cheap', soilPh: 6.4 };
      s.objects.push(pot);
      s.player.cuttings.push({ strainKey: 'ditch', genome: baseGenome('ditch'), lineId: 1, generation: 1 });
      if (plantCutting(s, pot)) ok++;
      s.plants.length = 0;
    }
    return ok / n;
  };
  assert.equal(tryRoot(7, 300), 1);
  const r = tryRoot(6, 1000);
  assert.ok(r > 0.8 && r < 0.9, String(r));
});

test('clone harvest compares to the last harvest of the line; journal keeps 20', () => {
  const { s, pot } = fresh();
  const mother = plantSeed(s, pot, 'ditch');
  mother.progress = 0.3;
  takeCutting(s, mother);
  mother.progress = 1; mother.overHours = 0;
  harvestPlant(s, mother);
  s.events.length = 0;
  const pot2 = s.objects.filter((o) => o.kind === 'pot')[1];
  s.player.level = 7;
  const clone = plantCutting(s, pot2);
  clone.progress = 1; clone.overHours = 0;
  harvestPlant(s, clone);
  assert.ok(s.events.find((e) => e.type === 'harvest').lines.some((l) => l.includes('vs. the last of this line')));
  for (let i = 0; i < 30; i++) { pot.plantId = null; harvestPlant(s, ripe(s, pot)); }
  const v = journalView(s);
  assert.equal(v.harvests.length, 20);
  assert.equal(v.level, s.player.level);
});

test('mastery, journal, cuttings and the clone PRNG stream survive save/load', () => {
  const { s, pot } = fresh();
  const mother = plantSeed(s, pot, 'ditch');
  mother.progress = 0.3;
  takeCutting(s, mother);
  harvestPlant(s, ripe(s, s.objects.filter((o) => o.kind === 'pot')[1]));
  const t = deserializeState(serializeState(s));
  assert.equal(t.player.xp, s.player.xp);
  assert.equal(t.player.journal.length, 1);
  assert.equal(t.player.cuttings.length, 1);
  assert.equal(t.genetics.rngState, s.genetics.rngState);
});

test('audio: 24 SFX with real samples under 0.5 s; two music beds + tension', () => {
  assert.equal(SFX_NAMES.length, 24);
  for (const name of SFX_NAMES) {
    const d = CONFIG.audio.sfx[name];
    assert.ok(d.len > 0 && d.len < 0.5 + 1e-9, name);
    const buf = renderSfx(d, 22050);
    assert.ok(buf.length > 0 && buf.some((v) => Math.abs(v) > 0.01), name);
    assert.ok(buf.every((v) => Math.abs(v) <= 1), name);
  }
  assert.deepEqual(MUSIC_BEDS, ['day', 'night']);
  for (const b of MUSIC_BEDS) assert.equal(CONFIG.audio.music[b].notes.length, 8);
  assert.ok(CONFIG.audio.music.tension.freq > 0);
});
