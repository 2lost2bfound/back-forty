import test from 'node:test';
import assert from 'node:assert/strict';

import { createRng } from '../src/rng.js';

test('same seed produces the same sequence (determinism)', () => {
  const a = createRng(1337);
  const b = createRng(1337);
  for (let i = 0; i < 100; i++) assert.equal(a.next(), b.next());
});

test('different seeds diverge', () => {
  const a = createRng(1);
  const b = createRng(2);
  const seqA = Array.from({ length: 8 }, () => a.next());
  const seqB = Array.from({ length: 8 }, () => b.next());
  assert.notDeepEqual(seqA, seqB);
});

test('next() stays within [0, 1)', () => {
  const rng = createRng(42);
  for (let i = 0; i < 10000; i++) {
    const v = rng.next();
    assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
  }
});

test('int() stays within [0, maxExclusive) and hits both ends', () => {
  const rng = createRng(7);
  const seen = new Set();
  for (let i = 0; i < 10000; i++) {
    const v = rng.int(6);
    assert.ok(v >= 0 && v < 6 && Number.isInteger(v));
    seen.add(v);
  }
  assert.deepEqual([...seen].sort(), [0, 1, 2, 3, 4, 5]);
});

test('range() stays within [min, max)', () => {
  const rng = createRng(99);
  for (let i = 0; i < 10000; i++) {
    const v = rng.range(-5, 10);
    assert.ok(v >= -5 && v < 10, `out of range: ${v}`);
  }
});

test('intRange() is inclusive on both ends', () => {
  const rng = createRng(3);
  const seen = new Set();
  for (let i = 0; i < 10000; i++) seen.add(rng.intRange(2, 4));
  assert.deepEqual([...seen].sort(), [2, 3, 4]);
});

test('chance(0) is never true, chance(1) is always true', () => {
  const rng = createRng(11);
  for (let i = 0; i < 1000; i++) {
    assert.equal(rng.chance(0), false);
    assert.equal(rng.chance(1), true);
  }
});

test('pick() only returns elements of the array', () => {
  const rng = createRng(5);
  const arr = ['a', 'b', 'c'];
  for (let i = 0; i < 1000; i++) assert.ok(arr.includes(rng.pick(arr)));
});

test('state is serializable and restorable (save determinism)', () => {
  const a = createRng(2026);
  for (let i = 0; i < 10; i++) a.next();
  const saved = JSON.parse(JSON.stringify({ rngState: a.state })).rngState;

  const b = createRng(0);
  b.state = saved;
  for (let i = 0; i < 10; i++) assert.equal(a.next(), b.next());
});
