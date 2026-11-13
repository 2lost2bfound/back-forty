// lighting.js — the darkness layer (plan §B7 item 7). A quarter-resolution
// canvas is filled with the night tint (plus a darker band underground), lamp
// lights are punched out with pre-rendered radial gradients, then the layer is
// scaled up over the scene. At most CONFIG.limits.softLights lights per frame.
// Browser-only (needs document).

import { CONFIG } from '../config.js';
import { nightAlpha } from '../sim/time.js';
import { lampOn } from '../sim/plants.js';
import { quality } from '../quality.js';

const W = CONFIG.canvas.width;
const H = CONFIG.canvas.height;
const TS = CONFIG.world.tile;
const Q = CONFIG.render.lighting.scale;
const LC = CONFIG.render.lighting;

export function createLighting() {
  const layer = document.createElement('canvas');
  layer.width = W / Q;
  layer.height = H / Q;
  const lg = layer.getContext('2d');

  // One white radial gradient, scaled per light (no per-frame gradients).
  const glow = document.createElement('canvas');
  glow.width = glow.height = 64;
  const gg = glow.getContext('2d');
  const grad = gg.createRadialGradient(32, 32, 2, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  gg.fillStyle = grad;
  gg.fillRect(0, 0, 64, 64);

  let lastQ = -1;
  let tint = 'rgba(6,8,16,0)';

  function punch(cx, cy, radiusPx) {
    const r = radiusPx / Q;
    lg.drawImage(glow, cx / Q - r, cy / Q - r, r * 2, r * 2);
  }

  return {
    draw(ctx, state, cam) {
      const night = nightAlpha(state.time.hour);
      // Is any underground visible? (below the lot surface row at the screen bottom)
      const ugVisible = cam.ry + H > CONFIG.world.surfaceRow * TS + TS;
      if (night <= 0.004 && !ugVisible) return;

      const q = Math.round(night * 100);
      if (q !== lastQ) { lastQ = q; tint = `rgba(6,8,16,${(q / 100).toFixed(2)})`; }
      lg.globalCompositeOperation = 'source-over';
      lg.clearRect(0, 0, layer.width, layer.height);
      lg.fillStyle = tint;
      lg.fillRect(0, 0, layer.width, layer.height);
      if (ugVisible) {
        lg.fillStyle = LC.undergroundTint;
        const c0 = Math.max(0, (cam.rx / TS) | 0);
        const c1 = Math.min(CONFIG.world.cols - 1, ((cam.rx + W) / TS) | 0);
        for (let c = c0; c <= c1; c++) {
          const top = Math.max(0, (state.surface[c] + 1) * TS - cam.ry);
          if (top < H) lg.fillRect(((c * TS - cam.rx) / Q) | 0, (top / Q) | 0, (TS / Q) + 1, ((H - top) / Q) + 1);
        }
      }
      lg.globalCompositeOperation = 'destination-out';
      let lights = 0;
      const p = state.player;
      const pcx = p.x + p.w / 2;
      const pcy = p.y + p.h / 2;
      if (quality.softLights && pcy > (state.surface[(pcx / TS) | 0] + 1) * TS) { // headlamp underground
        punch(pcx - cam.rx, pcy - cam.ry, LC.playerGlowTiles * TS);
        lights++;
      }
      for (const o of state.objects) {
        if (lights >= CONFIG.limits.softLights || !quality.softLights) break; // step-down: flat tint
        if (o.kind !== 'lamp' || !lampOn(o, state.time.hour)) continue;
        const sx = o.x * TS + TS / 2 - cam.rx;
        const sy = o.y * TS + TS / 2 - cam.ry;
        if (sx < -LC.lampRadiusTiles * TS || sx > W + LC.lampRadiusTiles * TS) continue;
        punch(sx, sy, CONFIG.lamps.types[o.lamp].radius * TS * LC.lampRadiusTiles / 2);
        lights++;
      }
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(layer, 0, 0, W, H);
      ctx.imageSmoothingEnabled = false;
    },
  };
}
