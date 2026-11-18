// core.js — REVERB shared engine layer (owned by the orchestrator; see SPEC.md)
(function () {
  'use strict';
  const R = (window.R = window.R || {});
  R.TILE = 2;
  R.MAT = { FLOOR: 0, CARPET: 1, PUDDLE: 2, METAL: 3 };
  R.settings = { sens: 0.0022, volume: 0.8 };

  // ---------------- util ----------------
  const GA = Math.PI * (3 - Math.sqrt(5));
  R.util = {
    clamp: (v, a, b) => (v < a ? a : v > b ? b : v),
    lerp: (a, b, t) => a + (b - a) * t,
    rand: (a, b) => a + Math.random() * (b - a),
    randInt: (a, b) => Math.floor(a + Math.random() * (b - a + 1)),
    choose: (arr) => arr[Math.floor(Math.random() * arr.length)],
    dist2: (ax, az, bx, bz) => Math.hypot(bx - ax, bz - az),
    dist3: (ax, ay, az, bx, by, bz) => Math.hypot(bx - ax, by - ay, bz - az),
    angleWrap: (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; },
    approach: (v, t, s) => (v < t ? Math.min(v + s, t) : Math.max(v - s, t)),
    // i-th of n points on a Fibonacci sphere (unit vector)
    fib(i, n) {
      const y = 1 - (2 * (i + 0.5)) / n, rr = Math.sqrt(Math.max(0, 1 - y * y)), th = GA * i;
      return [Math.cos(th) * rr, y, Math.sin(th) * rr];
    },
  };

  // three.js camera convention, rotation order 'YXZ': yaw 0 looks toward -Z, +yaw turns left, +pitch looks up
  R.forward = (yaw, pitch) => {
    const cp = Math.cos(pitch);
    return [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
  };

  // ---------------- bus ----------------
  const handlers = {};
  R.bus = {
    on(e, f) { (handlers[e] = handlers[e] || []).push(f); },
    off(e, f) { const h = handlers[e]; if (h) { const i = h.indexOf(f); if (i >= 0) h.splice(i, 1); } },
    emit(e, p) { const h = handlers[e]; if (!h) return; for (const f of h.slice()) { try { f(p); } catch (err) { console.error('[bus]', e, err); } } },
  };

  // ---------------- sounds ----------------
  R.SOUNDS = {
    step:    { radius: 7,   rays: 260,  bounces: 1 },
    sprint:  { radius: 13,  rays: 600,  bounces: 1 },
    crouch:  { radius: 2.2, rays: 70,   bounces: 0 },
    click:   { radius: 9,   rays: 2400, bounces: 1, cone: 75 },
    gunshot: { radius: 34,  rays: 6000, bounces: 2, directivity: 0.45 }, // muzzle blast: rear reaches 45% as far
    impact:  { radius: 6,   rays: 300,  bounces: 0 },
    reload:  { radius: 4,   rays: 120,  bounces: 0 },
    ping:    { radius: 18,  rays: 3500, bounces: 1 },
    melee:   { radius: 3,   rays: 150,  bounces: 0 },
    hurt:    { radius: 8,   rays: 400,  bounces: 1 },
    death:   { radius: 14,  rays: 1500, bounces: 1 },
    pickup:  { radius: 6,   rays: 300,  bounces: 0 },
    hum:     { radius: 4,   rays: 160,  bounces: 0 },
  };
  R.FLOOR_MULT = [1, 0.45, 2.0, 1.6];
  // R.sound(kind, x,y,z, actor, extra) — extra may contain mult, dir, cone, source, or overrides
  R.sound = function (kind, x, y, z, actor, extra) {
    const base = R.SOUNDS[kind] || { radius: 5, rays: 200, bounces: 0 };
    const ex = extra || {};
    const mult = ex.mult == null ? 1 : ex.mult;
    const ev = {
      x, y, z, kind,
      radius: (ex.radius != null ? ex.radius : base.radius) * mult,
      rays: Math.round((ex.rays != null ? ex.rays : base.rays) * Math.min(2, mult)),
      bounces: ex.bounces != null ? ex.bounces : base.bounces,
      source: ex.source || (actor ? (actor.isBot ? 'bot' : 'player') : 'world'),
      actor: actor || null,
      dir: ex.dir || null,
      cone: ex.cone != null ? ex.cone : base.cone || null,
      // rear/front reach ratio for a directional source (0 = omnidirectional); needs dir
      directivity: (R.flag && !R.flag('directivity')) ? 0 : ex.directivity != null ? ex.directivity : base.directivity || 0,
    };
    if (actor) actor.lastNoise = R.time || 0;
    R.bus.emit('sound', ev);
    return ev;
  };

  // how far a sound reaches toward (x,z), as a fraction of its radius: 1 ahead of a directional source,
  // ev.directivity straight behind it, smooth in between. Omnidirectional sounds return 1.
  R.soundGain = function (ev, x, z) {
    const back = ev && ev.directivity, d = ev && ev.dir;
    if (!back || !d) return 1;
    const dl = Math.hypot(d[0], d[2]), ox = x - ev.x, oz = z - ev.z, ol = Math.hypot(ox, oz);
    if (dl < 1e-6 || ol < 1e-6) return 1;
    const c = (ox * d[0] + oz * d[2]) / (dl * ol);
    return back + (1 - back) * Math.pow((1 + c) / 2, 1.5);
  };

  // ---------------- actors ----------------
  R.actors = [];
  let nextId = 1;
  R.makeActor = (o) => Object.assign({
    id: nextId++, name: 'actor', isBot: false, color: '#fff',
    x: 0, y: 0, z: 0, yaw: 0, pitch: 0, vx: 0, vz: 0,
    r: 0.35, h: 1.8, eye: 1.62, crouch: false,
    health: 100, alive: false, kills: 0, deaths: 0, lastNoise: 0,
  }, o || {});
  R.actorHeight = (a) => (a.crouch ? 1.2 : a.h);

  // ---------------- input ----------------
  const keys = new Set(), pressed = new Set();
  let anyPress = false, lookDX = 0, lookDY = 0, wheelAcc = 0;
  R.input = {
    mouse: { down: [false, false, false], clicked: [false, false, false], x: 0, y: 0 },
    wheel: 0, locked: false, lockOnClick: true,
    down: (c) => keys.has(c),
    pressed: (c) => pressed.has(c),
    anyPressed: () => anyPress,
    takeLook() { const r = { dx: lookDX, dy: lookDY }; lookDX = lookDY = 0; return r; },
    requestLock() { try { const p = document.body.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) {} },
    exitLock() { try { document.exitPointerLock(); } catch (e) {} },
    _end() { pressed.clear(); anyPress = false; this.mouse.clicked = [false, false, false]; this.wheel = wheelAcc; wheelAcc = 0; },
  };
  if (typeof window.addEventListener === 'function' && typeof document !== 'undefined') {
    const BLOCK = new Set(['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyF', 'KeyQ']);
    window.addEventListener('keydown', (e) => {
      if (BLOCK.has(e.code) || (R.input.locked && e.code.startsWith('Control'))) e.preventDefault();
      if (!keys.has(e.code)) { pressed.add(e.code); anyPress = true; }
      keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => keys.delete(e.code));
    window.addEventListener('blur', () => { keys.clear(); R.input.mouse.down = [false, false, false]; });
    document.addEventListener('mousemove', (e) => {
      R.input.mouse.x = e.clientX; R.input.mouse.y = e.clientY;
      if (R.input.locked) { lookDX += e.movementX || 0; lookDY += e.movementY || 0; }
    });
    document.addEventListener('mousedown', (e) => {
      if (e.button > 2) return;
      R.input.mouse.down[e.button] = true; R.input.mouse.clicked[e.button] = true; anyPress = true;
      if (!R.input.locked && R.input.lockOnClick) R.input.requestLock(); // inside the gesture handler
    });
    document.addEventListener('mouseup', (e) => { if (e.button <= 2) R.input.mouse.down[e.button] = false; });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('wheel', (e) => { wheelAcc += Math.sign(e.deltaY); }, { passive: true });
    document.addEventListener('pointerlockchange', () => {
      R.input.locked = document.pointerLockElement === document.body;
      R.bus.emit('lock', { locked: R.input.locked });
    });
  }

  // ---------------- world ----------------
  const NAV = 0.5, NAV_INFLATE = 0.3;
  const W = (R.world = {
    w: 0, h: 0, ceiling: 3, mats: new Uint8Array(0), boxes: [],
    navW: 0, navH: 0, nav: new Uint8Array(0), _cells: [], _stamp: new Uint32Array(0), _ray: 0,

    reset(w, h, ceiling) {
      this.w = w; this.h = h; this.ceiling = ceiling || 3;
      this.mats = new Uint8Array(w * h);
      this.boxes = [];
      this._cells = []; this.nav = new Uint8Array(0);
    },
    addBox(x0, y0, z0, x1, y1, z1, mat, kind) {
      const b = {
        min: [Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)],
        max: [Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)],
        mat: mat || 'concrete', kind: kind || 'box', solid: true, idx: this.boxes.length,
      };
      this.boxes.push(b);
      return b;
    },
    setFloor(tx, tz, m) { if (tx >= 0 && tz >= 0 && tx < this.w && tz < this.h) this.mats[tz * this.w + tx] = m; },
    floorMatAt(x, z) {
      const tx = Math.floor(x / R.TILE), tz = Math.floor(z / R.TILE);
      if (tx < 0 || tz < 0 || tx >= this.w || tz >= this.h) return R.MAT.FLOOR;
      return this.mats[tz * this.w + tx];
    },

    finalize() {
      const { w, h } = this, T = R.TILE;
      this._cells = Array.from({ length: w * h }, () => []);
      for (const b of this.boxes) {
        const x0 = Math.max(0, Math.floor(b.min[0] / T)), x1 = Math.min(w - 1, Math.floor((b.max[0] - 1e-6) / T));
        const z0 = Math.max(0, Math.floor(b.min[2] / T)), z1 = Math.min(h - 1, Math.floor((b.max[2] - 1e-6) / T));
        for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this._cells[z * w + x].push(b);
      }
      this._stamp = new Uint32Array(this.boxes.length);
      // nav grid
      const nw = Math.round((w * T) / NAV), nh = Math.round((h * T) / NAV);
      this.navW = nw; this.navH = nh;
      const nav = (this.nav = new Uint8Array(nw * nh));
      for (const b of this.boxes) {
        if (b.max[1] <= 0.4 || b.min[1] >= 1.7) continue;
        const x0 = Math.max(0, Math.floor((b.min[0] - NAV_INFLATE) / NAV)), x1 = Math.min(nw - 1, Math.floor((b.max[0] + NAV_INFLATE) / NAV));
        const z0 = Math.max(0, Math.floor((b.min[2] - NAV_INFLATE) / NAV)), z1 = Math.min(nh - 1, Math.floor((b.max[2] + NAV_INFLATE) / NAV));
        for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
          const cx = (x + 0.5) * NAV, cz = (z + 0.5) * NAV;
          if (cx > b.min[0] - NAV_INFLATE && cx < b.max[0] + NAV_INFLATE && cz > b.min[2] - NAV_INFLATE && cz < b.max[2] + NAV_INFLATE) nav[z * nw + x] = 1;
        }
      }
    },

    // ---- raycast: floor/ceiling planes + boxes (2D DDA broadphase over tiles) + actor capsules
    raycast(ox, oy, oz, dx, dy, dz, maxDist, opts) {
      const len = Math.hypot(dx, dy, dz) || 1;
      dx /= len; dy /= len; dz /= len;
      let best = maxDist == null ? 1e9 : maxDist;
      let res = null;
      const EPS = 1e-4;
      // floor / ceiling
      if (dy < -1e-9) { const t = -oy / dy; if (t > EPS && t < best) { best = t; res = { surface: 'floor', mat: 'floor', nx: 0, ny: 1, nz: 0, box: null }; } }
      else if (dy > 1e-9) { const t = (this.ceiling - oy) / dy; if (t > EPS && t < best) { best = t; res = { surface: 'ceiling', mat: 'ceiling', nx: 0, ny: -1, nz: 0, box: null }; } }
      // boxes
      const T = R.TILE, w = this.w, h = this.h;
      if (this._cells.length) {
        const stamp = ++this._ray >>> 0 || (this._stamp.fill(0), (this._ray = 1));
        let cx = Math.floor(ox / T), cz = Math.floor(oz / T);
        const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
        const tdx = Math.abs(dx) > 1e-12 ? Math.abs(T / dx) : Infinity;
        const tdz = Math.abs(dz) > 1e-12 ? Math.abs(T / dz) : Infinity;
        let tmx = Math.abs(dx) > 1e-12 ? ((dx > 0 ? (cx + 1) * T : cx * T) - ox) / dx : Infinity;
        let tmz = Math.abs(dz) > 1e-12 ? ((dz > 0 ? (cz + 1) * T : cz * T) - oz) / dz : Infinity;
        for (let guard = 0; guard < 4096; guard++) {
          if (cx >= 0 && cz >= 0 && cx < w && cz < h) {
            const list = this._cells[cz * w + cx];
            for (let i = 0; i < list.length; i++) {
              const b = list[i];
              if (this._stamp[b.idx] === stamp) continue;
              this._stamp[b.idx] = stamp;
              // slab test
              let tmin = -Infinity, tmax = Infinity, axis = -1, sgn = 0;
              const o = [ox, oy, oz], d = [dx, dy, dz];
              let miss = false;
              for (let a = 0; a < 3; a++) {
                if (Math.abs(d[a]) < 1e-12) { if (o[a] < b.min[a] || o[a] > b.max[a]) { miss = true; break; } continue; }
                let t1 = (b.min[a] - o[a]) / d[a], t2 = (b.max[a] - o[a]) / d[a], s = -1;
                if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; s = 1; }
                if (t1 > tmin) { tmin = t1; axis = a; sgn = s; }
                if (t2 < tmax) tmax = t2;
                if (tmin > tmax) { miss = true; break; }
              }
              if (miss || tmin <= EPS || tmin >= best || axis < 0) continue;
              best = tmin;
              res = { surface: 'box', mat: b.mat, nx: axis === 0 ? sgn : 0, ny: axis === 1 ? sgn : 0, nz: axis === 2 ? sgn : 0, box: b };
            }
          } else if ((cx < 0 && sx < 0) || (cz < 0 && sz < 0) || (cx >= w && sx > 0) || (cz >= h && sz > 0)) break;
          const tNext = Math.min(tmx, tmz);
          if (tNext >= best) break;
          if (tmx < tmz) { cx += sx; tmx += tdx; } else { cz += sz; tmz += tdz; }
        }
      }
      // actors
      if (!opts || opts.actors !== false) {
        const ignore = opts && opts.ignore;
        for (const a of R.actors) {
          if (!a.alive || a === ignore) continue;
          const hit = rayActor(ox, oy, oz, dx, dy, dz, a, best);
          if (hit) { best = hit.t; res = hit; }
        }
      }
      if (!res) return null;
      res.t = best; res.x = ox + dx * best; res.y = oy + dy * best; res.z = oz + dz * best;
      if (!res.actor) { res.actor = null; res.part = null; }
      return res;
    },
    los(ax, ay, az, bx, by, bz, ignoreActors) {
      const d = Math.hypot(bx - ax, by - ay, bz - az);
      if (d < 1e-6) return true;
      return !this.raycast(ax, ay, az, bx - ax, by - ay, bz - az, d - 1e-3, { actors: ignoreActors === false });
    },

    // ---- movement: circle vs boxes in xz
    moveActor(a, dx, dz) {
      let hit = false;
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dz)) / 0.1));
      for (let i = 0; i < steps; i++) {
        a.x += dx / steps; if (this._resolve(a)) hit = true;
        a.z += dz / steps; if (this._resolve(a)) hit = true;
      }
      return hit;
    },
    _resolve(a) {
      const T = R.TILE, r = a.r, ah = R.actorHeight(a);
      let hit = false;
      const x0 = Math.floor((a.x - r) / T), x1 = Math.floor((a.x + r) / T);
      const z0 = Math.floor((a.z - r) / T), z1 = Math.floor((a.z + r) / T);
      for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) {
        if (cx < 0 || cz < 0 || cx >= this.w || cz >= this.h) continue;
        for (const b of this._cells[cz * this.w + cx]) {
          if (b.max[1] <= 0.4 || b.min[1] >= ah) continue;
          const nx = Math.max(b.min[0], Math.min(a.x, b.max[0]));
          const nz = Math.max(b.min[2], Math.min(a.z, b.max[2]));
          const ddx = a.x - nx, ddz = a.z - nz, d2 = ddx * ddx + ddz * ddz;
          if (d2 >= r * r) continue;
          hit = true;
          if (d2 > 1e-10) { const d = Math.sqrt(d2), p = r - d; a.x += (ddx / d) * p; a.z += (ddz / d) * p; }
          else {
            // centre inside box: push out along the shallowest axis
            const px = Math.min(a.x - b.min[0], b.max[0] - a.x), pz = Math.min(a.z - b.min[2], b.max[2] - a.z);
            if (px < pz) a.x = a.x - b.min[0] < b.max[0] - a.x ? b.min[0] - r : b.max[0] + r;
            else a.z = a.z - b.min[2] < b.max[2] - a.z ? b.min[2] - r : b.max[2] + r;
          }
        }
      }
      // world bounds
      const maxX = this.w * T - r, maxZ = this.h * T - r;
      if (a.x < r) { a.x = r; hit = true; } if (a.x > maxX) { a.x = maxX; hit = true; }
      if (a.z < r) { a.z = r; hit = true; } if (a.z > maxZ) { a.z = maxZ; hit = true; }
      return hit;
    },

    // ---- navigation (0.5 m cells)
    _navIdx(x, z) {
      const cx = Math.floor(x / NAV), cz = Math.floor(z / NAV);
      if (cx < 0 || cz < 0 || cx >= this.navW || cz >= this.navH) return -1;
      return cz * this.navW + cx;
    },
    walkable(x, z) { const i = this._navIdx(x, z); return i >= 0 && !this.nav[i]; },
    // nearest free nav cell index to a point (searches a few rings), -1 if none
    _nearestFree(x, z) {
      const cx = Math.floor(x / NAV), cz = Math.floor(z / NAV), nw = this.navW, nh = this.navH;
      for (let r = 0; r <= 3; r++) {
        let best = -1, bd = Infinity;
        for (let oz = -r; oz <= r; oz++) for (let ox = -r; ox <= r; ox++) {
          if (Math.max(Math.abs(ox), Math.abs(oz)) !== r) continue;
          const nx = cx + ox, nz = cz + oz;
          if (nx < 0 || nz < 0 || nx >= nw || nz >= nh || this.nav[nz * nw + nx]) continue;
          const d = ox * ox + oz * oz;
          if (d < bd) { bd = d; best = nz * nw + nx; }
        }
        if (best >= 0) return best;
      }
      return -1;
    },
    flowField(x, z, maxDist) {
      const nw = this.navW, nh = this.navH, N = nw * nh;
      const f = new Float32Array(N).fill(Infinity);
      const s = this._nearestFree(x, z);
      if (s < 0) return f;
      const max = maxDist == null ? Infinity : maxDist;
      const q = new Int32Array(N);
      let head = 0, tail = 0;
      f[s] = 0; q[tail++] = s;
      const nav = this.nav;
      while (head < tail) {
        const i = q[head++], d = f[i] + NAV;
        if (d > max + NAV) continue;
        const cx = i % nw;
        if (cx > 0 && f[i - 1] === Infinity && !nav[i - 1]) { f[i - 1] = d; q[tail++] = i - 1; }
        if (cx < nw - 1 && f[i + 1] === Infinity && !nav[i + 1]) { f[i + 1] = d; q[tail++] = i + 1; }
        if (i >= nw && f[i - nw] === Infinity && !nav[i - nw]) { f[i - nw] = d; q[tail++] = i - nw; }
        if (i < N - nw && f[i + nw] === Infinity && !nav[i + nw]) { f[i + nw] = d; q[tail++] = i + nw; }
      }
      return f;
    },
    fieldAt(f, x, z) {
      let i = this._navIdx(x, z);
      if (i < 0 || f[i] === Infinity) { i = this._nearestFree(x, z); if (i < 0) return Infinity; }
      return f[i];
    },
    stepToward(f, x, z) {
      let i = this._navIdx(x, z);
      if (i < 0 || this.nav[i] || f[i] === Infinity) { i = this._nearestFree(x, z); if (i < 0 || f[i] === Infinity) return null; }
      const nw = this.navW, nh = this.navH, cx = i % nw, cz = (i / nw) | 0;
      if (f[i] === 0) return { x: (cx + 0.5) * NAV, z: (cz + 0.5) * NAV };
      let best = f[i], bx = cx, bz = cz;
      const free = (X, Z) => X >= 0 && Z >= 0 && X < nw && Z < nh && !this.nav[Z * nw + X];
      for (let oz = -1; oz <= 1; oz++) for (let ox = -1; ox <= 1; ox++) {
        if (!ox && !oz) continue;
        const nx = cx + ox, nz = cz + oz;
        if (!free(nx, nz)) continue;
        if (ox && oz && (!free(cx + ox, cz) || !free(cx, cz + oz))) continue;
        const v = f[nz * nw + nx] - (ox && oz ? NAV * 0.3 : 0);
        if (v < best) { best = v; bx = nx; bz = nz; }
      }
      return { x: (bx + 0.5) * NAV, z: (bz + 0.5) * NAV };
    },
    // walking-distance field from a sound, computed once per sound event and shared by every listener
    soundField(ev) {
      if (!ev._field) ev._field = this.flowField(ev.x, ev.z, ev.radius + 1);
      return ev._field;
    },
    // Where a listener at (lx,ly,lz) hears sound event ev coming from. In line of sight: the source itself.
    // Otherwise the sound has bent round corners: walk the shortest path from the listener toward the source and
    // return the last point still visible from the listener (the doorway or corner it comes round), plus the path
    // length d. Returns null when no walkable path reaches the listener within the sound's radius.
    portal(ev, lx, ly, lz) {
      const sy = Math.max(0.15, ev.y);
      if (this.los(lx, ly, lz, ev.x, sy, ev.z, true)) {
        return { x: ev.x, y: sy, z: ev.z, d: Math.hypot(ev.x - lx, sy - ly, ev.z - lz), direct: true };
      }
      const f = this.soundField(ev), d = this.fieldAt(f, lx, lz);
      if (!(d <= ev.radius)) return null;
      let px = lx, pz = lz, vx = lx, vz = lz;
      for (let k = 0; k < 200; k++) {
        const p = this.stepToward(f, px, pz);
        if (!p || (p.x === px && p.z === pz)) break;
        px = p.x; pz = p.z;
        if (this.los(lx, ly, lz, px, ly, pz, true)) { vx = px; vz = pz; }
        else if (Math.hypot(px - vx, pz - vz) > 2.5) break; // well past the opening
      }
      return { x: vx, y: ly + (sy - ly) * 0.3, z: vz, d, direct: false };
    },
    hearDist(x0, z0, x1, z1, maxDist) {
      if (Math.hypot(x1 - x0, z1 - z0) > maxDist) return Infinity;
      const v = this.fieldAt(this.flowField(x0, z0, maxDist + 1), x1, z1);
      return v > maxDist ? Infinity : v;
    },
    randomWalkable() {
      for (let k = 0; k < 2000; k++) {
        const i = Math.floor(Math.random() * this.nav.length);
        if (!this.nav[i]) return { x: ((i % this.navW) + 0.5) * NAV, z: (((i / this.navW) | 0) + 0.5) * NAV };
      }
      return { x: this.w, z: this.h };
    },
  });

  // ray vs actor: vertical cylinder body [0, top-0.32] + head sphere
  function rayActor(ox, oy, oz, dx, dy, dz, a, best) {
    if (R.body && R.flag && R.flag('humanoid')) return R.body.ray(ox, oy, oz, dx, dy, dz, a, best);
    const H = R.actorHeight(a), rr = a.r * 0.86, headR = 0.17, headY = H - headR, bodyTop = H - 0.3;
    let out = null;
    // head sphere
    {
      const lx = ox - a.x, ly = oy - headY, lz = oz - a.z;
      const b = lx * dx + ly * dy + lz * dz, c = lx * lx + ly * ly + lz * lz - headR * headR;
      const disc = b * b - c;
      if (disc >= 0) {
        const t = -b - Math.sqrt(disc);
        if (t > 1e-4 && t < best) {
          const hx = ox + dx * t, hy = oy + dy * t, hz = oz + dz * t;
          out = { t, surface: 'actor', mat: 'flesh', actor: a, part: 'head', box: null, nx: (hx - a.x) / headR, ny: (hy - headY) / headR, nz: (hz - a.z) / headR };
          best = t;
        }
      }
    }
    // body cylinder
    const A = dx * dx + dz * dz;
    if (A > 1e-10) {
      const lx = ox - a.x, lz = oz - a.z;
      const B = lx * dx + lz * dz, C = lx * lx + lz * lz - rr * rr;
      const disc = B * B - A * C;
      if (disc >= 0) {
        const t = (-B - Math.sqrt(disc)) / A;
        if (t > 1e-4 && t < best) {
          const y = oy + dy * t;
          if (y >= 0 && y <= bodyTop) {
            const hx = ox + dx * t, hz = oz + dz * t;
            out = { t, surface: 'actor', mat: 'flesh', actor: a, part: 'body', box: null, nx: (hx - a.x) / rr, ny: 0, nz: (hz - a.z) / rr };
          }
        }
      }
    }
    return out;
  }

  // ---------------- boot / loop ----------------
  R.time = 0;
  R.screen = { w: 960, h: 600, dpr: 1 };
  R.boot = function () {
    const stage = document.createElement('div');
    stage.id = 'stage';
    stage.style.cssText = 'position:fixed;inset:0;background:#000';
    const hud = document.createElement('canvas');
    hud.id = 'hud';
    hud.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none';
    document.body.appendChild(stage);
    document.body.appendChild(hud);
    R.stage = stage; R.hudCanvas = hud; R.hudCtx = hud.getContext('2d');
    function resize() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      R.screen.w = window.innerWidth; R.screen.h = window.innerHeight; R.screen.dpr = dpr;
      hud.width = Math.round(R.screen.w * dpr); hud.height = Math.round(R.screen.h * dpr);
      R.hudCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      R.bus.emit('resize', R.screen);
    }
    window.addEventListener('resize', resize);
    resize();
    for (const n of ['audio', 'echo', 'view', 'weapons', 'player', 'bots', 'game', 'ui']) {
      const m = R[n];
      if (!m) { console.error('[boot] missing R.' + n); continue; }
      if (typeof m.init === 'function') { try { m.init(); } catch (e) { console.error('[boot] init ' + n, e); } }
    }
    if (R.flags) R.flags.applyAll();
    resize();
    let last = performance.now();
    function frame(now) {
      const dt = Math.min(1 / 30, Math.max(0, (now - last) / 1000));
      last = now;
      R.time += dt;
      try {
        R.game.update(dt);
        R.view.render(dt);
        R.hudCtx.clearRect(0, 0, R.screen.w, R.screen.h);
        R.ui.draw(R.hudCtx, dt);
      } catch (e) { console.error('[loop]', e); }
      R.input._end();
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  };
})();
