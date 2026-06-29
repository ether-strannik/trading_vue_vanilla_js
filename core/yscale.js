// Y-scale zoom math — the PORTED pure logic from trading-vue's sidebar.js (calc_zoom / calc_range),
// verbatim. Only the input gesture was Vue/Hammer-coupled (stripped for zero-dep); this math is
// driven by the engine's native pointer events. Linear AND logarithmic price scale (the author's
// `math` is a SYMMETRICAL log: sign(x)*log(|x|+1) — must match $2screen/screen2$).
import Utils from './stuff/utils.js';
import math from './stuff/math.js';

// drag = { y0 (cursorY at drag start), z (zoom factor at drag start), height (grid px height) }
// curY = current cursorY  ->  new zoom factor (asymmetric 3x speed downward, clamped 0.005..100)
export function calcZoom(drag, curY) {
  const d = drag.y0 - curY;
  const speed = d > 0 ? 3 : 1;
  const k = 1 + speed * d / drag.height;
  return Utils.clamp(drag.z * k, 0.005, 100);
}

// startRange = [hi, lo] at drag start; z = zoom / drag.z  ->  new [hi, lo].
// log = { A, B, height } (log-space A/B at drag start) selects the author's logScale branch.
export function calcRange(startRange, z, log) {
  if (log && log.A != null) {
    // sidebar.js calc_range logScale branch: re-map the mid px window through the drag-start log A/B
    const px_mid = log.height / 2;
    const new_hi = px_mid - px_mid * (1 / z);
    const new_lo = px_mid + px_mid * (1 / z);
    const f = (y) => math.exp((y - log.B) / log.A);
    return [f(new_hi), f(new_lo)];
  }
  const range = startRange.slice();
  const delta = range[0] - range[1];
  const zk = (1 / z - 1) / 2;
  range[0] = range[0] + delta * zk;
  range[1] = range[1] - delta * zk;
  return range;
}
