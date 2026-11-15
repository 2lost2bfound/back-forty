// renderer.js — camera, sky, parallax hills, tile chunks, entities (plan §B7).
// Draw order per frame: sky -> hills -> tile chunks -> objects+plants ->
// player -> night tint -> world-space UI (Alt bars, dig cell). The canvas is
// 800x450 internally, never resized; imageSmoothingEnabled is false
// everywhere; camera positions are rounded to whole pixels.
//
// Tile chunks: 25x4 = 100 offscreen 256x256 canvases (16x16 tiles each). A
// tile edit marks its chunk dirty in state.dirtyChunks; at most
// maxChunkRedrawsPerFrame chunks re-render per frame. Browser-only module.

import { CONFIG } from '../config.js';
import { buildAtlas } from './sprites.js';
import { tileInfo, getTile } from '../world/tiles.js';
import { plantFrameName, PLANT_H } from './spritedata.js';
import { ART_RECTS } from './artdata.js';
import { createLighting } from './lighting.js';
import { drawRain } from './particles.js';
import { isRaining } from '../sim/time.js';
import { hs } from '../sim/heat.js';
import { stageOf, stressorsOf } from '../sim/plants.js';
import { presentBuyers } from '../entities/npc.js';

const W = CONFIG.canvas.width;
const H = CONFIG.canvas.height;
const TS = CONFIG.world.tile;
const CHUNK = CONFIG.render.chunkTiles;
const CHUNK_PX = CHUNK * TS;
const CHUNK_COLS = CONFIG.render.chunkCols;
const CHUNK_ROWS = CONFIG.render.chunkRows;
const WORLD_PX_W = CONFIG.world.cols * TS;
const WORLD_PX_H = CONFIG.world.rows * TS;

const ALLY_COLORS = { walt: '#7a8a4a', benny: '#c47a2a', june: '#c44a8a', rosa: '#f0f0f0' }; // M9 allies

// v1.1 art (tools/extract_art.py). Images load async; until they do (or if a
// name has no art) the old procedural shapes draw instead.
const loadImg = (src) => Object.assign(new Image(), { src });
const ART_SHEET = loadImg('assets/sprites.png');
const BACKDROP = loadImg('assets/background.jpg');
const FACADES = Object.fromEntries(CONFIG.world.buildings.map((b) => [b.key, loadImg(`assets/buildings/${b.key}.png`)]));
const ready = (img) => img.complete && img.naturalWidth > 0;
const BUYER_ART = { skeet: 'skeet', marla: 'marla', doc: 'doc_renner', tone: 'big_tone', vivian: 'vivian' };
const PED_ART = ['ped0', 'ped1', 'ped2', 'ped3', 'ped4'];
const entityArt =(e) => (e.kind === 'ally' ? e.ally : e.biker ? 'goon' : e.kind);

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const atlas = buildAtlas();
  const sky = makeSkyCanvas();
  const hills = makeHillsCanvas();
  const lighting = createLighting();

  // Chunk canvases are created up front and rendered lazily: on the first
  // draw every chunk is rendered once, after that only dirty ones.
  const chunkCanvases = new Array(CHUNK_COLS * CHUNK_ROWS);
  const chunkCtxs = new Array(CHUNK_COLS * CHUNK_ROWS);
  for (let i = 0; i < chunkCanvases.length; i++) {
    const c = document.createElement('canvas');
    c.width = CHUNK_PX;
    c.height = CHUNK_PX;
    chunkCanvases[i] = c;
    const cc = c.getContext('2d');
    cc.imageSmoothingEnabled = false;
    chunkCtxs[i] = cc;
  }
  let chunksRendered = false;
  ART_SHEET.addEventListener('load', () => { chunksRendered = false; }); // repaint tiles with the art

  // Camera floats (lerped) and rounded draw position. Exposed so main.js can
  // convert mouse aim to world coordinates.
  const cam = { x: 0, y: 0, rx: 0, ry: 0 };

  function renderChunk(state, idx) {
    const cc = chunkCtxs[idx];
    cc.clearRect(0, 0, CHUNK_PX, CHUNK_PX);
    const cx0 = (idx % CHUNK_COLS) * CHUNK;
    const cy0 = ((idx / CHUNK_COLS) | 0) * CHUNK;
    for (let ty = 0; ty < CHUNK; ty++) {
      const wy = cy0 + ty;
      if (wy >= CONFIG.world.rows) break;
      const base = wy * CONFIG.world.cols + cx0;
      for (let tx = 0; tx < CHUNK; tx++) {
        const wx = cx0 + tx;
        if (wx >= CONFIG.world.cols) break;
        const id = state.tiles[base + tx];
        if (!id) continue;
        const name = 'tile_' + tileInfo(id).name;
        const ar = ready(ART_SHEET) && ART_RECTS[name];
        if (ar) cc.drawImage(ART_SHEET, ar[0], ar[1], ar[2], ar[3], tx * TS, ty * TS, TS, TS);
        else {
          const r = atlas.rects[name];
          if (r) cc.drawImage(atlas.canvas, r[0], r[1], r[2], r[3], tx * TS, ty * TS, TS, TS);
        }
      }
    }
  }

  function renderAllChunks(state) {
    for (let i = 0; i < chunkCanvases.length; i++) renderChunk(state, i);
    chunksRendered = true;
  }

  function flushDirtyChunks(state) {
    let n = 0;
    for (const idx of state.dirtyChunks) {
      renderChunk(state, idx);
      state.dirtyChunks.delete(idx);
      if (++n >= CONFIG.render.maxChunkRedrawsPerFrame) break;
    }
  }

  function updateCamera(state, dt) {
    const p = state.player;
    const tx = p.x + p.w / 2 - W / 2;
    const ty = p.y + p.h / 2 - H / 2;
    const k = dt > 0 ? Math.min(1, dt / CONFIG.render.cameraLagS) : 1;
    cam.x += (tx - cam.x) * k;
    cam.y += (ty - cam.y) * k;
    cam.x = Math.max(0, Math.min(WORLD_PX_W - W, cam.x));
    cam.y = Math.max(0, Math.min(WORLD_PX_H - H, cam.y));
    cam.rx = Math.round(cam.x);
    cam.ry = Math.round(cam.y);
  }

  // Art backdrop: scaled once to the screen height, tiled sideways at the hills'
  // parallax rate, bottom on the surface line; its top colour fills the sky above.
  let bg = null;
  function drawBackdrop() {
    if (!bg) {
      if (!ready(BACKDROP)) return false;
      bg = document.createElement('canvas');
      bg.height = H;
      bg.width = Math.round(H * BACKDROP.naturalWidth / BACKDROP.naturalHeight);
      const g = bg.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(BACKDROP, 0, 0, bg.width, bg.height);
      const p = g.getImageData(0, 0, 1, 1).data;
      bg.sky = `rgb(${p[0]},${p[1]},${p[2]})`;
    }
    const by = CONFIG.world.surfaceRow * TS - Math.round(bg.height * 0.7) - cam.ry; // dark bottom 30% sits behind the ground
    ctx.fillStyle = bg.sky;
    ctx.fillRect(0, 0, W, Math.max(0, by + 1));
    if (by > H) return true;
    const bx = -Math.floor((cam.rx * CONFIG.render.hills.scroll) % bg.width);
    for (let x = bx; x < W; x += bg.width) ctx.drawImage(bg, x, by);
    return true;
  }

  function drawHills() {
    const hh = CONFIG.render.hills.h;
    const hy = CONFIG.world.surfaceRow * TS - hh - cam.ry;
    if (hy > H || hy + hh < 0) return;
    const hw = CONFIG.render.hills.w;
    const hx = -Math.floor((cam.rx * CONFIG.render.hills.scroll) % hw);
    ctx.drawImage(hills, hx, hy);
    if (hx + hw < W) ctx.drawImage(hills, hx + hw, hy);
  }

  function drawVisibleChunks(state) {
    const cx0 = Math.max(0, (cam.rx / CHUNK_PX) | 0);
    const cx1 = Math.min(CHUNK_COLS - 1, ((cam.rx + W - 1) / CHUNK_PX) | 0);
    const cy0 = Math.max(0, Math.floor(cam.ry / CHUNK_PX));
    const cy1 = Math.min(CHUNK_ROWS - 1, Math.floor((cam.ry + H - 1) / CHUNK_PX));
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        ctx.drawImage(chunkCanvases[cy * CHUNK_COLS + cx], cx * CHUNK_PX - cam.rx, cy * CHUNK_PX - cam.ry);
      }
    }
  }

  function playerFrameName(p) {
    if (p.action || p.dig.cx >= 0) return 'tend';
    if (!p.onGround && !p.onLadder) return 'jump';
    if (Math.abs(p.vx) > 1 && p.onGround) return 'walk' + (Math.floor(p.walkDist / 10) % 4);
    return 'idle';
  }

  /** Draw an art frame centred on cx with its bottom at feetY. False = no art yet. */
  function drawArt(name, cx, feetY) {
    const r = ART_RECTS[name];
    if (!r || !ready(ART_SHEET)) return false;
    const sx = Math.round(cx - r[2] / 2);
    const sy = Math.round(feetY - r[3]);
    if (sx > -r[2] && sx < W && sy > -r[3] && sy < H) ctx.drawImage(ART_SHEET, r[0], r[1], r[2], r[3], sx, sy, r[2], r[3]);
    return true;
  }

  // Facing for NPCs, from their movement between frames ('' right, 'L' left).
  const lastX = new WeakMap();
  function facing(obj, x) {
    const prev = lastX.get(obj) || { x, f: '', d: 0 };
    const dx = Math.abs(x - prev.x);
    const f = dx > 0.05 ? (x < prev.x ? 'L' : '') : prev.f;
    lastX.set(obj, { x, f, d: prev.d + dx, moving: dx > 0.05 });
    return f;
  }

  /** NPC art name: a walk frame (every 10 px walked, like the grower) while moving, if the sheet has one. */
  function walkArt(base, obj, x) {
    const f = facing(obj, x);
    const s = lastX.get(obj);
    const walk = `${base}_walk${Math.floor(s.d / 10) % 4}`;
    return (s.moving && ART_RECTS[walk] ? walk : base) + f;
  }

  // Facade art is ~1000 px wide: scale it once, smoothed, to the footprint width.
  const facadeCache = {};
  function facadeCanvas(b) {
    if (facadeCache[b.key]) return facadeCache[b.key];
    const img = FACADES[b.key];
    if (!ready(img)) return null;
    const c = document.createElement('canvas');
    c.width = b.w * TS;
    c.height = Math.round(c.width * img.naturalHeight / img.naturalWidth);
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, c.width, c.height);
    return (facadeCache[b.key] = c);
  }

  /** Building facades over their tile footprint, faded while the player is inside. */
  function drawBuildings(state) {
    const p = state.player;
    const pcx = p.x + p.w / 2;
    for (const b of CONFIG.world.buildings) {
      const img = facadeCanvas(b);
      if (!img) continue;
      const w = img.width;
      const h = img.height;
      const ground = state.surface[b.x] * TS;
      const sx = b.x * TS - cam.rx;
      const sy = ground - h - cam.ry;
      if (sx > W || sx + w < 0 || sy > H || sy + h < 0) continue;
      const inside = pcx > b.x * TS && pcx < b.x * TS + w && p.y + p.h > ground - b.h * TS && p.y < ground;
      if (inside) ctx.globalAlpha = 0.2;
      ctx.drawImage(img, sx, sy, w, h);
      ctx.globalAlpha = 1;
    }
  }

  function drawPlayer(state) {
    const p = state.player;
    let name = playerFrameName(p);
    if (p.facing < 0) name += 'L';
    if (drawArt('grower_' + name, p.x + p.w / 2 - cam.rx, p.y + p.h - cam.ry)) return;
    const r = atlas.rects['player_' + name] || atlas.rects['player_idle'];
    const sx = Math.round(p.x + p.w / 2 - PLAYER_HW - cam.rx);
    const sy = Math.round(p.y + p.h - PLAYER_HH - cam.ry);
    ctx.drawImage(atlas.canvas, r[0], r[1], r[2], r[3], sx, sy, r[2], r[3]);
  }

  // ------------------------------------------------- objects and plants ----

  const OBJECT_SPRITES = { pot: 'obj_pot', rack: 'obj_rack', tap: 'obj_tap', barrel: 'obj_barrel', bed: 'obj_bed', skeet: 'obj_skeet', stove: 'obj_stove' };
  const plantById = (state, id) => (id ? state.plants.find((pl) => pl.id === id) || null : null);

  /** Objects in view: pots (with their plant), racks, fixtures, markers. */
  function drawObjectsAndPlants(state) {
    const x0 = cam.rx - TS;
    const x1 = cam.rx + W;
    for (const o of state.objects) {
      const px = o.x * TS;
      if (px < x0 || px > x1) continue;
      const py = o.y * TS - cam.ry;
      const sx = px - cam.rx;
      if (o.kind === 'pot') {
        drawSprite('obj_pot', sx, py);
        const plant = plantById(state, o.plantId);
        if (plant) {
          // 16x32 with the base on the soil: ~12px into the old pot cell, ~8px into the art pot.
          drawSprite('plant_' + plantFrameName(plant), sx, py + (ready(ART_SHEET) ? 8 : 12) - PLANT_H);
        }
      } else if (NEW_OBJECTS[o.kind]) {
        drawNewObject(o, sx, py);
      } else {
        drawSprite(o.kind === 'stove' && o.cook && o.cook.left > 0 ? 'obj_stove_on' : OBJECT_SPRITES[o.kind], sx, py);
        if (o.kind === 'rack') {
          const n = state.product.reduce((s, b) => s + (b.where === o.id ? 1 : 0), 0);
          if (n > 0) {
            ctx.fillStyle = '#c9a23f';
            ctx.fillRect(sx + 2, py + 3, Math.min(12, n * 3), 2);
          }
        }
      }
    }
  }

  // M4 objects are drawn as simple shapes (procedural, no atlas entries).
  const NEW_OBJECTS = {
    tripwire: '#b9b9b9', floodlight: '#f5f0a0', camera: '#2b2b2b',
    lamp: '#f2e48a', stash: '#7a5a34', safe: '#6c7480', filter: '#3b3f46',
    generator: '#c9632b', hatch: 'rgba(40,28,16,0.9)', farmstand: '#d9b44a',
  };
  function drawNewObject(o, sx, py) {
    if (ready(ART_SHEET) && ART_RECTS['obj_' + o.kind]) return drawSprite('obj_' + o.kind, sx, py);
    ctx.fillStyle = NEW_OBJECTS[o.kind];
    if (o.kind === 'lamp') ctx.fillRect(sx + 5, py + 2, 6, 4);
    else if (o.kind === 'hatch') ctx.fillRect(sx + 1, py + 7, TS - 2, 2);
    else ctx.fillRect(sx + 2, py + 5, TS - 4, TS - 5);
  }

  /** Cops, the patrol car and the unmarked car (M4 world tells). */
  function drawPolice(state) {
    const ground = state.surface[CONFIG.world.zones.roadX0 + 5] * TS - cam.ry;
    const T = CONFIG.heat.tells;
    if (state.tells && state.tells.unmarkedCar) drawCar(T.unmarkedCarX * TS - cam.rx, ground, '#2a2d33', false, 'unmarked_car');
    if (state.patrolCar) drawCar(state.patrolCar.x - cam.rx, ground, '#e8edf5', true, 'patrol_car' + facing(state.patrolCar, state.patrolCar.x));
    ctx.fillStyle = '#2f5fb8';
    for (const c of state.cops || []) {
      const sx = Math.round(c.x - cam.rx);
      if (sx < -8 || sx > W) continue;
      const feet = state.surface[(c.x / TS) | 0] * TS - cam.ry;
      if (!drawArt(walkArt('cop', c, c.x), sx, feet)) ctx.fillRect(sx - 3, Math.round(feet - 14), 6, 14);
    }
    const raid = hs(state).raid;
    if (raid && raid.path.length > 0) {
      const k = Math.min(1, raid.t / CONFIG.heat.raid.arriveGh) * (raid.path.length - 1);
      const [tx, ty] = raid.path[Math.floor(k)];
      for (let i = 0; i < raid.cops; i++) {
        const x = tx * TS + i * 5 - cam.rx;
        if (!drawArt('cop', x + 2, (ty + 1) * TS - cam.ry)) ctx.fillRect(Math.round(x), Math.round(ty * TS - 6 - cam.ry), 5, 22);
      }
    }
  }

  /** M5: thieves, the dog and the player's bullets. */
  function drawThreats(state, dt) {
    const k = Math.min(1, (dt || 1 / 60) * 10);
    for (const e of state.entities || []) {
      e.rx = e.rx === undefined ? e.x : e.rx + (e.x - e.rx) * k;
      const sx = Math.round(e.rx - cam.rx);
      if (sx < -16 || sx > W) continue;
      const feet = Math.round(e.y - cam.ry);
      const down = e.state === 'ko' || e.state === 'downed';
      if (drawArt(down ? entityArt(e) + '_down' : walkArt(entityArt(e), e, e.rx), sx, feet)) continue;
      ctx.fillStyle = e.kind === 'ally' ? ALLY_COLORS[e.ally] : e.biker ? '#5a3a1e' : e.kind === 'goon' ? '#3a2e5a' : e.kind === 'saboteur' ? '#4a4a4a' : '#7a2e2e';
      if (e.state === 'ko' || e.state === 'downed') ctx.fillRect(sx - 11, feet - 6, 22, 6);
      else ctx.fillRect(sx - 6, feet - 22, 12, 22);
    }
    // Crew (M6): runners (blue), the guard (green), the gardener (olive).
    const colors = { runner: '#3a7fc4', guard: '#2f8f4a', gardener: '#8a9a2f' };
    for (const m of (state.crew && state.crew.members) || []) {
      if (m.status !== 'active') continue;
      const sx = Math.round(m.x - cam.rx);
      if (sx < -16 || sx > W) continue;
      const feet = Math.round((m.role === 'gardener' ? m.y + TS : state.surface[Math.max(0, Math.min(399, (m.x / TS) | 0))] * TS) - cam.ry);
      if (drawArt(m.role + facing(m, m.x), sx, feet)) continue;
      ctx.fillStyle = colors[m.role];
      ctx.fillRect(sx - 6, feet - 22, 12, 22);
    }
    const dog = state.threats && state.threats.dog;
    if (dog) {
      const sx = Math.round(dog.x - cam.rx);
      const feet = Math.round(state.surface[(dog.x / TS) | 0] * TS - cam.ry);
      if (!drawArt(dog.hp > 0 ? 'dog' + facing(dog, dog.x) : 'dog_down', sx, feet)) {
        ctx.fillStyle = dog.hp > 0 ? '#9a6b3a' : '#6b6b6b';
        ctx.fillRect(sx - 7, feet - 9, 14, 9);
      }
    }
    ctx.fillStyle = '#ffe66b';
    for (const b of state.bullets || []) ctx.fillRect(Math.round(b.x - cam.rx), Math.round(b.y - cam.ry), 2, 2);
  }

  function drawCar(sx, ground, color, lights, art) {
    if (sx < -40 || sx > W) return;
    if (drawArt(art, sx + 16, ground)) return; // art is 44 wide, centred on the old 32 px body
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(sx), Math.round(ground - 12), 32, 10);
    ctx.fillRect(Math.round(sx + 8), Math.round(ground - 18), 16, 6);
    if (lights && ((Date.now() / 250) | 0) % 2) { ctx.fillStyle = '#d8402e'; ctx.fillRect(Math.round(sx + 12), Math.round(ground - 21), 8, 3); }
  }

  /** Buyers at their spots (marker sprite) and pedestrians (small figures). */
  function drawPeople(state) {
    for (const b of presentBuyers(state)) {
      if (drawArt(BUYER_ART[b.key], b.x * TS + TS / 2 - cam.rx, state.surface[b.x] * TS - cam.ry)) continue;
      drawSprite('obj_skeet', b.x * TS - cam.rx, (state.surface[b.x] - 1) * TS - cam.ry);
    }
    ctx.fillStyle = '#8a7fa8';
    state.npcs.forEach((n, i) => {
      const sx = Math.round(n.x - cam.rx);
      if (sx < -8 || sx > W) return;
      const feet = state.surface[(n.x / TS) | 0] * TS - cam.ry;
      if (drawArt(PED_ART[(n.id ?? i) % PED_ART.length] + facing(n, n.x), sx, feet)) return;
      ctx.fillRect(sx - 3, Math.round(feet - 14), 6, 14);
    });
  }

  function drawSprite(name, sx, sy) {
    const ar = ready(ART_SHEET) && ART_RECTS[name];
    if (ar) {
      if (sy > -ar[3] && sy < H && sx > -ar[2] && sx < W) ctx.drawImage(ART_SHEET, ar[0], ar[1], ar[2], ar[3], sx, sy, ar[2], ar[3]);
      return;
    }
    const r = atlas.rects[name];
    if (!r || sy < -r[3] || sy > H || sx < -r[2] || sx > W) return;
    ctx.drawImage(atlas.canvas, r[0], r[1], r[2], r[3], sx, sy, r[2], r[3]);
  }

  /** Hover highlight on the pot cell the player is inspecting. */
  function drawHover(state) {
    if (!state.hoverCell) return;
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.strokeRect(state.hoverCell.x * TS - cam.rx + 0.5, state.hoverCell.y * TS - cam.ry + 0.5, TS - 1, TS - 1);
  }

  // --------------------------------------------------- world-space UI ------
  // Alt overlay (My Addition 6): moisture/pH/nutrient bars + a stressor dot
  // over every plant on screen. Three 2px bars, drawn only for visible plants.

  function drawAltOverlay(state) {
    if (!state.altOn) return;
    const A = CONFIG.render.alt;
    for (const plant of state.plants) {
      const pot = state.objects.find((o) => o.id === plant.potId);
      if (!pot) continue;
      const sx = pot.x * TS - cam.rx;
      if (sx < -TS || sx > W) continue;
      const top = pot.y * TS + 12 - PLANT_H - cam.ry - 8;
      bar(sx + 1, top, plant.moisture / 100, A.moisture, A);
      bar(sx + 1, top + A.barGap + A.barH, (plant.ph - 4) / 4, A.ph, A); // pH 4.0-8.0
      bar(sx + 1, top + 2 * (A.barGap + A.barH), plant.nutrients / 100, A.nutrients, A);
      if (stageOf(plant) !== 'dead' && stressorsOf(plant).length > 0) {
        ctx.fillStyle = A.stress;
        ctx.fillRect(sx + 7, top - 3, 2, 2);
      }
    }
  }

  function bar(x, y, frac, color, A) {
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x - 1, y - 1, A.barW + 2, A.barH + 2);
    ctx.fillStyle = color;
    ctx.fillRect(x, y, Math.round(A.barW * Math.max(0, Math.min(1, frac))), A.barH);
  }

  // World-space UI (plan §B7 item 8, minimal in M1): the active dig cell and
  // its progress bar.
  function drawDig(state) {
    const p = state.player;
    if (p.dig.cx < 0) return;
    const x = p.dig.cx * TS - cam.rx;
    const y = p.dig.cy * TS - cam.ry;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, TS - 1, TS - 1);
    const d = tileInfo(getTile(state, p.dig.cx, p.dig.cy));
    const frac = Math.min(1, p.dig.progress / d.digTime);
    ctx.fillStyle = '#ffe119';
    ctx.fillRect(x, y - 4, Math.round(TS * frac), 2);
  }

  return {
    ctx,
    cam,

    /** Force a full chunk repaint (after loading a save with different tiles). */
    invalidate() {
      chunksRendered = false;
    },

    /** One full frame. */
    draw(state, dt) {
      if (!chunksRendered) renderAllChunks(state); // boot: paint the world once
      updateCamera(state, dt);
      flushDirtyChunks(state);
      if (!drawBackdrop()) {
        ctx.drawImage(sky, 0, 0, 1, H, 0, 0, W, H); // 1px gradient stretched
        drawHills();
      }
      drawVisibleChunks(state);
      drawBuildings(state);
      drawObjectsAndPlants(state);
      drawPeople(state);
      drawPolice(state);
      drawThreats(state, dt);
      drawPlayer(state);
      drawDig(state);
      drawHover(state);
      lighting.draw(ctx, state, cam);
      if (state.stressOn) drawRain(ctx, dt || 1 / 60, CONFIG.stress.particles); // F4: rain at night
      else if (isRaining(state)) drawRain(ctx, dt || 1 / 60);
      drawAltOverlay(state);
    },
  };
}

const PLAYER_HW = 8;  // half sprite width (16)
const PLAYER_HH = 24; // sprite height; feet align with the hitbox bottom

/** 2-stop vertical gradient cached in a 1xH canvas (plan §B7 item 1). */
function makeSkyCanvas() {
  const c = document.createElement('canvas');
  c.width = 1;
  c.height = H;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, CONFIG.render.skyTop);
  grad.addColorStop(1, CONFIG.render.skyBottom);
  g.fillStyle = grad;
  g.fillRect(0, 0, 1, H);
  return c;
}

/** Pre-rendered parallax hills: 1600x200, 3 filled sine layers (plan §C1). */
function makeHillsCanvas() {
  const cfg = CONFIG.render.hills;
  const c = document.createElement('canvas');
  c.width = cfg.w;
  c.height = cfg.h;
  const g = c.getContext('2d');
  for (const layer of cfg.layers) {
    g.fillStyle = layer.color;
    g.beginPath();
    g.moveTo(0, cfg.h);
    for (let x = 0; x <= cfg.w; x += 4) {
      const y = layer.base - layer.amp *
        (0.6 * Math.sin(x * layer.freq + layer.phase) +
         0.4 * Math.sin(x * layer.freq * 2.7 + layer.phase * 1.7));
      g.lineTo(x, y);
    }
    g.lineTo(cfg.w, cfg.h);
    g.closePath();
    g.fill();
  }
  return c;
}
