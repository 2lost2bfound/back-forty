// renderer.js — M0: clear + test pattern + F4 stress rectangles.
// Kept deliberately small: M1 extends this with camera, sky, hills and tile
// chunks (plan §B7). The canvas is 800x450 internally, never resized;
// imageSmoothingEnabled is false everywhere.

import { CONFIG } from '../config.js';

const W = CONFIG.canvas.width;
const H = CONFIG.canvas.height;

/** Painted once at boot: a static repeating test pattern used as the backdrop. */
function makeTestPattern(ctx) {
  const s = CONFIG.testPattern.size;
  const off = document.createElement('canvas');
  off.width = s;
  off.height = s;
  const octx = off.getContext('2d');
  octx.fillStyle = '#101828';
  octx.fillRect(0, 0, s, s);
  octx.fillStyle = '#1c2b45';
  octx.fillRect(0, 0, s / 2, s / 2);
  octx.fillRect(s / 2, s / 2, s / 2, s / 2);
  octx.fillStyle = '#31415e';
  octx.fillRect(s / 2 - 4, s / 2 - 4, 8, 8);
  octx.strokeStyle = '#0a0f1a';
  octx.strokeRect(0.5, 0.5, s - 1, s - 1);
  return ctx.createPattern(off, 'repeat');
}

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const pattern = makeTestPattern(ctx);

  const stress = CONFIG.stress;
  const colors = stress.colors;

  return {
    ctx,

    /** Clear to the base color. */
    clear() {
      ctx.fillStyle = '#101828';
      ctx.fillRect(0, 0, W, H);
    },

    /** Repeating test pattern, scrolled by sim ticks so the 2 Hz tick shows. */
    drawTestPattern(simTicks) {
      const s = CONFIG.testPattern.size;
      const ox = -(simTicks * CONFIG.testPattern.scrollPxPerSimTick) % s;
      ctx.setTransform(1, 0, 0, 1, ox, 0);
      ctx.fillStyle = pattern;
      ctx.fillRect(-s, -s, W + 2 * s, H + 2 * s);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    },

    /**
     * Draw the pooled stress rectangles. Rects live in a Float32Array laid
     * out as [x, y, vx, vy] per rectangle; color is fixed per index bucket so
     * fillStyle changes at most `colors.length` times per frame and the frame
     * loop allocates nothing.
     */
    drawStressRects(rects, count) {
      const size = stress.rectSize;
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
