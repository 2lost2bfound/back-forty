// player.js — movement, digging/placing, tending actions, interactions
// (plan §B9 src/entities/player.js, §A4 tending).
// Pure module: no window/document/canvas — input arrives as a plain object
// and it runs unmodified in Node for tests (plan §B3 rule).
//
// Movement (plan §B5/§A3): walk 90 px/s, sprint 140 px/s, jump 300 px/s
// (clears 3 tiles), gravity 900, step-up of 1 tile is automatic. W/Space
// jumps or climbs a ladder; S drops through platforms. Left mouse digs the
// aimed cell or tends the aimed plant (watering can / nutrients / pH kit);
// right mouse places the selected tile or object (pot / rack / soil into an
// empty pot), and with the pH kit it doses pH Up (left click is pH Down).
// E interacts: harvest, plant, pick up a pot, racks, tap/barrel, bed, shops.
//
// Tending actions take real time (plan §A4: water 0.6 s, feed 0.8 s, pH 0.8 s,
// plant 1 s, harvest 2 s) via p.action; movement input cancels the action.
// Durations scale with Grower level (-4%/level) and the Tired state (+20%).
//
// One-shot inputs (jumpPressed, placePressed, interactPressed, hotbar,
// select) are consumed by setting them to false/0, because the fixed 60 Hz
// loop may run several physics steps per rendered frame.

import { CONFIG } from '../config.js';
import { T, itemKeyFor, setTile, digInfo, digTile, canPlace, inBounds, isSolidId, tileAt } from '../world/tiles.js';
import { moveBody, boxOverlapsId } from '../world/physics.js';
import * as plants from '../sim/plants.js';
import * as economy from '../sim/economy.js';
import { pedNear } from './npc.js';
import { isWeapon, attack, startReload, useBandage } from './combat.js';
import { installLock, canPlaceCamera } from '../sim/threats.js';

const TS = CONFIG.world.tile;
const PS = CONFIG.plants;
const SHOP_KEYS = ['hardware', 'walt', 'pawn', 'clinic', 'townhall', 'bar', 'alley'];

// Hotbar items that tend a plant with the primary (left) click.
const TEND_KEYS = { can: 'water', nutrients: 'feed', phkit: 'ph' };

// Objects placed with right click (M4 adds lamps, hiding and stash gear).
export const PLACEABLE = ['pot', 'rack', 'lamp_cfl', 'lamp_hps', 'lamp_led', 'filter',
  'generator', 'safe', 'stash', 'hatch', 'tripwire', 'floodlight', 'camera'];

/** Combat fields every player carries (also back-filled into old saves). */
export function combatFields() {
  return { hp: CONFIG.combat.playerHp, mag: {}, reload: null, fireCd: 0, heal: 0, crouch: false, downed: false, coverBrokenS: 0 };
}

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
    riding: false,              // on the bicycle (needs inv.bicycle)
    dropT: 0,
    dropThrough: false,
    reachPx: CONFIG.player.digReachTiles * TS,
    selected: T.DIRT,           // selected tile id (tile hotbar slots drive this)
    tool: 'can',                // selected item key (item hotbar slots drive this)
    hotbar: CONFIG.player.hotbar.map((e) => ({ ...e })),
    hotbarIndex: 0,
    inv: {
      dirt: start.dirt, wood: start.wood, ladder: start.ladder,
      pickaxe: start.pickaxe, seeds: start.seeds, can: start.can,
      pot: 0, soil_potting: 0, soil_living: 0,
      nutrients: 0, phkit: 0,
      moisture_meter: 0, ph_meter: 0, loupe: 0, rack: 0,
      fists: 1,                 // so fists can sit on the hotbar (plan §A9 tier 0)
    },
    seedBag: [],                // purchased seed genomes, used in order
    cash: CONFIG.economy.startCash,
    bank: 0,                    // clean money (M10; exists for save shape)
    debt: 0,                    // unpaid fines (blocks the license, M10)
    arrests: 0,                 // third arrest = game over (plan §A15)
    level: 1, xp: 0,            // mastery.js is M7; level 1 throughout M2
    awakeHours: 0,              // Tired after 30 gh awake (plan §A3)
    canCharges: PS.canCapacity, // watering can pours left
    canWater: 'tap',            // water source the can was filled from
    action: null,               // {kind, t, dur, plantId, potId, dir}
    dig: { cx: -1, cy: -1, progress: 0 }, // current dig target and accumulated time
    ...combatFields(),
  };
}

/** Apply a hotbar slot: tile slots set p.selected, item slots set p.tool. */
export function selectHotbar(state, index) {
  const p = state.player;
  const i = Math.max(0, Math.min(p.hotbar.length - 1, index));
  p.hotbarIndex = i;
  const e = p.hotbar[i];
  if (e.kind === 'tile') {
    p.selected = e.id;
  } else {
    p.tool = e.key;
  }
}

/** Cycle the hotbar with the mouse wheel. */
export function cycleHotbar(state, dir) {
  const p = state.player;
  let i = (p.hotbarIndex + dir) % p.hotbar.length;
  if (i < 0) i += p.hotbar.length;
  selectHotbar(state, i);
}

/** Assign an inventory item key to a hotbar slot (inventory menu). */
export function assignHotbar(state, index, key) {
  const p = state.player;
  if (PLACEABLE.includes(key) || isWeapon(key) || key === 'bandage' || key === 'soil_potting' || key === 'soil_living' ||
      key === 'can' || key === 'nutrients' || key === 'phkit') {
    p.hotbar[index] = { kind: 'item', key };
  } else if (key === 'dirt' || key === 'wood' || key === 'ladder') {
    const ids = { dirt: T.DIRT, wood: T.WOOD, ladder: T.LADDER };
    p.hotbar[index] = { kind: 'tile', id: ids[key] };
  } else {
    return false;
  }
  selectHotbar(state, p.hotbarIndex);
  return true;
}

/** Seconds an action of `base` takes right now (level + Tired, plan §A4). */
export function actionDuration(state, base) {
  const p = state.player;
  const levelMult = 1 - CONFIG.mastery.tendingPerLevel * ((p.level || 1) - 1);
  const tiredMult = p.awakeHours > CONFIG.player.tiredAfterGh ? CONFIG.player.tiredTendingMult : 1;
  return base * levelMult * tiredMult;
}

/** Advance the player one fixed 1/60 s physics step. */
export function stepPlayer(state, inp, dt) {
  const p = state.player;
  const grid = state.tiles;
  const C = CONFIG.player;
  const Ph = CONFIG.physics;

  // Consume one-shot inputs.
  const jump = !!inp.jumpPressed;
  inp.jumpPressed = false;
  const place = !!inp.placePressed;
  inp.placePressed = false;
  const interact = !!inp.interactPressed;
  inp.interactPressed = false;
  const reload = !!inp.reloadPressed;
  inp.reloadPressed = false;
  if (inp.hotbar !== undefined && inp.hotbar !== null && inp.hotbar !== -1) {
    selectHotbar(state, inp.hotbar);
    inp.hotbar = -1;
  }
  if (inp.wheel) { cycleHotbar(state, inp.wheel > 0 ? 1 : -1); inp.wheel = 0; }
  if (inp.select) { p.selected = inp.select; inp.select = 0; }

  // Stamina (§A9: sprint −10/s, regen +15/s) with a small exhausted hysteresis.
  const moving = (inp.right ? 1 : 0) !== (inp.left ? 1 : 0);
  p.sprinting = inp.sprint && moving && p.stamina > 0 && !p.exhausted && !p.riding;
  if (p.sprinting) {
    p.stamina -= C.sprintStaminaDrain * dt;
    if (p.stamina <= 0) { p.stamina = 0; p.exhausted = true; p.sprinting = false; }
  } else {
    p.stamina = Math.min(C.staminaMax, p.stamina + C.staminaRegen * dt);
    if (p.exhausted && p.stamina >= C.sprintMinStamina) p.exhausted = false;
  }
  if (inp.bikePressed) {
    inp.bikePressed = false;
    if (p.riding) p.riding = false;
    else if (p.inv.bicycle > 0) p.riding = true;
  }
  if (p.riding && p.onLadder) p.riding = false;
  const speed = p.riding ? CONFIG.economy.bikeSpeed : p.sprinting ? Ph.sprintSpeed : Ph.walkSpeed;
  const dir = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
  if (dir) p.facing = dir;

  // An in-progress tending action is cancelled by any movement input.
  if (p.action && (dir !== 0 || jump)) { p.action = null; }

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
    p.vx = p.action ? 0 : dir * speed; // actions plant the feet
  }

  const prevX = p.x;
  p.dropThrough = p.dropT > 0;
  moveBody(grid, p, dt, { stepUp: true });
  if (p.onGround) p.walkDist += Math.abs(p.x - prevX); // drives the walk cycle

  p.crouch = !!inp.down && p.onGround && !p.onLadder;
  updateAction(state, p, dt);
  const armed = isWeapon(p.tool) || p.tool === 'bandage';
  if (reload) startReload(state);
  if (!p.action && armed && !p.downed) {
    if (p.tool === 'bandage') { if (inp.tendPressed) { inp.tendPressed = false; useBandage(state); } }
    else if (inp.digHeld) attack(state, inp.aimX, inp.aimY);
  } else if (!p.action) {
    updateDig(state, p, inp, dt);
    tryPrimary(state, p, inp);
    trySecondary(state, p, place, inp);
  }
  if (interact) handleInteract(state);
  return p;
}

// -------------------------------------------------------- tending actions --

/** The pot under the aim point, if any. */
export function aimedPot(state, inp) {
  if (!inp || inp.aimX === undefined) return null;
  const cx = Math.floor(inp.aimX / TS);
  const cy = Math.floor(inp.aimY / TS);
  if (!inBounds(cx, cy)) return null;
  return state.objects.find((o) => o.kind === 'pot' && o.x === cx && o.y === cy) || null;
}

function startAction(state, p, kind, base, target) {
  p.action = {
    kind,
    t: 0,
    dur: actionDuration(state, base),
    plantId: target.plant ? target.plant.id : null,
    potId: target.pot ? target.pot.id : null,
    dir: target.dir || 0,
  };
}

function updateAction(state, p, dt) {
  const a = p.action;
  if (!a) return;
  a.t += dt;
  if (a.t < a.dur) return;
  p.action = null;
  completeAction(state, a);
}

function completeAction(state, a) {
  const pot = a.potId ? state.objects.find((o) => o.id === a.potId) : null;
  const plant = a.plantId ? state.plants.find((pl) => pl.id === a.plantId) : null;
  switch (a.kind) {
    case 'water': {
      if (!plant || plant.dead) return;
      const ph = state.player.canWater === 'barrel' ? PS.barrelPourPh : PS.tapPourPh;
      plants.waterPour(state, plant, ph);
      state.player.canCharges--;
      state.events.push({ type: 'action', name: 'pour' });
      break;
    }
    case 'feed': {
      if (!plant || plant.dead) return;
      if ((state.player.inv.nutrients || 0) <= 0) return;
      state.player.inv.nutrients--;
      plants.feedDose(state, plant);
      state.events.push({ type: 'action', name: 'feed' });
      break;
    }
    case 'ph': {
      if (!plant || plant.dead) return;
      if ((state.player.inv.phkit || 0) <= 0) return;
      state.player.inv.phkit--;
      plants.phAdjust(state, plant, a.dir);
      state.events.push({ type: 'action', name: 'ph' });
      break;
    }
    case 'plant': {
      if (!pot || pot.plantId) return;
      if ((state.player.inv.seeds || 0) <= 0) return;
      state.player.inv.seeds--;
      plants.plantSeed(state, pot, 'ditch');
      state.events.push({ type: 'action', name: 'plant' });
      break;
    }
    case 'harvest': {
      if (!plant || plant.dead) return;
      if (!plants.canHarvest(plant)) return;
      const batch = plants.harvestPlant(state, plant);
      if (batch) economy.addProduct(state, batch); // wet product -> inventory
      state.events.push({ type: 'action', name: 'harvest' });
      break;
    }
    case 'refill': {
      const p = state.player;
      if (a.source === 'tap') {
        p.canCharges = PS.canCapacity;
        p.canWater = 'tap';
      } else if (a.source === 'barrel') {
        const barrel = a.objId ? state.objects.find((o) => o.id === a.objId) : null;
        if (!barrel || (barrel.charges || 0) <= 0) {
          state.events.push({ type: 'toast', msg: 'The rain barrel is empty.' });
          return;
        }
        const take = Math.min(PS.canCapacity - p.canCharges, barrel.charges);
        p.canCharges += take;
        barrel.charges -= take;
        p.canWater = 'barrel';
      }
      state.events.push({ type: 'action', name: 'refill' });
      break;
    }
  }
}

/** Left click: tend the aimed plant if a tending tool is selected. Digging is
 *  handled once by updateDig() in stepPlayer — the aim cell of a hovered plant
 *  is the pot's own (air) cell, so holding the button can never dig a plant. */
function tryPrimary(state, p, inp) {
  const tendKind = TEND_KEYS[p.tool];
  if (tendKind) {
    const pot = aimedPot(state, inp);
    const plant = plants.plantByPot(state, pot);
    if (plant && !plant.dead) {
      // On press only: dig uses hold, tending uses one click per action.
      if (inp.tendPressed) {
        inp.tendPressed = false;
        if (tendKind === 'water' && p.canCharges <= 0) {
          state.events.push({ type: 'toast', msg: 'The can is empty — refill at the tap.' });
          return;
        }
        if (tendKind === 'feed' && !(p.inv.nutrients > 0)) {
          state.events.push({ type: 'toast', msg: 'No nutrient doses left.' });
          return;
        }
        if (tendKind === 'ph' && !(p.inv.phkit > 0)) {
          state.events.push({ type: 'toast', msg: 'No pH doses left.' });
          return;
        }
        startAction(state, p, tendKind, PS.actionSeconds[tendKind], { pot, plant });
      }
    }
  }
}

/** Right click: pH Up with the kit, else place tile/object/soil. */function trySecondary(state, p, place, inp) {
  if (!place) return;
  if (p.tool === 'phkit') {
    const pot = aimedPot(state, inp);
    const plant = plants.plantByPot(state, pot);
    if (plant && !plant.dead && p.inv.phkit > 0) {
      startAction(state, p, 'ph', PS.actionSeconds.ph, { pot, plant, dir: 1 });
    }
    return;
  }
  if (PLACEABLE.includes(p.tool)) {
    const cell = aimCell(state, p, inp);
    if (cell) placeObject(state, p.tool, cell.cx, cell.cy);
    return;
  }
  if (p.tool === 'soil_potting' || p.tool === 'soil_living') {
    const cell = aimCell(state, p, inp);
    if (cell) placeSoil(state, p.tool, cell.cx, cell.cy);
    return;
  }
  tryPlaceTile(state, p, inp); // tile slots (and tools that don't place)
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

function tryPlaceTile(state, p, inp) {
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

/**
 * Place a pot or a drying rack at an air cell in the lot that has solid
 * ground below and no object yet. Consumes one item.
 */
export function placeObject(state, key, cx, cy) {
  if (!PLACEABLE.includes(key)) return false;
  if (!inBounds(cx, cy)) return false;
  const cur = tileAt(state.tiles, cx, cy);
  if (cur !== T.AIR && cur !== T.BGWALL) return false;
  if (!isLotX(cx)) return false;
  if (state.objects.some((o) => o.x === cx && o.y === cy)) return false;
  const solid = (x, y) => isSolidId(tileAt(state.tiles, x, y));
  if (key === 'hatch') {
    // A hatch closes a shaft or tunnel: solid on both sides, or above and below.
    if (!((solid(cx - 1, cy) && solid(cx + 1, cy)) || (solid(cx, cy - 1) && solid(cx, cy + 1)))) return false;
  } else if (!key.startsWith('lamp_') && !solid(cx, cy + 1)) {
    return false; // everything but lamps and hatches stands on the ground
  }
  const p = state.player;
  if ((p.inv[key] || 0) <= 0) return false;
  if (key === 'camera' && !canPlaceCamera(state, cx, cy)) return false;
  const id = state.nextId++;
  let obj;
  if (key === 'pot') obj = { id, kind: 'pot', x: cx, y: cy, soil: 'cheap', soilPh: PS.freshSoilPh, plantId: null };
  else if (key.startsWith('lamp_')) obj = { id, kind: 'lamp', lamp: key, x: cx, y: cy, hours: CONFIG.lamps.hoursNormal };
  else if (key === 'safe' || key === 'stash') obj = { id, kind: key, x: cx, y: cy, cash: 0 };
  else if (key === 'camera') obj = { id, kind: key, x: cx, y: cy, dir: p.facing || -1, footage: 0 };
  else obj = { id, kind: key, x: cx, y: cy };
  p.inv[key]--;
  state.objects.push(obj);
  state.events.push({ type: 'action', name: 'place' });
  return true;
}

/** Stash/safe: put everything carried inside, or take it all back out. */
export function useContainer(state, box) {
  const p = state.player;
  const carried = state.product.filter((b) => b.where === 'inv');
  if (carried.length > 0 || p.cash > 0) {
    for (const b of carried) { b.where = box.id; }
    box.cash = (box.cash || 0) + p.cash;
    p.cash = 0;
    return 'Stashed your product and cash.';
  }
  for (const b of state.product) if (b.where === box.id) b.where = 'inv';
  p.cash += box.cash || 0;
  box.cash = 0;
  return 'Took everything back.';
}

/** Place soil into the empty pot at (cx, cy). */
export function placeSoil(state, soilKey, cx, cy) {
  const pot = state.objects.find((o) => o.kind === 'pot' && o.x === cx && o.y === cy);
  if (!pot || pot.plantId) return false;
  if ((state.player.inv[soilKey] || 0) <= 0) return false;
  state.player.inv[soilKey]--;
  pot.soil = soilKey === 'soil_potting' ? 'potting' : 'living';
  pot.soilPh = PS.freshSoilPh; // new soil starts at 6.4 (plan §A4)
  state.events.push({ type: 'action', name: 'place' });
  return true;
}

function isLotX(tx) {
  return tx >= CONFIG.world.zones.lotX0 && tx < CONFIG.world.zones.lotX1;
}

// ---------------------------------------------------------- interaction ---

/** The single best interaction target near the player, or null. */
export function interactTarget(state) {
  const p = state.player;
  const pcx = (p.x + p.w / 2) / TS - 0.5;
  const pcy = (p.y + p.h / 2) / TS - 0.5;
  const R = CONFIG.player.interactTiles;
  let best = null;
  const consider = (cand, x, y) => {
    const dx = x - pcx;
    const dy = y - pcy;
    if (Math.abs(dx) > R || Math.abs(dy) > R) return;
    const dist = Math.abs(dx) + Math.abs(dy);
    if (!best || dist < best.dist) best = { ...cand, dist };
  };

  for (const o of state.objects) {
    const x = o.x;
    const y = o.y;
    if (o.kind === 'pot') {
      const plant = plants.plantByPot(state, o);
      if (plant && plant.dead) consider({ kind: 'potDead', obj: o }, x, y);
      else if (plant && plants.canHarvest(plant)) consider({ kind: 'harvest', obj: o, plant }, x, y);
      else if (plant) consider({ kind: 'growing', obj: o, plant }, x, y);
      else consider({ kind: 'emptyPot', obj: o }, x, y);
    } else if (o.kind === 'rack') {
      consider({ kind: 'rack', obj: o }, x, y);
    } else if (o.kind === 'tap') {
      consider({ kind: 'tap', obj: o }, x, y);
    } else if (o.kind === 'barrel') {
      consider({ kind: 'barrel', obj: o }, x, y);
    } else if (o.kind === 'bed') {
      consider({ kind: 'bed', obj: o }, x, y);
    } else if (o.kind === 'lamp' || o.kind === 'stash' || o.kind === 'safe') {
      consider({ kind: o.kind, obj: o }, x, y);
    }
  }

  // Shop doors (right wall of each building, two tiles above the ground).
  for (const shop of SHOP_KEYS) {
    const b = CONFIG.world.buildings.find((x) => x.key === CONFIG.economy[shop].building);
    if (b) consider({ kind: 'shop', shop }, b.x + b.w - 1, state.surface[b.x + b.w - 1] - 1);
  }
  // The shack door takes a lock from the inventory (plan §A6).
  if (CONFIG.threats.locks.some((k) => p.inv[k] > 0)) {
    const sb = CONFIG.world.buildings.find((b) => b.key === 'shack');
    consider({ kind: 'door' }, sb.x + sb.w - 1, state.surface[sb.x + sb.w - 1] - 1);
  }
  // Buyers standing at their spot, and pedestrians (street sales).
  for (const key of economy.BUYER_KEYS) {
    if (!economy.buyerPresent(state, key)) continue;
    const bx = CONFIG.economy.buyers[key].x;
    consider({ kind: 'buyer', key }, bx, state.surface[bx] - 1);
  }
  const ped = pedNear(state);
  if (ped) consider({ kind: 'ped', ped }, ped.x / TS - 0.5, pcy);
  return best;
}

const hh = (h) => `${h % 24}:00`;

/** HUD hint for the current interaction target. */
export function interactHint(state) {
  const t = interactTarget(state);
  if (!t) return null;
  const inv = state.player.inv;
  switch (t.kind) {
    case 'potDead': return 'E: Rip out the dead plant';
    case 'harvest': return 'E: Harvest (2 s)';
    case 'growing': return null; // inspecting is hover-based
    case 'emptyPot': return inv.seeds > 0 ? 'E: Plant a seed (1 s)' : 'E: Pick up the pot';
    case 'rack': {
      const wet = state.product.some((b) => b.where === 'inv' && b.wet);
      const dry = state.product.some((b) => b.where === t.obj.id && !b.wet);
      if (dry) return 'E: Take the dried bud';
      if (wet) return 'E: Hang a batch to dry';
      return null;
    }
    case 'tap': return state.player.canCharges < PS.canCapacity ? 'E: Refill the can (tap)' : null;
    case 'barrel': return state.player.canCharges < PS.canCapacity ? 'E: Refill the can (barrel)' : null;
    case 'bed': return 'E: Sleep until 6:00';
    case 'shop': {
      const sh = CONFIG.economy[t.shop];
      return economy.shopOpen(state.time, t.shop)
        ? `E: ${sh.label}`
        : `${sh.label} (${hh(sh.open)}-${hh(sh.close)})`;
    }
    case 'buyer': {
      const o = economy.orderOf(state, t.key);
      const nm = CONFIG.economy.buyers[t.key].name;
      return o ? `E: Deliver ${nm}'s order (${Math.round(o.grams)} g)` : `E: Talk to ${nm}`;
    }
    case 'ped': return 'E: Offer a stranger some product';
    case 'door': return 'E: Fit a lock to the door';
    case 'lamp': return `E: Lamp timer ${t.obj.hours} h (switch to ${t.obj.hours === CONFIG.lamps.hoursNormal ? CONFIG.lamps.hoursLong : CONFIG.lamps.hoursNormal} h)`;
    case 'stash': case 'safe': return `E: Use the ${t.kind} (put in / take out)`;
    default: return null;
  }
}

/** E was pressed: resolve the interaction. Menu opens go through state.events. */
export function handleInteract(state) {
  const t = interactTarget(state);
  if (!t) return;
  const p = state.player;
  const obj = t.obj;
  switch (t.kind) {
    case 'potDead': {
      const plant = plants.plantByPot(state, obj);
      const i = state.plants.indexOf(plant);
      if (i >= 0) state.plants.splice(i, 1);
      obj.plantId = null;
      state.events.push({ type: 'toast', msg: `Ripped out the dead ${plant.strainName}.` });
      break;
    }
    case 'harvest':
      if (economy.carriedGrams(state) >= economy.carryCap(state)) {
        state.events.push({ type: 'toast', msg: 'You can\'t carry any more (buy a duffel).' });
        break;
      }
      startAction(state, p, 'harvest', PS.actionSeconds.harvest, { pot: obj, plant: t.plant });
      break;
    case 'emptyPot':
      if (p.inv.seeds > 0) {
        startAction(state, p, 'plant', PS.actionSeconds.plant, { pot: obj });
      } else {
        // Pick up the empty pot (plan §A2: E picks up pots).
        p.inv.pot = (p.inv.pot || 0) + 1;
        state.objects.splice(state.objects.indexOf(obj), 1);
        state.events.push({ type: 'toast', msg: 'Picked up the pot.' });
      }
      break;
    case 'rack': {
      if (state.product.some((b) => b.where === obj.id && !b.wet)) {
        if (economy.carriedGrams(state) >= economy.carryCap(state)) {
          state.events.push({ type: 'toast', msg: 'You can\'t carry any more (buy a duffel).' });
          break;
        }
        economy.unloadRack(state, obj);
        state.events.push({ type: 'action', name: 'harvest' });
      } else if (state.product.some((b) => b.where === 'inv' && b.wet)) {
        const r = economy.loadRack(state, obj);
        if (!r.ok) state.events.push({ type: 'toast', msg: r.msg });
      }
      break;
    }
    case 'tap':
      if (p.canCharges < PS.canCapacity) {
        p.action = { kind: 'refill', t: 0, dur: actionDuration(state, PS.refillSeconds), source: 'tap' };
      }
      break;
    case 'barrel':
      if (p.canCharges < PS.canCapacity) {
        p.action = { kind: 'refill', t: 0, dur: actionDuration(state, PS.refillSeconds), source: 'barrel', objId: obj.id };
      }
      break;
    case 'bed': {
      // Sleep (plan §A3/My Addition 7): main.js sees the event and runs the
      // sim at 20x until 06:00 (time.sleepStart).
      state.events.push({ type: 'sleep' });
      break;
    }
    case 'shop':
      if (economy.shopOpen(state.time, t.shop)) {
        state.events.push({ type: 'openShop', shop: t.shop });
      } else {
        const sh = CONFIG.economy[t.shop];
        state.events.push({ type: 'toast', msg: `${sh.label} is closed (${hh(sh.open)}-${hh(sh.close)}).` });
      }
      break;
    case 'buyer':
      state.events.push({ type: 'openSell', buyer: t.key });
      break;
    case 'lamp': {
      obj.hours = obj.hours === CONFIG.lamps.hoursNormal ? CONFIG.lamps.hoursLong : CONFIG.lamps.hoursNormal;
      state.events.push({ type: 'toast', msg: `Lamp on a ${obj.hours} h timer${obj.hours === CONFIG.lamps.hoursLong ? ' (faster growth, double heat)' : ''}.` });
      break;
    }
    case 'stash':
    case 'safe':
      state.events.push({ type: 'toast', msg: useContainer(state, obj) });
      break;
    case 'door': {
      const r = installLock(state);
      state.events.push({ type: 'toast', msg: r.msg });
      break;
    }
    case 'ped': {
      const r = economy.streetSale(state, t.ped);
      state.events.push({ type: 'toast', msg: r.ok ? `Sold ${r.grams} g for $${Math.round(r.value)}.` : r.msg });
      break;
    }
  }
}
