// player.js — movement, digging and placing (plan §B9 src/entities/player.js).
// Pure module: no window/document/canvas — input arrives as a plain object
// and it runs unmodified in Node for tests (plan §B3 rule).
//
// Movement (plan §B5/§A3): walk 90 px/s, sprint 140 px/s, jump 300 px/s
// (clears 3 tiles), gravity 900, step-up of 1 tile is automatic. W/Space
// jumps or climbs a ladder; S drops through platforms (crouch behind cover
// arrives with combat in M5). Left mouse digs the aimed cell; right mouse
// places the selected tile. Only the lot (40 <= x < 140) is editable.
//
// One-shot inputs (jumpPressed, placePressed, select) are consumed by setting
// them to false, because the fixed 60 Hz loop may run several physics steps
// per rendered frame.

import { CONFIG } from '../config.js';
import { T, itemKeyFor, setTile, digInfo, digTile, canPlace, inBounds, isSolidId } from '../world/tiles.js';
import { moveBody, boxOverlapsId } from '../world/physics.js';

const TS = CONFIG.world.tile;

export function createPlayer(x, y) {
  const start = CONFIG.player.start;
  return {
    x, y,
    vx: 0, vy: 0,
    w: CONFIG.player.w, h: CONFIG.player.h,
    facing: 1,
    onGround: false,
    onLadder: false,
    stamina: CONFIG.player.staminaMax,
    exhausted: false,
    sprinting: false,
    walkDist: 0,
    dropT: 0,
    dropThrough: false,
    reachPx: CONFIG.player.digReachTiles * TS,
    selected: T.DIRT,
    inv: { dirt: start.dirt, wood: start.wood, ladder: start.ladder, pickaxe: start.pickaxe },
    dig: { cx: -1, cy: -1, progress: 0 }, // current dig target and accumulated time
  };
}

/** Advance the player one fixed 1/60 s physics step. */
export function stepPlayer(state, inp, dt) {
  const p = state.player;
  const grid = state.tiles;
  const C = CONFIG.player;
  const Ph = CONFIG.physics;

  // Consume one-shot inputs.
  const jump = inp.jumpPressed;
  inp.jumpPressed = false;
  const place = inp.placePressed;
  inp.placePressed = false;
  if (inp.select) { p.selected = inp.select; inp.select = 0; }

  // Stamina (§A9: sprint −10/s, regen +15/s) with a small exhausted hysteresis.
  const moving = (inp.right ? 1 : 0) !== (inp.left ? 1 : 0);
  p.sprinting = inp.sprint && moving && p.stamina > 0 && !p.exhausted;
  if (p.sprinting) {
    p.stamina -= C.sprintStaminaDrain * dt;
    if (p.stamina <= 0) { p.stamina = 0; p.exhausted = true; p.sprinting = false; }
  } else {
    p.stamina = Math.min(C.staminaMax, p.stamina + C.staminaRegen * dt);
    if (p.exhausted && p.stamina >= C.sprintMinStamina) p.exhausted = false;
  }
  const speed = p.sprinting ? Ph.sprintSpeed : Ph.walkSpeed;
  const dir = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
  if (dir) p.facing = dir;

  // Ladders: vertical control, no gravity, jump to hop off.
  p.onLadder = boxOverlapsId(grid, p, T.LADDER);
  if (p.onLadder) {
    p.vy = inp.up ? -Ph.climbSpeed : inp.down ? Ph.climbSpeed : 0;
    if (jump) p.vy = -Ph.jumpVel;
    p.vx = dir * speed;
  } else {
    if (jump && p.onGround) { p.vy = -Ph.jumpVel; p.onGround = false; }
    if (inp.down && p.onGround) p.dropT = C.dropThroughS; // S: drop through platforms
    if (p.dropT > 0) p.dropT -= dt;
    p.vy += Ph.gravity * dt;
    if (p.vy > Ph.maxFallSpeed) p.vy = Ph.maxFallSpeed;
    p.vx = dir * speed;
  }

  const prevX = p.x;
  p.dropThrough = p.dropT > 0;
  moveBody(grid, p, dt, { stepUp: true });
  if (p.onGround) p.walkDist += Math.abs(p.x - prevX); // drives the walk cycle

  updateDig(state, p, inp, dt);
  tryPlace(state, p, inp, place);
  return p;
}

// ------------------------------------------------------------- digging ----

/** The aimed cell, if it is inside the world and within reach of the player. */
function aimCell(state, p, inp) {
  const cx = Math.floor(inp.aimX / TS);
  const cy = Math.floor(inp.aimY / TS);
  if (!inBounds(cx, cy)) return null;
  const dx = (cx + 0.5) * TS - (p.x + p.w / 2);
  const dy = (cy + 0.5) * TS - (p.y + p.h / 2);
  if (dx * dx + dy * dy > p.reachPx * p.reachPx) return null;
  return { cx, cy };
}

function resetDig(p) {
  p.dig.cx = -1;
  p.dig.cy = -1;
  p.dig.progress = 0;
}

function updateDig(state, p, inp, dt) {
  if (!inp.digHeld) { resetDig(p); return; }
  const cell = aimCell(state, p, inp);
  if (!cell) { resetDig(p); return; }
  const d = digInfo(state, cell.cx, cell.cy);
  if (!d || (d.tool && !p.inv[d.tool])) { resetDig(p); return; } // stone needs the pickaxe
  if (cell.cx !== p.dig.cx || cell.cy !== p.dig.cy) {
    p.dig.cx = cell.cx;
    p.dig.cy = cell.cy;
    p.dig.progress = 0;
  }
  p.dig.progress += dt;
  if (p.dig.progress >= d.digTime) {
    const drop = digTile(state, cell.cx, cell.cy);
    if (drop) {
      const key = itemKeyFor(drop);
      if (key) p.inv[key]++;
    }
    resetDig(p);
  }
}

// ----------------------------------------------------------- placing ------

function tryPlace(state, p, inp, place) {
  if (!place) return false;
  const cell = aimCell(state, p, inp);
  if (!cell) return false;
  if (!canPlace(state, cell.cx, cell.cy, p.selected)) return false;
  // Never seal the player inside a solid tile (ladders are walk-through).
  if (isSolidId(p.selected)) {
    const TSr = CONFIG.world.tile;
    const cx0 = cell.cx * TSr, cy0 = cell.cy * TSr;
    const overlap = p.x < cx0 + TSr && p.x + p.w > cx0 && p.y < cy0 + TSr && p.y + p.h > cy0;
    if (overlap) return false;
  }
  const key = itemKeyFor(p.selected);
  if (!key || p.inv[key] <= 0) return false;
  setTile(state, cell.cx, cell.cy, p.selected);
  p.inv[key]--;
  return true;
}
