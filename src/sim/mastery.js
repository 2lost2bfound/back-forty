// mastery.js — Grower level, XP, perks, strain unlocks, the grower's journal
// (plan §A10). Pure module: runs unmodified in Node.

import { CONFIG } from '../config.js';

const M = CONFIG.mastery;

/** Level for a total XP (1..10). */
export function levelFor(xp) {
  let lv = 1;
  for (let i = 1; i < M.levelXp.length; i++) if (xp >= M.levelXp[i]) lv = i + 1;
  return lv;
}

export const levelOf = (state) => state.player.level || 1;
export const hasLevel = (state, lv) => levelOf(state) >= lv;

/** XP for one harvest: dry grams x (0.5 + quality/100). */
export const xpForHarvest = (grams, quality) => grams * (M.xpBase + quality / 100);

/** Add XP, raise the level, and queue a level-up event per level gained. */
export function addXp(state, grams, quality) {
  const p = state.player;
  p.xp = (p.xp || 0) + xpForHarvest(grams, quality);
  const lv = levelFor(p.xp);
  while ((p.level || 1) < lv) {
    p.level = (p.level || 1) + 1;
    state.events.push({ type: 'levelUp', level: p.level, perk: M.perks[p.level] || null });
  }
}

/** Blue Haze: day 8 or L3. Widow Kush: L5. Ditch Weed: always. */
export function strainUnlocked(state, key) {
  const u = CONFIG.strains[key].unlock;
  if (!u) return true;
  return (u.day !== undefined && state.time.day >= u.day) || (u.level !== undefined && hasLevel(state, u.level));
}

export const journalOf = (state) => state.player.journal || (state.player.journal = []);

/** Record a harvest; keeps the last `journalMax`. Returns the previous harvest of the same line (or null). */
export function recordHarvest(state, entry) {
  const p = state.player;
  const j = journalOf(state);
  j.push(entry);
  while (j.length > M.journalMax) j.shift();
  if (entry.lineId == null) return null;
  const last = p.lineLast || (p.lineLast = {});
  const prev = last[entry.lineId] || null;
  last[entry.lineId] = { grams: entry.grams, quality: entry.quality };
  return prev;
}

/** Everything the journal screen shows. */
export function journalView(state) {
  const p = state.player;
  const lv = levelOf(state);
  const next = M.levelXp[lv] ?? null; // null at max level
  return {
    level: lv, xp: p.xp || 0, levelStart: M.levelXp[lv - 1], nextXp: next,
    perks: Object.keys(M.perks).map((k) => ({ level: +k, text: M.perks[k], got: lv >= +k })),
    harvests: journalOf(state),
  };
}
