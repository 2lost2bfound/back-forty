// combat.js — weapons, bullets, damage, KO vs kill, noise heat, police (plan §A9).
// Pure module: no window/document. The player's weapon state lives on
// state.player (hp, mag, reload, fireCd, downed); bullets are runtime-only in
// state.bullets (pooled, max CONFIG.limits.bullets); hostile humans are plain
// objects in state.entities (thieves, bikers; goons arrive with M6).
//
// Enemy fire is a hit-cone roll (plan §B6), not a flying bullet: only the
// player's shots are projectiles, so the sim step can run without physics.

import { CONFIG } from '../config.js';
import { withStateRng } from '../rng.js';
import { tileAt, isSolidId } from '../world/tiles.js';
import { raycastSolid } from '../world/physics.js';
import { noiseMult, nightKey } from '../sim/time.js';
import { heatEvent, hs, arrestPlayer, payFine } from '../sim/heat.js';

const W = CONFIG.weapons;
const C = CONFIG.combat;
const TS = CONFIG.world.tile;
const Z = CONFIG.world.zones;

export const isWeapon = (key) => !!W[key];
export const isGun = (key) => !!W[key] && !W[key].melee;
export const groundY = (state, x) => state.surface[Math.max(0, Math.min(CONFIG.world.cols - 1, (x / TS) | 0))] * TS;
const playerCx = (p) => p.x + p.w / 2;

/** Hitbox of a human entity: x is centre, y is the feet. */
export function entityBox(e) {
  return { x: e.x - C.bodyW / 2, y: e.y - C.bodyH, w: C.bodyW, h: C.bodyH };
}
const inBox = (b, x, y) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;

const threats = (s) => s.threats;
export const isHostile = (e) => (e.kind === 'thief' || e.kind === 'goon') && e.state !== 'ko' && e.state !== 'dead';

// ------------------------------------------------------------- weapons ---

/** Rounds loaded / in the bag for the held gun. */
export function ammoOf(p, key = p.tool) {
  const w = W[key];
  if (!w || w.melee) return null;
  return { mag: (p.mag && p.mag[key]) || 0, bag: p.inv[w.ammo] || 0, size: w.mag };
}

const suppressedFor = (p, key) => !!W[key].pistol && (p.inv.suppressor || 0) > 0;

/** Start a reload (R). 1.5 s, or 0.5 s per shell for the shotgun. */
export function startReload(state) {
  const p = state.player;
  const key = p.tool;
  const w = W[key];
  if (!w || w.melee || p.reload || p.downed) return false;
  const a = ammoOf(p, key);
  if (a.mag >= a.size || a.bag <= 0) return false;
  const need = Math.min(a.size - a.mag, a.bag);
  p.reload = { key, t: 0, dur: w.perShell ? C.reloadPerShell * need : C.reloadSeconds, n: need };
  return true;
}

/** Spread in degrees: 2 standing, 6 moving, x2 in withdrawal, x1.3 drunk. */
export function spreadDeg(state) {
  const p = state.player;
  let d = Math.abs(p.vx) > 1 || !p.onGround ? C.spreadMove : C.spreadStand;
  if (state.heatState && state.heatState.withdrawal) d *= C.withdrawalMult;
  if (p.drunk) d *= C.drunkMult;
  return d;
}

/**
 * Fire the held gun at a world point. Returns {ok, reason}. Reasons: 'empty',
 * 'cooldown', 'reloading', 'warning' (first aim at an officer: nothing fires).
 */
export function fire(state, aimX, aimY) {
  const p = state.player;
  const key = p.tool;
  const w = W[key];
  if (!w || w.melee || p.downed) return { ok: false, reason: 'none' };
  if (p.reload) return { ok: false, reason: 'reloading' };
  if (p.fireCd > 0) return { ok: false, reason: 'cooldown' };
  if (!p.mag || (p.mag[key] || 0) <= 0) {
    p.fireCd = 1 / w.rate;
    state.events.push({ type: 'click' });
    return { ok: false, reason: 'empty' };
  }
  // Aiming a loaded gun at an officer the first time: full-screen warning, no shot.
  const h = hs(state);
  if (!h.warnedOfficer && copAt(state, aimX, aimY)) {
    h.warnedOfficer = true;
    state.events.push({ type: 'officerWarning' });
    return { ok: false, reason: 'warning' };
  }
  p.mag[key]--;
  p.fireCd = 1 / w.rate;
  p.lastFireT = state.simTicks;
  p.coverBrokenS = C.crouchFireGraceS;
  const ox = playerCx(p);
  const oy = p.y + 8;
  const base = Math.atan2(aimY - oy, aimX - ox);
  const spread = spreadDeg(state);
  withStateRng(state, (rng) => {
    for (let i = 0; i < w.pellets; i++) {
      const dev = (rng.range(-1, 1) * (w.pelletSpread ? w.pelletSpread / 2 : 0) + rng.range(-1, 1) * spread) * Math.PI / 180;
      spawnBullet(state, ox, oy, base + dev, w.dmg, w.range * TS);
    }
  });
  const sup = suppressedFor(p, key);
  gunNoise(state, key, sup, ox);
  state.events.push({ type: 'shot', weapon: key, x: ox, y: oy, suppressed: sup });
  return { ok: true };
}

function spawnBullet(state, x, y, ang, dmg, rangePx) {
  const B = state.bullets || (state.bullets = []);
  if (B.length >= CONFIG.limits.bullets) return;
  B.push({
    x, y, vx: Math.cos(ang) * C.bulletSpeed, vy: Math.sin(ang) * C.bulletSpeed,
    dmg, left: rangePx, hit: new Set(),
  });
}

/** Noise heat per shot, capped per incident; 6+ loud shots at heat 50+ send a patrol car. */
export function gunNoise(state, key, suppressed, x) {
  const t = threats(state);
  const rad = W[key].noise * noiseMult(state) / (suppressed ? C.suppressorDiv : 1);
  const tile = x / TS;
  const town = tile >= Z.townX0 - rad;
  const lot = tile >= Z.lotX0 - rad && tile < Z.lotX1 + rad;
  const now = state.time.day * 24 + state.time.hour;
  const inc = t.incident;
  if (now - inc.lastGh > C.incidentGapGh) { inc.shots = 0; inc.heat = 0; inc.loud = 0; inc.dispatched = false; }
  inc.lastGh = now;
  inc.shots++;
  if (!suppressed) inc.loud++;
  const key2 = town ? 'gunshotTown' : lot ? 'gunshotLot' : null;
  if (key2) {
    const ev = CONFIG.heat.events[key2];
    const per = suppressed ? ev.suppressed : ev.per;
    const room = Math.max(0, ev.max - inc.heat);
    const n = per > 0 ? Math.min(1, room / per) : 0;
    if (n > 0) { heatEvent(state, key2, n, { suppressed }); inc.heat += per * n; }
  }
  const D = C.dispatch;
  if (!inc.dispatched && inc.loud >= D.shots && state.heat >= D.heat && !t.dispatch) {
    inc.dispatched = true;
    t.dispatch = { at: now + D.delayGh };
    state.events.push({ type: 'toast', msg: 'Someone called the shots in. A patrol car is on its way.' });
  }
}

// --------------------------------------------------------------- melee ---

/** Swing fists or the bat at whatever hostile stands in front (stamina -12). */
export function melee(state, key = state.player.tool) {
  const p = state.player;
  const w = W[key];
  if (!w || !w.melee || p.downed || p.fireCd > 0 || p.stamina < w.stamina) return { ok: false };
  p.stamina -= w.stamina;
  p.fireCd = 1 / w.rate;
  let hit = null;
  let best = w.reach + 1;
  for (const e of state.entities || []) {
    if (!isHostile(e)) continue;
    const d = (e.x - playerCx(p)) * p.facing;
    if (d < -4 || d > w.reach || Math.abs(e.y - (p.y + p.h)) > C.bodyH) continue;
    if (d < best) { best = d; hit = e; }
  }
  state.events.push({ type: 'swing', weapon: key });
  if (!hit) return { ok: true, hit: false };
  if (w.knock) hit.x += p.facing * w.knock;
  damageEntity(state, hit, w.dmg, 'melee');
  return { ok: true, hit: true, target: hit };
}

/** Left click with the held item: swing or fire. */
export function attack(state, aimX, aimY) {
  const key = state.player.tool;
  if (isGun(key)) return fire(state, aimX, aimY);
  if (isWeapon(key)) return melee(state, key);
  return { ok: false };
}

/** Bandage: +30 hp over 5 s. */
export function useBandage(state) {
  const p = state.player;
  if ((p.inv.bandage || 0) <= 0 || p.hp >= C.playerHp) return false;
  p.inv.bandage--;
  p.heal = (p.heal || 0) + C.bandage.hp;
  return true;
}

// -------------------------------------------------------------- bullets ---

function copAt(state, x, y) {
  for (const c of state.cops || []) {
    const gy = groundY(state, c.x);
    if (Math.abs(c.x - x) <= C.officerAimPx && y <= gy && y >= gy - C.bodyH * 2) return c;
  }
  return null;
}
const copBox = (state, c) => ({ x: c.x - C.bodyW / 2, y: groundY(state, c.x) - C.bodyH, w: C.bodyW, h: C.bodyH });

/** 60 Hz: reload progress, cooldowns, bandage healing, bullet flight. */
export function stepCombat(state, dt) {
  const p = state.player;
  if (p.fireCd > 0) p.fireCd = Math.max(0, p.fireCd - dt);
  if (p.coverBrokenS > 0) p.coverBrokenS = Math.max(0, p.coverBrokenS - dt);
  if (p.reload) {
    p.reload.t += dt;
    if (p.reload.t >= p.reload.dur) {
      const { key, n } = p.reload;
      const w = W[key];
      const take = Math.min(n, p.inv[w.ammo] || 0);
      p.inv[w.ammo] -= take;
      p.mag[key] = (p.mag[key] || 0) + take;
      p.reload = null;
    }
  }
  if (p.heal > 0 && p.hp > 0) {
    const g = Math.min(p.heal, C.bandage.hp / C.bandage.seconds * dt, C.playerHp - p.hp);
    p.hp += g;
    p.heal -= g;
    if (p.hp >= C.playerHp) p.heal = 0;
  }
  stepBullets(state, dt);
}

export function stepBullets(state, dt) {
  const B = state.bullets;
  if (!B || B.length === 0) return;
  for (let i = B.length - 1; i >= 0; i--) {
    const b = B[i];
    const dist = Math.hypot(b.vx, b.vy) * dt;
    const n = Math.max(1, Math.ceil(dist / 4));
    let done = false;
    for (let k = 0; k < n && !done; k++) {
      b.x += (b.vx * dt) / n;
      b.y += (b.vy * dt) / n;
      b.left -= dist / n;
      if (isSolidId(tileAt(state.tiles, Math.floor(b.x / TS), Math.floor(b.y / TS)))) { done = true; landed(state, b); break; }
      done = bulletHit(state, b);
      if (!done && b.left <= 0) { done = true; landed(state, b); }
    }
    if (done) B.splice(i, 1);
  }
}

/** Test a bullet against people. Returns true when it was consumed. */
function bulletHit(state, b) {
  for (const e of state.entities || []) {
    if (e.state === 'ko' || e.state === 'dead' || !isHostileKind(e)) continue;
    if (inBox(entityBox(e), b.x, b.y)) {
      damageEntity(state, e, b.dmg, 'gun');
      return true;
    }
  }
  for (const c of state.cops || []) {
    if (inBox(copBox(state, c), b.x, b.y)) { hitCop(state, c, b.dmg); return true; }
  }
  for (const n of state.npcs || []) {
    const gy = groundY(state, n.x);
    if (inBox({ x: n.x - C.pedW / 2, y: gy - C.pedH, w: C.pedW, h: C.pedH }, b.x, b.y)) {
      state.npcs.splice(state.npcs.indexOf(n), 1);
      heatEvent(state, 'killCivilian');
      state.events.push({ type: 'toast', msg: 'You shot a civilian.' });
      return true;
    }
  }
  return false;
}
const isHostileKind = (e) => e.kind === 'thief' || e.kind === 'goon';

/** A shot landing within 2 tiles of a thief may scare it off (50%). */
function landed(state, b) {
  const R = C.shotLandTiles * TS;
  for (const e of state.entities || []) {
    if (!isHostileKind(e) || e.state === 'ko' || e.state === 'dead') continue;
    if (Math.hypot(e.x - b.x, e.y - 8 - b.y) <= R) {
      if (withStateRng(state, (rng) => rng.chance(CONFIG.threats.thief.fleeShot))) e.scared = true;
    }
  }
}

// ---------------------------------------------------------- damage -------

/**
 * Hurt a hostile human. At 0 hp: fists/bat/dog = knocked out (crawls off after
 * 20 s, the word spreads); a gun = dead (+8 heat; a dead thief starts a blood
 * feud). `how` is 'melee' | 'gun' | 'dog'.
 */
export function damageEntity(state, e, dmg, how) {
  if (e.state === 'ko' || e.state === 'dead') return null;
  e.hp -= dmg;
  if (how !== 'dog') e.attacked = true;
  if (e.hp > 0) return 'hit';
  e.hp = 0;
  const t = threats(state);
  dropLoot(state, e);
  if (how === 'gun') {
    e.state = 'dead';
    t.stats.kills++;
    heatEvent(state, 'killCriminal');
    if (e.kind === 'thief' && !e.feud && !e.biker) {
      const night = nightKey(state.time) + CONFIG.threats.feud.nights;
      if (!t.feud.some((f) => f.night === night)) t.feud.push({ night, kind: 'feud' });
    }
    state.events.push({ type: 'kill', kind: e.kind });
    return 'dead';
  }
  e.state = 'ko';
  e.koT = C.koSeconds;
  t.stats.kos++;
  if (e.kind === 'thief') t.wordUntil = nightKey(state.time) + CONFIG.threats.wordOfMouth.nights;
  state.events.push({ type: 'ko', kind: e.kind });
  return 'ko';
}

/** Whatever a downed thief was carrying goes back where it came from. */
export function dropLoot(state, e) {
  const loot = e.loot;
  if (!loot) return;
  for (const b of loot.batches) state.product.push(b);
  for (const { plant, potId } of loot.plants) {
    const pot = state.objects.find((o) => o.id === potId);
    if (pot && !pot.plantId) { pot.plantId = plant.id; state.plants.push(plant); }
  }
  e.loot = null;
}

// ---------------------------------------------------------- police -------

/** An officer was hit: +50 heat and the permanent floor (once), cops return fire. */
function hitCop(state, c, dmg) {
  const h = hs(state);
  if (!h.firedAtPolice) heatEvent(state, 'shootOfficer');
  c.hostile = true;
  c.hp = (c.hp === undefined ? C.cop.hp : c.hp) - dmg;
  if (c.hp <= 0) {
    state.cops.splice(state.cops.indexOf(c), 1);
    if (!h.officerKilled) {
      h.officerKilled = true;
      state.events.push({ type: 'toast', msg: 'An officer is down. They will not stop looking for you.' });
    }
  }
}

/** Hostile cops shoot back at 70% accuracy, 15 dmg, once a second. */
export function stepCops(state, dt) {
  for (const c of state.cops || []) {
    if (!c.hostile) continue;
    c.cd = (c.cd || 0) - dt;
    if (c.cd > 0) continue;
    const p = state.player;
    if (p.downed || Math.abs(c.x - playerCx(p)) > C.cop.rangeTiles * TS) continue;
    c.cd = 1 / C.cop.rate;
    enemyShoot(state, { x: c.x, y: groundY(state, c.x) }, C.cop.dmg, C.cop.accuracy, 'cop');
  }
}

/** Instant hit-cone shot at the player (plan §B6): line of sight, then accuracy. */
export function enemyShoot(state, from, dmg, accuracy, src) {
  const p = state.player;
  const covered = p.crouch && !(p.coverBrokenS > 0);
  const hy = p.y + (covered ? C.crouchHeadDrop : 4);
  const fy = from.y - 12;
  state.events.push({ type: 'tracer', x0: from.x, y0: fy, x1: playerCx(p), y1: hy });
  if (raycastSolid(state.tiles, from.x, fy, playerCx(p), hy, 2000)) return false;
  if (!withStateRng(state, (rng) => rng.chance(accuracy))) return false;
  hurtPlayer(state, dmg, src);
  return true;
}

// ----------------------------------------------------------- player hp ---

/** Damage the player. At 0 hp: police = arrest, anyone else = downed. */
export function hurtPlayer(state, dmg, src) {
  const p = state.player;
  if (p.downed) return;
  p.hp = Math.max(0, p.hp - dmg);
  state.events.push({ type: 'hurt', dmg, src });
  if (p.hp > 0) return;
  p.downed = true;
  p.heal = 0;
  const t = threats(state);
  if (src === 'cop') {
    arrestPlayer(state, 'police');
    state.events.push({ type: 'notice', title: 'Shot down', lines: ['The police put you down and cuff you.'] });
    return;
  }
  const D = C.downed;
  const loss = p.cash * D.cashLoss;
  p.cash -= loss;
  payFine(state, D.bill);
  for (const e of state.entities || []) if (e.kind === 'thief') e.haulMult = D.haulMult;
  t.downed = true;
  t.news.push(`You woke at the clinic. You lost $${Math.round(loss)} and owe a $${D.bill} bill.`);
}

/** After the lost time: wake at the clinic (or in a cell) on your feet. */
export function recoverPlayer(state) {
  const p = state.player;
  p.downed = false;
  p.hp = Math.max(p.hp, C.downed.wakeHp);
  p.reload = null;
  const b = CONFIG.world.buildings.find((x) => x.key === 'clinic');
  const tx = b.x + b.w - 1;
  p.x = tx * TS + (TS - p.w) / 2;
  p.y = state.surface[tx] * TS - p.h;
  p.vx = 0; p.vy = 0;
}
