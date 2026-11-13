// sprites.js — paints the string-array art into one atlas canvas at boot
// (plan §C1). A 512x512 atlas is filled top-left to bottom-right with a naive
// row packer; rects records { name: [x, y, w, h] } for every sprite. Left
// facings are pre-rendered by mirroring the rows (plan §B7: no scale(-1,1)
// at draw time). Browser-only module (needs document).

import { CONFIG } from '../config.js';
import {
  PALETTE, TILES, PLAYER_FRAMES, PLAYER_W, PLAYER_H,
  PLANT_FRAMES, PLANT_W, PLANT_H, BRED_PALETTE, OBJECTS, OBJECT_W, OBJECT_H,
} from './spritedata.js';

function paint(ctx, ox, oy, rows, pal = PALETTE) {
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    for (let x = 0; x < row.length; x++) {
      const color = pal[row[x]];
      if (color) {
        ctx.fillStyle = color;
        ctx.fillRect(ox + x, oy + y, 1, 1);
      }
    }
  }
}

const mirror = (rows) => rows.map((r) => [...r].reverse().join(''));

/** Build the atlas. Returns { canvas, rects }. */
export function buildAtlas() {
  const size = CONFIG.render.atlasSize;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const rects = {};
  let cx = 0;
  let cy = 0;
  let rowH = 0;

  function put(name, w, h, rows, pal) {
    if (cx + w > size) { cx = 0; cy += rowH; rowH = 0; }
    paint(ctx, cx, cy, rows, pal);
    rects[name] = [cx, cy, w, h];
    cx += w;
    rowH = Math.max(rowH, h);
  }

  for (const [name, rows] of Object.entries(TILES)) {
    put('tile_' + name, 16, 16, rows);
  }
  for (const [name, rows] of Object.entries(PLAYER_FRAMES)) {
    put('player_' + name, PLAYER_W, PLAYER_H, rows);       // right facing
    put('player_' + name + 'L', PLAYER_W, PLAYER_H, mirror(rows)); // left facing
  }
  for (const [name, rows] of Object.entries(PLANT_FRAMES)) {
    put('plant_' + name, PLANT_W, PLANT_H, rows);
  }
  const bredPal = { ...PALETTE, ...BRED_PALETTE };
  for (const [name, rows] of Object.entries(PLANT_FRAMES)) {
    put('plant_b_' + name, PLANT_W, PLANT_H, rows, bredPal);
  }
  for (const [name, rows] of Object.entries(OBJECTS)) {
    put('obj_' + name, OBJECT_W, OBJECT_H, rows);
  }

  return { canvas, rects };
}
