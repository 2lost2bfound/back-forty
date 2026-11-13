// main.js — boot, fixed-step loop, perf overlay, UI wiring (plan §B9).
// Loop shape follows plan §B3: clamped dt, 60 Hz fixed physics, 2 Hz sim tick
// (1 tick = 1/60 game hour), sleep runs the sim at 20x and stops physics.
// stepSim (src/sim/sim.js) runs time -> plants -> heat -> economy (crew/threats/...
// join as they are built). The frame loop allocates nothing: input is a
// reused object, the stress pool is a preallocated Float32Array, DOM updates
// happen at CONFIG.ui.updateHz with dirty checks.

import { CONFIG } from './config.js';
import { createRng } from './rng.js';
import { initInput } from './ui/input.js';
import { createRenderer } from './render/renderer.js';
import { initHud } from './ui/hud.js';
import { initMenus } from './ui/menus.js';
import {
  newGame, saveGame, loadGame, autosave, browserStorage, slotKey, autoKey,
} from './state.js';
import { stepPlayer, aimedPot, assignHotbar, interactHint } from './entities/player.js';
import { plantByPot } from './sim/plants.js';
import { sleepStart, isLitHour } from './sim/time.js';
import { stepSim } from './sim/sim.js';
import { stepNpcs } from './entities/npc.js';
import { stepCombat } from './entities/combat.js';
import { T } from './world/tiles.js';
import * as audio from './audio/audio.js';

// ---------------------------------------------------------------- boot ----

let state = newGame(CONFIG.dev.seed);
state.paused = false;
state.stressOn = false;
state.overlayOn = false;
state.altOn = false;

const renderer = createRenderer(document.getElementById('game'));
const input = initInput(document.getElementById('game'));
const hud = initHud();
const menus = initMenus(hud);

// Browsers only allow sound after a user gesture (plan §B8).
for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, () => audio.start());

const perfEl = document.getElementById('perf');
const PHYS_DT = 1 / CONFIG.loop.physicsHz; // 1/60 s
const SIM_DT = 1 / CONFIG.loop.simHz;      // 0.5 s = 1/60 game hour

// Input snapshot for the physics step: one reused plain object, so the player
// module stays DOM-free (plan §B3 rule).
const inp = {
  left: false, right: false, up: false, down: false,
  sprint: false, jumpPressed: false,
  bikePressed: false, reloadPressed: false, clonePressed: false,
  digHeld: false, tendPressed: false, placePressed: false, interactPressed: false,
  aimX: 0, aimY: 0, select: 0,
  hotbar: -1, wheel: 0, alt: false,
};

function readInput() {
  const k = input.keys;
  inp.left = k.has('KeyA');
  inp.right = k.has('KeyD');
  inp.up = k.has('KeyW');
  inp.down = k.has('KeyS');
  inp.sprint = k.has('ShiftLeft') || k.has('ShiftRight');
  inp.jumpPressed = input.wasPressed('KeyW') || input.wasPressed('Space');
  inp.tendPressed = input.wasButtonPressed(0);         // left click: tend/dig start
  inp.digHeld = (input.mouse.buttons & 1) !== 0;       // left held: dig
  inp.placePressed = input.wasButtonPressed(2);        // right click: place / pH Up
  inp.interactPressed = input.wasPressed('KeyE');
  if (input.wasPressed('KeyB')) inp.bikePressed = true;
  if (input.wasPressed('KeyR')) inp.reloadPressed = true;
  if (input.wasPressed('KeyC')) inp.clonePressed = true;
  inp.alt = k.has('AltLeft') || k.has('AltRight');
  inp.aimX = input.mouse.x + renderer.cam.rx;          // mouse -> world cell
  inp.aimY = input.mouse.y + renderer.cam.ry;
  inp.wheel = input.mouse.wheel;
  inp.hotbar = -1;
  for (let i = 0; i < 8; i++) {
    if (input.wasPressed('Digit' + (i + 1))) inp.hotbar = i;
  }
  // M1 tile hotkeys (1/2/3 as tiles) are superseded by the 8-slot hotbar.
  inp.select = 0;
}

/** Drop one-shot inputs while paused or sleeping so nothing queues up. */
function flushOneShots() {
  inp.jumpPressed = false;
  inp.tendPressed = false;
  inp.placePressed = false;
  inp.interactPressed = false;
  inp.bikePressed = false;
  inp.reloadPressed = false;
  inp.clonePressed = false;
  inp.hotbar = -1;
  inp.wheel = 0;
  inp.select = 0;
}

// ------------------------------------------------------------- update ----

/** 60 Hz fixed step: player movement, dig/place/tend actions. (§B3) */
function stepPhysics(s, dt) {
  stepPlayer(s, inp, dt);
  stepCombat(s, dt);
  stepNpcs(s, dt);
  if (s.stressOn) updateStress(dt);
}

/** Stress-scene rectangles bounce inside the canvas (F4 perf gate). */
function updateStress(dt) {
  const rects = stressRects;
  const count = stress.rectangles;
  const w = CONFIG.canvas.width;
  const h = CONFIG.canvas.height;
  const size = stress.rectSize;
  for (let i = 0; i < count; i++) {
    const j = i * 4;
    let x = rects[j] + rects[j + 2] * dt;
    let y = rects[j + 1] + rects[j + 3] * dt;
    if (x < 0) { x = 0; rects[j + 2] = -rects[j + 2]; }
    else if (x > w - size) { x = w - size; rects[j + 2] = -rects[j + 2]; }
    if (y < 0) { y = 0; rects[j + 3] = -rects[j + 3]; }
    else if (y > h - size) { y = h - size; rects[j + 3] = -rects[j + 3]; }
    rects[j] = x;
    rects[j + 1] = y;
  }
}

// ------------------------------------------------------------- events ----

// Sim events -> sound (plan §B8). The sim never calls audio; this is the only wire.
const SFX_ACTION = { pour: 'pour', refill: 'pour', feed: 'feed', ph: 'feed', plant: 'place', place: 'place',
  harvest: 'harvest', snip: 'snip', cash: 'cash', jump: 'jump', dig: 'dig' };
const SFX_GUN = { pistol22: 'gunshot1', pistol9: 'gunshot1', shotgun: 'gunshot2', rifle: 'gunshot3' };
const SFX_EVENT = { sale: 'cash', order: 'phoneBuzz', discover: 'phoneBuzz', missed: 'phoneBuzz', hurt: 'hurt', reload: 'reload',
  meleeHit: 'batHit', dogBite: 'bite', raidStart: 'siren', helicopter: 'siren', theft: 'lockpick', sleep: 'door',
  openShop: 'door', levelUp: 'levelUp' };

function playSfx(ev) {
  let name = null;
  if (ev.type === 'action') name = SFX_ACTION[ev.name];
  else if (ev.type === 'shot') name = SFX_GUN[ev.weapon];
  else if (ev.type === 'swing') name = ev.weapon === 'bat' ? 'batSwing' : null;
  else if (ev.type === 'alert') name = ev.kind === 'dog' ? 'bark' : 'alarm';
  else name = SFX_EVENT[ev.type];
  if (name) audio.sfx(name, ev.x !== undefined ? ev.x - (renderer.cam.rx + CONFIG.canvas.width / 2) : 0);
}

/** Footsteps by distance walked; ambient bed by time of day; tension layer in raids and fights. */
let lastStep = 0;
function stepAudio() {
  const p = state.player;
  const stride = Math.floor(p.walkDist / CONFIG.audio.footstepPx);
  if (stride !== lastStep) { if (p.onGround && !state.paused) audio.sfx('footstep'); lastStep = stride; }
  audio.setMusic(isLitHour(state.time.hour) ? 'day' : 'night');
  audio.setTension((state.cops && state.cops.length > 0) || (state.entities && state.entities.length > 0));
}

/** Consume the sim's event queue once per frame (plan §B3). */
function processEvents() {
  const evs = state.events.splice(0);
  for (const ev of evs) {
    playSfx(ev);
    switch (ev.type) {
      case 'levelUp':
        hud.toast(`Grower level ${ev.level}!${ev.perk ? ' ' + ev.perk : ''}`);
        break;
      case 'dawn': {
        const r = autosave(state, browserStorage);
        hud.toast(r && r.ok ? `Autosaved (dawn of day ${ev.day})` : 'Autosave failed');
        break;
      }
      case 'sleep':
        if (!state.sleeping) {
          sleepStart(state);
          hud.toast('Sleeping until 6:00...');
        }
        break;
      case 'wake':
        hud.toast('Good morning.');
        break;
      case 'harvest':
        menus.queueReport(ev);
        break;
      case 'sale':
        hud.toast(`Sold to ${ev.buyer}: +$${Math.round(ev.value)}`);
        break;
      case 'order':
        hud.toast(`${ev.name} wants ${ev.grams} g.`);
        break;
      case 'missed':
        hud.toast(`You missed ${ev.name}'s order.`);
        break;
      case 'discover':
        hud.toast(`New contact: ${ev.name} (${ev.via}).`);
        break;
      case 'undercover':
        hud.toast('That was an undercover cop! Product gone.');
        break;
      case 'dried':
        hud.toast('A batch finished drying.');
        break;
      case 'plantDied':
        hud.toast(`Your ${ev.strainName} died (${ev.cause}).`);
        break;
      case 'toast':
        hud.toast(ev.msg);
        break;
      case 'notice':
        menus.openNotice(ev.title, ev.lines);
        break;
      case 'raidStart':
        hud.toast(`POLICE RAID: ${ev.cops} cops are coming up the road!`);
        break;
      case 'raidWarning':
        hud.toast(ev.source === 'deputy'
          ? 'The deputy phones: "They are coming for you tonight."'
          : `Scanner: a raid is coming in ${ev.gh} hours.`);
        break;
      case 'alert':
        hud.toast(ev.msg);
        break;
      case 'hostile':
        hud.toast(ev.kind === 'thief' ? 'Someone is creeping around the lot.' : 'Trouble is coming for you tonight.');
        break;
      case 'ko':
        hud.toast('Knocked out. He will crawl off, and word gets around.');
        break;
      case 'kill':
        hud.toast('He is dead. That is heat, and somebody will want revenge.');
        break;
      case 'officerWarning':
        menus.openNotice('WARNING: THAT IS AN OFFICER', [
          'Shooting a police officer: +50 heat and a permanent heat floor of 25.',
          'The license needs heat of 20 or less. After this it is out of reach for the rest of the run.',
          'Killing an officer ends the run: you become a Fugitive.',
          'Aim again and fire only if you mean it.',
        ]);
        break;
      case 'helicopter':
        hud.toast('A helicopter circles in the dusk.');
        break;
      case 'skipped':
        hud.toast(`${ev.days} day(s) pass.`);
        break;
      case 'gameOver':
        menus.openGameOver(ev.reason);
        break;
      case 'openShop':
        menus.openShop(state, ev.shop);
        break;
      case 'openSell':
        menus.openSell(state, ev.buyer);
        break;
      default:
        break; // 'action' sfx events are wired in M7
    }
  }
}

// -------------------------------------------------------------- frame ----

let last = performance.now();
let physAcc = 0;
let simAcc = 0;
let lastDt = 0;
let hoverInfo = null;
let lastUi = performance.now();

function frame(now) {
  const rawMs = now - last; // real frame delta, before the hidden-tab clamp
  const dt = Math.min(rawMs / 1000, CONFIG.loop.maxFrameDt);
  last = now;
  lastDt = dt;

  state.paused = menus.anyOpen();
  readInput();

  if (state.paused) {
    flushOneShots();
  } else if (!state.sleeping) {
    state.altOn = inp.alt;
    physAcc += dt;
    let steps = 0;
    while (physAcc >= PHYS_DT) {
      stepPhysics(state, PHYS_DT);
      physAcc -= PHYS_DT;
      if (++steps >= CONFIG.loop.maxPhysicsStepsPerFrame) { physAcc = 0; break; }
    }
    simAcc += dt;
    let simSteps = 0;
    while (simAcc >= SIM_DT) {
      stepSim(state, SIM_DT);
      simAcc -= SIM_DT;
      if (++simSteps >= CONFIG.loop.maxSimStepsPerFrame) { simAcc = 0; break; }
    }
  } else {
    // Sleeping: physics never runs (plan §B3); the sim catches up at 20x.
    flushOneShots();
    simAcc += dt * CONFIG.sleep.speed;
    let simSteps = 0;
    while (simAcc >= SIM_DT) {
      stepSim(state, SIM_DT);
      simAcc -= SIM_DT;
      if (++simSteps >= CONFIG.loop.maxSimStepsPerFrame * CONFIG.sleep.speed) { simAcc = 0; break; }
    }
  }

  updateHover();
  render();

  // Dev toggles and global keys (plan §A2 / §B2).
  if (input.wasPressed('F3')) {
    state.overlayOn = !state.overlayOn;
    perfEl.style.display = state.overlayOn ? 'block' : 'none';
  }
  if (input.wasPressed('F4')) {
    state.stressOn = !state.stressOn;
  }
  if (input.wasPressed('Escape') || input.wasPressed('KeyE')) {
    if (menus.isOpen('gameover')) { /* only its button leaves */ }
    else if (menus.anyOpen()) menus.closeAll();
    else if (input.wasPressed('Escape')) menus.openPause(state);
  }
  if (input.wasPressed('KeyI') && !menus.anyOpen()) menus.openInventory(state);
  if (input.wasPressed('Tab')) {
    if (menus.isOpen('phone')) menus.closeAll();
    else if (!menus.anyOpen()) menus.openPhone(state);
  }

  processEvents();
  stepAudio();

  // HUD + hover panel at ui.updateHz (DOM, dirty-checked).
  if (now - lastUi >= 1000 / CONFIG.ui.updateHz) {
    lastUi = now;
    hud.update(state, interactHint(state));
    menus.tick(state, hoverInfo);
  }

  input.endFrame();
  updateOverlay(now, rawMs);

  requestAnimationFrame(frame);
}

function updateHover() {
  const pot = aimedPot(state, inp);
  hoverInfo = pot ? { pot, plant: plantByPot(state, pot) } : null;
  state.hoverCell = pot ? { x: pot.x, y: pot.y } : null;
}

function render() {
  renderer.draw(state, state.paused ? 0 : lastDt);
  if (state.stressOn) {
    renderer.drawStressRects(stressRects, stress.rectangles);
  }
}

// ------------------------------------------------- save/load UI hooks ----

window.addEventListener('backforty:assign', (e) => {
  if (assignHotbar(state, state.player.hotbarIndex, e.detail.key)) {
    hud.toast(`Assigned to slot ${state.player.hotbarIndex + 1}.`);
  }
});
window.addEventListener('backforty:loadauto', () => {
  const loaded = loadGame(autoKey(1), browserStorage);
  if (!loaded) { hud.toast('No autosave yet.'); return; }
  state = loaded;
  menus.closeAll();
  renderer.invalidate();
  hud.toast('Loaded the last autosave.');
});
window.addEventListener('backforty:save', () => {
  const r = saveGame(state, slotKey(1), browserStorage);
  hud.toast(r.ok ? 'Saved.' : `Save failed: ${r.error}`);
});
window.addEventListener('backforty:load', () => {
  const loaded = loadGame(slotKey(1), browserStorage);
  if (!loaded) { hud.toast('Nothing to load.'); return; }
  state = loaded;
  menus.closeAll();
  renderer.invalidate();
  hud.toast('Loaded.');
});

// Preallocated stress-rectangle pool: [x, y, vx, vy] per rectangle.
const stress = CONFIG.stress;
const stressRects = new Float32Array(stress.rectangles * 4);
const stressRng = createRng(CONFIG.dev.seed ^ 0x9e3779b9);
for (let i = 0; i < stress.rectangles; i++) {
  const j = i * 4;
  stressRects[j] = stressRng.range(0, CONFIG.canvas.width);
  stressRects[j + 1] = stressRng.range(0, CONFIG.canvas.height);
  stressRects[j + 2] = stressRng.range(stress.speedMin, stress.speedMax) *
    (stressRng.chance(0.5) ? 1 : -1);
  stressRects[j + 3] = stressRng.range(stress.speedMin, stress.speedMax) *
    (stressRng.chance(0.5) ? 1 : -1);
}

// ------------------------------------------------------ perf overlay ----
// F3 shows fps and frame ms plus entity/particle counts (plan §A2).
// DOM, updated at overlayHz with dirty checks — never per frame.

const hist = new Float32Array(CONFIG.perf.frameHistory);
let histLen = 0;
let histAt = 0;
let lastOverlay = performance.now();
let framesSince = 0;
let lastText = '';

function updateOverlay(now, rawMs) {
  hist[histAt] = rawMs; // frame duration in ms
  histAt = (histAt + 1) % hist.length;
  if (histLen < hist.length) histLen++;
  framesSince++;

  const interval = 1000 / CONFIG.perf.overlayHz;
  if (now - lastOverlay < interval) return;
  const span = now - lastOverlay;
  lastOverlay = now;

  let avg = 0;
  let worst = 0;
  for (let i = 0; i < histLen; i++) {
    avg += hist[i];
    if (hist[i] > worst) worst = hist[i];
  }
  avg = histLen ? avg / histLen : 0;
  const fps = Math.round((framesSince * 1000) / span);
  const p = state.player;
  const ents = 1 + (state.stressOn ? stress.rectangles : 0);
  const text =
    `fps ${fps}  frame ${avg.toFixed(1)}ms avg / ${worst.toFixed(1)}ms max\n` +
    `ents ${ents}  plants ${state.plants.length}  parts 0  dirty ${state.dirtyChunks.size}` +
    `${state.stressOn ? '  STRESS (F4)' : ''}${state.sleeping ? '  SLEEP x' + CONFIG.sleep.speed : ''}\n` +
    `day ${state.time.day} ${state.time.hour.toFixed(2)}gh  cash $${Math.round(p.cash)}  pos ${(p.x | 0)},${(p.y | 0)}`;
  framesSince = 0;
  if (text !== lastText) {
    lastText = text;
    perfEl.textContent = text;
  }
}

requestAnimationFrame(frame);
