// quality.test.js — the auto step-down ignores loading and one-off stalls.
import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { feedFrame, warmUp, quality, applyLevel } from '../src/quality.js';

const Q = CONFIG.quality;
const run = (seconds, ms, work = 1) => {
  let stepped = null;
  for (let t = 0; t < seconds * 1000; t += ms) stepped = feedFrame(ms, work) ?? stepped;
  return stepped;
};

test('slow frames during the warm-up never step quality down', () => {
  applyLevel(0); warmUp();
  run(Q.warmupS - 0.5, 50, 30);
  assert.equal(quality.level, 0);
});

test('a single stall or one bad window does not step down; sustained slowness does', () => {
  applyLevel(0); warmUp();
  run(Q.warmupS, 16.7);
  feedFrame(500, 400);                       // tab switch / GC stall
  run(Q.windowS, 16.7);
  assert.equal(quality.level, 0);
  run(Q.windowS, 25, 20);                    // one bad window
  run(Q.windowS, 16.7);
  assert.equal(quality.level, 0);
  run(Q.windowS * Q.badWindows, 25, 20);     // sustained
  assert.equal(quality.level, 1);
  applyLevel(0);
});

test('slow frame intervals with light work (compositor, other apps) never step down', () => {
  applyLevel(0); warmUp();
  run(Q.warmupS, 16.7);
  run(Q.windowS * Q.badWindows * 5, 30, 2);  // 33 fps, the game itself idle: lowering effects cannot help
  assert.equal(quality.level, 0);
});
