// audio.js — REVERB procedural spatial audio (R.audio). See SPEC.md "audio.js".
// Every 'sound' event becomes a procedural one-shot: voice graph
//   sources -> v.in (level) -> v.lp (air absorption / occlusion lowpass) -> v.out (kill fade)
//        -> PannerNode(HRTF) -> dry bus            (or -> self bus, unpanned, for the local player's own sounds)
//        -> v.send -> shared reverb (3 procedural IR convolvers crossfaded by R.echo.roomSize)
// Safe in node: without AudioContext every handler is a no-op.
(function () {
  'use strict';
  const R = (window.R = window.R || {});

  const REF = 1.5;          // panner refDistance (m)
  const EDGE = 0.07;        // inverse-distance gain reached at the event radius
  const OCC_FREQ = 900;     // occlusion lowpass (Hz)
  const OCC_GAIN = 0.5;     // occlusion gain factor
  const DIFF_FREQ = 3200;   // lowpass for sound heard round a corner (Hz)
  const DIFF_GAIN = 0.8;    // gain factor for sound heard round a corner
  const MAX_VOICES = 32;

  // per-kind mix: level (voice gain), send (reverb), self (level multiplier when the local player made it)
  const KINDS = {
    step:    { level: 0.55, send: 0.22, self: 0.5 },
    sprint:  { level: 0.8,  send: 0.3,  self: 0.6 },
    crouch:  { level: 0.35, send: 0.12, self: 0.55 },
    click:   { level: 0.6,  send: 0.45, self: 0.65 },
    gunshot: { level: 0.95, send: 0.9,  self: 0.8 },
    impact:  { level: 0.6,  send: 0.35, self: 1 },
    reload:  { level: 0.5,  send: 0.18, self: 0.6 },
    ping:    { level: 0.45, send: 0.65, self: 0.8 },
    melee:   { level: 0.6,  send: 0.2,  self: 0.6 },
    hurt:    { level: 0.7,  send: 0.35, self: 0.7 },
    death:   { level: 0.85, send: 0.5,  self: 0.8 },
    pickup:  { level: 0.5,  send: 0.3,  self: 0.6 },
    hum:     { level: 0.35, send: 0.2,  self: 1 },
    dartThrow: { level: 0.45, send: 0.2, self: 0.7 },
    dartStick: { level: 0.6,  send: 0.4, self: 1 },
    _:       { level: 0.5,  send: 0.3,  self: 0.7 },
  };

  const A = (R.audio = {
    ctx: null, ready: false, muted: false,
    MAX_VOICES, KINDS, TRIM: 2.0,
    voices: [],
    roomSize: 6,
    listener: { x: 0, y: 1.62, z: 0 },
    stats: { played: 0, culled: 0, dropped: 0, stolen: 0, occluded: 0, cleaned: 0 },
  });

  let ctx = null, master, limiter, dry, selfBus, uiBus, revIn, revGains = [], noiseBuf = null;
  let ambient = null, hbTimer = 0, curVol = -1, curMute = null;
  const nowT = () => (ctx ? ctx.currentTime : 0);
  const rnd = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  // ---------------- init / context ----------------
  A.init = function () {
    if (A._inited) return;
    A._inited = true;
    R.bus.on('sound', onSound);
    R.bus.on('damage', onDamage);
    R.bus.on('kill', onKill);
    R.bus.on('dryfire', (e) => { if (ctx && e && e.actor === R.player) playUi(dryClick, 0); });
    if (typeof window.addEventListener === 'function') {
      const unlock = () => A.unlock();
      for (const e of ['pointerdown', 'mousedown', 'keydown', 'touchstart']) window.addEventListener(e, unlock, true);
    }
  };

  A.unlock = function () {
    try {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        A.attach(new AC({ latencyHint: 'interactive' }));
      }
      if (ctx && ctx.state === 'suspended' && ctx.resume) { const p = ctx.resume(); if (p && p.catch) p.catch(() => {}); }
    } catch (e) { console.error('[audio] unlock', e); }
  };

  // Build the whole engine on a given (Offline)AudioContext. Used by unlock() and by test harnesses.
  A.attach = function (c) {
    ctx = A.ctx = c;
    A.voices = [];
    master = c.createGain();
    master.gain.value = (R.settings && R.settings.volume != null ? R.settings.volume : 0.8);
    limiter = c.createDynamicsCompressor();
    setP(limiter.threshold, -8); setP(limiter.knee, 4); setP(limiter.ratio, 16);
    setP(limiter.attack, 0.002); setP(limiter.release, 0.18);
    // trim -> limiter -> tanh soft clip (guarantees |out| < 1 even when many gunshots stack)
    const trim = c.createGain(); trim.gain.value = A.TRIM;
    const clip = c.createWaveShaper();
    const curve = new Float32Array(2048);
    for (let i = 0; i < 2048; i++) { const x = (i / 2047) * 2 - 1; curve[i] = x < -0.7 || x > 0.7 ? Math.sign(x) * (0.7 + 0.28 * Math.tanh((Math.abs(x) - 0.7) / 0.28)) : x; }
    clip.curve = curve;
    master.connect(trim); trim.connect(limiter); limiter.connect(clip); clip.connect(c.destination);
    dry = c.createGain(); dry.connect(master);
    selfBus = c.createGain(); selfBus.connect(master);
    uiBus = c.createGain(); uiBus.gain.value = 0.7; uiBus.connect(master);
    // reverb: 3 IRs crossfaded
    revIn = c.createGain();
    const revOut = c.createGain(); revOut.gain.value = 0.55; revOut.connect(master);
    revGains = [];
    const IRS = [[0.4, 0.022, 0.9], [1.2, 0.05, 1.0], [2.6, 0.09, 1.1]]; // [seconds, early window, energy scale]
    for (let i = 0; i < 3; i++) {
      const conv = c.createConvolver();
      conv.normalize = false;
      conv.buffer = makeIR(c, IRS[i][0], IRS[i][1], IRS[i][2], i + 1);
      const g = c.createGain(); g.gain.value = i === 1 ? 1 : 0;
      revIn.connect(conv); conv.connect(g); g.connect(revOut);
      revGains.push(g);
    }
    // shared noise (2 s white, mono)
    const sr = c.sampleRate, n = Math.floor(sr * 2);
    noiseBuf = c.createBuffer(1, n, sr);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    if (!A._noAmbient) startAmbient();
    A.ready = true;
    applyRoom(true);
    return A;
  };

  function setP(p, v) { if (p) p.value = v; }

  // Procedural impulse response: early reflections + exponentially decaying stereo noise with HF damping.
  function makeIR(c, dur, early, scale, seed) {
    const sr = c.sampleRate, len = Math.max(1, Math.floor(sr * dur));
    const buf = c.createBuffer(2, len, sr);
    let energy = 0;
    const chans = [buf.getChannelData(0), buf.getChannelData(1)];
    for (let ch = 0; ch < 2; ch++) {
      const out = chans[ch];
      const tailStart = Math.floor(sr * early * 0.6);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        const envl = Math.exp((-6.9 * t) / dur);
        const fade = i < tailStart ? 0 : Math.min(1, (i - tailStart) / (sr * early + 1));
        const x = (Math.random() * 2 - 1) * envl * fade;
        const a = 0.85 * Math.exp((-2.2 * t) / dur) + 0.08; // high frequencies die faster
        lp += a * (x - lp);
        out[i] = lp;
      }
      // early reflections: discrete taps, different per ear
      const taps = 6 + seed * 3;
      for (let k = 0; k < taps; k++) {
        const tt = 0.003 + Math.random() * early;
        const i = Math.floor(tt * sr);
        if (i < len) out[i] += (Math.random() < 0.5 ? -1 : 1) * rnd(0.25, 0.7) * Math.exp(-tt / early);
      }
      for (let i = 0; i < len; i++) energy += out[i] * out[i];
    }
    const norm = Math.sqrt((scale * 2) / Math.max(1e-9, energy)) * 0.5;
    for (const out of chans) for (let i = 0; i < len; i++) out[i] *= norm;
    return buf;
  }

  function startAmbient() {
    // very quiet stereo brown-noise room tone
    const c = ctx, sr = c.sampleRate, n = Math.floor(sr * 4);
    const b = c.createBuffer(2, n, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      let last = 0;
      for (let i = 0; i < n; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.5; }
      // crossfade the loop seam
      const xf = Math.floor(sr * 0.25);
      for (let i = 0; i < xf; i++) { const w = i / xf; d[i] = d[i] * w + d[n - xf + i] * (1 - w); }
    }
    const src = c.createBufferSource(); src.buffer = b; src.loop = true;
    if (src.loopEnd !== undefined) { src.loopStart = 0.25; src.loopEnd = 4; }
    const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 28;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 240; lp.Q.value = 0.4;
    const g = c.createGain(); g.gain.value = 0.02;
    src.connect(hp); hp.connect(lp); lp.connect(g); g.connect(master);
    src.start(c.currentTime);
    ambient = { src, gain: g };
  }

  // ---------------- update (per frame, from game.js) ----------------
  A.update = function (dt) {
    dt = dt || 0;
    try {
      if (R.input && R.input.pressed && R.input.pressed('KeyM')) A.muted = !A.muted;
    } catch (e) {}
    const p = R.player;
    if (p) {
      const eye = p.crouch ? Math.min(p.eye || 1.62, 1.05) : (p.eye || 1.62);
      A.listener.x = p.x; A.listener.y = (p.y || 0) + eye; A.listener.z = p.z;
    }
    if (!ctx) return;
    const t = ctx.currentTime;
    // master volume / mute
    const vol = R.settings && R.settings.volume != null ? R.settings.volume : 0.8;
    if (vol !== curVol || A.muted !== curMute) {
      curVol = vol; curMute = A.muted;
      ramp(master.gain, A.muted ? 0 : vol, t, 0.03);
    }
    // listener
    if (p) setListener(A.listener.x, A.listener.y, A.listener.z, p.yaw || 0, p.pitch || 0);
    // room-size reverb crossfade
    const target = R.echo && isFinite(R.echo.roomSize) && R.echo.roomSize > 0 ? R.echo.roomSize : 6;
    A.roomSize += (target - A.roomSize) * (1 - Math.exp(-dt / 0.5));
    applyRoom(false);
    // heartbeat
    if (p && p.alive && p.health > 0 && p.health < 35) {
      hbTimer -= dt;
      if (hbTimer <= 0) {
        const k = clamp(p.health / 35, 0, 1);
        hbTimer = 0.55 + 0.45 * k;
        playUi(heartbeat, 0.7 + 0.5 * (1 - k));
      }
    } else hbTimer = 0;
    // safety sweep for voices whose onended never fired
    for (let i = A.voices.length - 1; i >= 0; i--) {
      const v = A.voices[i];
      if (t > v.end + 1.0) cleanup(v);
    }
  };

  function ramp(param, v, t, tc) {
    if (param.setTargetAtTime) { if (param.cancelScheduledValues) param.cancelScheduledValues(t); param.setTargetAtTime(v, t, tc); }
    else param.value = v;
  }

  function setListener(x, y, z, yaw, pitch) {
    const L = ctx.listener;
    if (!L) return;
    const f = R.forward(yaw, pitch);
    const sp = Math.sin(pitch), cp = Math.cos(pitch);
    const up = [Math.sin(yaw) * sp, cp, Math.cos(yaw) * sp];
    if (L.positionX) {
      L.positionX.value = x; L.positionY.value = y; L.positionZ.value = z;
      L.forwardX.value = f[0]; L.forwardY.value = f[1]; L.forwardZ.value = f[2];
      L.upX.value = up[0]; L.upY.value = up[1]; L.upZ.value = up[2];
    } else {
      if (L.setPosition) L.setPosition(x, y, z);
      if (L.setOrientation) L.setOrientation(f[0], f[1], f[2], up[0], up[1], up[2]);
    }
  }

  // equal-power crossfade over log2(roomSize): small 3 m, medium 8 m, large 16 m
  const RS = [Math.log2(3), Math.log2(8), Math.log2(16)];
  function roomWeights(rs) {
    const x = Math.log2(Math.max(0.5, rs));
    if (x <= RS[0]) return [1, 0, 0];
    if (x >= RS[2]) return [0, 0, 1];
    if (x < RS[1]) { const u = (x - RS[0]) / (RS[1] - RS[0]); return [Math.cos(u * Math.PI / 2), Math.sin(u * Math.PI / 2), 0]; }
    const u = (x - RS[1]) / (RS[2] - RS[1]);
    return [0, Math.cos(u * Math.PI / 2), Math.sin(u * Math.PI / 2)];
  }
  A.roomWeights = roomWeights;
  function applyRoom(immediate) {
    if (!revGains.length) return;
    const w = roomWeights(A.roomSize), t = ctx.currentTime;
    for (let i = 0; i < 3; i++) {
      if (immediate || !revGains[i].gain.setTargetAtTime) revGains[i].gain.value = w[i];
      else revGains[i].gain.setTargetAtTime(w[i], t, 0.08);
    }
  }

  // ---------------- events ----------------
  function onSound(ev) {
    if (!ctx || !A.ready || !ev) return;
    if (ctx.state && ctx.state !== 'running' && !A._offline) return; // don't queue a burst while suspended
    const kind = ev.kind;
    const spec = KINDS[kind] || KINDS._;
    const self = !!(ev.actor && R.player && ev.actor === R.player);
    const L = A.listener;
    const spatial = !self && isFinite(ev.x) && isFinite(ev.z);
    let level = spec.level * rnd(0.88, 1.06), est = level;
    let occluded = false, dist = 0, rolloff = 1, bent = false;
    let px = ev.x, py = isFinite(ev.y) ? Math.max(0.1, ev.y) : 1, pz = ev.z;
    if (spatial) {
      const ey = isFinite(ev.y) ? ev.y : 1;
      dist = Math.hypot(ev.x - L.x, ey - L.y, ev.z - L.z);
      // a directional source (gunshot) is quieter behind it: shrink its reach toward us
      const radius = (ev.radius > 0 ? ev.radius : 6) * (R.soundGain ? R.soundGain(ev, L.x, L.z) : 1);
      if (dist > radius * 1.15 + 0.5) { A.stats.culled++; return; }
      rolloff = clamp((REF * (1 / EDGE - 1)) / Math.max(0.5, radius - REF), 0.2, 25);
      occluded = isOccluded(ev.x, Math.max(0.12, ey), ev.z, L);
      if (occluded && R.flag && R.flag('diffraction') && R.world && R.world.portal) {
        // the sound bends round the corner: we hear it from the opening, at the length of the path it took
        let p = null;
        try { p = R.world.portal(ev, L.x, L.y, L.z); } catch (e) { p = null; }
        if (p && !p.direct) {
          const ox = p.x - L.x, oy = p.y - L.y, oz = p.z - L.z, ol = Math.hypot(ox, oy, oz);
          if (ol > 0.05) {
            if (p.d > radius * 1.15 + 0.5) { A.stats.culled++; return; }
            dist = p.d; bent = true; occluded = false;
            px = L.x + (ox / ol) * dist; py = L.y + (oy / ol) * dist; pz = L.z + (oz / ol) * dist;
          }
        }
      }
      const dg = REF / (REF + rolloff * (Math.max(dist, REF) - REF));
      est = level * dg * (occluded ? OCC_GAIN : bent ? DIFF_GAIN : 1);
    } else if (self) {
      level *= spec.self; est = level;
    }
    const v = newVoice(est, false);
    if (!v) return;
    v.kind = kind; v.occluded = occluded; v.self = self;
    if (occluded) A.stats.occluded++;
    const t = ctx.currentTime + 0.005;
    // routing
    v.in.gain.value = level * (occluded ? OCC_GAIN : bent ? DIFF_GAIN : 1);
    const lp = node(v, ctx.createBiquadFilter());
    lp.type = 'lowpass'; lp.Q.value = occluded ? 0.5 : 0.3;
    // bending round an edge loses highs, but far less than going through a wall
    lp.frequency.value = occluded ? OCC_FREQ : bent ? DIFF_FREQ : clamp(20000 / (1 + dist / 7), 2800, 20000);
    v.lp = lp;
    v.in.connect(lp); lp.connect(v.out);
    let send = spec.send * (occluded ? 1.6 : 1) * (self ? 0.7 : 1);
    if (spatial) {
      const pan = node(v, ctx.createPanner());
      pan.panningModel = 'HRTF'; pan.distanceModel = 'inverse';
      pan.refDistance = REF; pan.rolloffFactor = rolloff; pan.maxDistance = 10000;
      if (pan.positionX) { pan.positionX.value = px; pan.positionY.value = py; pan.positionZ.value = pz; }
      else if (pan.setPosition) pan.setPosition(px, py, pz);
      v.out.connect(pan); pan.connect(dry);
      v.panner = pan;
      // reverb falls off slower than the direct sound
      const dg = REF / (REF + rolloff * (Math.max(dist, REF) - REF));
      send *= Math.max(0.12, Math.sqrt(dg));
    } else {
      v.out.connect(self ? selfBus : dry);
    }
    const sg = node(v, ctx.createGain());
    sg.gain.value = send;
    v.out.connect(sg); sg.connect(revIn);
    v.sendGain = sg;
    const build = SFX[kind] || SFX._;
    let dur = 0.3;
    try { dur = build(v, t, ev) || 0.3; } catch (e) { console.error('[audio] sfx', kind, e); }
    finishVoice(v, t, dur);
    A.stats.played++;
  }

  function isOccluded(x, y, z, L) {
    const W = R.world;
    if (!W || typeof W.los !== 'function' || !W._cells || !W._cells.length) return false;
    // pull the test point 5 cm toward the listener so sounds on a surface aren't self-occluded
    const dx = L.x - x, dy = L.y - y, dz = L.z - z, d = Math.hypot(dx, dy, dz);
    if (d < 0.2) return false;
    const k = 0.05 / d;
    try { return !W.los(L.x, L.y, L.z, x + dx * k, y + dy * k, z + dz * k); } catch (e) { return false; }
  }

  // hits in a row (each within 0.6 s) climb in pitch; kills in a row (each within 4 s) add notes
  let comboN = 0, comboAt = -9, multiN = 0, multiAt = -9;
  const wallT = () => (typeof performance !== 'undefined' ? performance.now() / 1000 : 0);
  function onDamage(e) {
    if (!ctx || !e || !R.player) return;
    if (e.attacker === R.player && e.target !== R.player) {
      const t = wallT();
      comboN = t - comboAt < 0.6 ? comboN + 1 : 1; comboAt = t;
      playUi(hitMarker, { head: e.part === 'head', combo: comboN });
    }
  }
  function onKill(e) {
    if (!ctx || !e || !R.player) return;
    if (e.victim === R.player) playUi(youDied, 0);
    else if (e.killer === R.player) {
      const t = wallT();
      multiN = t - multiAt < 4 ? multiN + 1 : 1; multiAt = t;
      playUi(killConfirm, { head: !!e.headshot, multi: multiN });
    }
  }

  // non-spatial UI voice (stings, heartbeat): high priority
  function playUi(fn, arg) {
    if (!ctx || !A.ready) return;
    const v = newVoice(10, true);
    if (!v) return;
    v.kind = 'ui:' + (fn.name || 'sting');
    v.in.connect(v.out); v.out.connect(uiBus);
    const t = ctx.currentTime + 0.005;
    let dur = 0.3;
    try { dur = fn(v, t, arg) || 0.3; } catch (e) { console.error('[audio] ui', e); }
    finishVoice(v, t, dur);
  }

  // ---------------- voices ----------------
  function priority(v, t) {
    const age = clamp((t - v.t0) / Math.max(0.05, v.end - v.t0), 0, 1);
    return v.est * (1 - 0.8 * age);
  }
  function newVoice(est, ui) {
    const t = ctx.currentTime;
    if (A.voices.length >= MAX_VOICES) {
      let worst = null, wp = Infinity;
      for (const v of A.voices) { const p = priority(v, t); if (p < wp) { wp = p; worst = v; } }
      if (!worst || (!ui && est <= wp)) { A.stats.dropped++; return null; }
      killVoice(worst);
      A.stats.stolen++;
    }
    const v = { t0: t, end: t + 1, est, nodes: [], srcs: [], pending: 0, dead: false, ui };
    v.in = node(v, ctx.createGain());
    v.out = node(v, ctx.createGain());
    A.voices.push(v);
    return v;
  }
  function node(v, n) { v.nodes.push(n); return n; }
  function src(v, s, t, stopAt) {
    v.nodes.push(s); v.srcs.push(s); v.pending++;
    s.onended = () => { v.pending--; if (v.pending <= 0) cleanup(v); };
    s.start(t);
    s.stop(stopAt);
    return s;
  }
  function finishVoice(v, t, dur) {
    v.end = t + dur;
    if (!v.srcs.length) cleanup(v);
  }
  function killVoice(v) {
    const i = A.voices.indexOf(v);
    if (i >= 0) A.voices.splice(i, 1);
    const t = ctx.currentTime;
    try { v.out.gain.cancelScheduledValues(t); v.out.gain.setValueAtTime(v.out.gain.value, t); v.out.gain.linearRampToValueAtTime(0, t + 0.015); } catch (e) {}
    for (const s of v.srcs) { try { s.stop(t + 0.02); } catch (e) {} }
    v.killed = true;
  }
  function cleanup(v) {
    if (v.dead) return;
    v.dead = true;
    const i = A.voices.indexOf(v);
    if (i >= 0) A.voices.splice(i, 1);
    for (const s of v.srcs) { s.onended = null; try { s.stop(); } catch (e) {} }
    for (const n of v.nodes) { try { n.disconnect(); } catch (e) {} }
    v.nodes.length = 0; v.srcs.length = 0;
    A.stats.cleaned++;
  }

  // ---------------- synthesis primitives ----------------
  // envelope: silence -> peak in a -> exponential decay over d
  function env(param, t, peak, a, d) {
    param.setValueAtTime(0.0001, t);
    param.linearRampToValueAtTime(peak, t + a);
    param.exponentialRampToValueAtTime(0.0001, t + a + d);
  }
  // filtered noise burst. o: {g, a, d, type, f, f1, sw, Q, type2, f2, Q2}
  function noise(v, t, o) {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    if (o.rate) s.playbackRate.value = o.rate;
    let last = s;
    if (o.type) {
      const f = node(v, ctx.createBiquadFilter());
      f.type = o.type; f.Q.value = o.Q != null ? o.Q : 0.7;
      f.frequency.setValueAtTime(o.f, t);
      if (o.f1) f.frequency.exponentialRampToValueAtTime(o.f1, t + (o.sw || o.d));
      if (o.f2b) f.frequency.exponentialRampToValueAtTime(o.f2b, t + (o.sw || o.d) + (o.sw2 || o.d));
      last.connect(f); last = f;
    }
    if (o.type2) {
      const f = node(v, ctx.createBiquadFilter());
      f.type = o.type2; f.frequency.value = o.f2; f.Q.value = o.Q2 != null ? o.Q2 : 0.7;
      last.connect(f); last = f;
    }
    const g = node(v, ctx.createGain());
    env(g.gain, t, o.g, o.a || 0.001, o.d);
    last.connect(g); g.connect(o.to || v.in);
    const len = (o.a || 0.001) + o.d + 0.02;
    // random offset into the shared noise buffer (start(when, offset))
    v.nodes.push(s); v.srcs.push(s); v.pending++;
    s.onended = () => { v.pending--; if (v.pending <= 0) cleanup(v); };
    s.start(t, Math.random() * Math.max(0, 2 - len - 0.05));
    s.stop(t + len);
    return len;
  }
  // oscillator with pitch sweep. o: {g, a, d, type, f, f1, sw, lp, detune}
  function tone(v, t, o) {
    const s = ctx.createOscillator();
    s.type = o.type || 'sine';
    s.frequency.setValueAtTime(o.f, t);
    if (o.f1) s.frequency.exponentialRampToValueAtTime(o.f1, t + (o.sw || o.d));
    if (o.detune) s.detune.value = o.detune;
    let last = s;
    if (o.lp) {
      const f = node(v, ctx.createBiquadFilter());
      f.type = 'lowpass'; f.frequency.value = o.lp; f.Q.value = o.lpQ || 0.7;
      last.connect(f); last = f;
    }
    const g = node(v, ctx.createGain());
    env(g.gain, t, o.g, o.a || 0.002, o.d);
    last.connect(g); g.connect(o.to || v.in);
    const len = (o.a || 0.002) + o.d + 0.02;
    src(v, s, t, t + len);
    return len;
  }

  // ---------------- SFX per kind ----------------
  function footstep(v, t, ev, weight) {
    // weight: 0 crouch, 1 walk, 2 sprint
    const W = R.world;
    let mat = 0;
    try { mat = W && W.floorMatAt ? W.floorMatAt(ev.x, ev.z) : 0; } catch (e) {}
    const M = R.MAT || { FLOOR: 0, CARPET: 1, PUDDLE: 2, METAL: 3 };
    const p = rnd(0.9, 1.1), hv = weight === 2 ? 1.5 : 1;
    let len = 0;
    if (weight === 0) {
      // faint scuff
      len = noise(v, t, { g: 0.35, a: 0.025, d: 0.11, type: 'bandpass', f: 900 * p, f1: 600 * p, Q: 0.8 });
      if (mat === M.METAL) len = Math.max(len, tone(v, t + 0.01, { g: 0.04, d: 0.25, f: 1240 * p, type: 'triangle' }));
      else if (mat === M.PUDDLE) len = Math.max(len, noise(v, t + 0.01, { g: 0.18, a: 0.01, d: 0.12, type: 'bandpass', f: 1400, f1: 800, Q: 3 }));
      else if (mat === M.CARPET) v.in.gain.value *= 0.6;
      return len;
    }
    if (mat === M.CARPET) {
      len = noise(v, t, { g: 0.32 * hv, a: 0.008, d: 0.1, type: 'lowpass', f: 480 * p, Q: 0.5 });
      tone(v, t, { g: 0.32 * hv, d: 0.07, f: 85 * p, f1: 50 });
      v.in.gain.value *= 0.75;
    } else if (mat === M.PUDDLE) {
      len = noise(v, t, { g: 0.55 * hv, a: 0.004, d: 0.2 * (weight === 2 ? 1.3 : 1), type: 'bandpass', f: 1900 * p, f1: 650 * p, Q: 3.5 });
      noise(v, t, { g: 0.25 * hv, a: 0.002, d: 0.09, type: 'highpass', f: 3500 });
      tone(v, t, { g: 0.25 * hv, d: 0.06, f: 90 * p, f1: 55 });
      const drops = 2 + (Math.random() * 3) | 0;
      for (let i = 0; i < drops; i++) {
        const dt = rnd(0.04, 0.2);
        len = Math.max(len, dt + tone(v, t + dt, { g: 0.06, a: 0.001, d: 0.03, f: rnd(1800, 3400), f1: rnd(2600, 4800), sw: 0.03 }));
      }
    } else if (mat === M.METAL) {
      // clank + ringing partials of the grate
      len = noise(v, t, { g: 0.5 * hv, a: 0.0008, d: 0.035, type: 'highpass', f: 1500, type2: 'peaking', f2: 3200, Q2: 2 });
      tone(v, t, { g: 0.3 * hv, d: 0.08, f: 120 * p, f1: 70 });
      const base = 410 * p;
      const parts = [[1, 0.1, 0.42], [2.71, 0.07, 0.28], [5.4, 0.045, 0.16]];
      for (const [m, g, d] of parts) len = Math.max(len, tone(v, t, { g: g * hv, a: 0.0015, d, f: base * m, type: 'triangle' }));
      len = Math.max(len, noise(v, t, { g: 0.6 * hv, a: 0.001, d: 0.3, type: 'bandpass', f: 2300 * p, Q: 28 }));
    } else {
      // hard floor: soft thud + heel tick + toe scuff
      len = tone(v, t, { g: 0.6 * hv, a: 0.003, d: 0.09 * (weight === 2 ? 1.3 : 1), f: (weight === 2 ? 85 : 100) * p, f1: 48 });
      noise(v, t, { g: 0.32 * hv, a: 0.001, d: 0.035, type: 'bandpass', f: 2500 * p, Q: 1.2 });
      len = Math.max(len, 0.05 + noise(v, t + 0.05, { g: 0.12 * hv, a: 0.01, d: 0.06, type: 'bandpass', f: 1300 * p, Q: 0.8 }));
    }
    return len;
  }

  function impactMat(x, y, z) {
    const W = R.world;
    if (!W) return 'concrete';
    const e = 0.04;
    if (y <= e) {
      try { const m = W.floorMatAt(x, z); if (m === R.MAT.METAL) return 'metal'; if (m === R.MAT.CARPET) return 'fabric'; if (m === R.MAT.PUDDLE) return 'water'; } catch (er) {}
      return 'concrete';
    }
    if (W.ceiling && y >= W.ceiling - e) return 'plaster';
    for (const a of R.actors || []) {
      if (a.alive && Math.hypot(a.x - x, a.z - z) < a.r + 0.12 && y <= R.actorHeight(a) + 0.1) return 'flesh';
    }
    const B = W.boxes || [];
    for (let i = 0; i < B.length; i++) {
      const b = B[i];
      if (x >= b.min[0] - e && x <= b.max[0] + e && y >= b.min[1] - e && y <= b.max[1] + e && z >= b.min[2] - e && z <= b.max[2] + e) return b.mat;
    }
    return 'concrete';
  }

  const SFX = {
    step: (v, t, ev) => footstep(v, t, ev, 1),
    sprint: (v, t, ev) => footstep(v, t, ev, 2),
    crouch: (v, t, ev) => footstep(v, t, ev, 0),
    click(v, t) {
      // sharp tongue click: wet filtered snap + 2-3 kHz resonant blip + tiny low pop
      const f = rnd(2200, 2900);
      noise(v, t, { g: 0.9, a: 0.0005, d: 0.012, type: 'bandpass', f, Q: 6 });
      tone(v, t, { g: 0.35, a: 0.0008, d: 0.03, f: f * 1.05, f1: f * 0.82, sw: 0.03 });
      tone(v, t, { g: 0.25, a: 0.0008, d: 0.015, f: 420, f1: 260 });
      return 0.06;
    },
    gunshot(v, t) {
      const p = rnd(0.94, 1.06);
      noise(v, t, { g: 1.0, a: 0.0004, d: 0.055, type: 'highpass', f: 1300 * p });         // crack
      noise(v, t, { g: 0.6, a: 0.001, d: 0.16, type: 'bandpass', f: 650 * p, Q: 0.8 });     // body
      tone(v, t, { g: 0.95, a: 0.001, d: 0.22, f: 155 * p, f1: 42, sw: 0.18 });            // thump
      noise(v, t + 0.01, { g: 0.12, a: 0.02, d: 0.7, type: 'lowpass', f: 2200, f1: 260 });  // rolling tail
      noise(v, t + 0.07, { g: 0.08, a: 0.0005, d: 0.012, type: 'bandpass', f: 4200, Q: 3 }); // slide
      return 0.75;
    },
    impact(v, t, ev) {
      const m = impactMat(ev.x, ev.y, ev.z);
      v.mat = m;
      const p = rnd(0.9, 1.1);
      if (m === 'metal') {
        noise(v, t, { g: 0.6, a: 0.0005, d: 0.02, type: 'highpass', f: 2500 });
        tone(v, t, { g: 0.12, a: 0.001, d: 0.35, f: 1850 * p, type: 'triangle' });
        tone(v, t, { g: 0.07, a: 0.001, d: 0.22, f: 2960 * p });
        return 0.4;
      }
      if (m === 'glass') {
        noise(v, t, { g: 0.5, a: 0.0005, d: 0.04, type: 'highpass', f: 4500 });
        for (let i = 0; i < 4; i++) tone(v, t + rnd(0, 0.08), { g: 0.06, a: 0.001, d: rnd(0.08, 0.2), f: rnd(3000, 6500) });
        return 0.32;
      }
      if (m === 'wood') {
        noise(v, t, { g: 0.7, a: 0.0006, d: 0.06, type: 'bandpass', f: 750 * p, Q: 3 });
        tone(v, t, { g: 0.3, a: 0.001, d: 0.06, f: 230 * p, f1: 160 });
        return 0.1;
      }
      if (m === 'fabric') {
        noise(v, t, { g: 0.5, a: 0.002, d: 0.06, type: 'lowpass', f: 450 });
        return 0.09;
      }
      if (m === 'flesh') {
        noise(v, t, { g: 0.55, a: 0.002, d: 0.07, type: 'lowpass', f: 380, Q: 1.5 });
        tone(v, t, { g: 0.4, a: 0.002, d: 0.08, f: 95, f1: 55 });
        return 0.11;
      }
      if (m === 'water') {
        noise(v, t, { g: 0.6, a: 0.002, d: 0.15, type: 'bandpass', f: 2000, f1: 700, Q: 3 });
        return 0.17;
      }
      // concrete / plaster / floor: gritty thud, sometimes a ricochet whine
      noise(v, t, { g: 0.6, a: 0.0005, d: 0.05, type: 'bandpass', f: 1800 * p, Q: 1.4 });
      tone(v, t, { g: 0.3, a: 0.001, d: 0.05, f: 180 * p, f1: 90 });
      if (Math.random() < 0.3) { tone(v, t + 0.01, { g: 0.07, a: 0.004, d: 0.28, f: rnd(2800, 3600), f1: rnd(1500, 2000), sw: 0.3 }); return 0.33; }
      return 0.08;
    },
    reload(v, t) {
      // mag out click ... mag in / slide click
      noise(v, t + 0.1, { g: 0.6, a: 0.0005, d: 0.018, type: 'bandpass', f: 3200, Q: 4 });
      tone(v, t + 0.1, { g: 0.2, a: 0.0006, d: 0.025, f: 1250, f1: 1000 });
      noise(v, t + 0.35, { g: 0.08, a: 0.04, d: 0.12, type: 'bandpass', f: 1800, Q: 1 }); // mag slide
      noise(v, t + 1.15, { g: 0.7, a: 0.0005, d: 0.022, type: 'bandpass', f: 2100, Q: 3 });
      tone(v, t + 1.15, { g: 0.3, a: 0.0006, d: 0.04, f: 320, f1: 200 });
      return 1.25;
    },
    ping(v, t) {
      // clean sonar ping with pitch drop + two echoes
      let len = 0;
      const echoes = [[0, 1], [0.19, 0.32], [0.38, 0.12]];
      for (const [dt, g] of echoes) {
        len = Math.max(len, dt + tone(v, t + dt, { g: 0.55 * g, a: 0.004, d: 0.5, f: 1400, f1: 1180, sw: 0.45 }));
        tone(v, t + dt, { g: 0.06 * g, a: 0.004, d: 0.25, f: 2800, f1: 2360, sw: 0.25 });
      }
      return len;
    },
    dartThrow(v, t) {
      // wrist flick: a quick airy whoosh rising in pitch, with a soft release tick
      noise(v, t, { g: 0.5, a: 0.015, d: 0.11, type: 'bandpass', f: 900, f1: 4200, sw: 0.1, Q: 3 });
      noise(v, t, { g: 0.25, a: 0.0005, d: 0.01, type: 'bandpass', f: 2600, Q: 4 });
      return 0.16;
    },
    dartStick(v, t) {
      // the tip biting in (sharp tick + small thud), then the sonar head arming: a rising two-note chirp
      const p = rnd(0.92, 1.08);
      noise(v, t, { g: 0.8, a: 0.0004, d: 0.014, type: 'bandpass', f: 3400 * p, Q: 3 });
      tone(v, t, { g: 0.35, a: 0.001, d: 0.06, f: 260 * p, f1: 140 });
      tone(v, t + 0.07, { g: 0.13, a: 0.004, d: 0.07, f: 1180, f1: 1260, sw: 0.06 });
      tone(v, t + 0.15, { g: 0.13, a: 0.004, d: 0.1, f: 1400, f1: 1480, sw: 0.08 });
      return 0.28;
    },
    melee(v, t) {
      // swish: bandpass noise sweeping up then down
      noise(v, t, { g: 0.6, a: 0.07, d: 0.14, type: 'bandpass', f: 500, f1: 3200, sw: 0.08, f2b: 900, sw2: 0.12, Q: 2.2 });
      return 0.24;
    },
    hurt(v, t) {
      // grunt-ish: formant-filtered noise + buzzy low voice + body thump
      const p = rnd(0.85, 1.15);
      noise(v, t, { g: 0.5, a: 0.02, d: 0.2, type: 'bandpass', f: 560 * p, f1: 430 * p, Q: 4 });
      noise(v, t, { g: 0.25, a: 0.02, d: 0.16, type: 'bandpass', f: 1150 * p, f1: 900 * p, Q: 5 });
      tone(v, t, { g: 0.22, a: 0.015, d: 0.18, type: 'sawtooth', f: 125 * p, f1: 88 * p, lp: 700 });
      tone(v, t, { g: 0.5, a: 0.002, d: 0.13, f: 75, f1: 40 });
      return 0.24;
    },
    death(v, t) {
      tone(v, t, { g: 0.85, a: 0.002, d: 0.4, f: 80, f1: 34 });
      noise(v, t, { g: 0.4, a: 0.003, d: 0.25, type: 'lowpass', f: 320 });
      tone(v, t + 0.05, { g: 0.16, a: 0.05, d: 0.95, type: 'triangle', f: 440, f1: 105, sw: 0.95 });
      tone(v, t + 0.05, { g: 0.1, a: 0.05, d: 0.95, type: 'triangle', f: 443, f1: 104, sw: 0.95 });
      tone(v, t + 0.38, { g: 0.55, a: 0.002, d: 0.25, f: 70, f1: 36 }); // body hits the floor
      noise(v, t + 0.38, { g: 0.25, a: 0.003, d: 0.15, type: 'lowpass', f: 400 });
      return 1.05;
    },
    pickup(v, t) {
      const notes = [[0, 1046.5], [0.07, 1568], [0.14, 2093]];
      for (const [dt, f] of notes) tone(v, t + dt, { g: 0.22, a: 0.005, d: 0.55, f });
      return 0.72;
    },
    hum(v, t) {
      // very soft beating 55/110 Hz hum
      tone(v, t, { g: 0.3, a: 0.3, d: 1.1, f: 55 });
      tone(v, t, { g: 0.22, a: 0.3, d: 1.1, f: 110 });
      tone(v, t, { g: 0.18, a: 0.3, d: 1.1, f: 110.8 });
      tone(v, t, { g: 0.05, a: 0.3, d: 0.9, f: 220.5 });
      return 1.42;
    },
    _(v, t) {
      noise(v, t, { g: 0.4, a: 0.002, d: 0.08, type: 'bandpass', f: 1000, Q: 1 });
      return 0.1;
    },
  };
  A._sfx = SFX;

  // ---------------- UI stings ----------------
  function hitMarker(v, t, o) {
    o = typeof o === 'object' && o ? o : { head: !!o, combo: 1 };
    const up = Math.pow(2, Math.min(4, (o.combo || 1) - 1) / 12); // a semitone higher per hit in a row
    // crisp tick + a meaty low thock underneath, so it lands in the chest as well as the ears
    tone(v, t, { g: 0.34, a: 0.0006, d: 0.04, f: (o.head ? 4200 : 3300) * up, type: 'triangle' });
    noise(v, t, { g: 0.3, a: 0.0004, d: 0.014, type: 'highpass', f: 5000 });
    tone(v, t, { g: 0.42, a: 0.0008, d: 0.07, f: 190 * up, f1: 95 });
    noise(v, t, { g: 0.22, a: 0.0006, d: 0.03, type: 'bandpass', f: 1300, Q: 2 });
    if (o.head) {
      // headshot: a bright little bell on top
      tone(v, t + 0.03, { g: 0.24, a: 0.0006, d: 0.22, f: 5600, type: 'sine' });
      tone(v, t + 0.03, { g: 0.08, a: 0.0006, d: 0.16, f: 8400, type: 'sine' });
      return 0.28;
    }
    return 0.12;
  }
  function killConfirm(v, t, o) {
    o = typeof o === 'object' && o ? o : { head: !!o, multi: 1 };
    tone(v, t, { g: 0.5, a: 0.002, d: 0.16, f: 120, f1: 50 });                  // body blow
    noise(v, t, { g: 0.25, a: 0.001, d: 0.06, type: 'lowpass', f: 900 });
    tone(v, t, { g: 0.22, a: 0.004, d: 0.22, f: 880, type: 'triangle' });
    tone(v, t + 0.08, { g: 0.22, a: 0.004, d: 0.35, f: 1318.5, type: 'triangle' });
    let end = 0.6;
    if (o.head) { tone(v, t + 0.16, { g: 0.16, a: 0.004, d: 0.45, f: 1760, type: 'sine' }); end = 0.65; }
    // kills in a row: climb a major arpeggio past the usual two notes
    const steps = [1760, 2217.5, 2637, 3520];
    for (let i = 0; i < Math.min(steps.length, (o.multi || 1) - 1); i++) {
      const at = 0.16 + (o.head ? 0.08 : 0) + i * 0.08;
      tone(v, t + at, { g: 0.15, a: 0.004, d: 0.4, f: steps[i], type: 'triangle' });
      end = Math.max(end, at + 0.45);
    }
    return end;
  }
  function youDied(v, t) {
    tone(v, t, { g: 0.7, a: 0.003, d: 0.6, f: 70, f1: 30 });
    tone(v, t + 0.02, { g: 0.2, a: 0.08, d: 1.4, type: 'sawtooth', f: 220, f1: 55, sw: 1.4, lp: 600 });
    tone(v, t + 0.02, { g: 0.14, a: 0.08, d: 1.4, type: 'sawtooth', f: 207.6, f1: 52, sw: 1.4, lp: 500 });
    return 1.5;
  }
  function heartbeat(v, t, g) {
    tone(v, t, { g: 0.32 * g, a: 0.006, d: 0.12, f: 62, f1: 42 });
    tone(v, t + 0.17, { g: 0.22 * g, a: 0.006, d: 0.14, f: 56, f1: 38 });
    return 0.35;
  }
  // match countdown: a short blip on 3, 2, 1 and a brighter two-tone at GO
  function countTick(v, t) {
    tone(v, t, { g: 0.28, a: 0.002, d: 0.12, f: 880, type: 'triangle' });
    return 0.16;
  }
  function countGo(v, t) {
    tone(v, t, { g: 0.3, a: 0.002, d: 0.35, f: 1760, type: 'triangle' });
    tone(v, t, { g: 0.14, a: 0.002, d: 0.35, f: 2637, type: 'sine' });
    tone(v, t, { g: 0.35, a: 0.002, d: 0.15, f: 110, f1: 55 });
    return 0.4;
  }
  A.countdown = (go) => playUi(go ? countGo : countTick, 0);
  A._ui = { hitMarker, killConfirm, youDied, heartbeat, countTick, countGo };
  // empty gun: a small dry hammer click, only in your own ears
  function dryClick(v, t) {
    noise(v, t, { g: 0.4, a: 0.0003, d: 0.012, type: 'highpass', f: 3500 });
    tone(v, t, { g: 0.1, a: 0.0004, d: 0.018, f: 1900, type: 'square' });
    noise(v, t + 0.028, { g: 0.16, a: 0.0003, d: 0.008, type: 'bandpass', f: 2400, Q: 2 });
  }

  A._playUi = playUi;
  A._impactMat = impactMat;
})();
