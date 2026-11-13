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

const TS = CONFIG.world.tile;
const PS = CONFIG.plants;

// Hotbar items that tend a plant with the primary (left) click.
const TEND_KEYS = { can: 'water', nutrients: 'feed', phkit: 'ph' };

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
    },
    seedBag: [],                // purchased seed genomes, used in order
    cash: CONFIG.economy.startCash,
    bank: 0,                    // clean money (M10; exists for save shape)
    level: 1, xp: 0,            // mastery.js is M7; level 1 throughout M2
    awakeHours: 0,              // Tired after 30 gh awake (plan §A3)
    canCharges: PS.canCapacity, // watering can pours left
    canWater: 'tap',            // water source the can was filled from
    action: null,               // {kind, t, dur, plantId, potId, dir}
    dig: { cx: -1, cy: -1, progress: 0 }, // current dig target and accumulated time
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
  if (key === 'pot' || key === 'rack' || key === 'soil_potting' || key === 'soil_living' ||
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
  if (inp.hotbar !== undefined && inp.hotbar !== null && inp.hotbar !== -1) {
    selectHotbar(state, inp.hotbar);
    inp.hotbar = -1;
  }
  if (inp.wheel) { cycleHotbar(state, inp.wheel > 0 ? 1 : -1); inp.wheel = 0; }
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

  updateAction(state, p, dt);
  if (!p.action) {
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
  if (p.tool === 'pot' || p.tool === 'rack') {
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
  if (key !== 'pot' && key !== 'rack') return false;
  if (!inBounds(cx, cy)) return false;
  const cur = tileAt(state.tiles, cx, cy);
  if (cur !== T.AIR && cur !== T.BGWALL) return false;
  if (!isSolidId(tileAt(state.tiles, cx, cy + 1))) return false;
  if (!isLotX(cx)) return false;
  if (state.objects.some((o) => o.x === cx && o.y === cy)) return false;
  const p = state.player;
  if ((p.inv[key] || 0) <= 0) return false;
  const obj = key === 'pot'
    ? { id: state.nextId++, kind: 'pot', x: cx, y: cy, soil: 'cheap', soilPh: PS.freshSoilPh, plantId: null }
    : { id: state.nextId++, kind: 'rack', x: cx, y: cy };
  p.inv[key]--;
  state.objects.push(obj);
  state.events.push({ type: 'action', name: 'place' });
  return true;
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
    } else if (o.kind === 'skeet') {
      consider({ kind: 'skeet', obj: o }, x, y);
    }
  }

  // The hardware store door (right wall, two tiles above the ground).
  const hw = CONFIG.world.buildings.find((b) => b.key === CONFIG.economy.hardware.building);
  if (hw) {
    const doorX = hw.x + hw.w - 1;
    const doorY = state.surface[doorX] - 1;
    consider({ kind: 'shop' }, doorX, doorY);
  }
  return best;
}

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
    case 'shop': return economy.shopOpen(state.time, 'hardware')
      ? 'E: Browse the hardware store'
      : 'Hardware store (8:00-18:00)';
    case 'skeet': return economy.invBatches(state).length > 0
      ? 'E: Sell to Skeet'
      : 'Skeet: "Got anything to sell?"';
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
      if (economy.shopOpen(state.time, 'hardware')) {
        state.events.push({ type: 'openShop' });
      } else {
        state.events.push({ type: 'toast', msg: 'The hardware store is closed (8:00-18:00).' });
      }
      break;
    case 'skeet':
      if (economy.invBatches(state).length > 0) {
        state.events.push({ type: 'openSell' });
      } else {
        state.events.push({ type: 'toast', msg: 'Skeet: "Come back when you\'ve got product."' });
      }
      break;
  }
}
