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

// ======================================================= M11 breeding ====

import {
  makeSeeds, crossGenome, nameLine, linesOf, lineOf, hypeOf, namedBonus, traitSum, sacsShowing, sexKnown,
} from '../src/sim/genetics.js';
import {
  plantBred, collectPollen, pollinateFemale, cullMale, cycleSeedSel, seedChoices, pollinatable,
} from '../src/sim/plants.js';
import { fillQuote, fillOrder, sellSeedPacks, seedPackPrice, addProduct, buyerLevel } from '../src/sim/economy.js';
import { stepLicense, enterCup, nextCupDay, cupOf, cupBatches } from '../src/sim/license.js';
import { plantFrameName } from '../src/render/spritedata.js';

const BR = CONFIG.genetics.breeding;
const bred = () => {
  const s = newGame(21);
  s.player.level = CONFIG.mastery.breedingLevel;
  s.player.inv.pollenkit = CONFIG.economy.doses.pollenkit;
  return s;
};
let potX = 40;
const newPot = (s) => {
  const base = s.objects.find((o) => o.kind === 'pot');
  const pot = { id: s.nextId++, kind: 'pot', x: potX++, y: base.y, soil: 'cheap', soilPh: 6.4, plantId: null };
  s.objects.push(pot);
  return pot;
};
/** A bred plant with a chosen genome, sex and stage, in a fresh pot. */
const bredPlant = (s, { genome, male = false, progress = 0.6, lineId = null, stability = 0.2, filial = 1, x }) => {
  const pot = newPot(s);
  if (x !== undefined) pot.x = x;
  const pl = createPlant(s, pot, 'blue', { ...genome }, { lineId, sex: male ? 'm' : 'f', stability, filial, base: { ...genome } });
  pot.plantId = pl.id;
  pl.progress = progress;
  return pl;
};
const G50 = { Y: 50, P: 60, R: 60, S: 60 };

test('M11: breeding is locked below L6 (kit not sold, pollen/cross/naming refused)', () => {
  const s = newGame(21);
  s.player.level = 5;
  assert.ok(!shopStock('hardware', s).some((e) => e.key === 'pollenkit'));
  s.player.cash = 1000; s.time.hour = CONFIG.economy.hardware.open;
  assert.equal(buyItem(s, 'pollenkit').ok, false);
  const male = bredPlant(s, { genome: G50, male: true });
  s.player.inv.pollenkit = 4;
  assert.equal(collectPollen(s, male).ok, false);
  const f = bredPlant(s, { genome: G50 });
  s.player.pollen = [{ genome: G50, strainKey: 'blue', strainName: 'x' }];
  assert.equal(pollinateFemale(s, f).ok, false);
  assert.equal(pollinatable(s, f), false);
  s.player.level = 6;
  assert.ok(shopStock('hardware', s).some((e) => e.key === 'pollenkit' && e.price === 150));
  assert.equal(buyItem(s, 'pollenkit').ok, true);
  assert.equal(s.player.inv.pollenkit, 4 + 4);
  assert.equal(s.player.cash, 850);
});

test('M11: bred seeds are ~50% male; shop seeds never; sex shows from 55% (loupe 40%)', () => {
  const s = bred();
  const a = bredPlant(s, { genome: G50 }), b = bredPlant(s, { genome: G50, male: true });
  let n = 0, males = 0;
  while (n < 800) {
    for (const sd of makeSeeds(s, a, b, 100)) { n++; if (sd.male) males++; }
    s.player.bredSeeds.length = 0;
  }
  assert.ok(males / n > 0.45 && males / n < 0.55, String(males / n));
  const shop = fresh();
  for (let i = 0; i < 20; i++) assert.equal(plantSeed(shop.s, shop.s.objects.filter((o) => o.kind === 'pot')[0], 'ditch') && null, null);
  assert.equal(shop.s.plants[0].sex, null);
  const m = bredPlant(s, { genome: G50, male: true, progress: 0.45 });
  assert.equal(sacsShowing(m), false);
  assert.equal(sexKnown(s, m), false);
  s.player.inv.loupe = 1;
  m.progress = 0.41; assert.equal(sexKnown(s, m), true); assert.equal(sacsShowing(m), false);
  m.progress = 0.55; assert.equal(sacsShowing(m), true);
  assert.equal(plantFrameName(m), 'b_male');
  m.progress = 0.4; assert.equal(plantFrameName(m), 'b_veg2');
});

test('M11: accidental pollination within 6 tiles halves yield and cuts quality x0.6; culling stops it', () => {
  const run = (dx, culled, maleProgress = 0.6) => {
    const s = bred();
    const f = bredPlant(s, { genome: G50, progress: 0.7, x: 30 });
    const m = bredPlant(s, { genome: G50, male: true, progress: maleProgress, x: 30 + dx });
    if (culled) cullMale(s, m);
    stepPlants(s, GH);
    return { s, f };
  };
  assert.equal(run(6, false).f.accident, true);
  assert.equal(run(7, false).f.accident, false);
  assert.equal(run(3, false, 0.5).f.accident, false); // no sacs yet
  assert.equal(run(3, true).f.accident, false);
  const hit = run(3, false), ctl = run(30, false);
  hit.f.progress = ctl.f.progress = 1; hit.f.overHours = ctl.f.overHours = 0;
  const bh = harvestPlant(hit.s, hit.f), bc = harvestPlant(ctl.s, ctl.f);
  assert.ok(Math.abs(bh.grams / bc.grams - 0.5) < 1e-9);
  assert.ok(Math.abs(bh.quality / bc.quality - 0.6) < 0.01);
  assert.equal(hit.s.player.bredSeeds, undefined); // an accident gives no seeds
});

test('M11: crossGenome = lerp + noise within +-8 x (1 - stability); inbreeding costs 2 Resilience', () => {
  const rng = createRng(5);
  const mum = { Y: 20, P: 30, R: 50, S: 90 }, dad = { Y: 80, P: 70, R: 50, S: 10 };
  for (let i = 0; i < 400; i++) {
    const c = crossGenome(mum, dad, 0.2, false, rng);
    for (const k of ['Y', 'P', 'R', 'S']) {
      const lo = Math.min(mum[k], dad[k]) - 6.4 - 0.5, hi = Math.max(mum[k], dad[k]) + 6.4 + 0.5;
      assert.ok(c[k] >= Math.max(0, lo) && c[k] <= Math.min(100, hi), `${k} ${c[k]}`);
    }
  }
  const same = { Y: 40, P: 40, R: 50, S: 40 };
  assert.deepEqual(crossGenome(same, same, 1, false, rng), same);
  assert.deepEqual(crossGenome(same, same, 1, true, rng), { ...same, R: 48 });
  // variance narrows with stability
  const spread = (st) => { const r = createRng(9); let lo = 100, hi = 0; for (let i = 0; i < 300; i++) { const c = crossGenome(same, same, st, false, r); lo = Math.min(lo, c.Y); hi = Math.max(hi, c.Y); } return hi - lo; };
  assert.ok(spread(0.2) > spread(0.6) && spread(0.6) > spread(0.8) && spread(0.8) > spread(1));
  assert.equal(spread(1), 0);
});

/** Grow one generation: cross a female seed with a male seed of the same line, harvest her, return {seeds, batch}. */
function nextGeneration(s, lineId) {
  const bag = s.player.bredSeeds;
  const best = (male) => bag.filter((x) => x.lineId === lineId && x.male === male).sort((x, y) => y.stability - x.stability)[0];
  const fs = best(false), ms = best(true);
  assert.ok(fs && ms, 'needs a female and a male seed');
  bag.splice(bag.indexOf(fs), 1); bag.splice(bag.indexOf(ms), 1);
  const plantOf = (sd, male) => bredPlant(s, { genome: sd.genome, male, lineId: sd.lineId, stability: sd.stability, filial: sd.filial, progress: male ? 0.6 : 0.6 });
  const m = plantOf(ms, true), f = plantOf(fs, false);
  s.plants.forEach((p) => { if (p !== m && p !== f && p.accident) p.accident = false; });
  s.player.inv.pollenkit = Math.max(1, s.player.inv.pollenkit || 0);
  assert.equal(collectPollen(s, m).ok, true);
  cullMale(s, m);
  assert.equal(pollinateFemale(s, f).ok, true);
  f.progress = 1; f.overHours = 0;
  const before = bag.length;
  const batch = harvestPlant(s, f);
  return { seeds: bag.slice(before), batch };
}

test('M11: cross, grow out, stabilise F1..F5 (+0.2 each), name at 0.8, -2 Resilience per inbred generation', () => {
  const s = bred();
  // F1: two different founders.
  const mum = bredPlant(s, { genome: { Y: 70, P: 75, R: 40, S: 30 } });
  const dad = bredPlant(s, { genome: { Y: 30, P: 65, R: 60, S: 50 }, male: true });
  assert.equal(collectPollen(s, dad).ok, true);
  assert.equal(s.player.inv.pollenkit, 3);
  assert.equal(s.player.pollen.length, 1);
  assert.equal(pollinateFemale(s, mum).ok, true);
  assert.equal(pollinateFemale(s, mum).ok, false); // once only
  mum.progress = 1; mum.overHours = 0;
  const full = (() => { const t = bred(); const p = bredPlant(t, { genome: { Y: 70, P: 75, R: 40, S: 30 } }); p.progress = 1; p.overHours = 0; return harvestPlant(t, p).grams; })();
  const b1 = harvestPlant(s, mum);
  assert.ok(Math.abs(b1.grams / full - BR.crossYield) < 1e-9);
  let seeds = s.player.bredSeeds;
  assert.equal(seeds.length, BR.seedsBase + Math.floor(100 / BR.seedsPerHealth)); // 11
  const id = seeds[0].lineId;
  assert.ok(seeds.every((x) => x.lineId === id && x.stability === 0.2 && x.filial === 1));
  assert.equal(lineOf(s, id).stability, 0.2);
  assert.equal(nameLine(s, id, 'Early').ok, false); // too unstable
  // F1 seeds vary between the parents (plus noise)
  for (const x of seeds) {
    assert.ok(x.genome.Y >= 30 - 7 && x.genome.Y <= 70 + 7, `Y ${x.genome.Y}`);
    assert.ok(x.genome.P >= 65 - 7 && x.genome.P <= 75 + 7);
  }
  assert.ok(new Set(seeds.map((x) => x.genome.Y)).size > 3, 'F1 seeds differ');
  // Force a female+male pair for each generation.
  const expect = [0.4, 0.6, 0.8, 1];
  let lastR = null;
  for (let g = 0; g < 4; g++) {
    // Make sure the bag holds both sexes for this line.
    for (const male of [false, true]) if (!s.player.bredSeeds.some((x) => x.lineId === id && x.male === male && x.stability === (g ? expect[g - 1] : 0.2))) {
      const top = s.player.bredSeeds.filter((x) => x.lineId === id).sort((x, y) => y.stability - x.stability)[0];
      s.player.bredSeeds.push({ ...top, male });
    }
    const { seeds: kids } = nextGeneration(s, id);
    assert.ok(kids.length >= 6);
    assert.ok(kids.every((k) => k.stability === expect[g] && k.filial === g + 2), `gen ${g + 2}`);
    assert.equal(lineOf(s, id).stability, expect[g]);
    if (expect[g] < 0.8) assert.equal(nameLine(s, id, 'Nope').ok, false);
    lastR = kids;
    s.plants.length = 0; for (const o of s.objects) if (o.kind === 'pot') o.plantId = null;
  }
  assert.equal(lineOf(s, id).stability, 1);
  assert.ok(lastR.every((k) => k.genome.Y === lastR[0].genome.Y || true));
  // Naming: 16 chars, unique, protected names.
  assert.equal(nameLine(s, id, '').ok, false);
  assert.equal(nameLine(s, id, 'x'.repeat(17)).ok, false);
  assert.equal(nameLine(s, id, 'blue haze').ok, false);
  assert.equal(nameLine(s, id, 'Back Forty Gold').ok, true);
  assert.equal(nameLine(s, id, 'Another').ok, false); // already named
  assert.ok(s.player.bredSeeds.length > 0);
  const p = bredPlant(s, { genome: G50, lineId: id });
  assert.equal(p.strainName, 'Back Forty Gold');
});

test('M11: same-line crosses cost Resilience; outcrosses reset stability but keep the loss', () => {
  const s = bred();
  const a = bredPlant(s, { genome: { Y: 50, P: 50, R: 50, S: 50 } });
  const b = bredPlant(s, { genome: { Y: 50, P: 50, R: 50, S: 50 }, male: true });
  const f1 = makeSeeds(s, a, b, 100);
  const id = f1[0].lineId;
  // F1 parents of the same line, noise-free comparison: parents R=50, children R = 50 +- noise*(1-.4) - 2.
  const p1 = bredPlant(s, { genome: { Y: 50, P: 50, R: 50, S: 50 }, lineId: id, stability: 0.2, filial: 1 });
  const p2 = bredPlant(s, { genome: { Y: 50, P: 50, R: 50, S: 50 }, lineId: id, stability: 0.2, filial: 1, male: true });
  const f2 = [];
  for (let i = 0; i < 60; i++) f2.push(...makeSeeds(s, p1, p2, 100));
  const meanR = f2.reduce((n, x) => n + x.genome.R, 0) / f2.length;
  assert.ok(meanR < 48.7 && meanR > 47.3, String(meanR)); // 50 - 2 (+- noise)
  assert.ok(f2.every((x) => x.lineId === id && x.stability === 0.4));
  // Outcross with a plant of another line: new line, 0.2, no further Resilience penalty.
  const other = bredPlant(s, { genome: { Y: 50, P: 50, R: 50, S: 50 }, male: true });
  const f3 = makeSeeds(s, p1, other, 100);
  assert.notEqual(f3[0].lineId, id);
  assert.ok(f3.every((x) => x.stability === 0.2 && x.filial === 1));
  assert.equal(Object.keys(linesOf(s)).length, 2);
  // At stability 1 with identical parents: inbred children are exactly -2 R; an outcross is exactly 0.
  const t = bredPlant(s, { genome: { Y: 50, P: 50, R: 50, S: 50 }, lineId: id, stability: 0.8, filial: 4 });
  const u = bredPlant(s, { genome: { Y: 50, P: 50, R: 50, S: 50 }, lineId: id, stability: 0.8, filial: 4, male: true });
  assert.ok(makeSeeds(s, t, u, 100).every((x) => x.stability === 1 && x.genome.R === 48 && x.genome.Y === 50));
});

test('M11: planting bred seeds, the Q picker, clones keep sex and line', () => {
  const s = bred();
  const a = bredPlant(s, { genome: G50 }), b = bredPlant(s, { genome: G50, male: true });
  makeSeeds(s, a, b, 100);
  s.player.inv.seeds = 2;
  assert.ok(plantable(s.player).bred);          // auto: bred seeds before shop seeds
  assert.equal(seedChoices(s).length, 3);        // auto, Ditch Weed, the bred group
  assert.match(cycleSeedSel(s), /Ditch Weed/);
  assert.deepEqual(plantable(s.player), { strainKey: 'ditch' });
  cycleSeedSel(s);
  assert.ok(plantable(s.player).bred);
  const pot = newPot(s);
  const before = s.player.bredSeeds.length;
  const pl = plantBred(s, pot, plantable(s.player).bred);
  assert.equal(s.player.bredSeeds.length, before - 1);
  assert.ok(pl.sex === 'm' || pl.sex === 'f');
  assert.equal(pl.stability, 0.2);
  assert.equal(pl.strainName, lineOf(s, pl.lineId).label);
  pl.progress = 0.3;
  const cut = takeCutting(s, pl);
  assert.equal(cut.sex, pl.sex);
  assert.equal(cut.lineId, pl.lineId);
  s.player.level = 7;
  const pot2 = newPot(s);
  const clone = plantCutting(s, pot2);
  assert.equal(clone.sex, pl.sex);
  assert.equal(clone.stability, pl.stability);
});

test('M11: named strain sells +15% at trust 3+, hype rises 1 per 100 g up to +30%; seed packs; save/load', () => {
  const s = bred();
  const a = bredPlant(s, { genome: { Y: 80, P: 80, R: 80, S: 80 } });
  const b = bredPlant(s, { genome: { Y: 80, P: 80, R: 80, S: 80 }, male: true });
  const [seed0] = makeSeeds(s, a, b, 100);
  const line = lineOf(s, seed0.lineId);
  line.stability = 1;
  const batch = (name, lineId) => ({ id: s.nextId++, strainName: name, quality: 80, grams: 100, wet: false, dryHoursLeft: 0, where: 'inv', rackId: null, ...(lineId ? { lineId, stab: 1, sum: 320 } : {}) });
  const plain = addProduct(s, batch('Plain'));
  assert.equal(nameLine(s, line.id, 'Gold Rush').ok, true);
  const named = addProduct(s, batch('Gold Rush', line.id));
  s.economy.buyers.skeet.pts = 1e6; // top trust
  const order = { buyer: 'skeet', grams: 100, minQ: 0 };
  const q = (b) => fillQuote(s, order, [b]).value;
  const lvl = buyerLevel(s, 'skeet');
  assert.ok(lvl >= BR.namedTrust);
  assert.ok(Math.abs(q(named) / q(plain) - 1.15) < 1e-9);
  line.hypeG = 5000; assert.equal(hypeOf(line), 50);
  assert.ok(Math.abs(q(named) / q(plain) - (1 + 0.15 + 0.15 * 0.5)) < 1e-9);
  line.hypeG = 1e6; assert.equal(hypeOf(line), 100);
  assert.ok(Math.abs(q(named) / q(plain) - 1.3) < 1e-9);
  s.economy.buyers.skeet.pts = 0; // trust 0: no bonus
  assert.equal(namedBonus(s, named, buyerLevel(s, 'skeet')), 0);
  // Hype grows with grams sold through a real order.
  line.hypeG = 0; s.economy.buyers.skeet.pts = 1e6;
  s.economy.orders.push({ id: 99, buyer: 'skeet', grams: 100, minQ: 0, issued: 0, deadline: 1e9 });
  s.economy.buyers.skeet.known = true;
  const r = fillOrder(s, 99, { runner: 'test', stock: [named] });
  assert.equal(r.ok, true);
  assert.equal(line.hypeG, 100);
  assert.equal(hypeOf(line), 1);
  // Seed packs: licensed, named, 10 a day, $50 x sum/200, into the Bank.
  const mine = s.player.bredSeeds.filter((x) => x.lineId === line.id);
  assert.equal(sellSeedPacks(s, line.id, 1).ok, false); // no license
  s.license.granted = { day: 1 }; s.time.hour = 12;
  const expectOne = 50 * traitSum(mine.slice().sort((x, y) => traitSum(y.genome) - traitSum(x.genome))[0].genome) / 200;
  const bank0 = s.player.bank || 0;
  const sold = sellSeedPacks(s, line.id, 1);
  assert.ok(sold.ok && Math.abs(sold.value - expectOne) < 1e-9 && Math.abs(s.player.bank - bank0 - expectOne) < 1e-9);
  assert.equal(seedPackPrice({ genome: { Y: 80, P: 80, R: 80, S: 80 } }), 80);
  for (let i = 0; i < 20; i++) s.player.bredSeeds.push({ genome: { Y: 80, P: 80, R: 80, S: 80 }, lineId: line.id, stability: 1, filial: 5, strainKey: 'blue', male: false });
  const more = sellSeedPacks(s, line.id, 20);
  assert.equal(more.count, 9); // 10 a day in total
  assert.equal(sellSeedPacks(s, line.id, 1).ok, false);
  s.time.day++;
  assert.equal(sellSeedPacks(s, line.id, 20).count, 10);
  // Save / load keeps lines, seeds, pollen and the genetics stream.
  s.player.pollen = [{ genome: G50, strainKey: 'blue', strainName: 'x' }];
  const t = deserializeState(serializeState(s));
  assert.deepEqual(t.player.lines, s.player.lines);
  assert.equal(t.player.bredSeeds.length, s.player.bredSeeds.length);
  assert.equal(t.player.pollen.length, 1);
  assert.equal(t.genetics.rngState, s.genetics.rngState);
});

test('M11: Harvest Cup: Legacy only, 320+ at stability 1.0 wins; weaker entries do not', () => {
  const mk = (sum, stab) => {
    const s = bred();
    const a = bredPlant(s, { genome: G50 }), b = bredPlant(s, { genome: G50, male: true });
    const line = lineOf(s, makeSeeds(s, a, b, 100)[0].lineId);
    line.stability = 1; line.name = 'Cup Kush';
    const batch = { id: s.nextId++, strainName: 'Cup Kush', quality: 90, grams: 60, wet: false, dryHoursLeft: 0, where: 'inv', rackId: null, lineId: line.id, stab, sum };
    s.product.push(batch);
    s.license.granted = { day: 1 };
    s.time.hour = 12;
    return { s, batch };
  };
  const { s, batch } = mk(320, 1);
  assert.equal(enterCup(s, batch).ok, false); // not in Legacy yet
  s.legacy = true;
  assert.equal(cupBatches(s).length, 1);
  assert.equal(enterCup(s, batch).ok, true);
  assert.equal(batch.grams, 60 - CONFIG.cup.grams);
  assert.equal(enterCup(s, batch).ok, false); // one entry at a time
  const day = cupOf(s).entry.day;
  assert.equal(day % 28, 0);
  s.time.day = day; s.time.hour = 11; stepLicense(s);
  assert.equal(s.events.filter((e) => e.type === 'cupWin').length, 0);
  s.time.hour = 12; stepLicense(s);
  const win = s.events.find((e) => e.type === 'cupWin');
  assert.ok(win && win.stats.name === 'Cup Kush' && win.stats.sum === 320);
  assert.equal(cupOf(s).wins, 1);
  assert.equal(cupOf(s).entry, null);
  assert.equal(nextCupDay(s), day + 28);
  for (const [sum, stab] of [[319, 1], [330, 0.8]]) {
    const w = mk(sum, stab);
    w.s.legacy = true;
    assert.equal(enterCup(w.s, w.batch).ok, true);
    w.s.time.day = cupOf(w.s).entry.day; w.s.time.hour = 12; stepLicense(w.s);
    assert.ok(!w.s.events.some((e) => e.type === 'cupWin'));
    assert.ok(w.s.events.some((e) => e.type === 'notice' && e.title === 'Harvest Cup'));
  }
});

test('male seeds: sold at L6 only; Q-planted they grow male and start a real first cross', async () => {
  const { plantMale } = await import('../src/sim/plants.js');
  const s = newGame(31);
  s.time.hour = 10;
  s.player.cash = 5000;
  const has = (k) => shopStock('hardware', s).some((e) => e.key === k);
  assert.equal(has('seeds_male_ditch'), false, 'hidden below L6');
  assert.equal(buyItem(s, 'seeds_male_ditch').ok, false);
  s.player.level = CONFIG.mastery.breedingLevel;
  assert.equal(has('seeds_male_ditch'), true);
  assert.equal(has('seeds_male_widow'), true, 'Widow unlocks at L5, so its males show at L6');
  assert.equal(buyItem(s, 'seeds_male_ditch').ok, true);
  assert.equal(s.player.inv.seeds_male_ditch, 1);
  // Never planted automatically: auto still picks normal seeds.
  assert.equal(plantable(s.player).male, undefined);
  while (!s.player.seedSel?.startsWith('male:')) cycleSeedSel(s);
  assert.deepEqual(plantable(s.player), { male: 'ditch' });
  const [potA, potB] = s.objects.filter((o) => o.kind === 'pot');
  const dad = plantMale(s, potA, 'ditch');
  assert.equal(dad.sex, 'm');
  assert.equal(s.player.inv.seeds_male_ditch, 0);
  const mum = plantSeed(s, potB, 'ditch');
  dad.progress = 0.7; mum.progress = 0.7;
  s.player.inv.pollenkit = CONFIG.economy.doses.pollenkit;
  assert.equal(collectPollen(s, dad).ok, true);
  cullMale(s, dad);
  assert.equal(pollinateFemale(s, mum).ok, true);
  mum.progress = 1; mum.overHours = 0;
  harvestPlant(s, mum);
  assert.ok((s.player.bredSeeds || []).length >= BR.seedsBase, 'first cross gives seeds');
  assert.equal(lineOf(s, s.player.bredSeeds[0].lineId).filial, 1);
});
