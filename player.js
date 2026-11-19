// player.js — REVERB local player controller. See SPEC.md.
// R.player IS the local actor object (made with R.makeActor in init and pushed to R.actors); controller
// methods and HUD/view fields are attached to it:
//   update(dt)            call only while alive (game.js)
//   respawn(x,z,yaw)      full health, fresh actor.wpn, alive=true, emits 'spawn' (re-adds itself to R.actors if missing)
//   resetMatch()          kills/deaths = 0
//   HUD/view fields: wpn {ammo, mag, reloadT, fireT, darts, knifeT, clickT, dartT}; getters ammo, darts, reloading, lastHitMarker;
//     clickCooldown (s left), recoil (0..~1.5, decays), hurtDir (rad, 0 ahead, +left, ±PI behind; follows view), hurtT (1 -> 0),
//     hitMarkerT (0.25 -> 0), killMarkerT (0.6 -> 0), speedNorm (0..1), moveMode ('idle'|'walk'|'sprint'|'crouch'),
//     eye (smoothed camera eye height incl. crouch), bobPhase (radians, advances with stride), lastStepT.
//   allowUnlockedLook: set true (tests) to accept look/mouse buttons without pointer lock.
(function () {
  'use strict';
  const R = (window.R = window.R || {});

  const M = {
    WALK: 4.2, SPRINT: 6.8, CROUCH: 1.9, ACCEL: 30,
    STOP: 20,        // m/s^2 coasting to a stop with no keys held (momentum flag); pressing the opposite key still uses ACCEL
    AIR_ACCEL: 5,    // steering in the air
    JUMP_V: 5.2, GRAV: 16, // about 0.84 m up and 0.6 s in the air: onto a bed or a table, not over a counter
    STEP_INT: { step: 0.42, sprint: 0.30, crouch: 0.6 },
    PITCH_MAX: 1.45, STAND_H: 1.8, CROUCH_H: 1.2,
  };

  function create() {
    const a = R.makeActor({ name: 'You', isBot: false, color: '#bff' });
    Object.assign(a, {
      M,
      allowUnlockedLook: false,
      clickCooldown: 0, recoil: 0, hurtDir: 0, hurtT: 0, hurtX: null, hurtZ: null,
      hitMarkerT: 0, killMarkerT: 0, speedNorm: 0, moveMode: 'idle', bobPhase: 0, lastStepT: 0,
      crouchToggle: false, stepAcc: 0.5, respawnT: 0,
      vy: 0, air: false, dryFire: true,
      update, look, respawn, resetMatch, canStand,
    });
    Object.defineProperty(a, 'ammo', { get() { return this.wpn ? this.wpn.ammo : 0; }, enumerable: false });
    Object.defineProperty(a, 'darts', { get() { return this.wpn ? this.wpn.darts : 0; }, enumerable: false });
    Object.defineProperty(a, 'reloading', { get() { return !!(this.wpn && this.wpn.reloadT > 0); }, enumerable: false });
    Object.defineProperty(a, 'lastHitMarker', { get() { return this.hitMarkerT; }, enumerable: false });
    return a;
  }

  // R.player is replaced by init(); this placeholder keeps load-order-safe access during boot.
  R.player = { init };

  function init() {
    const prev = R.player && R.player.id ? R.player : null;
    if (prev) { const i = R.actors.indexOf(prev); if (i >= 0) R.actors.splice(i, 1); }
    const a = create();
    a.init = init;
    R.player = a;
    R.actors.push(a);
    if (R.weapons) R.weapons.ensure(a);
    return a;
  }

  function resetMatch() { this.kills = 0; this.deaths = 0; }

  function respawn(x, z, yaw) {
    const a = this;
    if (R.actors.indexOf(a) < 0) R.actors.push(a);
    a.x = x; a.z = z; a.y = 0; a.yaw = yaw || 0; a.pitch = 0; a.vx = 0; a.vz = 0;
    a.health = 100; a.alive = true; a.crouch = false; a.crouchToggle = false; a.eye = 1.62;
    a.respawnT = 0; a.killer = null;
    a.recoil = 0; a.hurtT = 0; a.hurtDir = 0; a.hurtX = a.hurtZ = null; a.hitMarkerT = 0; a.killMarkerT = 0;
    a.speedNorm = 0; a.moveMode = 'idle'; a.stepAcc = 0.5; a.clickCooldown = 0; a.vy = 0; a.air = false;
    if (R.weapons) R.weapons.resetActor(a); else a.wpn = { ammo: 12, mag: 12, reloadT: 0, fireT: 0, darts: 3, knifeT: 0, clickT: 0, dartT: 0 };
    if (R.input && R.input.takeLook) R.input.takeLook();
    R.bus.emit('spawn', { actor: a });
    return a;
  }

  // can we stand up here? (no box overlapping y 1.2..1.8 within our radius)
  function canStand() {
    const a = this, r = a.r;
    for (const b of R.world.boxes) {
      if (b.max[1] <= a.y + M.CROUCH_H || b.min[1] >= a.y + M.STAND_H) continue;
      const nx = Math.max(b.min[0], Math.min(a.x, b.max[0])), nz = Math.max(b.min[2], Math.min(a.z, b.max[2]));
      if ((a.x - nx) ** 2 + (a.z - nz) ** 2 < r * r) return false;
    }
    return true;
  }

  function lookStep(a, live) {
    const I = R.input;
    const lk = I.takeLook ? I.takeLook() : { dx: 0, dy: 0 };
    if (live) {
      const s = (R.settings && R.settings.sens) || 0.0022;
      a.yaw = R.util.angleWrap(a.yaw - lk.dx * s);
      a.pitch = R.util.clamp(a.pitch - lk.dy * s, -M.PITCH_MAX, M.PITCH_MAX);
    }
  }
  // mouse look only (the offline countdown: you can look around before you can move)
  function look() {
    const a = this, I = R.input;
    if (!a.alive || !I) return;
    lookStep(a, I.locked || a.allowUnlockedLook);
  }

  function update(dt) {
    const a = this, I = R.input, W = R.weapons;
    if (!a.alive || dt <= 0) return;
    W.ensure(a);
    const live = I.locked || a.allowUnlockedLook;

    // ---- look
    lookStep(a, live);

    // ---- crouch (C toggles, Ctrl holds); Shift cancels a toggled crouch
    if (I.pressed('KeyC')) a.crouchToggle = !a.crouchToggle;
    const shift = I.down('ShiftLeft') || I.down('ShiftRight');
    const fwdKey = I.down('KeyW') || I.down('ArrowUp');
    if (shift && fwdKey) a.crouchToggle = false;
    const wantCrouch = a.crouchToggle || I.down('ControlLeft') || I.down('ControlRight');
    if (wantCrouch) a.crouch = true;
    else if (a.crouch && a.canStand()) a.crouch = false;

    // ---- movement
    let f = 0, s = 0;
    if (fwdKey) f += 1;
    if (I.down('KeyS') || I.down('ArrowDown')) f -= 1;
    if (I.down('KeyD') || I.down('ArrowRight')) s += 1;
    if (I.down('KeyA') || I.down('ArrowLeft')) s -= 1;
    const sy = Math.sin(a.yaw), cy = Math.cos(a.yaw);
    // forward (-sin, -cos), right (cos, -sin)
    let wx = -sy * f + cy * s, wz = -cy * f - sy * s;
    const wl = Math.hypot(wx, wz);
    if (wl > 0) { wx /= wl; wz /= wl; }
    const sprinting = !a.crouch && shift && f > 0 && wl > 0 && (f / Math.hypot(f, s)) > 0.5;
    const maxSpeed = a.crouch ? M.CROUCH : sprinting ? M.SPRINT : M.WALK;
    const tx = wx * maxSpeed, tz = wz * maxSpeed;
    let dvx = tx - a.vx, dvz = tz - a.vz;
    const accel = a.air ? M.AIR_ACCEL : wl === 0 && R.flag && R.flag('momentum') ? M.STOP : M.ACCEL;
    const dvl = Math.hypot(dvx, dvz), maxDv = accel * dt;
    if (dvl > maxDv) { dvx *= maxDv / dvl; dvz *= maxDv / dvl; }
    a.vx += dvx; a.vz += dvz;
    const px = a.x, pz = a.z;
    if (a.vx || a.vz) {
      const hit = R.world.moveActor(a, a.vx * dt, a.vz * dt);
      if (hit) { a.vx = (a.x - px) / dt; a.vz = (a.z - pz) / dt; }
    }
    // ---- jump, gravity, landing (feet height a.y; 0 is the floor, furniture tops above 0.4 m can be stood on)
    const floorMult = () => R.FLOOR_MULT[R.world.floorMatAt(a.x, a.z)] || 1;
    if (live && I.pressed('Space') && !a.air && !a.crouch && R.flag && R.flag('jump')) {
      a.vy = M.JUMP_V; a.air = true;
      R.sound('step', a.x, a.y + 0.05, a.z, a, { mult: floorMult() });
    }
    const ground = R.world.groundAt(a, a.y);
    if (a.air) {
      a.vy -= M.GRAV * dt;
      let ny = a.y + a.vy * dt;
      if (a.vy > 0) {
        const c = R.world.ceilingAt(a, a.y, ny);
        if (c < Infinity) { ny = Math.max(a.y, c - R.actorHeight(a) - 0.01); a.vy = 0; }
      }
      if (ny <= ground) {
        const fall = -a.vy;
        a.y = ground; a.vy = 0; a.air = false;
        // landing: as loud as a sprinting step, louder from higher
        R.sound('sprint', a.x, a.y + 0.05, a.z, a, { mult: Math.min(2, floorMult() * (0.8 + fall * 0.06)) });
        a.lastStepT = R.time || 0; a.stepAcc = 0;
      } else a.y = ny;
    } else if (ground < a.y - 0.01) { a.air = true; a.vy = 0; } // stepped off an edge
    else a.y = ground;

    const moved = Math.hypot(a.x - px, a.z - pz);
    const speed = moved / dt;
    a.speedNorm = R.util.clamp(speed / M.SPRINT, 0, 1);
    a.moveMode = speed < 0.25 ? 'idle' : a.crouch ? 'crouch' : sprinting && speed > M.WALK * 0.9 ? 'sprint' : 'walk';

    // eye height (smoothed for the camera; gameplay uses R.weapons.eyeY)
    a.eye = R.util.approach(a.eye, a.crouch ? W.C.CROUCH_EYE : W.C.STAND_EYE, 4 * dt);

    // ---- footsteps: one per stride (nominal speed * table interval)
    if (a.moveMode === 'idle' || a.air) {
      a.stepAcc = Math.min(a.stepAcc, 0.5);
    } else {
      const kind = a.moveMode === 'sprint' ? 'sprint' : a.moveMode === 'crouch' ? 'crouch' : 'step';
      const nominal = kind === 'sprint' ? M.SPRINT : kind === 'crouch' ? M.CROUCH : M.WALK;
      const stride = nominal * M.STEP_INT[kind];
      a.stepAcc += moved / stride;
      a.bobPhase += (moved / stride) * Math.PI;
      if (a.stepAcc >= 1) {
        a.stepAcc -= Math.floor(a.stepAcc);
        const mult = R.FLOOR_MULT[R.world.floorMatAt(a.x, a.z)] || 1;
        R.sound(kind, a.x, a.y + 0.05, a.z, a, { mult });
        a.lastStepT = R.time || 0;
      }
    }

    // ---- actions
    if (I.pressed('KeyE')) W.click(a);
    if (I.pressed('KeyR')) W.reload(a);
    const mouse = I.mouse || { down: [], clicked: [] };
    // The click that starts/resumes play (menu, pause, respawn) must not fire: after any gap in
    // live updates, each mouse button has to be released once before it can act again.
    const now = R.time || 0;
    if (!live || a._lastLiveT == null || now - a._lastLiveT > 0.1) { a._armL = false; a._armR = false; }
    if (live) a._lastLiveT = now;
    if (!mouse.down[0] && !mouse.clicked[0]) a._armL = true;
    if (!mouse.down[2] && !mouse.clicked[2]) a._armR = true;
    if (live && a._armL && (mouse.down[0] || mouse.clicked[0])) {
      if (W.fire(a)) a.recoil = Math.min(1.5, a.recoil + 1);
    }
    if ((live && a._armR && mouse.clicked[2]) || I.pressed('KeyQ')) W.throwDart(a);
    if (I.pressed('KeyF') || I.pressed('KeyV')) W.knife(a);
    W.tryPickups(a);

    // ---- timers / HUD values
    a.recoil = Math.max(0, a.recoil - a.recoil * Math.min(1, 9 * dt) - 0.2 * dt);
    if (a.hurtT > 0) a.hurtT = Math.max(0, a.hurtT - dt);
    if (a.hitMarkerT > 0) a.hitMarkerT = Math.max(0, a.hitMarkerT - dt);
    if (a.killMarkerT > 0) a.killMarkerT = Math.max(0, a.killMarkerT - dt);
    if (a.hurtX != null) a.hurtDir = W.relAngle(a, a.hurtX, a.hurtZ);
    a.clickCooldown = a.wpn.clickT;
  }
})();
