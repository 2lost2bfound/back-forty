// lighting.js — darkness layer (plan §B7 item 7).
// M2 scope: the flat night tint only (0 at day, nightAlpha at midnight,
// ramped over duskHours at both ends). The quarter-res layer with punched-out
// lights arrives in M4; the nightAlpha curve and this draw hook stay.
//
// The rgba string is only rebuilt when the quantized alpha changes, so the
// frame loop does not allocate (plan §B2).

import { nightAlpha } from '../sim/time.js';

let lastQ = -1;
let fillStyle = 'rgba(6,8,16,0)';

export function drawNightTint(ctx, hour) {
  const a = nightAlpha(hour);
  if (a <= 0.004) { lastQ = 0; return; }
  const q = Math.round(a * 100); // quantize to 1/100 to avoid string churn
  if (q !== lastQ) {
    lastQ = q;
    fillStyle = `rgba(6,8,16,${(q / 100).toFixed(2)})`;
  }
  ctx.fillStyle = fillStyle;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}
