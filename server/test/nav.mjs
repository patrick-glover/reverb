// Pathing for test clients: load the game's world builder and walk along its nav grid like a bot would.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export function loadWorld() {
  if (!globalThis.window) globalThis.window = globalThis;
  if (!globalThis.location) globalThis.location = { search: '' };
  if (!window.R || !window.R.props) for (const f of ['flags', 'core', 'body', 'props', 'maps']) (0, eval)(fs.readFileSync(path.join(ROOT, f + '.js'), 'utf8'));
  return window.R;
}
// one step of at most `max` metres from (x,z) toward (tx,tz) along walkable cells; world must already be built
export function stepToward(R, x, z, tx, tz, max) {
  const W = R.world, f = W.flowField(tx, tz);
  let px = x, pz = z, left = max;
  for (let k = 0; k < 8 && left > 1e-3; k++) {
    const n = W.stepToward(f, px, pz);
    if (!n) break;
    const dx = n.x - px, dz = n.z - pz, d = Math.hypot(dx, dz);
    if (d < 1e-3) { const e = Math.hypot(tx - px, tz - pz), s = Math.min(left, e); if (e > 1e-3) { px += ((tx - px) / e) * s; pz += ((tz - pz) / e) * s; } break; }
    const s = Math.min(left, d); px += (dx / d) * s; pz += (dz / d) * s; left -= s;
  }
  return { x: px, z: pz };
}
