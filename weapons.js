// weapons.js — REVERB shared combat (pistol, sonar darts, knife, click, damage, pickups). See SPEC.md.
// Shared by the player and bots: all per-actor state lives on actor.wpn (created lazily by R.weapons.ensure).
//   actor.wpn = {ammo, mag, reloadT, fireT, darts, knifeT, clickT, dartT}
// Spread is x3 while actor.moveMode === 'sprint' (player sets it; bots should set it too).
(function () {
  'use strict';
  const R = (window.R = window.R || {});

  const C = {
    DMG: 34, HEAD_MULT: 2.4, FIRE_INTERVAL: 0.15, MAG: 12, RELOAD: 1.5, SPREAD_DEG: 0.6, SPRINT_SPREAD_MULT: 3,
    RANGE: 120,
    // csSpread flag: inaccuracy (degrees, cone half-angle) builds from movement speed, being in the air and recent
    // shots, Counter-Strike style. Standing still and tapping is accurate; running and spamming is not.
    SPR_STAND: 0.25, SPR_CROUCH: 0.15, SPR_WALK: 3.0, SPR_SPRINT: 5.0, SPR_AIR: 7.0, SPR_MAX: 10,
    SPR_SPEED0: 0.6,  // m/s: below this you count as standing still
    SPR_SHOT: 1.1, SPR_RECOVER: 0.3, // each shot adds SPR_SHOT; it decays with this time constant (s)
    DART_SPEED: 22, DART_GRAVITY: 6, DART_START: 3, DART_MAX: 5, DART_COOLDOWN: 0.5, DART_LIFE: 6,
    PING_COUNT: 3, PING_INTERVAL: 0.7,
    KNIFE_RANGE: 1.0, KNIFE_CONE_DEG: 35, KNIFE_BACK: 100, KNIFE_FRONT: 55, KNIFE_COOLDOWN: 0.6, BACKSTAB_DOT: 0.3,
    CLICK_COOLDOWN: 0.55,
    STAND_EYE: 1.62, CROUCH_EYE: 1.05,
    RESPAWN: 3,
    PICKUP_RADIUS: 1.0, PICKUP_RESPAWN: 20, PICKUP_HEALTH: 50, HEALTH_MAX: 100, PICKUP_DARTS: 2,
  };

  const W = (R.weapons = {
    C,
    darts: [], // live darts: {thrower, x,y,z, vx,vy,vz, stuck, stuckActor, ox,oy,oz, pings, pingT, age}

    init() { this.reset(); },
    reset() { this.darts.length = 0; },

    ensure(a) {
      if (!a.wpn) a.wpn = { ammo: C.MAG, mag: C.MAG, reloadT: 0, fireT: 0, darts: C.DART_START, knifeT: 0, clickT: 0, dartT: 0 };
      return a.wpn;
    },
    resetActor(a) { a.wpn = null; return this.ensure(a); },

    // gameplay eye height (camera may smooth actor.eye separately)
    eyeY(a) { return a.crouch ? C.CROUCH_EYE : C.STAND_EYE; },
    eye(a) { return [a.x, a.y + this.eyeY(a), a.z]; },
    right(yaw) { return [Math.cos(yaw), 0, -Math.sin(yaw)]; },
    muzzle(a) {
      const f = R.forward(a.yaw, a.pitch), r = this.right(a.yaw), ey = a.y + this.eyeY(a);
      return [a.x + f[0] * 0.5 + r[0] * 0.12, ey + f[1] * 0.5 - 0.1, a.z + f[2] * 0.5 + r[2] * 0.12];
    },

    // horizontal speed the spread uses: online players, what the room granted (smoothed _spd, or the latest message's
    // _spdNow if lower, so stopping counts at once); everyone else, their velocity
    speedOf(a) {
      if (typeof a._spd !== 'number') return Math.hypot(a.vx || 0, a.vz || 0);
      return typeof a._spdNow === 'number' ? Math.min(a._spd, a._spdNow) : a._spd;
    },
    // current cone half-angle in degrees for this actor's next shot (the crosshair draws this too)
    spreadDeg(a) {
      if (!(R.flag && R.flag('csSpread'))) return C.SPREAD_DEG * (a.moveMode === 'sprint' ? C.SPRINT_SPREAD_MULT : 1);
      const w = this.ensure(a), sp = this.speedOf(a), WALK = 4.2, SPRINT = 6.8;
      let d = a.crouch ? C.SPR_CROUCH : C.SPR_STAND;
      if (sp > C.SPR_SPEED0) d += C.SPR_WALK * Math.min(1, (sp - C.SPR_SPEED0) / (WALK - C.SPR_SPEED0));
      if (sp > WALK) d += (C.SPR_SPRINT - C.SPR_WALK) * Math.min(1, (sp - WALK) / (SPRINT - WALK));
      if (a.air) d += C.SPR_AIR;
      return Math.min(C.SPR_MAX, d + (w.shotInacc || 0));
    },

    canFire(a) { const w = this.ensure(a); return a.alive !== false && w.fireT <= 0 && w.reloadT <= 0 && w.ammo > 0; },

    // ---- pistol: returns raycast hit (or {miss:true}) when a shot was fired, false otherwise
    fire(a) {
      const w = this.ensure(a);
      if (a.alive === false || w.fireT > 0 || w.reloadT > 0) return false;
      if (w.ammo <= 0) {
        // the local player gets a dry click first (dryFire flag); the reload starts on that pull of the trigger
        if (a.dryFire && R.flag && R.flag('dryFire')) { w.fireT = C.FIRE_INTERVAL; R.bus.emit('dryfire', { actor: a }); }
        this.reload(a);
        return false;
      }
      w.ammo--;
      w.fireT = C.FIRE_INTERVAL;
      const f = R.forward(a.yaw, a.pitch);
      const spreadDeg = this.spreadDeg(a);
      w.shotInacc = Math.min(C.SPR_MAX, (w.shotInacc || 0) + C.SPR_SHOT);
      const d = spreadDir(f, (spreadDeg * Math.PI) / 180);
      const e = this.eye(a), m = this.muzzle(a);
      R.sound('gunshot', m[0], m[1], m[2], a, { dir: f.slice() });
      const hit = R.world.raycast(e[0], e[1], e[2], d[0], d[1], d[2], C.RANGE, { ignore: a });
      if (hit) {
        if (hit.actor) {
          const head = hit.part === 'head';
          this.damage(hit.actor, Math.round(C.DMG * (head ? C.HEAD_MULT : 1)), a, hit.part, hit.x, hit.y, hit.z, 'pistol');
        } else {
          R.sound('impact', hit.x + hit.nx * 0.02, hit.y + hit.ny * 0.02, hit.z + hit.nz * 0.02, a);
        }
      }
      R.bus.emit('shot', { actor: a, ox: m[0], oy: m[1], oz: m[2], dx: d[0], dy: d[1], dz: d[2], hit });
      if (w.ammo <= 0 && !(a.dryFire && R.flag && R.flag('dryFire'))) this.reload(a);
      return hit || { miss: true };
    },

    reload(a) {
      const w = this.ensure(a);
      if (a.alive === false || w.reloadT > 0 || w.ammo >= C.MAG) return false;
      w.reloadT = C.RELOAD;
      R.sound('reload', a.x, a.y + 1.1, a.z, a);
      return true;
    },

    // ---- tongue click: forward cone from eye. returns true if emitted
    click(a) {
      const w = this.ensure(a);
      if (a.alive === false || w.clickT > 0) return false;
      w.clickT = C.CLICK_COOLDOWN;
      const e = this.eye(a);
      R.sound('click', e[0], e[1], e[2], a, { dir: R.forward(a.yaw, a.pitch) });
      return true;
    },

    // ---- sonar dart
    throwDart(a) {
      const w = this.ensure(a);
      if (a.alive === false || w.darts <= 0 || w.dartT > 0) return false;
      w.darts--;
      w.dartT = C.DART_COOLDOWN;
      const f = R.forward(a.yaw, a.pitch), e = this.eye(a);
      const dart = {
        thrower: a, x: e[0] + f[0] * 0.4, y: e[1] + f[1] * 0.4 - 0.05, z: e[2] + f[2] * 0.4,
        vx: f[0] * C.DART_SPEED, vy: f[1] * C.DART_SPEED, vz: f[2] * C.DART_SPEED,
        stuck: false, stuckActor: null, ox: 0, oy: 0, oz: 0, pings: 0, pingT: 0, age: 0,
      };
      this.darts.push(dart);
      return dart;
    },

    // ---- knife: returns the target hit, null on whiff, false if on cooldown
    knife(a) {
      const w = this.ensure(a);
      if (a.alive === false || w.knifeT > 0) return false;
      w.knifeT = C.KNIFE_COOLDOWN;
      const f = R.forward(a.yaw, 0), e = this.eye(a);
      R.sound('melee', e[0] + f[0] * 0.6, e[1] - 0.3, e[2] + f[2] * 0.6, a);
      const cosCone = Math.cos((C.KNIFE_CONE_DEG * Math.PI) / 180);
      let best = null, bestD = Infinity;
      for (const t of R.actors) {
        if (t === a || !t.alive) continue;
        const dx = t.x - a.x, dz = t.z - a.z, dist = Math.hypot(dx, dz);
        if (dist > C.KNIFE_RANGE + t.r) continue;
        if (dist > 1e-4 && (dx * f[0] + dz * f[2]) / dist < cosCone) continue;
        const ty = t.y + R.actorHeight(t) * 0.6;
        if (!R.world.los(e[0], e[1], e[2], t.x, ty, t.z, true)) continue;
        if (dist < bestD) { bestD = dist; best = t; }
      }
      if (!best) return null;
      const dx = best.x - a.x, dz = best.z - a.z, dl = Math.hypot(dx, dz) || 1;
      const tf = R.forward(best.yaw, 0);
      const back = (tf[0] * dx + tf[2] * dz) / dl > C.BACKSTAB_DOT;
      this.damage(best, back ? C.KNIFE_BACK : C.KNIFE_FRONT, a, 'body', best.x, best.y + R.actorHeight(best) * 0.6, best.z, 'knife');
      best._lastBackstab = back;
      return best;
    },

    // ---- damage: shared by everything. weapon: 'pistol'|'knife' (default pistol)
    damage(target, amount, attacker, part, x, y, z, weapon) {
      if (!target || !target.alive || amount <= 0) return 0;
      if (attacker && attacker === target) return 0; // no self-damage
      if (target === R.player && R.flag && R.flag('godMode')) return 0;
      attacker = attacker || null;
      if (x == null) { x = target.x; y = target.y + 1.2; z = target.z; }
      const dealt = Math.min(target.health, amount);
      target.health -= amount;
      R.bus.emit('damage', { target, attacker, amount, part: part || 'body', x, y, z });
      const P = R.player;
      if (P && attacker === P && target !== P) P.hitMarkerT = 0.25;
      if (P && target === P) {
        P.hurtT = 1.0;
        if (attacker) { P.hurtX = attacker.x; P.hurtZ = attacker.z; P.hurtDir = W.relAngle(P, attacker.x, attacker.z); }
      }
      const cy = target.y + R.actorHeight(target) * 0.65;
      if (target.health <= 0) {
        target.health = 0;
        target.alive = false;
        target.deaths++;
        target.respawnT = C.RESPAWN;
        target.killer = attacker;
        if (attacker) attacker.kills++;
        if (P && attacker === P && target !== P) P.killMarkerT = 0.6;
        R.sound('death', target.x, cy, target.z, target);
        R.bus.emit('kill', { victim: target, killer: attacker, weapon: weapon || 'pistol', headshot: part === 'head' });
      } else {
        R.sound('hurt', target.x, cy, target.z, target);
      }
      return dealt;
    },

    // angle of world point (x,z) relative to actor's view yaw: 0 = ahead, +PI/2 = left, -PI/2 = right, ±PI = behind
    relAngle(a, x, z) {
      const dx = x - a.x, dz = z - a.z;
      return R.util.angleWrap(Math.atan2(-dx, -dz) - a.yaw);
    },

    // ---- pickups (R.game.pickups [{x,z,kind,active,respawnT}]); returns list of kinds taken
    tryPickups(a) {
      const G = R.game;
      if (!G || !G.pickups || !a.alive) return null;
      const w = this.ensure(a);
      let took = null;
      for (const p of G.pickups) {
        if (!p.active) continue;
        if (Math.hypot(p.x - a.x, p.z - a.z) > C.PICKUP_RADIUS) continue;
        if (p.kind === 'health') {
          if (a.health >= C.HEALTH_MAX) continue;
          a.health = Math.min(C.HEALTH_MAX, a.health + C.PICKUP_HEALTH);
        } else if (p.kind === 'darts') {
          if (w.darts >= C.DART_MAX) continue;
          w.darts = Math.min(C.DART_MAX, w.darts + C.PICKUP_DARTS);
        } else continue;
        p.active = false;
        p.respawnT = C.PICKUP_RESPAWN;
        R.bus.emit('pickup', { actor: a, kind: p.kind });
        R.sound('pickup', p.x, 0.5, p.z, a);
        (took = took || []).push(p.kind);
      }
      return took;
    },

    // ---- per-frame: timers for every actor, dart flight and pings
    update(dt) {
      for (const a of R.actors) {
        const w = a.wpn;
        if (!w) continue;
        if (w.fireT > 0) w.fireT = Math.max(0, w.fireT - dt);
        if (w.shotInacc > 0) w.shotInacc = w.shotInacc < 0.01 ? 0 : w.shotInacc * Math.exp(-dt / C.SPR_RECOVER);
        if (w.knifeT > 0) w.knifeT = Math.max(0, w.knifeT - dt);
        if (w.clickT > 0) w.clickT = Math.max(0, w.clickT - dt);
        if (w.dartT > 0) w.dartT = Math.max(0, w.dartT - dt);
        if (w.reloadT > 0) {
          if (!a.alive) w.reloadT = 0;
          else { w.reloadT -= dt; if (w.reloadT <= 0) { w.reloadT = 0; w.ammo = C.MAG; } }
        }
      }
      const darts = this.darts;
      for (let i = darts.length - 1; i >= 0; i--) {
        const d = darts[i];
        d.age += dt;
        if (!d.stuck) {
          stepDart(d, dt);
          if (!d.stuck && d.age > C.DART_LIFE) { darts.splice(i, 1); continue; }
          if (d.stuck) { d.pingT = 0; }
        }
        if (d.stuck) {
          if (d.stuckActor) {
            const t = d.stuckActor;
            if (t.alive) {
              const c = Math.cos(t.yaw - d.ayaw), s = Math.sin(t.yaw - d.ayaw);
              d.x = t.x + d.ox * c + d.oz * s; d.y = t.y + d.oy; d.z = t.z - d.ox * s + d.oz * c;
            } else d.stuckActor = null;
          }
          d.pingT -= dt;
          if (d.pingT <= 0) {
            const th = d.thrower;
            const keep = th ? th.lastNoise : 0;
            R.sound('ping', d.x, d.y, d.z, th, { source: th ? (th.isBot ? 'bot' : 'player') : 'world' });
            if (th) th.lastNoise = keep; // a dart ping is not the thrower's own noise
            d.pings++;
            d.pingT += C.PING_INTERVAL;
            if (d.pings >= C.PING_COUNT) darts.splice(i, 1);
          }
        }
      }
    },
  });

  function stepDart(d, dt) {
    const n = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / n;
    for (let k = 0; k < n; k++) {
      d.vy -= C.DART_GRAVITY * h;
      const sx = d.vx * h, sy = d.vy * h, sz = d.vz * h, len = Math.hypot(sx, sy, sz);
      if (len < 1e-9) continue;
      const hit = R.world.raycast(d.x, d.y, d.z, sx, sy, sz, len, { ignore: d.thrower });
      if (hit) {
        d.x = hit.x + hit.nx * 0.03; d.y = hit.y + hit.ny * 0.03; d.z = hit.z + hit.nz * 0.03;
        d.stuck = true; d.vx = d.vy = d.vz = 0;
        d.surface = hit.surface;
        if (hit.actor) {
          const t = hit.actor;
          d.stuckActor = t; d.ayaw = t.yaw; d.ox = d.x - t.x; d.oy = d.y - t.y; d.oz = d.z - t.z;
        }
        return;
      }
      d.x += sx; d.y += sy; d.z += sz;
    }
  }

  // random direction within a cone of half-angle `ang` around unit vector f
  function spreadDir(f, ang) {
    if (ang <= 0) return f.slice();
    let ux = 0, uy = 1, uz = 0;
    if (Math.abs(f[1]) > 0.9) { ux = 1; uy = 0; }
    // a = normalize(cross(f, up)), b = cross(a, f)
    let ax = f[1] * uz - f[2] * uy, ay = f[2] * ux - f[0] * uz, az = f[0] * uy - f[1] * ux;
    const al = Math.hypot(ax, ay, az) || 1; ax /= al; ay /= al; az /= al;
    const bx = ay * f[2] - az * f[1], by = az * f[0] - ax * f[2], bz = ax * f[1] - ay * f[0];
    const r = Math.tan(ang) * Math.sqrt(Math.random()), th = Math.random() * Math.PI * 2;
    const p = r * Math.cos(th), q = r * Math.sin(th);
    const x = f[0] + ax * p + bx * q, y = f[1] + ay * p + by * q, z = f[2] + az * p + bz * q;
    const l = Math.hypot(x, y, z);
    return [x / l, y / l, z / l];
  }
  W._spreadDir = spreadDir;
})();
