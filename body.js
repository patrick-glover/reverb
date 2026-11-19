// body.js — REVERB humanoid bodies (R.body). 13 capsules posed by a procedural walk cycle.
// Bodies are never drawn; they only exist for rays (echo dots, bullets, darts, bot hearing).
// Each frame update() poses every live actor from its velocity and crouch state and caches the capsules in the
// actor's local frame; rays are moved into that frame, so position and yaw are always current. Behind the 'humanoid' flag;
// with it off, core.js falls back to the original cylinder + head sphere.
(function () {
  'use strict';
  const R = (window.R = window.R || {});

  // gait parameters (radians / metres). stride = metres travelled per full cycle (two steps)
  const GAIT = {
    stand:  { hip0: 0,    hipA: 0,    knee0: 0.05, kneeA: 0,    arm0: 0.05, armA: 0,    elb0: 0.15, elbA: 0,    lean: 0.02 },
    walk:   { hip0: 0,    hipA: 0.5,  knee0: 0.1,  kneeA: 1.05, arm0: 0.05, armA: 0.45, elb0: 0.3,  elbA: 0.25, lean: 0.08 },
    sprint: { hip0: 0.1,  hipA: 0.75, knee0: 0.15, kneeA: 1.6,  arm0: 0.1,  armA: 0.95, elb0: 1.35, elbA: 0.2,  lean: 0.24 },
    crouch: { hip0: 1.2,  hipA: 0.28, knee0: 2.1,  kneeA: 0.4,  arm0: 0.6,  armA: 0.15, elb0: 0.9,  elbA: 0.1,  lean: 0.5 },
  };
  const STRIDE = { walk: 3.4, sprint: 4.1, crouch: 2.2 };
  const KEYS = Object.keys(GAIT.stand);
  const WALK = 4.2, SPRINT = 6.8;
  const LT = 0.44, LS = 0.43;

  function blend(a, b, k, out) { for (const n of KEYS) out[n] = a[n] + (b[n] - a[n]) * k; return out; }
  const gtmp = {}, gtmp2 = {};

  function gaitFor(a, speed) {
    if (a.crouch) return blend(GAIT.stand, GAIT.crouch, 1, gtmp);
    if (speed <= WALK) return blend(GAIT.stand, GAIT.walk, Math.min(1, speed / (WALK * 0.6)), gtmp);
    return blend(GAIT.walk, GAIT.sprint, Math.min(1, (speed - WALK) / (SPRINT - WALK)), gtmp2);
  }

  // local frame: +z forward, +x right, y up from the feet. Game forward is (-sin yaw, -cos yaw), right (cos yaw, -sin yaw)
  function toLocal(a, x, y, z, out) {
    const sy = Math.sin(a.yaw || 0), cy = Math.cos(a.yaw || 0), dx = x - a.x, dz = z - a.z;
    out[0] = dx * cy - dz * sy; out[1] = y - (a.y || 0); out[2] = -dx * sy - dz * cy; return out;
  }
  function dirLocal(a, x, y, z, out) {
    const sy = Math.sin(a.yaw || 0), cy = Math.cos(a.yaw || 0);
    out[0] = x * cy - z * sy; out[1] = y; out[2] = -x * sy - z * cy; return out;
  }
  function toWorld(a, x, y, z, out) {
    const sy = Math.sin(a.yaw || 0), cy = Math.cos(a.yaw || 0);
    out[0] = a.x + x * cy - z * sy; out[1] = (a.y || 0) + y; out[2] = a.z - x * sy - z * cy; return out;
  }
  function dirWorld(a, x, y, z, out) {
    const sy = Math.sin(a.yaw || 0), cy = Math.cos(a.yaw || 0);
    out[0] = x * cy - z * sy; out[1] = y; out[2] = -x * sy - z * cy; return out;
  }

  // build capsules for actor a in its local frame
  function pose(a, g) {
    const caps = a._caps || (a._caps = []);
    let n = 0;
    // legs swing along the direction of travel (so strafing swings sideways, backpedalling reverses)
    const mx = a._mx || 0, mz = a._mz == null ? 1 : a._mz;
    function put(x0, y0, z0, x1, y1, z1, r, part) {
      const c = caps[n] || (caps[n] = { a: [0, 0, 0], b: [0, 0, 0], r: 0, part: '' });
      c.a[0] = x0; c.a[1] = y0; c.a[2] = z0;
      c.b[0] = x1; c.b[1] = y1; c.b[2] = z1;
      c.r = r; c.part = part; n++;
    }
    let hy = 0;
    const legs = [];
    // shooting stance when planted with the gun up: support (left) foot forward with a soft knee, gun-side foot
    // ~20 cm back with the leg near-straight, feet shoulder-width apart and toes turned out (both feet stay grounded)
    const set = a._set || 0;
    for (let s = -1; s <= 1; s += 2) {
      const p = a._phase + (s > 0 ? Math.PI : 0);
      const hOff = set * (s < 0 ? 0.2 : -0.15), kOff = set * (s < 0 ? 0.25 : 0);
      const ha = g.hip0 + hOff + g.hipA * Math.sin(p);
      const kn = g.knee0 + kOff + g.kneeA * Math.pow(Math.max(0, Math.cos(p - 0.35)), 1.4);
      const th = ha - kn;
      legs.push(s, ha, th, p, hOff, kOff);
      hy = Math.max(hy, LT * Math.cos(ha) + LS * Math.cos(th) + 0.06);
    }
    // swing components: crouch flexion is always forward; gait swing follows travel direction
    for (let i = 0; i < 12; i += 6) {
      const s = legs[i], ha = legs[i + 1], th = legs[i + 2], hOff = legs[i + 4], kOff = legs[i + 5];
      const hx = s * (0.095 + 0.025 * set), hY = hy - 0.02, wide = s * 0.08 * set;
      const fwdK = Math.sin(ha), fwdS = Math.sin(th);
      // split the forward offset into a static crouch part (local +z) and a swing part (travel direction)
      const base = Math.sin(g.hip0 + hOff), baseS = Math.sin(g.hip0 + hOff - g.knee0 - kOff);
      const kx = hx + wide * 0.5 + (fwdK - base) * LT * mx, kz = (base + (fwdK - base) * mz) * LT, ky = hY - LT * Math.cos(ha);
      const ex = kx + wide * 0.5 + (fwdS - baseS) * LS * mx, ez = kz + (baseS + (fwdS - baseS) * mz) * LS, ey = ky - LS * Math.cos(th);
      const tx = ex + s * 0.05 * set, tz = ez + 0.17 * Math.cos(th) - 0.008 * set, tyy = ey + 0.17 * Math.sin(th);
      put(hx, hY, 0, kx, ky, kz, 0.075, 'leg');
      put(kx, ky, kz, ex, ey, ez, 0.058, 'leg');
      put(ex, ey, ez, tx, Math.max(0.03, tyy), tz, 0.042, 'leg');
    }
    // lean into the gun a little while aiming
    const L = g.lean + 0.1 * (a._aim || 0), spy = Math.cos(L), spz = Math.sin(L);
    put(-0.075, hy + spy * 0.06, spz * 0.06, -0.075, hy + spy * 0.5, spz * 0.5, 0.12, 'body');
    put(0.075, hy + spy * 0.06, spz * 0.06, 0.075, hy + spy * 0.5, spz * 0.5, 0.12, 'body');
    put(0, hy + spy * 0.66, spz * 0.66, 0, hy + spy * 0.75, spz * 0.75, 0.105, 'head');
    // isosceles two-handed pistol stance: arms pushed out from the shoulders, grip just under the eye line,
    // swung about the shoulders with view pitch (blended out while sprinting). Grip on the centre line so both arms
    // come out near-locked (0.553 of 0.56 m), elbows just soft.
    const aim = a._aim || 0, pit = a.pitch || 0;
    const REACH = 0.5, LIFT = 0.12, sp0 = Math.sin(pit), cp0 = Math.cos(pit);
    const gx = 0, gy = hy + spy * 0.5 + REACH * sp0 + LIFT * cp0, gz = spz * 0.5 + REACH * cp0 - LIFT * sp0;
    for (let i = 0; i < 12; i += 6) {
      const s = legs[i], p = legs[i + 3];
      const shx = s * 0.205, shy = hy + spy * 0.5, shz = spz * 0.5;
      const q = L * 0.4 + g.arm0 - g.armA * Math.sin(p);
      const e = g.elb0 + g.elbA * (0.5 - 0.5 * Math.sin(p));
      let elx = shx + s * 0.02, ely = shy - 0.29 * Math.cos(q), elz = shz + 0.29 * Math.sin(q);
      let hx2 = elx, hy2 = ely - 0.27 * Math.cos(q + e), hz2 = elz + 0.27 * Math.sin(q + e);
      if (aim > 0.01) {
        // two-bone IK from shoulder to the grip; elbow bends down and out
        let ux = gx - shx, uy = gy - shy, uz = gz - shz, d = Math.hypot(ux, uy, uz) || 1;
        ux /= d; uy /= d; uz /= d;
        const dd = Math.min(d, 0.555), along = (0.29 * 0.29 - 0.27 * 0.27 + dd * dd) / (2 * dd);
        const hh = Math.sqrt(Math.max(0, 0.29 * 0.29 - along * along));
        // bend direction: (s, -1, 0) made perpendicular to u
        let bx = s * 0.6, by = -1, bz = 0;
        const bu = bx * ux + by * uy + bz * uz; bx -= bu * ux; by -= bu * uy; bz -= bu * uz;
        const bl = Math.hypot(bx, by, bz) || 1;
        const ax2 = shx + ux * along + (bx / bl) * hh, ay2 = shy + uy * along + (by / bl) * hh, az2 = shz + uz * along + (bz / bl) * hh;
        const tx2 = shx + ux * dd, ty2 = shy + uy * dd, tz2 = shz + uz * dd;
        elx += (ax2 - elx) * aim; ely += (ay2 - ely) * aim; elz += (az2 - elz) * aim;
        hx2 += (tx2 - hx2) * aim; hy2 += (ty2 - hy2) * aim; hz2 += (tz2 - hz2) * aim;
      }
      put(shx, shy, shz, elx, ely, elz, 0.048, 'arm');
      put(elx, ely, elz, hx2, hy2, hz2, 0.042, 'arm');
    }
    caps.length = n;
    a._top = hy + spy * 0.75 + 0.105;
    return caps;
  }

  // ray vs capsule (distance along unit ray dir, or -1)
  function rayCapsule(ox, oy, oz, dx, dy, dz, pa, pb, r) {
    const bax = pb[0] - pa[0], bay = pb[1] - pa[1], baz = pb[2] - pa[2];
    const oax = ox - pa[0], oay = oy - pa[1], oaz = oz - pa[2];
    const baba = bax * bax + bay * bay + baz * baz, bard = bax * dx + bay * dy + baz * dz;
    const baoa = bax * oax + bay * oay + baz * oaz, rdoa = dx * oax + dy * oay + dz * oaz;
    const oaoa = oax * oax + oay * oay + oaz * oaz;
    const A = baba - bard * bard, B = baba * rdoa - baoa * bard, C = baba * oaoa - baoa * baoa - r * r * baba;
    let h = B * B - A * C;
    if (h >= 0 && A > 1e-9) {
      const t = (-B - Math.sqrt(h)) / A, y = baoa + t * bard;
      if (y > 0 && y < baba) return t;
      const cx = y <= 0 ? oax : ox - pb[0], cyy = y <= 0 ? oay : oy - pb[1], cz = y <= 0 ? oaz : oz - pb[2];
      const b2 = dx * cx + dy * cyy + dz * cz, c2 = cx * cx + cyy * cyy + cz * cz - r * r;
      h = b2 * b2 - c2;
      if (h > 0) return -b2 - Math.sqrt(h);
    }
    return -1;
  }

  // closest point on capsule axis to p, written to out
  function axisPoint(c, x, y, z, out) {
    const bx = c.b[0] - c.a[0], by = c.b[1] - c.a[1], bz = c.b[2] - c.a[2];
    const bb = bx * bx + by * by + bz * bz || 1;
    let t = ((x - c.a[0]) * bx + (y - c.a[1]) * by + (z - c.a[2]) * bz) / bb;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    out[0] = c.a[0] + bx * t; out[1] = c.a[1] + by * t; out[2] = c.a[2] + bz * t;
    return out;
  }
  const q3 = [0, 0, 0], o3 = [0, 0, 0], d3 = [0, 0, 0], w3 = [0, 0, 0];

  const B = (R.body = {
    GAIT,
    update(dt) {
      for (const a of R.actors) {
        if (!a.alive) continue;
        const sp = Math.hypot(a.vx || 0, a.vz || 0);
        if (a._phase == null) { a._phase = Math.random() * 6.283; a._mx = 0; a._mz = 1; }
        // gun raised unless sprinting
        const aimT = R.flag && !R.flag('selfEcho') ? 0 : sp > WALK + 0.5 ? 0 : 1;
        a._aim = (a._aim == null ? aimT : a._aim) + (aimT - (a._aim == null ? aimT : a._aim)) * Math.min(1, dt * 8);
        // planted stance: gun up, standing (not crouched), barely moving
        const setT = a._aim > 0.5 && !a.crouch && sp < 0.6 ? 1 : 0;
        a._set = (a._set || 0) + (setT - (a._set || 0)) * Math.min(1, dt * 6);
        if (sp > 0.2) {
          // travel direction in the actor's local frame, smoothed
          const sy = Math.sin(a.yaw || 0), cy = Math.cos(a.yaw || 0);
          const fz = (-(a.vx) * sy - a.vz * cy) / sp, fx = (a.vx * cy - a.vz * sy) / sp;
          const k = Math.min(1, dt * 10);
          a._mx += (fx - a._mx) * k; a._mz += (fz - a._mz) * k;
          const stride = a.crouch ? STRIDE.crouch : sp > WALK ? STRIDE.sprint : STRIDE.walk;
          a._phase += (sp / stride) * 2 * Math.PI * dt;
        } else {
          // settle feet together when stopping
          a._phase += Math.sin(-a._phase % Math.PI) * Math.min(1, dt * 6);
        }
        pose(a, gaitFor(a, sp));
      }
    },
    caps(a) { return a._caps || pose(a, gaitFor(a, 0)); },
    // ray vs posed body: returns a core-style hit or null
    ray(ox, oy, oz, dx, dy, dz, a, best) {
      // cheap reject: ray must pass within 0.75 m of the actor's vertical axis
      const lx = a.x - ox, lz = a.z - oz, hh = dx * dx + dz * dz;
      if (hh > 1e-10) {
        let t = (lx * dx + lz * dz) / hh;
        if (t < 0) t = 0; else if (t > best) t = best;
        const ex = ox + dx * t - a.x, ez = oz + dz * t - a.z;
        if (ex * ex + ez * ez > 0.5625) return null;
      } else if (lx * lx + lz * lz > 0.5625) return null;
      const caps = B.caps(a);
      toLocal(a, ox, oy, oz, o3); dirLocal(a, dx, dy, dz, d3);
      let ci = -1;
      for (let i = 0; i < caps.length; i++) {
        const c = caps[i], t = rayCapsule(o3[0], o3[1], o3[2], d3[0], d3[1], d3[2], c.a, c.b, c.r);
        if (t > 1e-4 && t < best) { best = t; ci = i; }
      }
      if (ci < 0) return null;
      const c = caps[ci];
      axisPoint(c, o3[0] + d3[0] * best, o3[1] + d3[1] * best, o3[2] + d3[2] * best, q3);
      dirWorld(a, o3[0] + d3[0] * best - q3[0], o3[1] + d3[1] * best - q3[1], o3[2] + d3[2] * best - q3[2], w3);
      return { t: best, surface: 'actor', mat: 'flesh', actor: a, part: c.part, cap: c, box: null,
        nx: w3[0] / c.r, ny: w3[1] / c.r, nz: w3[2] / c.r };
    },
    // push a world point onto the surface of actor a's capsule c (used to splat echo dots over a limb)
    toSurface(a, c, x, y, z, out) {
      toLocal(a, x, y, z, o3);
      axisPoint(c, o3[0], o3[1], o3[2], q3);
      const ox = o3[0] - q3[0], oy = o3[1] - q3[1], oz = o3[2] - q3[2], l = Math.hypot(ox, oy, oz) || 1;
      return toWorld(a, q3[0] + (ox / l) * c.r, q3[1] + (oy / l) * c.r, q3[2] + (oz / l) * c.r, out);
    },
  });
})();
