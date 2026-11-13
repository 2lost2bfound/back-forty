// license.js — M4 scope only: the arrest counter and the Prison lose
// condition (plan §A15). Laundering, the front and the license are M10.

import { CONFIG } from '../config.js';

/** Third arrest = game over. Idempotent. */
export function checkLose(state) {
  if (!state.gameOver && (state.player.arrests || 0) >= CONFIG.heat.raid.maxArrests) {
    state.gameOver = { reason: 'prison' };
    state.events.push({ type: 'gameOver', reason: 'prison' });
  }
}
