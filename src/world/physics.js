// physics.js — AABB vs tiles and tile raycast (plan §B5).
// Pure module: no window/document, runs unmodified in Node (plan §B3 rule).
//
// Rules: gravity 900, jump 300 (clears 3 tiles), player box 12x22, no slopes,
// no tile physics. Platforms are one-way: they only catch a body that was
// above their top edge on the previous sub-step and is falling. Movement is
// sub-stepped so nothing tunnels through a 16 px tile.

import { CONFIG } from '../config.js';
import { tileAt, isSolidId, isPlatformId } from './tiles.js';

const TS = CONFIG.world.tile;
const EPS = CONFIG.physics.eps;

/** Any solid tile overlapping the box? */
export function boxHitsSolid(grid, x, y, w, h) {
  const x0 = Math.floor(x / TS);
  const x1 = Math.floor((x + w - EPS) / TS);
  const y0 = Math.floor(y / TS);
  const y1 = Math.floor((y + h - EPS) / TS);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (isSolidId(tileAt(grid, tx, ty))) return true;
    }
  }
  return false;
}

/** Falling onto tiles: solids always block; platforms block only when the
 * previous bottom edge was at or above their top edge. */
function landingBlocked(grid, x, y, w, h, prevBottom, allowPlatform) {
  const x0 = Math.floor(x / TS);
  const x1 = Math.floor((x + w - EPS) / TS);
  const y0 = Math.floor(y / TS);
  const y1 = Math.floor((y + h - EPS) / TS);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const id = tileAt(grid, tx, ty);
      if (isSolidId(id)) return true;
      if (allowPlatform && isPlatformId(id) && prevBottom <= ty * TS + EPS) return true;
    }
  }
  return false;
}

/** Does the box overlap any tile with the given id (ladders, hazards...)? */
export function boxOverlapsId(grid, b, id) {
  const x0 = Math.floor(b.x / TS);
  const x1 = Math.floor((b.x + b.w - EPS) / TS);
  const y0 = Math.floor(b.y / TS);
  const y1 = Math.floor((b.y + b.h - EPS) / TS);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (tileAt(grid, tx, ty) === id) return true;
    }
  }
  return false;
}

/**
 * Integrate one body for dt seconds against the tile grid, in sub-steps.
 * Body: { x, y, w, h, vx, vy, onGround, dropThrough }. Gravity is applied by
 * the caller; this function is purely kinematic. `opts.stepUp` lets a grounded
 * body walk over a single 16 px ledge automatically (plan §B5, NPCs).
 */
export function moveBody(grid, b, dt, opts = {}) {
  const maxDisp = Math.max(Math.abs(b.vx), Math.abs(b.vy)) * dt;
  const steps = Math.max(1, Math.ceil(maxDisp / CONFIG.physics.subStepPx));
  const sdt = dt / steps;
  for (let i = 0; i < steps; i++) {
    moveX(grid, b, sdt, opts);
    moveY(grid, b, sdt, opts);
  }
  // World bounds: invisible walls at x 0 and 400 tiles (plan §A3 one world).
  const worldPx = CONFIG.world.cols * TS;
  if (b.x < 0) { b.x = 0; b.vx = 0; }
  else if (b.x + b.w > worldPx) { b.x = worldPx - b.w; b.vx = 0; }
}

function moveX(grid, b, dt, opts) {
  if (b.vx === 0) return;
  const nx = b.x + b.vx * dt;
  if (!boxHitsSolid(grid, nx, b.y, b.w, b.h)) {
    b.x = nx;
    return;
  }
  // Automatic step-up over a 1-tile ledge while grounded.
  if (opts.stepUp && (b.onGround || Math.abs(b.vy) < 1)) {
    const upY = b.y - TS;
    if (!boxHitsSolid(grid, b.x, upY, b.w, b.h) && !boxHitsSolid(grid, nx, upY, b.w, b.h)) {
      b.y = upY;
      b.x = nx;
      return;
    }
  }
  // Snap flush against the tile face.
  if (b.vx > 0) b.x = Math.floor((nx + b.w) / TS) * TS - b.w - EPS;
  else b.x = (Math.floor(nx / TS) + 1) * TS + EPS;
  b.vx = 0;
}

function moveY(grid, b, dt, opts) {
  b.onGround = false; // only a landing this step grounds the body
  if (b.vy === 0) return;
  const ny = b.y + b.vy * dt;
  const prevBottom = b.y + b.h;
  if (b.vy > 0) {
    if (landingBlocked(grid, b.x, ny, b.w, b.h, prevBottom, !b.dropThrough)) {
      b.y = Math.floor((ny + b.h) / TS) * TS - b.h - EPS;
      b.vy = 0;
      b.onGround = true;
      return;
    }
  } else if (b.vy < 0) {
    if (boxHitsSolid(grid, b.x, ny, b.w, b.h)) {
      b.y = (Math.floor(ny / TS) + 1) * TS + EPS;
      b.vy = 0;
      return;
    }
  }
  b.y = ny;
}

/**
 * Tile raycast (used later for AI line-of-sight, plan §B6). Steps the segment
 * in 4 px increments; returns the first solid tile as { tx, ty } or null.
 */
export function raycastSolid(grid, x0, y0, x1, y1, maxDist = 600) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  if (dist > maxDist) return null;
  const n = Math.max(1, Math.ceil(dist / 4));
  let lastTx = -1;
  let lastTy = -1;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const tx = Math.floor((x0 + dx * t) / TS);
    const ty = Math.floor((y0 + dy * t) / TS);
    if (tx === lastTx && ty === lastTy) continue;
    lastTx = tx;
    lastTy = ty;
    if (isSolidId(tileAt(grid, tx, ty))) return { tx, ty };
  }
  return null;
}
