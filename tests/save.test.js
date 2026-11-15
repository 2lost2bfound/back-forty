// save.test.js — M2: RLE codec, save/load round trip, autosave rotation.
import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import {
  newGame, rleEncode, rleDecode, saveGame, loadGame, autosave, autoKey, slotKey,
  serializeState, deserializeState,
} from '../src/state.js';
import { stepTime } from '../src/sim/time.js';
import { stepPlants, plantSeed } from '../src/sim/plants.js';

const mockStorage = (limit = Infinity) => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { if (v.length > limit) throw new Error('quota'); m.set(k, v); },
    removeItem: (k) => m.delete(k),
  };
};

test('RLE round-trips the world tiles', () => {
  const s = newGame(1);
  assert.deepEqual(rleDecode(rleEncode(s.tiles)), s.tiles);
});

test('save/load restores everything and the sim continues identically', () => {
  const s = newGame(3);
  const pot = s.objects.find((o) => o.kind === 'pot');
  plantSeed(s, pot, 'ditch');
  s.player.cash = 123;
  for (let i = 0; i < 400; i++) { stepTime(s, 0.5); stepPlants(s, 0.5 / CONFIG.clock.secPerGh); }
  const st = mockStorage();
  assert.ok(saveGame(s, slotKey(1), st).ok);
  const r = loadGame(slotKey(1), st);
  assert.equal(serializeState(r), serializeState(s));
  for (const x of [s, r]) for (let i = 0; i < 100; i++) { stepTime(x, 0.5); stepPlants(x, 0.5 / CONFIG.clock.secPerGh); }
  assert.equal(serializeState(r), serializeState(s));
});

test('save stays under the size budget', () => {
  assert.ok(serializeState(newGame(1)).length < CONFIG.limits.saveBytes);
});

test('missing or corrupt saves load as null; quota failure is reported', () => {
  const st = mockStorage();
  assert.equal(loadGame('nope', st), null);
  st.setItem('bad', '{not json');
  assert.equal(loadGame('bad', st), null);
  const r = saveGame(newGame(1), 'x', mockStorage(10));
  assert.equal(r.ok, false);
  assert.ok(r.json);
});

test('autosave rolls across three slots', () => {
  const st = mockStorage();
  const s = newGame(1);
  for (let d = 1; d <= 4; d++) { s.player.cash = d; autosave(s, st); }
  const cash = (n) => loadGame(autoKey(n), st).player.cash;
  assert.deepEqual([cash(1), cash(2), cash(3)], [4, 3, 2]);
});

test('old saves (2-tile doors, 22 px player) load with 3-tile doors and a tall player', () => {
  const state = newGame(7);
  const COLS = CONFIG.world.cols;
  const shack = CONFIG.world.buildings[0];
  const dx = shack.x + shack.w - 1;
  const top = (state.surface[dx] - 3) * COLS + dx;
  state.tiles[top] = state.tiles[top - COLS]; // re-close the third door row, as old worlds had it
  const feet = state.player.y + state.player.h;
  state.player.h = 22;
  state.player.y = feet - 22;
  const o = deserializeState(serializeState(state));
  assert.equal(o.tiles[top], 0, 'third door row opened');
  assert.equal(o.player.h, CONFIG.player.h);
  assert.equal(o.player.y + o.player.h, feet, 'feet stay put');
});
