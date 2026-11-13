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
import { drawNightTint } from './lighting.js';
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

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const atlas = buildAtlas();
  const sky = makeSkyCanvas();
  const hills = makeHillsCanvas();

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
        const r = atlas.rects['tile_' + tileInfo(id).name];
        if (r) cc.drawImage(atlas.canvas, r[0], r[1], r[2], r[3], tx * TS, ty * TS, TS, TS);
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

  function drawPlayer(state) {
    const p = state.player;
    let name = playerFrameName(p);
    if (p.facing < 0) name += 'L';
    const r = atlas.rects['player_' + name] || atlas.rects['player_idle'];
    const sx = Math.round(p.x + p.w / 2 - PLAYER_HW - cam.rx);
    const sy = Math.round(p.y + p.h - PLAYER_HH - cam.ry);
    ctx.drawImage(atlas.canvas, r[0], r[1], r[2], r[3], sx, sy, r[2], r[3]);
  }

  // ------------------------------------------------- objects and plants ----

  const OBJECT_SPRITES = { pot: 'obj_pot', rack: 'obj_rack', tap: 'obj_tap', barrel: 'obj_barrel', bed: 'obj_bed', skeet: 'obj_skeet' };
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
          // 16x32 with the base ~12px into the pot cell.
          drawSprite('plant_' + plantFrameName(plant), sx, py + 12 - PLANT_H);
        }
      } else {
        drawSprite(OBJECT_SPRITES[o.kind], sx, py);
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

  /** Buyers at their spots (marker sprite) and pedestrians (small figures). */
  function drawPeople(state) {
    for (const b of presentBuyers(state)) {
      drawSprite('obj_skeet', b.x * TS - cam.rx, (state.surface[b.x] - 1) * TS - cam.ry);
    }
    ctx.fillStyle = '#8a7fa8';
    for (const n of state.npcs) {
      const sx = Math.round(n.x - cam.rx);
      if (sx < -8 || sx > W) continue;
      ctx.fillRect(sx - 3, Math.round(state.surface[(n.x / TS) | 0] * TS - 14 - cam.ry), 6, 14);
    }
  }

  function drawSprite(name, sx, sy) {
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
      ctx.drawImage(sky, 0, 0, 1, H, 0, 0, W, H); // 1px gradient stretched
      drawHills();
      drawVisibleChunks(state);
      drawObjectsAndPlants(state);
      drawPeople(state);
      drawPlayer(state);
      drawDig(state);
      drawHover(state);
      drawNightTint(ctx, state.time.hour); // flat night tint (M4: lights)
      drawAltOverlay(state);
    },

    /**
     * F4 stress rectangles. Rects live in a Float32Array [x, y, vx, vy] per
     * rectangle; color fixed per index bucket so fillStyle changes at most
     * `colors.length` times per frame and the frame loop allocates nothing.
     */
    drawStressRects(rects, count) {
      const stress = CONFIG.stress;
      const size = stress.rectSize;
      const colors = stress.colors;
      const nColors = colors.length;
      for (let c = 0; c < nColors; c++) {
        ctx.fillStyle = colors[c];
        for (let i = c; i < count; i += nColors) {
          const j = i * 4;
          ctx.fillRect(rects[j] | 0, rects[j + 1] | 0, size, size);
        }
      }
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
