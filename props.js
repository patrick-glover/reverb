// props.js — REVERB world builder: turns a mapDef (see maps.js / SPEC "Map format") into R.world boxes.
// R.props.build(mapDef) -> {spawns:[{x,z,yaw}], pickups:[{x,z,kind}]}
// Plain script, no THREE. Deterministic: all variation comes from a seeded RNG per map name.
(function () {
  'use strict';
  const R = (window.R = window.R || {});
  const T = 2; // tile size (m), mirrors R.TILE

  // ---------------- seeded rng ----------------
  function hashStr(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // facing directions: 0=N(-z) 1=E(+x) 2=S(+z) 3=W(-x)
  const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  const FLOORS = { '.': 0, '_': 1, '~': 2, '=': 3 };
  const PROPS = 'TcBCPObLDKG|';
  const BARRIER = 'G|';

  let W, rng, grid, GW, GH, theme, ceil, mats;
  const rnd = (a, b) => a + rng() * (b - a);
  const at = (tx, tz) => (tx < 0 || tz < 0 || tx >= GW || tz >= GH ? '#' : grid[tz][tx]);
  const isWall = (c) => c === '#';
  const isProp = (c) => PROPS.indexOf(c) >= 0;
  const isFree = (c) => c !== '#' && !isProp(c); // floor, spawn, pickup
  const add = (x0, y0, z0, x1, y1, z1, mat, kind) => W.addBox(x0, y0, z0, x1, y1, z1, mat, kind);

  // local frame at (cx,cz) facing dir: +lz = forward, +lx = right
  function frame(cx, cz, dir) {
    const f = DIRS[dir];
    return { cx, cz, fx: f[0], fz: f[1], rx: -f[1], rz: f[0] };
  }
  // centred local box: centre (lx,lz), size w (along lx) x d (along lz), y0..y1
  function lb(fr, lx, lz, w, d, y0, y1, mat, kind) {
    const ax = lx - w / 2, bx = lx + w / 2, az = lz - d / 2, bz = lz + d / 2;
    const X0 = fr.cx + ax * fr.rx + az * fr.fx, Z0 = fr.cz + ax * fr.rz + az * fr.fz;
    const X1 = fr.cx + bx * fr.rx + bz * fr.fx, Z1 = fr.cz + bx * fr.rz + bz * fr.fz;
    return add(X0, y0, Z0, X1, y1, Z1, mat, kind);
  }
  const dirFrom = (dx, dz) => (Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 1 : 3) : dz > 0 ? 2 : 0);
  const tc = (t) => t * T + T / 2; // tile centre coordinate

  // number of walkable-ish tiles in a straight line from a tile
  function openRun(tx, tz, dir) {
    let n = 0;
    for (let k = 1; k < 12; k++) {
      const c = at(tx + DIRS[dir][0] * k, tz + DIRS[dir][1] * k);
      if (!isFree(c)) break;
      n++;
    }
    return n;
  }
  function mostOpenDir(tx, tz) {
    let best = 0, bv = -1;
    for (let d = 0; d < 4; d++) { const v = openRun(tx, tz, d) + rng() * 0.5; if (v > bv) { bv = v; best = d; } }
    return best;
  }
  // choose the adjacent wall side for wall-snapped props; prefers walls shared along the run of same chars
  function wallSide(tx, tz, ch, accept) {
    accept = accept || isWall;
    let best = -1, bv = -1;
    for (let s = 0; s < 4; s++) {
      if (!accept(at(tx + DIRS[s][0], tz + DIRS[s][1]))) continue;
      let v = 1 + rng() * 0.5;
      // perpendicular neighbours with the same char and same wall side => this is a run along that wall
      for (const p of [(s + 1) % 4, (s + 3) % 4]) {
        const nx = tx + DIRS[p][0], nz = tz + DIRS[p][1];
        if (at(nx, nz) === ch && accept(at(nx + DIRS[s][0], nz + DIRS[s][1]))) v += 2;
      }
      // prefer the side whose opposite is open (room to stand in front)
      if (isFree(at(tx - DIRS[s][0], tz - DIRS[s][1]))) v += 0.75;
      if (v > bv) { bv = v; best = s; }
    }
    return best;
  }

  // ---------------- furniture pieces ----------------
  function chair(cx, cz, dir, mat) {
    const fr = frame(cx, cz, dir), m = mat || 'wood', L = 0.035, s = 0.44, hs = 0.2;
    lb(fr, 0, 0, s, s, 0.43, 0.47, m, 'chair');
    for (const ox of [-hs, hs]) for (const oz of [-hs, hs]) lb(fr, ox, oz, L, L, 0, 0.43, m, 'chair');
    // back: rear posts + top rail + slats (the back is on -lz side; sitter faces +lz)
    for (const ox of [-hs, hs]) lb(fr, ox, -hs, L, L, 0.47, 0.92, m, 'chair');
    lb(fr, 0, -hs, s - 0.02, 0.03, 0.85, 0.92, m, 'chair');
    if (rng() < 0.5) { for (const ox of [-0.07, 0.07]) lb(fr, ox, -hs, 0.035, 0.02, 0.47, 0.85, m, 'chair'); }
    else lb(fr, 0, -hs, s - 0.04, 0.02, 0.62, 0.68, m, 'chair');
  }

  function officeChair(cx, cz, dir) {
    const fr = frame(cx, cz, dir);
    lb(fr, 0, 0, 0.62, 0.05, 0.03, 0.09, 'metal', 'chair');
    lb(fr, 0, 0, 0.05, 0.62, 0.03, 0.09, 'metal', 'chair');
    lb(fr, 0, 0, 0.05, 0.05, 0.09, 0.44, 'metal', 'chair');
    lb(fr, 0, 0, 0.5, 0.48, 0.44, 0.53, 'fabric', 'chair');
    lb(fr, 0, -0.24, 0.05, 0.04, 0.44, 0.62, 'metal', 'chair');
    lb(fr, 0, -0.27, 0.46, 0.07, 0.6, 1.1, 'fabric', 'chair');
    for (const ox of [-0.27, 0.27]) {
      lb(fr, ox, 0.0, 0.03, 0.03, 0.53, 0.66, 'metal', 'chair');
      lb(fr, ox, 0.0, 0.06, 0.26, 0.66, 0.7, 'fabric', 'chair');
    }
  }

  // axis-aligned table; alongX = long axis is x
  function table(cx, cz, alongX, len, wid, h, mat) {
    const hx = alongX ? len / 2 : wid / 2, hz = alongX ? wid / 2 : len / 2, L = 0.06, ins = 0.07;
    add(cx - hx, h - 0.04, cz - hz, cx + hx, h, cz + hz, mat, 'table');
    const lxs = [-hx + ins, hx - ins], lzs = [-hz + ins, hz - ins];
    // extra middle legs on long tables
    const longs = [];
    const nMid = Math.floor(len / 2.2);
    for (let i = 1; i <= nMid; i++) longs.push(-len / 2 + (len * i) / (nMid + 1));
    for (const ox of lxs) for (const oz of lzs) add(cx + ox - L / 2, 0, cz + oz - L / 2, cx + ox + L / 2, h - 0.04, cz + oz + L / 2, mat, 'table');
    for (const m of longs) for (const o of [-wid / 2 + ins, wid / 2 - ins]) {
      const ox = alongX ? m : o, oz = alongX ? o : m;
      add(cx + ox - L / 2, 0, cz + oz - L / 2, cx + ox + L / 2, h - 0.04, cz + oz + L / 2, mat, 'table');
    }
    // apron under the top along the long sides
    if (alongX) for (const oz of [-hz + 0.04, hz - 0.06]) add(cx - hx + ins, h - 0.14, cz + oz, cx + hx - ins, h - 0.04, cz + oz + 0.02, mat, 'table');
    else for (const ox of [-hx + 0.04, hx - 0.06]) add(cx + ox, h - 0.14, cz - hz + ins, cx + ox + 0.02, h - 0.04, cz + hz - ins, mat, 'table');
  }

  // T runs: one table per horizontal run of T (or vertical, for isolated columns), chairs around
  function buildTables(done) {
    for (let tz = 0; tz < GH; tz++) for (let tx = 0; tx < GW; tx++) {
      if (at(tx, tz) !== 'T' || done[tz * GW + tx]) continue;
      let n = 1, alongX = true;
      while (at(tx + n, tz) === 'T') n++;
      if (n === 1) {
        let m = 1; while (at(tx, tz + m) === 'T') m++;
        if (m > 1) { n = m; alongX = false; }
        else {
          // single tile: long axis along the more open direction
          const ox = openRun(tx, tz, 1) + openRun(tx, tz, 3), oz = openRun(tx, tz, 0) + openRun(tx, tz, 2);
          alongX = ox === oz ? rng() < 0.5 : ox > oz;
        }
      }
      for (let i = 0; i < n; i++) done[(alongX ? tz : tz + i) * GW + (alongX ? tx + i : tx)] = 1;
      const big = n > 1;
      const len = big ? n * T - 0.8 : rnd(1.3, 1.5), wid = big ? 1.15 : rnd(0.8, 0.9);
      const cx = alongX ? tx * T + (n * T) / 2 : tc(tx), cz = alongX ? tc(tz) : tz * T + (n * T) / 2;
      const ccx = cx + (big ? 0 : rnd(-0.1, 0.1)), ccz = cz + (big ? 0 : rnd(-0.1, 0.1));
      const mat = theme === 'office' ? 'wood' : 'wood';
      table(ccx, ccz, alongX, len, wid, 0.75, mat);
      // chairs
      const slots = [];
      if (big) {
        const per = Math.max(2, Math.floor(len / 0.8));
        for (const side of [-1, 1]) for (let i = 0; i < per; i++) slots.push([-len / 2 + (len * (i + 0.5)) / per, side]);
        slots.push([null, -1], [null, 1]); // ends
      } else {
        const k = 2 + Math.floor(rng() * 3);
        if (k === 2) slots.push([rnd(-0.15, 0.15), -1], [rnd(-0.15, 0.15), 1]);
        else if (k === 3) { const s = rng() < 0.5 ? -1 : 1; slots.push([-0.35, s], [0.35, s], [rnd(-0.1, 0.1), -s]); }
        else slots.push([-0.35, -1], [0.35, -1], [-0.35, 1], [0.35, 1]);
      }
      for (const [along, side] of slots) {
        const pull = rnd(0.12, 0.3);
        let ox, oz;
        if (along === null) { // chair at the end of a long table
          const a = side * (len / 2 + 0.25 + pull);
          ox = alongX ? a : 0; oz = alongX ? 0 : a;
        } else {
          const p = side * (wid / 2 + 0.12 + pull);
          ox = alongX ? along : p; oz = alongX ? p : along;
        }
        const x = ccx + ox, z = ccz + oz;
        const c = at(Math.floor(x / T), Math.floor(z / T));
        if (c !== 'T' && !isFree(c) && c !== 'c') continue; // never push a chair into a wall/prop
        // keep 0.25 m off walls
        if (isWall(at(Math.floor((x - 0.3) / T), Math.floor(z / T))) || isWall(at(Math.floor((x + 0.3) / T), Math.floor(z / T))) ||
            isWall(at(Math.floor(x / T), Math.floor((z - 0.3) / T))) || isWall(at(Math.floor(x / T), Math.floor((z + 0.3) / T)))) continue;
        const dir = dirFrom(-ox, -oz);
        if (theme === 'office') officeChair(x, z, dir); else chair(x, z, dir);
      }
      if (theme === 'apartment' || theme === 'office') {
        // pendant / ceiling light above the table
        const y = theme === 'apartment' ? 2.0 : ceil - 0.5;
        add(ccx - 0.01, y + 0.2, ccz - 0.01, ccx + 0.01, ceil, ccz + 0.01, 'metal', 'pendant');
        if (big) add(ccx - (alongX ? len / 2.6 : 0.2), y, ccz - (alongX ? 0.2 : len / 2.6), ccx + (alongX ? len / 2.6 : 0.2), y + 0.2, ccz + (alongX ? 0.2 : len / 2.6), 'metal', 'pendant');
        else add(ccx - 0.22, y, ccz - 0.22, ccx + 0.22, y + 0.2, ccz + 0.22, 'fabric', 'pendant');
      }
    }
  }

  function bookshelf(tx, tz) {
    const s = wallSide(tx, tz, 'B');
    const cx = tc(tx), cz = tc(tz);
    const dir = s >= 0 ? (s + 2) % 4 : (openRun(tx, tz, 1) + openRun(tx, tz, 3) > openRun(tx, tz, 0) + openRun(tx, tz, 2) ? 0 : 1);
    const fr = frame(cx, cz, dir);
    const w = rnd(1.7, 1.85), D = 0.34, H = rnd(1.85, 2.2), back = s >= 0 ? -0.98 : -D / 2;
    const zc = back + D / 2;
    for (const ox of [-w / 2 + 0.015, w / 2 - 0.015]) lb(fr, ox, zc, 0.03, D, 0, H, 'wood', 'bookshelf');
    lb(fr, 0, back + 0.008, w, 0.016, 0, H, 'wood', 'bookshelf');
    const n = 4 + Math.floor(rng() * 2);
    const ys = [];
    for (let i = 0; i <= n; i++) ys.push(0.06 + ((H - 0.09) * i) / n);
    for (const y of ys) lb(fr, 0, zc, w - 0.06, D - 0.01, y, y + 0.03, 'wood', 'bookshelf');
    for (let i = 0; i < n; i++) {
      const gap = ys[i + 1] - ys[i] - 0.03, y0 = ys[i] + 0.03;
      let x = -w / 2 + 0.04 + rnd(0, 0.15);
      let clumps = 0;
      while (x < w / 2 - 0.1 && clumps < 4) {
        const cw = Math.min(rnd(0.12, 0.42), w / 2 - 0.04 - x);
        const hh = gap * rnd(0.6, 0.9), dd = rnd(0.18, 0.26);
        if (rng() < 0.15) { lb(fr, x + 0.12, back + 0.05 + 0.1, 0.24, 0.2, y0, y0 + 0.06, 'fabric', 'book'); x += 0.3; } // lying stack
        else lb(fr, x + cw / 2, back + 0.02 + dd / 2, cw, dd, y0, y0 + hh, 'fabric', 'book');
        x += cw + rnd(0.02, 0.25);
        clumps++;
      }
    }
  }

  function crate(x0, y0, z0, sx, sy, sz, mat) {
    const m = mat || 'wood', b = 0.025;
    add(x0 + b, y0, z0 + b, x0 + sx - b, y0 + sy, z0 + sz - b, m, 'crate');
    add(x0, y0, z0, x0 + sx, y0 + 0.1, z0 + sz, m, 'crate');
    add(x0, y0 + sy - 0.1, z0, x0 + sx, y0 + sy, z0 + sz, m, 'crate');
    if (sy > 0.7) {
      if (rng() < 0.5) add(x0, y0 + sy / 2 - 0.05, z0, x0 + sx, y0 + sy / 2 + 0.05, z0 + sz, m, 'crate');
      else { // vertical battens on the x faces
        add(x0 + sx * 0.3, y0, z0, x0 + sx * 0.3 + 0.09, y0 + sy, z0 + sz, m, 'crate');
        add(x0 + sx * 0.7 - 0.09, y0, z0, x0 + sx * 0.7, y0 + sy, z0 + sz, m, 'crate');
      }
    }
  }
  function pallet(x0, z0, sx, sz) {
    for (const f of [0.04, 0.5, 0.96]) add(x0, 0, z0 + sz * f - 0.04, x0 + sx, 0.1, z0 + sz * f + 0.04, 'wood', 'pallet');
    for (let i = 0; i < 4; i++) { const a = x0 + (sx * i) / 4 + 0.02; add(a, 0.1, z0, a + sx / 4 - 0.04, 0.14, z0 + sz, 'wood', 'pallet'); }
  }
  function crateStack(tx, tz) {
    const cx = tc(tx), cz = tc(tz);
    if (theme === 'office' && mats[tz * GW + tx] === 3) return serverRack(tx, tz);
    const wh = theme === 'warehouse';
    const smin = wh ? 1.0 : theme === 'office' ? 0.45 : 0.5, smax = wh ? 1.3 : theme === 'office' ? 0.65 : 0.75;
    const maxN = wh ? 3 : 3;
    const n = 1 + Math.floor(rng() * maxN);
    let s = rnd(smin, smax);
    const lim = 1 - s / 2 - 0.15;
    let x = cx + rnd(-lim, lim) - s / 2, z = cz + rnd(-lim, lim) - s / 2, y = 0;
    if (wh) { pallet(x - 0.05, z - 0.05, s + 0.1, s + 0.1); y = 0.14; }
    crate(x, y, z, s, s * rnd(0.85, 1.0), s);
    let topY = y + s * 0.9;
    for (let i = 1; i < n; i++) {
      const beside = i === 1 && rng() < 0.4;
      const s2 = beside ? rnd(smin, smax) * 0.8 : s * rnd(0.6, 0.9);
      if (beside) {
        // second crate next to the first, still inside the tile
        let bx = x + s + 0.05, bz = z + rnd(-0.1, 0.2);
        if (bx + s2 > tx * T + T - 0.1) bx = x - s2 - 0.05;
        if (bx < tx * T + 0.1) { // doesn't fit: stack instead
          const ox = x + rnd(0, s - s2), oz = z + rnd(0, s - s2);
          crate(ox, topY, oz, s2, s2, s2); topY += s2; continue;
        }
        bz = Math.min(Math.max(bz, tz * T + 0.1), tz * T + T - 0.1 - s2);
        crate(bx, 0, bz, s2, s2, s2);
      } else {
        if (topY + s2 > ceil - 0.6) break;
        const ox = x + rnd(0, s - s2), oz = z + rnd(0, s - s2);
        crate(ox, topY, oz, s2, s2 * rnd(0.8, 1), s2);
        topY += s2 * 0.9;
      }
    }
  }
  function serverRack(tx, tz) {
    const s = wallSide(tx, tz, 'C');
    const dir = s >= 0 ? (s + 2) % 4 : mostOpenDir(tx, tz);
    const fr = frame(tc(tx), tc(tz), dir);
    const back = s >= 0 ? -0.95 : -0.5, D = 1.0, H = 2.0;
    for (const ox of [-0.33, 0.33]) {
      lb(fr, ox, back + D / 2, 0.6, D, 0, H, 'metal', 'server');
      for (let k = 0; k < 7; k++) { const y = 0.2 + k * 0.24; lb(fr, ox, back + D + 0.01, 0.5, 0.02, y, y + 0.1, 'metal', 'server'); }
    }
  }

  function pillar(tx, tz) {
    const cx = tc(tx), cz = tc(tz);
    if (theme === 'warehouse') {
      add(cx - 0.36, 0, cz - 0.36, cx + 0.36, 1.0, cz + 0.36, 'concrete', 'pillar');
      const ax = rng() < 0.5;
      const fl = (o) => (ax ? add(cx - 0.2, 1.0, cz + o - 0.015, cx + 0.2, ceil, cz + o + 0.015, 'metal', 'pillar')
                            : add(cx + o - 0.015, 1.0, cz - 0.2, cx + o + 0.015, ceil, cz + 0.2, 'metal', 'pillar'));
      fl(-0.18); fl(0.18);
      if (ax) add(cx - 0.015, 1.0, cz - 0.18, cx + 0.015, ceil, cz + 0.18, 'metal', 'pillar');
      else add(cx - 0.18, 1.0, cz - 0.015, cx + 0.18, ceil, cz + 0.015, 'metal', 'pillar');
    } else {
      add(cx - 0.3, 0, cz - 0.3, cx + 0.3, ceil, cz + 0.3, 'concrete', 'pillar');
      add(cx - 0.38, 0, cz - 0.38, cx + 0.38, 0.12, cz + 0.38, 'concrete', 'pillar');
      add(cx - 0.36, ceil - 0.2, cz - 0.36, cx + 0.36, ceil, cz + 0.36, 'plaster', 'pillar');
    }
  }

  function couch(tx, tz) {
    const s = wallSide(tx, tz, 'O');
    const dir = s >= 0 ? (s + 2) % 4 : mostOpenDir(tx, tz);
    const fr = frame(tc(tx), tc(tz), dir);
    const D = 0.92, back = s >= 0 ? -0.98 : -D / 2, front = back + D, w = 2.0;
    // run neighbours (sectional): skip the arm on that side
    const rDir = (dir + 1) % 4, lDir = (dir + 3) % 4;
    const nR = at(tx + DIRS[rDir][0], tz + DIRS[rDir][1]) === 'O', nL = at(tx + DIRS[lDir][0], tz + DIRS[lDir][1]) === 'O';
    const xl = nL ? -1 : -w / 2 + 0.03, xr = nR ? 1 : w / 2 - 0.03;
    const mid = (xl + xr) / 2, ww = xr - xl, zc = (back + front) / 2;
    lb(fr, mid, zc, ww, D - 0.04, 0.1, 0.42, 'fabric', 'couch');
    for (const ox of [xl + 0.06, xr - 0.06]) for (const oz of [back + 0.06, front - 0.08]) lb(fr, ox, oz, 0.06, 0.06, 0, 0.1, 'wood', 'couch');
    lb(fr, mid, back + 0.11, ww, 0.22, 0.42, 0.9, 'fabric', 'couch');
    const inL = nL ? xl : xl + 0.18, inR = nR ? xr : xr - 0.18;
    const cushions = ww > 1.5 ? 2 : 1, cw = (inR - inL) / cushions;
    for (let i = 0; i < cushions; i++) lb(fr, inL + cw * (i + 0.5), (back + 0.22 + front) / 2, cw - 0.02, front - back - 0.24, 0.42, 0.53, 'fabric', 'couch');
    if (!nL) lb(fr, xl + 0.09, zc, 0.18, D - 0.02, 0.1, 0.65, 'fabric', 'couch');
    if (!nR) lb(fr, xr - 0.09, zc, 0.18, D - 0.02, 0.1, 0.65, 'fabric', 'couch');
    if (rng() < 0.5) lb(fr, inL + 0.25, back + 0.32, 0.4, 0.14, 0.53, 0.9, 'fabric', 'couch'); // throw pillow
  }

  function bed(tx, tz) {
    const s = wallSide(tx, tz, 'b');
    const dir = s >= 0 ? (s + 2) % 4 : mostOpenDir(tx, tz);
    const fr = frame(tc(tx), tc(tz), dir);
    const w = rnd(1.4, 1.6), back = s >= 0 ? -0.98 : -1.0, L = 2.0, foot = back + L;
    const zc = (back + foot) / 2;
    lb(fr, 0, zc + 0.03, w, L - 0.06, 0.12, 0.32, 'wood', 'bed');
    for (const ox of [-w / 2 + 0.05, w / 2 - 0.05]) for (const oz of [back + 0.1, foot - 0.05]) lb(fr, ox, oz, 0.07, 0.07, 0, 0.12, 'wood', 'bed');
    lb(fr, 0, zc + 0.04, w - 0.06, L - 0.14, 0.32, 0.55, 'fabric', 'bed');
    // headboard: posts + panel + slats
    for (const ox of [-w / 2 + 0.04, w / 2 - 0.04]) lb(fr, ox, back + 0.04, 0.08, 0.08, 0, 1.1, 'wood', 'bed');
    lb(fr, 0, back + 0.04, w - 0.08, 0.04, 0.95, 1.05, 'wood', 'bed');
    for (const ox of [-0.3, 0, 0.3]) lb(fr, ox * (w / 1.5), back + 0.04, 0.08, 0.03, 0.55, 0.95, 'wood', 'bed');
    lb(fr, 0, foot - 0.03, w, 0.05, 0.12, 0.5, 'wood', 'bed');
    // pillows + folded blanket
    const two = w > 1.45;
    for (const ox of two ? [-w / 4, w / 4] : [0]) lb(fr, ox + rnd(-0.04, 0.04), back + 0.32, two ? w / 2 - 0.14 : 0.6, 0.36, 0.55, 0.67, 'fabric', 'bed');
    lb(fr, 0, foot - rnd(0.45, 0.6), w + 0.06, 0.55, 0.53, 0.6, 'fabric', 'bed');
  }

  function lamp(tx, tz) {
    const cx = tc(tx) + rnd(-0.35, 0.35), cz = tc(tz) + rnd(-0.35, 0.35);
    if (theme === 'warehouse') { // oil drum cluster
      const n = 2 + Math.floor(rng() * 2);
      const spots = [[-0.32, -0.32], [0.32, -0.3], [0, 0.32]];
      for (let i = 0; i < n; i++) {
        const x = tc(tx) + spots[i][0], z = tc(tz) + spots[i][1], r = 0.29;
        add(x - r, 0, z - r, x + r, 0.88, z + r, 'metal', 'barrel');
        for (const y of [0.28, 0.58]) add(x - r - 0.02, y, z - r - 0.02, x + r + 0.02, y + 0.03, z + r + 0.02, 'metal', 'barrel');
      }
      if (rng() < 0.6) { const x = tc(tx) + spots[0][0], z = tc(tz) + spots[0][1]; add(x - 0.2, 0.88, z - 0.2, x + 0.2, 1.4, z + 0.2, 'metal', 'barrel'); }
      return;
    }
    if (theme === 'office') { // potted plant
      add(cx - 0.2, 0, cz - 0.2, cx + 0.2, 0.45, cz + 0.2, 'plaster', 'plant');
      add(cx - 0.02, 0.45, cz - 0.02, cx + 0.02, 1.1, cz + 0.02, 'wood', 'plant');
      for (let i = 0; i < 4; i++) {
        const s = rnd(0.25, 0.45), ox = rnd(-0.25, 0.25), oz = rnd(-0.25, 0.25), y = rnd(0.75, 1.35);
        add(cx + ox - s / 2, y, cz + oz - s / 2, cx + ox + s / 2, y + s * 0.6, cz + oz + s / 2, 'fabric', 'plant');
      }
      return;
    }
    if (rng() < 0.6) { // floor lamp
      add(cx - 0.16, 0, cz - 0.16, cx + 0.16, 0.03, cz + 0.16, 'metal', 'lamp');
      add(cx - 0.015, 0.03, cz - 0.015, cx + 0.015, 1.4, cz + 0.015, 'metal', 'lamp');
      add(cx - 0.21, 1.32, cz - 0.21, cx + 0.21, 1.62, cz + 0.21, 'fabric', 'lamp');
    } else { // coat stand with a coat
      add(cx - 0.25, 0.02, cz - 0.03, cx + 0.25, 0.07, cz + 0.03, 'wood', 'lamp');
      add(cx - 0.03, 0.02, cz - 0.25, cx + 0.03, 0.07, cz + 0.25, 'wood', 'lamp');
      add(cx - 0.02, 0.07, cz - 0.02, cx + 0.02, 1.8, cz + 0.02, 'wood', 'lamp');
      for (const [dx, dz] of DIRS) add(cx + dx * 0.12 - 0.015, 1.68, cz + dz * 0.12 - 0.015, cx + dx * 0.12 + 0.015, 1.72, cz + dz * 0.12 + 0.015, 'wood', 'lamp');
      const d = DIRS[Math.floor(rng() * 4)];
      const hx = cx + d[0] * 0.14, hz = cz + d[1] * 0.14;
      add(hx - (d[0] ? 0.06 : 0.2), 0.85, hz - (d[1] ? 0.06 : 0.2), hx + (d[0] ? 0.06 : 0.2), 1.66, hz + (d[1] ? 0.06 : 0.2), 'fabric', 'lamp');
    }
  }

  function desk(tx, tz) {
    const accept = (c) => isWall(c) || BARRIER.indexOf(c) >= 0;
    let s = wallSide(tx, tz, 'D', (c) => BARRIER.indexOf(c) >= 0);
    let nearBarrier = s >= 0;
    if (s < 0) s = wallSide(tx, tz, 'D', accept);
    const dir = s >= 0 ? (s + 2) % 4 : mostOpenDir(tx, tz);
    const fr = frame(tc(tx), tc(tz), dir);
    const w = rnd(1.4, 1.6), D = 0.75, back = s < 0 ? -0.6 : nearBarrier ? -0.92 : -0.97, zc = back + D / 2;
    lb(fr, 0, zc, w, D, 0.72, 0.75, 'wood', 'desk');
    for (const ox of [-w / 2 + 0.02, w / 2 - 0.02]) lb(fr, ox, zc, 0.03, D - 0.02, 0, 0.72, 'wood', 'desk');
    lb(fr, 0, back + 0.03, w - 0.06, 0.02, 0.3, 0.72, 'wood', 'desk');
    if (rng() < 0.6) { const ox = (rng() < 0.5 ? -1 : 1) * (w / 2 - 0.25); lb(fr, ox, zc + 0.03, 0.4, D - 0.1, 0.02, 0.62, 'metal', 'desk'); }
    // monitor
    const mx = rnd(-0.15, 0.15);
    lb(fr, mx, back + 0.2, 0.22, 0.18, 0.75, 0.77, 'metal', 'monitor');
    lb(fr, mx, back + 0.2, 0.04, 0.04, 0.77, 0.95, 'metal', 'monitor');
    lb(fr, mx, back + 0.24, 0.6, 0.03, 0.92, 1.27, 'glass', 'monitor');
    lb(fr, mx, back + 0.5, 0.45, 0.15, 0.75, 0.77, 'metal', 'monitor');
    if (rng() < 0.4) lb(fr, mx + 0.5 * (rng() < 0.5 ? -1 : 1), back + 0.35, 0.2, 0.28, 0.75, 0.78, 'fabric', 'desk'); // papers
    // office chair in front, facing the desk
    const cz = back + D + rnd(0.2, 0.4), cx = rnd(-0.15, 0.15);
    const wx = fr.cx + cx * fr.rx + cz * fr.fx, wz = fr.cz + cx * fr.rz + cz * fr.fz;
    officeChair(wx, wz, (dir + 2) % 4);
  }

  function counter(tx, tz) {
    const s = wallSide(tx, tz, 'K', (c) => isWall(c) || c === '|');
    let dir;
    if (s >= 0) dir = (s + 2) % 4;
    else { // free-standing: orient along the run of K
      const hx = at(tx - 1, tz) === 'K' || at(tx + 1, tz) === 'K';
      const front = hx ? (openRun(tx, tz, 0) > openRun(tx, tz, 2) ? 0 : 2) : (openRun(tx, tz, 1) > openRun(tx, tz, 3) ? 1 : 3);
      dir = front;
    }
    const fr = frame(tc(tx), tc(tz), dir);
    const rDir = (dir + 1) % 4, lDir = (dir + 3) % 4;
    const nR = at(tx + DIRS[rDir][0], tz + DIRS[rDir][1]) === 'K', nL = at(tx + DIRS[lDir][0], tz + DIRS[lDir][1]) === 'K';
    const xl = nL || (s >= 0 && isWall(at(tx + DIRS[lDir][0], tz + DIRS[lDir][1]))) ? -1 : -0.9;
    const xr = nR || (s >= 0 && isWall(at(tx + DIRS[rDir][0], tz + DIRS[rDir][1]))) ? 1 : 0.9;
    const ww = xr - xl, mid = (xl + xr) / 2;
    if (theme === 'warehouse') { // workbench + pegboard
      const back = s >= 0 ? -0.98 : -0.4, D = 0.75, zc = back + D / 2;
      lb(fr, mid, zc, ww - 0.04, D, 0.86, 0.92, 'wood', 'bench');
      for (const ox of [xl + 0.08, xr - 0.08]) for (const oz of [back + 0.06, back + D - 0.06]) lb(fr, ox, oz, 0.06, 0.06, 0, 0.86, 'metal', 'bench');
      lb(fr, mid, zc, ww - 0.1, D - 0.1, 0.22, 0.25, 'metal', 'bench');
      lb(fr, mid + rnd(-0.5, 0.5), back + D - 0.12, 0.16, 0.2, 0.92, 1.08, 'metal', 'bench'); // vise
      if (rng() < 0.6) lb(fr, mid + rnd(-0.5, 0.5), zc, 0.45, 0.25, 0.25, 0.5, 'metal', 'bench'); // toolbox
      if (s >= 0) {
        lb(fr, mid, back + 0.01, ww - 0.2, 0.02, 1.1, 1.9, 'wood', 'bench');
        for (let i = 0; i < 4; i++) lb(fr, xl + 0.3 + i * (ww - 0.6) / 3, back + 0.05, 0.04, 0.04, rnd(1.3, 1.5), rnd(1.6, 1.8), 'metal', 'bench');
      }
      return;
    }
    const freeStanding = s < 0;
    const back = freeStanding ? -0.35 : -0.98, D = 0.62, front = back + D, zc = back + D / 2;
    const topY = freeStanding && theme === 'office' ? 1.05 : 0.86;
    lb(fr, mid, zc - 0.03, ww, D - 0.06, 0, 0.1, 'wood', 'counter');
    lb(fr, mid, zc - 0.01, ww, D - 0.02, 0.1, topY, 'wood', 'counter');
    const nd = ww > 1.5 ? 2 : 1, dw = (ww - 0.06) / nd;
    for (let i = 0; i < nd; i++) {
      const x = xl + 0.03 + dw * (i + 0.5);
      lb(fr, x, front + 0.005, dw - 0.03, 0.02, 0.14, topY - 0.06, 'wood', 'counter');
      lb(fr, x + dw * 0.3, front + 0.025, 0.12, 0.02, topY - 0.16, topY - 0.13, 'metal', 'counter');
    }
    lb(fr, mid, zc + 0.015, ww, D + 0.03, topY, topY + 0.04, 'concrete', 'counter');
    if (!freeStanding && theme === 'apartment' && isWall(at(tx + DIRS[s][0], tz + DIRS[s][1])) && rng() < 0.75) {
      lb(fr, mid, back + 0.17, ww, 0.34, 1.45, 2.15, 'wood', 'counter');
      for (let i = 0; i < nd; i++) lb(fr, xl + 0.03 + dw * (i + 0.5), back + 0.35, dw - 0.03, 0.02, 1.48, 2.12, 'wood', 'counter');
    }
    // items on top
    const items = Math.floor(rng() * 3);
    for (let i = 0; i < items; i++) {
      const k = rng(), x = mid + rnd(-ww / 2 + 0.3, ww / 2 - 0.3), z = back + rnd(0.15, 0.35), y = topY + 0.04;
      if (k < 0.3) lb(fr, x, z, 0.5, 0.36, y, y + 0.3, 'metal', 'item'); // microwave / printer
      else if (k < 0.6) lb(fr, x, z, 0.17, 0.17, y, y + 0.24, 'metal', 'item'); // kettle
      else if (k < 0.8) { lb(fr, x, z, 0.07, 0.07, y, y + 0.3, 'glass', 'item'); lb(fr, x + 0.1, z + 0.04, 0.07, 0.07, y, y + 0.24, 'glass', 'item'); }
      else lb(fr, x, z + 0.05, 0.4, 0.26, y, y + 0.02, 'wood', 'item'); // board
    }
  }

  // glass partitions (G) and half walls (|): segments connect to neighbouring G/| (and walls at run ends)
  function partition(tx, tz, ch) {
    const cx = tc(tx), cz = tc(tz);
    const c = [], w = [];
    for (let s = 0; s < 4; s++) { const n = at(tx + DIRS[s][0], tz + DIRS[s][1]); c[s] = BARRIER.indexOf(n) >= 0; w[s] = isWall(n); }
    let hx = c[1] || c[3], vz = c[0] || c[2];
    if (!hx && !vz) { if ((w[0] || w[2]) && !(w[1] || w[3])) vz = true; else hx = true; }
    const spans = [];
    if (hx) spans.push([true, c[3] || w[3] ? cx - 1 : cx - 0.6, c[1] || w[1] ? cx + 1 : cx + 0.6, !(c[3] || w[3]), !(c[1] || w[1])]);
    if (vz) spans.push([false, c[0] || w[0] ? cz - 1 : cz - 0.6, c[2] || w[2] ? cz + 1 : cz + 0.6, !(c[0] || w[0]), !(c[2] || w[2])]);
    for (const [alongX, a, b, capA, capB] of spans) {
      const box = (o0, o1, half, y0, y1, mat, kind) => (alongX ? add(o0, y0, cz - half, o1, y1, cz + half, mat, kind) : add(cx - half, y0, o0, cx + half, y1, o1, mat, kind));
      if (ch === 'G') {
        box(a, b, 0.015, 0.05, 1.2, 'glass', 'glass');
        box(a, b, 0.025, 1.2, 1.24, 'metal', 'glass');
        box(a, b, 0.03, 0, 0.05, 'metal', 'glass');
        if (capA) box(a, a + 0.05, 0.03, 0, 1.25, 'metal', 'glass');
        if (capB) box(b - 0.05, b, 0.03, 0, 1.25, 'metal', 'glass');
      } else {
        box(a, b, 0.08, 0, 1.1, 'plaster', 'halfwall');
        box(a - (capA ? 0.03 : 0), b + (capB ? 0.03 : 0), 0.11, 1.1, 1.14, 'wood', 'halfwall');
      }
    }
    if (ch === 'G') add(cx - 0.03, 0, cz - 0.03, cx + 0.03, 1.25, cz + 0.03, 'metal', 'glass');
  }

  // ---------------- extras (map-specific set pieces) ----------------
  function forklift(tx, tz, dir) {
    const fr = frame(tc(tx), tc(tz), dir);
    lb(fr, 0, -0.75, 1.1, 0.5, 0.2, 1.1, 'metal', 'forklift'); // counterweight
    lb(fr, 0, 0.05, 1.0, 1.1, 0.2, 0.7, 'metal', 'forklift'); // chassis
    lb(fr, 0, -0.25, 0.5, 0.4, 0.7, 0.8, 'fabric', 'forklift');
    lb(fr, 0, -0.43, 0.5, 0.06, 0.8, 1.2, 'fabric', 'forklift');
    lb(fr, 0, 0.3, 0.06, 0.06, 0.7, 1.15, 'metal', 'forklift');
    lb(fr, 0, 0.25, 0.32, 0.04, 1.15, 1.18, 'metal', 'forklift');
    for (const ox of [-0.5, 0.5]) {
      for (const oz of [-0.85, 0.45]) lb(fr, ox, oz, 0.06, 0.06, 0.7, 2.1, 'metal', 'forklift');
      lb(fr, ox, -0.2, 0.06, 1.36, 2.1, 2.16, 'metal', 'forklift');
      for (const oz of [-0.65, 0.4]) lb(fr, ox * 1.08, oz, 0.22, 0.5, 0, 0.5, 'fabric', 'forklift'); // tyres
      lb(fr, ox * 0.7, 0.68, 0.08, 0.12, 0.08, 2.4, 'metal', 'forklift'); // mast rails
    }
    for (const oz of [-0.6, -0.2, 0.2]) lb(fr, 0, oz, 1.0, 0.05, 2.1, 2.16, 'metal', 'forklift');
    lb(fr, 0, 0.68, 0.8, 0.12, 2.3, 2.4, 'metal', 'forklift');
    lb(fr, 0, 0.76, 0.9, 0.04, 0.1, 0.75, 'metal', 'forklift'); // carriage
    for (const ox of [-0.28, 0.28]) lb(fr, ox, 1.3, 0.12, 1.05, 0.08, 0.13, 'metal', 'forklift'); // forks
  }
  // roll-up door ribs on the wall face on side `side` (0..3) of floor tile tx,tz
  function rollup(tx, tz, side) {
    const fr = frame(tc(tx), tc(tz), side);
    const H = Math.min(4.0, ceil - 0.8);
    for (let y = 0.05; y < H - 0.2; y += 0.38) lb(fr, 0, 0.97, 3.2, 0.06, y, y + 0.3, 'metal', 'door');
    for (const ox of [-1.7, 1.7]) lb(fr, ox, 0.94, 0.14, 0.12, 0, H + 0.2, 'metal', 'door');
    lb(fr, 0, 0.75, 3.6, 0.5, H, H + 0.5, 'metal', 'door');
    // yellow-line bump at the threshold (walkable)
    lb(fr, 0, 0.75, 3.2, 0.3, 0, 0.06, 'metal', 'door');
  }

  // ---------------- main build ----------------
  function build(def) {
    W = R.world;
    grid = def.grid;
    GH = grid.length; GW = grid[0].length;
    ceil = def.ceiling || 3;
    theme = (def.theme || def.name || '').toLowerCase();
    rng = mulberry32(hashStr(def.name || 'map'));
    rackDone = null;
    W.reset(GW, GH, ceil);
    mats = new Uint8Array(GW * GH);

    // floors (prop/spawn/pickup tiles inherit the dominant neighbouring floor)
    for (let tz = 0; tz < GH; tz++) for (let tx = 0; tx < GW; tx++) {
      const ch = at(tx, tz);
      if (ch === '#') continue;
      let m = FLOORS[ch];
      if (m === undefined) {
        const votes = [0, 0, 0, 0];
        for (let oz = -1; oz <= 1; oz++) for (let ox = -1; ox <= 1; ox++) {
          if (!ox && !oz) continue;
          const f = FLOORS[at(tx + ox, tz + oz)];
          if (f !== undefined) votes[f] += ox && oz ? 1 : 2;
        }
        m = 0; for (let k = 1; k < 4; k++) if (votes[k] > votes[m]) m = k;
      }
      mats[tz * GW + tx] = m;
      W.setFloor(tx, tz, m);
    }

    // walls: greedy rectangles (horizontal runs merged downward when identical)
    const used = new Uint8Array(GW * GH);
    for (let tz = 0; tz < GH; tz++) for (let tx = 0; tx < GW; tx++) {
      if (used[tz * GW + tx] || at(tx, tz) !== '#') continue;
      let x1 = tx; while (x1 + 1 < GW && at(x1 + 1, tz) === '#' && !used[tz * GW + x1 + 1]) x1++;
      let z1 = tz;
      outer: while (z1 + 1 < GH) {
        for (let x = tx; x <= x1; x++) if (at(x, z1 + 1) !== '#' || used[(z1 + 1) * GW + x]) break outer;
        z1++;
      }
      for (let z = tz; z <= z1; z++) for (let x = tx; x <= x1; x++) used[z * GW + x] = 1;
      add(tx * T, 0, tz * T, (x1 + 1) * T, ceil, (z1 + 1) * T, theme === 'warehouse' ? 'concrete' : 'plaster', 'wall');
    }

    // door headers: isolated 1-tile gaps through a wall get a lintel (makes doorways readable)
    for (let tz = 1; tz < GH - 1; tz++) for (let tx = 1; tx < GW - 1; tx++) {
      if (at(tx, tz) === '#') continue;
      const ew = isWall(at(tx - 1, tz)) && isWall(at(tx + 1, tz)), ns = isWall(at(tx, tz - 1)) && isWall(at(tx, tz + 1));
      if (ew === ns) continue;
      const corr = (x, z) => (ew ? isWall(at(x - 1, z)) && isWall(at(x + 1, z)) : isWall(at(x, z - 1)) && isWall(at(x, z + 1)));
      if (ew ? corr(tx, tz - 1) || corr(tx, tz + 1) : corr(tx - 1, tz) || corr(tx + 1, tz)) continue;
      const hy = Math.min(2.15, ceil - 0.3);
      add(tx * T, hy, tz * T, tx * T + T, ceil, tz * T + T, theme === 'warehouse' ? 'concrete' : 'plaster', 'header');
    }

    // floor detail: rugs on carpet rectangles, grate slats on metal
    const fdone = new Uint8Array(GW * GH);
    for (let tz = 0; tz < GH; tz++) for (let tx = 0; tx < GW; tx++) {
      const i = tz * GW + tx;
      if (fdone[i] || at(tx, tz) === '#') continue;
      const m = mats[i];
      if (m !== 1 && m !== 3) continue;
      const same = (x, z) => at(x, z) !== '#' && mats[z * GW + x] === m && !fdone[z * GW + x];
      let x1 = tx; while (x1 + 1 < GW && same(x1 + 1, tz)) x1++;
      let z1 = tz;
      if (m === 1) {
        outer2: while (z1 + 1 < GH) { for (let x = tx; x <= x1; x++) if (!same(x, z1 + 1)) break outer2; z1++; }
      }
      for (let z = tz; z <= z1; z++) for (let x = tx; x <= x1; x++) fdone[z * GW + x] = 1;
      if (m === 1) {
        const ins = 0.12;
        add(tx * T + ins, 0, tz * T + ins, (x1 + 1) * T - ins, 0.015, (z1 + 1) * T - ins, 'fabric', 'rug');
      } else {
        for (let k = 0; k < 5; k++) { const z = tz * T + 0.2 + k * 0.4; add(tx * T + 0.05, 0, z - 0.03, (x1 + 1) * T - 0.05, 0.035, z + 0.03, 'metal', 'grate'); }
      }
    }

    // props
    const done = new Uint8Array(GW * GH);
    buildTables(done);
    const spawns = [], pickups = [];
    for (let tz = 0; tz < GH; tz++) for (let tx = 0; tx < GW; tx++) {
      const ch = at(tx, tz);
      switch (ch) {
        case 'c': {
          let dir = -1;
          for (let s = 0; s < 4; s++) if ('TD'.indexOf(at(tx + DIRS[s][0], tz + DIRS[s][1])) >= 0) { dir = s; break; }
          if (dir < 0) dir = mostOpenDir(tx, tz);
          const x = tc(tx) + rnd(-0.3, 0.3), z = tc(tz) + rnd(-0.3, 0.3);
          if (theme === 'office') officeChair(x, z, dir); else chair(x, z, dir);
          break;
        }
        case 'B': bookshelfOrRack(tx, tz); break;
        case 'C': crateStack(tx, tz); break;
        case 'P': pillar(tx, tz); break;
        case 'O': couch(tx, tz); break;
        case 'b': bed(tx, tz); break;
        case 'L': lamp(tx, tz); break;
        case 'D': desk(tx, tz); break;
        case 'K': counter(tx, tz); break;
        case 'G': case '|': partition(tx, tz, ch); break;
        case 'S': spawns.push({ x: tc(tx), z: tc(tz), yaw: 0 }); break;
        case '+': pickups.push({ x: tc(tx), z: tc(tz), kind: 'health' }); break;
        case 'd': pickups.push({ x: tc(tx), z: tc(tz), kind: 'darts' }); break;
      }
    }

    for (const e of def.extras || []) {
      if (e.kind === 'forklift') forklift(e.tx, e.tz, e.dir || 0);
      else if (e.kind === 'rollup') rollup(e.tx, e.tz, e.dir || 0);
    }

    ceilingDetail();
    W.finalize();

    // spawn yaw: face the most open direction (smoothed over neighbouring angles)
    for (const s of spawns) {
      const N = 32, d = [];
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2, dx = Math.cos(a), dz = Math.sin(a);
        const h = W.raycast(s.x, 1.2, s.z, dx, 0, dz, 30, { actors: false });
        d.push(h ? h.t : 30);
      }
      let best = 0, bv = -1;
      for (let i = 0; i < N; i++) {
        const v = d[i] + 0.6 * (d[(i + 1) % N] + d[(i + N - 1) % N]) + 0.3 * (d[(i + 2) % N] + d[(i + N - 2) % N]);
        if (v > bv) { bv = v; best = i; }
      }
      const a = (best / N) * Math.PI * 2;
      s.yaw = Math.atan2(-Math.cos(a), -Math.sin(a));
    }
    return { spawns, pickups };
  }

  // warehouse pallet racks are built per run; elsewhere B is a bookshelf per tile
  let rackDone = null;
  function bookshelfOrRack(tx, tz) {
    if (theme !== 'warehouse') return bookshelf(tx, tz);
    if (!rackDone) rackDone = new Uint8Array(GW * GH);
    if (rackDone[tz * GW + tx]) return;
    let n = 1, alongX = true;
    while (at(tx + n, tz) === 'B') n++;
    if (n === 1) { let m = 1; while (at(tx, tz + m) === 'B') m++; if (m > 1) { n = m; alongX = false; } }
    if (n === 1) {
      const s = wallSide(tx, tz, 'B');
      alongX = s >= 0 ? s === 0 || s === 2 : true;
    }
    for (let i = 0; i < n; i++) rackDone[(alongX ? tz : tz + i) * GW + (alongX ? tx + i : tx)] = 1;
    // depth position: against a wall if the whole run touches one, else centred
    let off = 0;
    const sideA = alongX ? 0 : 3, sideB = alongX ? 2 : 1;
    const allWall = (s) => { for (let i = 0; i < n; i++) { const x = alongX ? tx + i : tx, z = alongX ? tz : tz + i; if (!isWall(at(x + DIRS[s][0], z + DIRS[s][1]))) return false; } return true; };
    const D = 1.0, H = Math.min(4.2, ceil - 1.0);
    if (allWall(sideA)) off = -1 + D / 2 + 0.05; else if (allWall(sideB)) off = 1 - D / 2 - 0.05;
    const a0 = (alongX ? tx : tz) * T + 0.1, a1 = (alongX ? tx + n : tz + n) * T - 0.1;
    const c = (alongX ? tc(tz) : tc(tx)) + off;
    const box = (u0, u1, v0, v1, y0, y1, mat, kind) => (alongX ? add(u0, y0, v0, u1, y1, v1, mat, kind) : add(v0, y0, u0, v1, y1, u1, mat, kind));
    // uprights at every bay boundary
    for (let i = 0; i <= n; i++) {
      const u = Math.min(a1 - 0.04, Math.max(a0 + 0.04, (alongX ? tx : tz) * T + i * T));
      for (const v of [c - D / 2 + 0.04, c + D / 2 - 0.04]) box(u - 0.04, u + 0.04, v - 0.04, v + 0.04, 0, H, 'metal', 'rack');
      box(u - 0.02, u + 0.02, c - D / 2 + 0.04, c + D / 2 - 0.04, 0.3, 0.34, 'metal', 'rack');
    }
    const levels = [];
    for (let y = 1.45; y < H - 0.3; y += 1.35) levels.push(y);
    for (const y of levels) for (const v of [c - D / 2 + 0.04, c + D / 2 - 0.04]) box(a0, a1, v - 0.05, v + 0.05, y - 0.12, y, 'metal', 'rack');
    // loads per bay and level
    for (let i = 0; i < n; i++) {
      const b0 = (alongX ? tx : tz) * T + i * T;
      for (const y of [0].concat(levels)) {
        if (rng() < 0.22) continue;
        const ph = 0.14, s = rnd(0.8, 1.05), h = rnd(0.55, Math.min(1.1, (y === 0 ? 1.3 : 1.2) - 0.1));
        const u0 = b0 + 0.12 + rnd(0, T - 0.3 - s);
        box(u0, u0 + s + 0.1, c - 0.46, c + 0.46, y, y + ph, 'wood', 'pallet');
        if (rng() < 0.5) { // single crate
          const p0 = alongX ? u0 + 0.05 : c - 0.42, q0 = alongX ? c - 0.42 : u0 + 0.05;
          crate(p0, y + ph, q0, alongX ? s : 0.84, h, alongX ? 0.84 : s);
        } else { // stacked cartons
          const k = 2 + Math.floor(rng() * 2), cw = s / k;
          for (let j = 0; j < k; j++) box(u0 + 0.05 + j * cw, u0 + 0.05 + (j + 1) * cw - 0.03, c - 0.4, c + 0.4, y + ph, y + ph + h * rnd(0.6, 1), 'wood', 'crate');
        }
      }
    }
  }

  function ceilingDetail() {
    if (theme === 'warehouse') {
      // steel roof trusses along z every 4 m, purlins along x every 6 m, hanging lamps
      const z0 = T, z1 = (GH - 1) * T, x0 = T, x1 = (GW - 1) * T;
      for (let x = 2 * T; x < x1; x += 2 * T) {
        add(x - 0.15, ceil - 0.75, z0, x + 0.15, ceil - 0.7, z1, 'metal', 'beam');
        add(x - 0.015, ceil - 0.7, z0, x + 0.015, ceil, z1, 'metal', 'beam');
      }
      for (let z = 3 * T; z < z1; z += 3 * T) add(x0, ceil - 0.18, z - 0.06, x1, ceil - 0.02, z + 0.06, 'metal', 'beam');
      for (let x = 4 * T; x < x1; x += 4 * T) for (let z = 3 * T; z < z1; z += 6 * T) {
        if (isWall(at(Math.floor(x / T), Math.floor(z / T)))) continue;
        add(x - 0.01, ceil - 1.9, z - 0.01, x + 0.01, ceil - 0.75, z + 0.01, 'metal', 'light');
        add(x - 0.3, ceil - 2.15, z - 0.3, x + 0.3, ceil - 1.9, z + 0.3, 'metal', 'light');
      }
    } else if (theme === 'office') {
      for (let tz = 1; tz < GH - 1; tz++) for (let tx = 1; tx < GW - 1; tx++) {
        if (isWall(at(tx, tz)) || (tx + tz) % 2) continue;
        const cx = tc(tx), cz = tc(tz), alongX = tz % 4 < 2;
        add(cx - (alongX ? 0.6 : 0.3), ceil - 0.06, cz - (alongX ? 0.3 : 0.6), cx + (alongX ? 0.6 : 0.3), ceil - 0.01, cz + (alongX ? 0.3 : 0.6), 'metal', 'light');
      }
    } else {
      for (let tz = 1; tz < GH - 1; tz++) for (let tx = 1; tx < GW - 1; tx++) {
        if (isWall(at(tx, tz)) || at(tx, tz) === 'T') continue;
        let walls = 0;
        for (const [dx, dz] of DIRS) if (isWall(at(tx + dx, tz + dz))) walls++;
        if (walls || (tx + 2 * tz) % 4) continue;
        const cx = tc(tx), cz = tc(tz);
        add(cx - 0.2, ceil - 0.12, cz - 0.2, cx + 0.2, ceil, cz + 0.2, 'glass', 'light');
      }
      // crown moulding is too many boxes; instead a picture rail on long wall runs would go here
    }
  }

  R.props = { build, _rng: mulberry32, _hash: hashStr };
})();
