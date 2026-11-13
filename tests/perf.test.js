// perf.test.js — music-bed oscillator types, rolling perf stats, the F4 stress scene.

import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { createPerf } from '../src/perf.js';
import { newGame } from '../src/state.js';
import { stepSim } from '../src/sim/sim.js';
import { startStress, stepStress, stopStress } from '../src/dev/stress.js';
import { lampOn } from '../src/sim/plants.js';

const VALID_OSC = ['sine', 'square', 'sawtooth', 'triangle'];

test('every music-bed wave maps to a valid OscillatorType', () => {
  const A = CONFIG.audio;
  for (const [bed, M] of Object.entries(A.music)) {
    if (!M.wave) continue;
    assert.ok(VALID_OSC.includes(A.oscTypes[M.wave]), `${bed}: ${M.wave} -> ${A.oscTypes[M.wave]}`);
  }
  // SFX keep the config names (own buffer renderer), all of which must be mapped too.
  for (const [name, d] of Object.entries(A.sfx)) assert.ok(A.oscTypes[d.wave], `sfx ${name}: ${d.wave}`);
});

test('perf stats: rolling work avg/max, over-20 and dropped counts, reset', () => {
  const P = createPerf();
  for (let i = 0; i < 100; i++) P.record(5, 16.7);
  P.record(25, 16.7);           // work over 20 ms
  P.record(5, 40);              // dropped (> 1.5 x display interval)
  assert.equal(P.samples, 102);
  assert.equal(P.over20, 1);
  assert.equal(P.dropped, 1);
  assert.equal(P.workMax, 25);
  assert.equal(P.runWorkMax, 25);
  assert.ok(P.workAvg > 5 && P.workAvg < 7);
  assert.ok(Math.abs(P.displayMs - 16.7) < 0.5, `display ${P.displayMs}`);
  P.reset();
  assert.equal(P.samples, 0);
  assert.equal(P.over20 + P.dropped + P.workMax + P.runWorkMax, 0);
});

test('F4 stress scene: 40 entities, 60 plants, 12 lit lamps, night; off restores the world', () => {
  const s = newGame(1337);
  const before = {
    objs: s.objects.length, plants: s.plants.length, ents: s.entities.length,
    hour: s.time.hour, day: s.time.day, weather: s.time.weather,
  };
  const r = startStress(s, 40 * CONFIG.world.tile);
  assert.ok(r);
  assert.equal(s.entities.filter((e) => e.kind === 'stress').length, CONFIG.stress.entities);
  assert.equal(s.plants.length, CONFIG.stress.plants);
  const lamps = s.objects.filter((o) => o.kind === 'lamp');
  assert.equal(lamps.length, CONFIG.stress.lights);
  assert.ok(lamps.every((l) => lampOn(l, CONFIG.stress.hour)), 'lamps lit at the pinned hour');
  assert.ok(s.stressOn);
  // the real sim and the stress step run without error and hold the clock
  for (let i = 0; i < 120; i++) { stepStress(s, 1 / 60); if (i % 30 === 0) stepSim(s, 0.5); }
  assert.equal(s.time.hour, CONFIG.stress.hour);
  assert.equal(startStress(s, 0), null, 'second start is a no-op');
  stopStress(s);
  assert.equal(s.objects.length, before.objs);
  assert.equal(s.plants.length, before.plants);
  assert.equal(s.entities.length, before.ents);
  assert.equal(s.time.hour, before.hour);
  assert.equal(s.time.day, before.day);
  assert.equal(s.time.weather, before.weather);
  assert.ok(!s.stressOn);
});
