// echo.js — REVERB echo simulation (no THREE; runs in node with window = global)
// Every 'sound' becomes a job: rays (Fibonacci sphere or cone, randomly rotated) are traced through R.world
// with mirror bounces (+jitter). Each hit becomes a glowing dot whose birth time is pathLength / SPEED, so the
// imprint grows outward like a wavefront. Static dots go straight into a ring buffer (born in the future; the
// shader hides unborn dots). Dots that land on actors freeze in place as ghost images (flag stickyDots makes them follow).
(function () {
  'use strict';
  const R = (window.R = window.R || {});

  // headless (game server): nobody draws the dots, only bots read actorHits, so keep the buffers small
  const HEADLESS = !!window.REVERB_HEADLESS;
  const CAP = HEADLESS ? 4096 : 300000;   // static dot ring capacity
  const ACAP = HEADLESS ? 4096 : 24000;   // actor dot pool capacity
  const G = 0.06;              // lattice pitch (m)
  const IG = 1 / G;
  const LIFE = 3.2, ALIFE = 1.1, CORPSE_LIFE = 2.6;
  const NORMAL_OFS = 0.012;    // lift dots off their surface (for the depth prepass in view.js)
  const BUDGET = 20000;        // raycasts per update
  const STALE = 1.6;           // drop the unprocessed rest of a job older than this (s)

  const COL = {
    player: [0.80, 0.97, 1.00],
    bot:    [1.00, 0.36, 0.17],
    world:  [0.38, 1.00, 0.52],
    ping:   [0.30, 0.70, 1.00],
  };
  const BLUE = [0.30, 0.46, 1.00];
  const MATK = { metal: 1.12, glass: 0.72, fabric: 0.72, wood: 1.0, concrete: 0.85, plaster: 0.9, floor: 0.72, ceiling: 0.36, flesh: 1.25 };
  // per-kind visual tweaks: gain, base dot size, surface-spread probability
  const KIND = {
    gunshot: { gain: 1.0, size: 1.0, spread: 0.9 },
    click:   { gain: 0.95, size: 0.9, spread: 0.35 },
    ping:    { gain: 1.0, size: 1.0, spread: 0.7 },
    step:    { gain: 0.8, size: 0.9, spread: 0.6 },
    sprint:  { gain: 1.0, size: 0.95, spread: 0.7 },
    crouch:  { gain: 0.6, size: 0.85, spread: 0.3 },
    death:   { gain: 1.0, size: 1.0, spread: 0.8 },
    hum:     { gain: 0.7, size: 0.85, spread: 0.3 },
  };
  const KDEF = { gain: 0.9, size: 0.95, spread: 0.5 };

  // ---- static ring buffer -------------------------------------------------------------------------------
  const dots = {
    capacity: CAP,
    pos: new Float32Array(CAP * 3),
    color: new Float32Array(CAP * 3),
    born: new Float32Array(CAP).fill(-1e6),
    life: new Float32Array(CAP),
    size: new Float32Array(CAP),
    head: 0,          // next write index
    written: 0,       // monotonic count of writes (view derives dirty ranges from it)
    gen: 0,           // bumps on reset -> full re-upload
  };

  function pushDot(x, y, z, r, g, b, born, life, size) {
    const i = dots.head, i3 = i * 3;
    dots.pos[i3] = x; dots.pos[i3 + 1] = y; dots.pos[i3 + 2] = z;
    dots.color[i3] = r; dots.color[i3 + 1] = g; dots.color[i3 + 2] = b;
    dots.born[i] = born; dots.life[i] = life; dots.size[i] = size;
    dots.head = i + 1 === CAP ? 0 : i + 1;
    dots.written++;
  }

  // ---- actor dots ----------------------------------------------------------------------------------------
  const ad = {
    actor: new Array(ACAP).fill(null),
    lx: new Float32Array(ACAP), ly: new Float32Array(ACAP), lz: new Float32Array(ACAP), // ly = fraction of height
    r: new Float32Array(ACAP), g: new Float32Array(ACAP), b: new Float32Array(ACAP),
    born: new Float32Array(ACAP), life: new Float32Array(ACAP), size: new Float32Array(ACAP),
    n: 0,
  };
  const actorDotsPos = new Float32Array(ACAP * 3);
  const actorDotsColor = new Float32Array(ACAP * 3);
  const actorDotsBorn = new Float32Array(ACAP);
  const actorDotsLife = new Float32Array(ACAP);
  const actorDotsSize = new Float32Array(ACAP);

  function addActorDot(a, hx, hy, hz, r, g, b, born, size) {
    let i = ad.n;
    if (i >= ACAP) { // replace the oldest-born
      let oi = 0, ob = Infinity;
      for (let k = 0; k < ACAP; k += 7) if (ad.born[k] < ob) { ob = ad.born[k]; oi = k; }
      i = oi;
    } else ad.n++;
    const ox = hx - a.x, oz = hz - a.z, c = Math.cos(a.yaw || 0), s = Math.sin(a.yaw || 0);
    // rotate world offset by -yaw (so resolving with +yaw follows the actor)
    ad.actor[i] = a;
    ad.lx[i] = ox * c - oz * s;
    ad.lz[i] = ox * s + oz * c;
    ad.ly[i] = (hy - (a.y || 0)) / (R.actorHeight ? R.actorHeight(a) : a.h || 1.8);
    ad.r[i] = r; ad.g[i] = g; ad.b[i] = b;
    ad.born[i] = born; ad.life[i] = ALIFE; ad.size[i] = size;
  }
  function removeActorDot(i) {
    const j = --ad.n;
    if (i !== j) {
      ad.actor[i] = ad.actor[j]; ad.lx[i] = ad.lx[j]; ad.ly[i] = ad.ly[j]; ad.lz[i] = ad.lz[j];
      ad.r[i] = ad.r[j]; ad.g[i] = ad.g[j]; ad.b[i] = ad.b[j];
      ad.born[i] = ad.born[j]; ad.life[i] = ad.life[j]; ad.size[i] = ad.size[j];
    }
    ad.actor[j] = null;
  }
  function actorWorld(i, out) {
    const a = ad.actor[i], c = Math.cos(a.yaw || 0), s = Math.sin(a.yaw || 0);
    const lx = ad.lx[i], lz = ad.lz[i];
    out[0] = a.x + lx * c + lz * s;
    out[1] = (a.y || 0) + ad.ly[i] * (R.actorHeight ? R.actorHeight(a) : a.h || 1.8);
    out[2] = a.z - lx * s + lz * c;
  }

  // ---- jobs ----------------------------------------------------------------------------------------------
  const jobs = [];
  const rnd = Math.random;
  const GA = Math.PI * (3 - Math.sqrt(5));

  // random rotation matrix (uniform via random unit quaternion)
  function randRot() {
    const u1 = rnd(), u2 = rnd() * 2 * Math.PI, u3 = rnd() * 2 * Math.PI;
    const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
    const qx = a * Math.sin(u2), qy = a * Math.cos(u2), qz = b * Math.sin(u3), qw = b * Math.cos(u3);
    return [
      1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw),
      2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw),
      2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy),
    ];
  }
  // basis whose third column is the (unit) cone axis, random roll
  function coneBasis(dx, dy, dz) {
    const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
    let ux = 0, uy = 1, uz = 0;
    if (Math.abs(dy) > 0.95) { ux = 1; uy = 0; }
    // t = normalize(u x d), bvec = d x t
    let tx = uy * dz - uz * dy, ty = uz * dx - ux * dz, tz = ux * dy - uy * dx;
    const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
    const bx = dy * tz - dz * ty, by = dz * tx - dx * tz, bz = dx * ty - dy * tx;
    const rr = rnd() * 2 * Math.PI, c = Math.cos(rr), s = Math.sin(rr);
    const t2x = tx * c + bx * s, t2y = ty * c + by * s, t2z = tz * c + bz * s;
    const b2x = -tx * s + bx * c, b2y = -ty * s + by * c, b2z = -tz * s + bz * c;
    return [t2x, b2x, dx, t2y, b2y, dy, t2z, b2z, dz];
  }

  function onSound(ev) {
    addJob(ev, 0, 1);
    if (ev && !ev.diffracted && R.flag && R.flag('diffraction') && ev.radius >= DIFF_MIN_RADIUS && !(ev.cone && ev.dir)) {
      try { diffract(ev); } catch (e) { console.error('[echo] diffract', e); }
    }
  }

  // delay: seconds before the job's wavefront starts; gain: brightness multiplier
  function addJob(ev, delay, gain) {
    if (!ev || !(ev.radius > 0) || !(ev.rays > 0)) return;
    if (![ev.x, ev.y, ev.z].every(Number.isFinite)) return;
    const src = ev.kind === 'ping' ? 'ping' : (COL[ev.source] ? ev.source : 'world');
    const base = COL[src];
    const kd = KIND[ev.kind] || KDEF;
    const cone = ev.cone && ev.dir ? ev.cone : 0;
    const p = R.player;
    const nearPlayer = !!(p && Math.hypot(ev.x - p.x, ev.z - p.z) < 3.5);
    jobs.push({
      ev, x: ev.x, y: ev.y, z: ev.z, radius: ev.radius, n: Math.min(20000, ev.rays | 0),
      bounces: Math.max(0, Math.min(3, ev.bounces | 0)),
      actor: ev.actor || null, t0: E.time + delay, i: 0, kd, gain,
      dirv: ev.directivity && ev.dir && !cone ? ev.dir : null, back: ev.directivity || 0, seenA: null,
      col: base,
      M: cone ? coneBasis(ev.dir[0], ev.dir[1], ev.dir[2]) : randRot(),
      cosH: cone ? Math.cos((cone * 0.5 * Math.PI) / 180) : -1,
      seen: new Set(),
      spacing: cone ? Math.sqrt((2 * Math.PI * (1 - Math.cos((cone * 0.5 * Math.PI) / 180))) / Math.max(1, ev.rays)) : Math.sqrt((4 * Math.PI) / Math.max(1, ev.rays)),
      near: nearPlayer, mfpSum: 0, mfpN: 0,
      self: ev.kind === 'gunshot' && !!(R.flag && R.flag('selfEcho')),
    });
  }

  // ---- diffraction: sound bends round door jambs and corners. Find the edge of the source's acoustic shadow on
  // the nav grid (cells it can see that border cells it can't, further along the walking path) and re-emit a dimmer
  // cone from a few of them into the shadow, delayed by the walk there. That paints the rooms round the corner.
  const DIFF_TESTS = 240, DIFF_MIN_RADIUS = 9, DIFF_MAX = 4, DIFF_SPACING = 2.2, DIFF_GAIN = 0.55, DIFF_RAYS = 0.12, DIFF_REACH = 0.55;
  function diffract(ev) {
    const W = R.world;
    if (!W || !W.soundField || !W.nav) return;
    const f = W.soundField(ev), nw = W.navW, nh = W.navH, cell = (W.w * R.TILE) / nw;
    const sx = ev.x, sz = ev.z, sy = Math.max(0.3, Math.min(1.7, ev.y));
    const maxD = ev.radius * 0.7;
    const shadowed = (i) => {
      const cx = ((i % nw) + 0.5) * cell, cz = (((i / nw) | 0) + 0.5) * cell;
      return f[i] > Math.hypot(cx - sx, cz - sz) * 1.08 + 0.6;
    };
    const cands = [];
    for (let i = 0; i < f.length; i++) {
      const d = f[i];
      if (!(d >= 1.5 && d <= maxD) || shadowed(i)) continue;
      const cx = i % nw, cz = (i / nw) | 0;
      let ax = 0, az = 0, n = 0;
      const nb = (j, ox, oz) => { if (f[j] > d && f[j] !== Infinity && shadowed(j)) { ax += ox; az += oz; n++; } };
      if (cx > 0) nb(i - 1, -1, 0);
      if (cx < nw - 1) nb(i + 1, 1, 0);
      if (cz > 0) nb(i - nw, 0, -1);
      if (cz < nh - 1) nb(i + nw, 0, 1);
      if (n) cands.push({ i, d, ax, az, x: (cx + 0.5) * cell, z: (cz + 0.5) * cell });
    }
    E.stats.diffr = 0;
    if (!cands.length) return;
    cands.sort((a, b) => a.d - b.d);
    const picked = [];
    let tests = 0;
    for (const c of cands) {
      if (picked.length >= DIFF_MAX || tests >= DIFF_TESTS) break;
      if (picked.some((p) => Math.hypot(p.x - c.x, p.z - c.z) < DIFF_SPACING)) continue;
      // the neighbour must really be out of sight (low furniture blocks walking, not sound)
      const bx = c.x + Math.sign(c.ax) * cell, bz = c.z + Math.sign(c.az) * cell;
      tests += 2;
      if (W.los(sx, sy, sz, bx, sy, bz, true) || !W.los(sx, sy, sz, c.x, sy, c.z, true)) continue;
      picked.push(c);
    }
    for (const c of picked) {
      // aim into the shadow, bent away from the source's straight line
      let dx = c.x - sx, dz = c.z - sz; const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
      const al = Math.hypot(c.ax, c.az) || 1;
      const ux = dx * 0.5 + c.ax / al, uz = dz * 0.5 + c.az / al, ul = Math.hypot(ux, uz) || 1;
      const reach = (ev.radius - c.d) * DIFF_REACH * R.soundGain(ev, c.x, c.z);
      if (reach < 2) continue;
      addJob({
        x: c.x, y: sy, z: c.z, kind: ev.kind, source: ev.source, actor: ev.actor,
        radius: reach, rays: Math.max(40, Math.round(ev.rays * DIFF_RAYS)), bounces: 1,
        dir: [ux / ul, 0, uz / ul], cone: 150, diffracted: true,
      }, c.d / E.SPEED, DIFF_GAIN);
      E.stats.diffr++;
    }
  }

  const tmp = [0, 0, 0];

  // ---- lattice helpers
  const P3 = [0, 0, 0];
  function keyOf(ax, plane, iu, iv, bounce) {
    const ip = Math.round(plane * 500);
    return ((iu * 73856093) ^ (iv * 19349663) ^ (ip * 83492791) ^ ((ax + 3 * bounce) * 2654435761)) | 0;
  }
  // world solidity test used to tell convex prop edges from seams between coplanar boxes
  function solidAt(x, y, z, self) {
    const W = R.world;
    if (y <= 0 || y >= W.ceiling) return true;
    const T = R.TILE, cx = Math.floor(x / T), cz = Math.floor(z / T);
    if (cx < 0 || cz < 0 || cx >= W.w || cz >= W.h) return true;
    const list = W._cells && W._cells[cz * W.w + cx];
    if (!list) return false;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (b === self) continue;
      if (x > b.min[0] && x < b.max[0] && y > b.min[1] && y < b.max[1] && z > b.min[2] && z < b.max[2]) return true;
    }
    return false;
  }

  // emit dots for one hit (actor dot, or a lattice patch + convex edge highlights on a surface)
  function emitHit(job, h, path, bounce, intensity) {
    const kd = job.kd;
    const mk = MATK[h.mat] || 1;
    let I = intensity * kd.gain * mk * job.gain;
    if (I < 0.012) return;
    // colour: source tint, shifted toward blue on bounces
    const c = job.col, bt = bounce ? Math.min(0.75, 0.42 * bounce) : 0;
    const cr = (c[0] + (BLUE[0] - c[0]) * bt), cg = (c[1] + (BLUE[1] - c[1]) * bt), cb = (c[2] + (BLUE[2] - c[2]) * bt);
    const born = job.t0 + path / E.SPEED;
    const sz = kd.size * (bounce ? 0.8 : 1) * (0.88 + 0.24 * rnd()) * (0.8 + 0.3 * Math.min(1, I));

    if (h.actor) {
      const a = h.actor;
      const AH = R.actorHeight ? R.actorHeight(a) : a.h || 1.8;
      // skip dots that would sit in the local player's own head (camera)
      if (a === R.player && (h.cap ? h.part === 'head' : h.y - (a.y || 0) > AH - 0.45)) return;
      I = Math.min(1.5, I * 1.7 + 0.15);
      const S = sz * E.ACTOR_SIZE;
      // log a couple of hits per body per sound so bots can see the same dots a player would
      const sa = job.seenA || (job.seenA = new Map()), na = sa.get(a) || 0;
      if (na < 2) {
        sa.set(a, na + 1);
        E.actorHits.push({ actor: a, x: h.x, y: h.y, z: h.z, nx: h.nx, nz: h.nz, part: h.part, born, src: job.actor });
      }
      const tryPut = (x, y, z, J, b2) => {
        const qx = Math.round((x - a.x) * 22), qy = Math.round((y - (a.y || 0)) * 22), qz = Math.round((z - a.z) * 22);
        const key = ((qx * 73856093) ^ (qy * 19349663) ^ (qz * 83492791) ^ ((a.id | 0) * 40503) ^ ((7 + bounce) * 2654435761)) | 0;
        if (job.seen.has(key)) return;
        job.seen.add(key);
        // flag off: freeze the dot where the sound hit instead of following the body
        if (R.flag && !R.flag('stickyDots')) pushDot(x, y, z, cr * J, cg * J, cb * J, b2, ALIFE, S);
        else addActorDot(a, x, y, z, cr * J, cg * J, cb * J, b2, S);
      };
      tryPut(h.x, h.y, h.z, I, born);
      // splat the ray footprint over the body so silhouettes read even from sparse rays
      const fr = Math.min(E.ACTOR_SPLAT, 0.5 * path * job.spacing * E.FOOT * (bounce ? 0.6 : 1));
      const m = Math.min(9, Math.round((fr * fr) / (0.045 * 0.045) * (bounce ? 0.8 : 1.6)));
      if (m > 0) {
        const head = h.part === 'head', rr = a.r * 0.86, headR = 0.17, headY = (a.y || 0) + AH - headR, bodyTop = (a.y || 0) + AH - 0.3;
        let nx = h.nx, nz = h.nz; const nl = Math.hypot(nx, nz) || 1; nx /= nl; nz /= nl;
        for (let j = 0; j < m; j++) {
          const ang = rnd() * 6.2832, d = fr * Math.sqrt(rnd());
          const du = Math.cos(ang) * d, dv = Math.sin(ang) * d;
          let x = h.x - nz * du, y = h.y + dv, z = h.z + nx * du;
          if (h.cap) {
            // humanoid: keep the splat on the limb that was hit
            R.body.toSurface(a, h.cap, x, y, z, P3); x = P3[0]; y = P3[1]; z = P3[2];
          } else if (head) {
            const ox = x - a.x, oy = y - headY, oz = z - a.z, l = Math.hypot(ox, oy, oz) || 1;
            x = a.x + (ox / l) * headR; y = headY + (oy / l) * headR; z = a.z + (oz / l) * headR;
          } else {
            const ox = x - a.x, oz = z - a.z, l = Math.hypot(ox, oz) || 1;
            x = a.x + (ox / l) * rr; z = a.z + (oz / l) * rr;
            if (y < (a.y || 0) || y > bodyTop) continue;
          }
          tryPut(x, y, z, I * (0.7 + 0.3 * rnd()), born + d / E.SPEED);
        }
      }
      return;
    }

    // tangent frame of an axis-aligned surface
    const n = [h.nx, h.ny, h.nz];
    const ax = Math.abs(n[0]) > 0.5 ? 0 : Math.abs(n[1]) > 0.5 ? 1 : 2;
    const u = (ax + 1) % 3, v = (ax + 2) % 3;
    const hp = [h.x, h.y, h.z];
    const plane = hp[ax], ns = n[ax] > 0 ? 1 : -1;
    const b = h.box, W = R.world, T = R.TILE;
    let umin, umax, vmin, vmax;
    if (b) { umin = b.min[u]; umax = b.max[u]; vmin = b.min[v]; vmax = b.max[v]; }
    else { umin = 0; vmin = 0; umax = u === 0 ? W.w * T : u === 1 ? W.ceiling : W.h * T; vmax = v === 0 ? W.w * T : v === 1 ? W.ceiling : W.h * T; }
    const iu0 = Math.round(hp[u] * IG), iv0 = Math.round(hp[v] * IG);
    const pa = plane + ns * NORMAL_OFS;
    const life = LIFE * (bounce ? 0.85 : 1);
    const S = sz * E.DOT_SIZE;

    function put(pu, pv, iu, iv, J, born2, size2) {
      const key = keyOf(ax, plane, iu, iv, bounce);
      if (job.seen.has(key)) return;
      job.seen.add(key);
      P3[ax] = pa; P3[u] = pu; P3[v] = pv;
      pushDot(P3[0], P3[1], P3[2], cr * J, cg * J, cb * J, born2, life, size2);
    }
    const inU = (x) => x >= umin - 1e-4 && x <= umax + 1e-4;
    const inV = (x) => x >= vmin - 1e-4 && x <= vmax + 1e-4;

    // footprint of this ray on the surface, in lattice cells
    const rc = bounce ? 0 : 0.5 * path * job.spacing * IG * E.FOOT;
    const r = Math.min(rc, E.DISC_MAX);
    // centre dot (clamped onto the face)
    let cu = iu0 * G, cv = iv0 * G;
    cu = cu < umin ? umin : cu > umax ? umax : cu;
    cv = cv < vmin ? vmin : cv > vmax ? vmax : cv;
    put(cu, cv, iu0, iv0, I, born, S);
    if (bounce) return;

    if (rc > E.DISC_MAX + 0.5) {
      // footprint larger than a solid splat: scatter the same number of dots over the whole footprint
      const rr = Math.min(rc, E.SCATTER_MAX), m = Math.round(E.FILL * Math.PI * E.DISC_MAX * E.DISC_MAX);
      for (let j = 0; j < m; j++) {
        const a = rnd() * 6.2832, d = rr * Math.sqrt(rnd());
        const du = Math.round(Math.cos(a) * d), dv = Math.round(Math.sin(a) * d);
        if (!du && !dv) continue;
        const pu = (iu0 + du) * G, pv = (iv0 + dv) * G;
        if (!inU(pu) || !inV(pv)) continue;
        const f = d / rr;
        put(pu, pv, iu0 + du, iv0 + dv, I * (1 - 0.45 * f * f), born + d * G / E.SPEED, S * 0.92);
      }
    } else if (r >= 0.75) {
      const R2 = r * r, Ri = Math.floor(r), fill = E.FILL;
      for (let du = -Ri; du <= Ri; du++) for (let dv = -Ri; dv <= Ri; dv++) {
        const d2 = du * du + dv * dv;
        if (!d2 || d2 > R2 || rnd() > fill) continue;
        const pu = (iu0 + du) * G, pv = (iv0 + dv) * G;
        if (!inU(pu) || !inV(pv)) continue;
        put(pu, pv, iu0 + du, iv0 + dv, I * (1 - 0.4 * d2 / (R2 + 1)), born + Math.sqrt(d2) * G / E.SPEED, S * 0.92);
      }
    } else {
      // sparse random neighbours so distant imprints read as small patches
      let k = kd.spread * E.SPREAD * (0.4 + 0.6 * Math.min(1, I));
      while (k > 0 && rnd() < k) {
        k -= 1;
        const q = (rnd() * 8) | 0, du = q & 1 ? 1 : -1, dv = q & 4 ? (q & 2 ? 1 : -1) : 0;
        const pu = (iu0 + du) * G, pv = (iv0 + dv) * G;
        if (!inU(pu) || !inV(pv)) continue;
        put(pu, pv, iu0 + du, iv0 + dv, I * (0.4 + 0.25 * rnd()), born + 0.004 + rnd() * 0.02, S * 0.85);
      }
    }

    // convex edges of props: a short bright line of dots along the edge -> crisp silhouettes
    if (b && E.EDGES) {
      const reach = (Math.max(r, 1) + 0.75) * G, k = Math.ceil(Math.max(r, 1)) + 1;
      const EI = Math.min(1.6, I * E.EDGE_GAIN);
      for (let side = 0; side < 4; side++) {
        const onU = side < 2, lo = (side & 1) === 0;
        const edgeC = onU ? (lo ? umin : umax) : (lo ? vmin : vmax);
        const along = onU ? hp[u] : hp[v];
        if (Math.abs(along - edgeC) > reach) continue;
        // probe just past the edge, slightly inside the face plane: solid there -> seam, not an edge
        const out = lo ? -0.025 : 0.025;
        P3[ax] = plane - ns * 0.025;
        if (onU) { P3[u] = edgeC + out; P3[v] = hp[v]; } else { P3[v] = edgeC + out; P3[u] = hp[u]; }
        if (solidAt(P3[0], P3[1], P3[2], b)) continue;
        const ie = Math.round(edgeC * IG * 8) + 1000003 * (side + 1); // unique pseudo lattice index for the edge line
        for (let s2 = -k; s2 <= k; s2++) {
          if (onU) {
            const iv = iv0 + s2, pv = iv * G;
            if (!inV(pv)) continue;
            put(edgeC, pv, ie, iv, EI * (1 - 0.25 * Math.abs(s2) / k), born + Math.abs(s2) * G / E.SPEED, S);
          } else {
            const iu = iu0 + s2, pu = iu * G;
            if (!inU(pu)) continue;
            put(pu, edgeC, iu, ie, EI * (1 - 0.25 * Math.abs(s2) / k), born + Math.abs(s2) * G / E.SPEED, S);
          }
        }
      }
    }
  }

  // trace ray i of job; returns raycasts used
  function traceRay(job, i) {
    let dx, dy, dz;
    const M = job.M, n = job.n;
    if (job.cosH > -1) {
      // spherical cap Fibonacci around +Z of basis, slight jitter
      const ct = 1 - (1 - job.cosH) * ((i + rnd()) / n);
      const st = Math.sqrt(Math.max(0, 1 - ct * ct)), ph = GA * i;
      const lx = Math.cos(ph) * st, ly = Math.sin(ph) * st, lz = ct;
      dx = M[0] * lx + M[1] * ly + M[2] * lz;
      dy = M[3] * lx + M[4] * ly + M[5] * lz;
      dz = M[6] * lx + M[7] * ly + M[8] * lz;
    } else {
      const fy = 1 - (2 * (i + 0.5)) / n, rr = Math.sqrt(Math.max(0, 1 - fy * fy)), th = GA * i;
      const lx = Math.cos(th) * rr, lz = Math.sin(th) * rr;
      dx = M[0] * lx + M[1] * fy + M[2] * lz;
      dy = M[3] * lx + M[4] * fy + M[5] * lz;
      dz = M[6] * lx + M[7] * fy + M[8] * lz;
    }
    let ox = job.x, oy = job.y, oz = job.z, path = 0, casts = 0;
    let radius = job.radius;
    if (job.dirv) {
      // directional source (muzzle blast): rays behind the gun die out sooner
      const v = job.dirv, c = (dx * v[0] + dy * v[1] + dz * v[2]) / (Math.hypot(v[0], v[1], v[2]) || 1);
      radius *= job.back + (1 - job.back) * Math.pow((1 + c) / 2, 1.5);
    }
    // a gunshot is held in front of the shooter, so its blast and reverb land on the shooter's own body too
    const W = R.world, opts = job.opts || (job.opts = { actors: true, ignore: job.self ? null : job.actor });
    for (let bounce = 0; bounce <= job.bounces; bounce++) {
      const remain = radius - path;
      if (remain <= 0.05) break;
      const h = W.raycast(ox, oy, oz, dx, dy, dz, remain, opts);
      casts++;
      if (!h) { if (bounce === 0 && job.near) { job.mfpSum += remain; job.mfpN++; } break; }
      if (bounce === 0 && job.near) { job.mfpSum += h.t; job.mfpN++; }
      path += h.t;
      const f = 1 - path / radius;
      if (f <= 0) break;
      const I = Math.pow(f, 1.3) * Math.pow(E.BOUNCE_DIM, bounce);
      emitHit(job, h, path, bounce, I);
      if (bounce === job.bounces) break;
      // mirror reflection with jitter (rougher on fabric, near-specular on metal/glass)
      let nx = h.nx, ny = h.ny, nz = h.nz;
      const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
      const dn = dx * nx + dy * ny + dz * nz;
      dx -= 2 * dn * nx; dy -= 2 * dn * ny; dz -= 2 * dn * nz;
      const jit = h.mat === 'metal' || h.mat === 'glass' ? 0.08 : h.mat === 'fabric' || h.mat === 'flesh' ? 0.45 : 0.22;
      dx += (rnd() * 2 - 1) * jit; dy += (rnd() * 2 - 1) * jit; dz += (rnd() * 2 - 1) * jit;
      let dd = dx * nx + dy * ny + dz * nz;
      if (dd < 0.05) { dx += nx * (0.05 - dd); dy += ny * (0.05 - dd); dz += nz * (0.05 - dd); }
      const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
      ox = h.x + nx * 0.003; oy = h.y + ny * 0.003; oz = h.z + nz * 0.003;
    }
    return casts;
  }

  function finishJob(job) {
    if (job.near && job.mfpN > 8) {
      const m = job.mfpSum / job.mfpN;
      E.roomSize += (m - E.roomSize) * 0.35;
    }
  }

  const clock = typeof performance !== 'undefined' && performance.now ? () => performance.now() : () => Date.now();

  // ---- public --------------------------------------------------------------------------------------------
  const E = (R.echo = {
    SPEED: 26,
    BUDGET,
    MAX_MS: 3,           // wall-clock cap per update for ray tracing (rest is amortized over next frames)
    DOT_SIZE: 0.055,     // world-space sprite diameter (m) for static dots
    ACTOR_SIZE: 0.05,
    ACTOR_SPLAT: 0.16,   // max footprint splat radius on bodies (m)
    BOUNCE_DIM: 0.45,
    SPREAD: 1.0,
    FOOT: 1.0,           // footprint splat scale (1 = each ray covers its share of the surface)
    DISC_MAX: 1.5,       // max splat radius in lattice cells
    FILL: 0.8,
    SCATTER_MAX: 4,      // max scatter radius (cells) when footprint exceeds the solid splat           // splat fill probability
    EDGES: true,         // convex prop edge highlighting
    EDGE_GAIN: 1.6,
    LATTICE: G,
    time: 0,
    roomSize: 4,
    dots,
    actorDots: ad,
    actorDotsPos, actorDotsColor, actorDotsBorn, actorDotsLife, actorDotsSize,
    actorDotsCount: 0,
    actorHits: [],       // {actor,x,y,z,nx,nz,part,born,src}: dots that landed on bodies, read by bots.js
    stats: { casts: 0, jobs: 0, ms: 0, diffr: 0 },
    _inited: false,

    init() {
      if (this._inited) return;
      this._inited = true;
      R.bus.on('sound', onSound);
    },
    reset() {
      jobs.length = 0;
      this.actorHits.length = 0;
      dots.born.fill(-1e6); dots.life.fill(0);
      dots.head = 0; dots.written = 0; dots.gen++;
      for (let i = 0; i < ad.n; i++) ad.actor[i] = null;
      ad.n = 0; this.actorDotsCount = 0;
      this.roomSize = 4;
    },
    pending() { let n = 0; for (const j of jobs) n += j.n - j.i; return n; },

    update(dt) {
      const t0 = clock();
      this.time += dt || 0;
      const now = this.time;
      // ---- trace rays under budget
      let budget = this.BUDGET, casts = 0;
      if (R.world && R.world.raycast) {
        while (jobs.length && budget > 0) {
          const job = jobs[0];
          if (now - job.t0 > STALE) { finishJob(job); jobs.shift(); continue; }
          let k = 0;
          while (job.i < job.n && budget > 0) {
            const c = traceRay(job, job.i++); budget -= c; casts += c;
            if ((++k & 63) === 0 && clock() - t0 > this.MAX_MS) { budget = 0; break; }
          }
          if (job.i >= job.n) { finishJob(job); jobs.shift(); }
        }
      } else jobs.length = 0;
      // nobody reading the hit log (no bots): keep it bounded
      if (this.actorHits.length > 400) this.actorHits.splice(0, this.actorHits.length - 400);
      // ---- actor dots: expire, convert dead actors' dots to static, resolve to world
      let cnt = 0;
      for (let i = ad.n - 1; i >= 0; i--) {
        const a = ad.actor[i];
        const age = now - ad.born[i];
        if (!a || age > ad.life[i]) { removeActorDot(i); continue; }
        if (!a.alive) {
          actorWorld(i, tmp);
          pushDot(tmp[0], tmp[1], tmp[2], ad.r[i], ad.g[i], ad.b[i], ad.born[i], CORPSE_LIFE, ad.size[i]);
          removeActorDot(i);
          continue;
        }
      }
      for (let i = 0; i < ad.n; i++) {
        actorWorld(i, tmp);
        const c3 = cnt * 3;
        actorDotsPos[c3] = tmp[0]; actorDotsPos[c3 + 1] = tmp[1]; actorDotsPos[c3 + 2] = tmp[2];
        actorDotsColor[c3] = ad.r[i]; actorDotsColor[c3 + 1] = ad.g[i]; actorDotsColor[c3 + 2] = ad.b[i];
        actorDotsBorn[cnt] = ad.born[i]; actorDotsLife[cnt] = ad.life[i]; actorDotsSize[cnt] = ad.size[i];
        cnt++;
      }
      this.actorDotsCount = cnt;
      const t1 = clock();
      this.stats.casts = casts; this.stats.jobs = jobs.length; this.stats.ms = t1 - t0;
    },
  });
})();
