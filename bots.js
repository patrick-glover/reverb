// bots.js — REVERB bots (R.bots). See SPEC.md "bots.js".
// Bots have no eyes beyond what a player has. Everything they know about other actors comes from:
//   - 'sound' events they can hear (walking distance <= radius, less behind a gun), read ONLY at emission time,
//     turned into a noisy estimate. Out of sight, a sound is placed at the doorway or corner it came round, like
//     a human ear does. sound.actor is used only as an identity key to group sounds per contact. A click or
//     gunshot heard directly also tells them which way the source was facing.
//   - echo dots that land on bodies (R.echo.actorHits), from anyone's sound, when the dot is in front of the bot
//     and in its line of sight: the same dots a player sees. Their own clicks and dart pings are also scanned
//     directly for an instant read.
//   - 'shot' events that hit them: the shot origin gives a (noisy) bearing, like the player's damage arc.
// They never read another actor's live x/z.
(function () {
  'use strict';
  const R = (window.R = window.R || {});

  const SPEED = { walk: 4.2, sprint: 6.8, crouch: 1.9 };
  const STEP_INT = { walk: 0.42, sprint: 0.30, crouch: 0.6 };
  const STEP_KIND = { walk: 'step', sprint: 'sprint', crouch: 'crouch' };
  const ACCEL = 30, STAND_EYE = 1.62, CROUCH_EYE = 1.05, FIRE_INTERVAL = 0.26;
  const DART_V = 22, DART_G = 6;
  const DEG = Math.PI / 180;

  const NAMES = ['Vesper', 'Moth', 'Hollow', 'Static', 'Wren', 'Cinder', 'Gauge', 'Lark', 'Mute', 'Sable'];
  const COLORS = ['#ff5a3c', '#ffb43c', '#ff3c8c', '#c46bff', '#ff8a5a', '#e8e04a', '#ff6f6f', '#ffa0d0', '#d07a3c', '#b0ff5a'];

  // Personalities tweak thresholds. All distances in m, times in s.
  const PERS = {
    aggressive: {
      engageRange: 20, crouchDist: 5, sprintFar: 16, relocateP: 0.3, memory: 9, holdT: 0.8,
      clickEvery: 7, dartEvery: 16, hpSeek: 30, roamCrouchP: 0.1, burst: [3, 4], crouchShoot: false,
      knifeHunt: false, reloadAt: 3, aimMult: 1.1, investRange: 26, fleeHp: 35, pingCurious: true, burstPause: [0.35, 0.7], strafe: 2.4,
      w: { sneak: 0.45, hold: 0.9, hunt: 1.1, health: 0.9 },
    },
    cautious: {
      engageRange: 16, crouchDist: 10, sprintFar: 99, relocateP: 0.8, memory: 12, holdT: 3.0,
      clickEvery: 10, dartEvery: 11, hpSeek: 60, roamCrouchP: 0.3, burst: [2, 3], crouchShoot: true,
      knifeHunt: false, reloadAt: 5, aimMult: 0.95, investRange: 12, fleeHp: 70, pingCurious: false, burstPause: [0.6, 1.1], strafe: 1.7,
      w: { sneak: 0.6, hold: 1.1, hunt: 0.95, health: 1.1 },
    },
    sneaky: {
      engageRange: 14, crouchDist: 12, sprintFar: 99, relocateP: 0.7, memory: 12, holdT: 2.0,
      clickEvery: 14, dartEvery: 9, hpSeek: 45, roamCrouchP: 0.55, burst: [2, 3], crouchShoot: true,
      knifeHunt: true, reloadAt: 4, aimMult: 1.0, investRange: 18, fleeHp: 40, pingCurious: false, burstPause: [0.5, 1.0], strafe: 1.5,
      w: { sneak: 1.15 },
    },
  };
  const PERS_ORDER = ['aggressive', 'cautious', 'sneaky', 'aggressive', 'sneaky', 'cautious'];

  // localization quality multiplier per sound kind (lower = easier to pinpoint)
  const KIND_LOC = {
    gunshot: 0.5, death: 0.8, hurt: 0.75, click: 0.8, sprint: 0.8, step: 1.0, crouch: 0.6,
    reload: 0.7, melee: 0.5, pickup: 0.9, impact: 1.0, ping: 0.6,
  };

  const T = (R.bots = {
    skill: 0.5,
    PERS,
    NAMES,              // the room server keeps humans from taking these
    // global tuning knobs
    tune: {
      hearErr: 1.0,        // multiplier on hearing localisation error
      aimErr: 1.0,         // multiplier on aim error (deg)
      reactMult: 1.0,      // multiplier on reaction delay
      clickRays: 1.0,      // multiplier on rays bots get from their own click
      curiosity: 0.6,      // multiplier on how far away a noise still gets investigated
      fireConf: 1.1,       // max estimate error (m, 1 sigma) a bot will shoot at; repeated sounds sharpen estimates
      pauseP: 0.9,         // chance to stop and listen at each roam waypoint
      pauseLen: 4.5,       // multiplier on listening pause length (base 1-3 s at waypoints, 1.5-4 s mid-walk)
      roamClick: 1.5,      // multiplier on the interval between idle (non-hunting) probe clicks
      flee: 1.2,           // multiplier on the health threshold under which hit bots break off
      listenEvery: 2.0,    // mean seconds of roaming between mid-walk listening stops (0 = never)
      // => the biggest lever on lobby kill rate is how much bots move: raise pauseLen / lower listenEvery for slower matches
    },
    stats: null,
    _inited: false,
    _timeAcc: 0, _timeN: 0,

    init() {
      if (this._inited) return;
      this._inited = true;
      R.bus.on('sound', onSound);
      R.bus.on('shot', onShot);
      R.bus.on('kill', onKill);
      R.bus.on('spawn', (e) => { if (e && e.actor && e.actor.brain && !e.actor._brainFresh) T.onRespawn(e.actor); if (e && e.actor) e.actor._brainFresh = false; });
      this.resetStats();
    },

    resetStats() {
      this.stats = {
        shots: 0, hits: 0, heads: 0, kills: 0, knifeKills: 0, darts: 0, clicks: 0, lives: 0,
        heardSum: 0, heardN: 0, shotSum: 0, shotN: 0, sights: 0,
      };
    },

    list() { return R.actors.filter((a) => a.brain); },

    // create n bot actors (positions are set by game.js via respawn)
    spawnAll(n) {
      if (!this._inited) this.init();
      for (let i = R.actors.length - 1; i >= 0; i--) if (R.actors[i].brain) R.actors.splice(i, 1);
      const names = NAMES.slice().sort(() => Math.random() - 0.5);
      const out = [];
      for (let i = 0; i < n; i++) out.push(makeBot(i, names[i % names.length]));
      return out;
    },

    // add one bot mid-match (multiplayer bot fill); game.js spawns it. Picks a name and colour not in use.
    addOne() {
      if (!this._inited) this.init();
      const used = new Set(R.actors.map((a) => a.name));
      const i = R.actors.filter((a) => a.brain).length;
      const name = NAMES.find((nm) => !used.has(nm)) || 'Bot' + (i + 1);
      return makeBot(i, name);
    },

    // called by game.js after it positions/heals the bot
    onRespawn(b) {
      if (!b || !b.brain) return;
      b.brain = newBrain(b.brain.persName);
      b._brainFresh = true; // the following 'spawn' event shouldn't reset again
      b.vx = b.vz = 0; b.crouch = false; b.pitch = 0; b.moveMode = 'idle';
      if (this.stats) this.stats.lives++;
    },

    update(dt) {
      if (!R.world || !R.world.navW) return;
      const t0 = now();
      const time = R.time || 0;
      processSight();
      for (const b of R.actors) if (b.brain && b.alive) tickBot(b, dt, time);
      this._timeAcc += now() - t0; this._timeN++;
    },

    // short debug string for HUD/console
    describe(b) {
      const br = b && b.brain;
      if (!br) return '';
      const sc = br.scores ? Object.keys(br.scores).filter((k) => br.scores[k] > 0).map((k) => k + ' ' + br.scores[k].toFixed(2)).join(', ') : '';
      return b.name + ' [' + br.persName + '] ' + br.state + ' contacts:' + br.contacts.size + (sc ? ' (' + sc + ')' : '');
    },
  });

  function makeBot(i, name) {
    const persName = PERS_ORDER[i % PERS_ORDER.length];
    const b = R.makeActor({ name, isBot: true, color: COLORS[i % COLORS.length] });
    b.persona = persName;
    b.brain = newBrain(persName);
    b.moveMode = 'idle';
    if (R.weapons && R.weapons.ensure) R.weapons.ensure(b);
    else b.wpn = { ammo: 12, mag: 12, reloadT: 0, fireT: 0, darts: 3, knifeT: 0, clickT: 0, dartT: 0 };
    R.actors.push(b);
    return b;
  }

  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  const sk = () => R.util.clamp(T.skill == null ? 0.5 : T.skill, 0, 1);
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  const gauss = () => { let u = 0, v = 0; while (u === 0) u = Math.random(); v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const hyp = Math.hypot;
  const eyeY = (b) => (b.crouch ? CROUCH_EYE : STAND_EYE);
  const yawTo = (dx, dz) => Math.atan2(-dx, -dz);

  function newBrain(persName) {
    const t = R.time || 0;
    return {
      persName, pers: PERS[persName], state: 'roam', scores: null, sneakId: -1,
      cover: null, coverT: -99, peekUntil: 0, peekNext: 0, strafeSign: 1, strafeFlipT: 0, strafeX: 0, strafeZ: 0,
      contacts: new Map(), interests: [],
      goal: null, field: null, fieldGoal: null, fieldT: -99, legMode: 'walk', pauseUntil: 0,
      engagedId: -1, lastEngageT: -99, reactAt: 0, burstLeft: 0, nextShotT: 0, aimOff: [0, 0],
      relocateUntil: 0, relocateMinT: 0, relocGoal: null,
      pending: null, // {type:'dart'|'click', yaw, pitch, until}
      stepT: 0.2, nextClickT: t + rand(3, 8), nextDartT: t + rand(5, 12),
      stuckT: 0, stuckX: 0, stuckZ: 0, stuck: 0, sideUntil: 0, sideX: 0, sideZ: 0,
      hurtYaw: null, hurtT: -99, exposedT: -99, humHint: null,
      scanYaw: null, scanT: 0,
      lastShots: {}, // contact id -> time of last gunshot heard (to notice other people's fights)
      lifeStart: t, firstHeard: false, firstShot: false,
    };
  }

  // ======================= senses =======================
  function onSound(s) {
    if (!R.world || !R.world.navW) return;
    // own click / own dart ping: "see" the echo dots
    if (s.actor && s.actor.brain && s.actor.alive) {
      if (s.kind === 'click') echoScan(s.actor, s, true);
      else if (s.kind === 'ping') echoScan(s.actor, s, false);
    }
    for (const b of R.actors) {
      if (!b.brain || !b.alive || b === s.actor) continue;
      const e = hyp(s.x - b.x, s.z - b.z);
      const reach = s.radius * R.soundGain(s, b.x, b.z); // quieter behind a gun
      if (e > reach) continue;
      const d = R.world.fieldAt(R.world.soundField(s), b.x, b.z);
      if (!(d <= reach)) continue;
      hear(b, s, d, e);
    }
  }

  function hear(b, s, d, e) {
    const br = b.brain, t = R.time || 0, kind = s.kind;
    if (kind === 'hum') { br.humHint = { x: s.x, z: s.z, t }; return; }
    // occluded sounds (came around corners) are harder to place
    const occl = d > e * 1.25 + 0.75;
    const sig = (KIND_LOC[kind] || 1) * lerp(1.35, 0.65, sk()) * T.tune.hearErr *
      (0.12 + 0.07 * d + 1.1 * (d / s.radius)) * (occl ? 1.5 : 1);
    let cx = s.x, cz = s.z, sg = sig;
    if (occl && R.flag && R.flag('diffraction')) {
      // heard round a corner: it seems to come from the opening, a little beyond it
      const p = R.world.portal(s, b.x, eyeY(b), b.z);
      if (p && !p.direct) {
        const ox = p.x - b.x, oz = p.z - b.z, ol = hyp(ox, oz) || 1, past = Math.min(2, Math.max(0, d - ol));
        cx = p.x + (ox / ol) * past; cz = p.z + (oz / ol) * past;
        sg = Math.max(sig, 1.25); // never sharp enough to shoot at
      }
    }
    const ex = cx + gauss() * sg, ez = cz + gauss() * sg;
    if (kind === 'ping') {
      // a dart landed there: the thrower is elsewhere and is about to see that area
      br.interests.push({ x: ex, z: ez, t, kind });
      if (e < 7) br.exposedT = t;
      return;
    }
    if (kind === 'impact') {
      if (e < 3) br.exposedT = t; // being shot at
      br.interests.push({ x: ex, z: ez, t, kind });
      return;
    }
    if (kind === 'death') {
      if (s.actor) br.contacts.delete(s.actor.id);
      br.interests.push({ x: ex, z: ez, t, kind }); // a killer is near there
      return;
    }
    if (!s.actor) { br.interests.push({ x: ex, z: ez, t, kind }); return; }
    if (kind === 'pickup' && s.actor === b) return;
    // chest height from what the sound says about stance
    let chest = 1.15;
    if (kind === 'crouch') chest = 0.7;
    else if ((kind === 'gunshot' || kind === 'click') && s.y > 0.3) chest = R.util.clamp(s.y - 0.45, 0.55, 1.25);
    const c = addContact(b, s.actor.id, ex, ez, chest, sg, kind, t);
    // a click or gunshot heard directly gives away which way they face
    if (!occl && s.dir && (kind === 'click' || kind === 'gunshot')) { c.fyaw = yawTo(s.dir[0], s.dir[2]); c.fyawT = t; }
    if (!br.firstHeard) { br.firstHeard = true; T.stats.heardSum += t - br.lifeStart; T.stats.heardN++; }
  }

  function addContact(b, id, x, z, chest, sig, kind, t) {
    const br = b.brain;
    let c = br.contacts.get(id);
    const keenRoll = () => kind === 'echo' || Math.random() < R.util.clamp(1.3 - hyp(x - b.x, z - b.z) / (br.pers.investRange * T.tune.curiosity * (kind === 'gunshot' ? 1.6 : 1)), 0, 1);
    if (!c) {
      // not every distant noise is worth chasing: roll once per new contact (closer = more likely)
      c = { id, x, z, chest, sig, t, kind, armed: false, searched: false, keen: keenRoll(), rollT: t, n: 0 };
      br.contacts.set(id, c);
    } else {
      // fuse with the previous estimate (older info decays: people move ~2 m/s)
      const age = t - c.t, so = c.sig + age * 2.2;
      // a sharp new fix well away from a recent one: they're moving that way, and probably facing it
      const mv = hyp(x - c.x, z - c.z);
      if (age < 2.5 && sig < 0.9 && c.sig < 0.9 && mv > 1.0 + sig + c.sig) { c.myaw = yawTo(x - c.x, z - c.z); c.myawT = t; }
      const wo = 1 / (so * so), wn = 1 / (sig * sig), ws = wo + wn;
      c.x = (c.x * wo + x * wn) / ws; c.z = (c.z * wo + z * wn) / ws;
      c.sig = Math.sqrt(1 / ws);
      if (!c.keen && t - c.rollT > 6) { c.keen = keenRoll(); c.rollT = t; }
      else if (!c.keen && kind === 'echo') c.keen = true;
      c.searched = false;
      c.chest = chest; c.t = t; c.kind = kind;
    }
    c.n++;
    if (kind === 'gunshot') { c.armed = true; c.shotT = t; br.lastShots[id] = t; }
    if (kind === 'reload') c.reloadT = t;
    return c;
  }

  // cast rays like echo.js would; any ray landing on an actor = a dot we "see"
  function echoScan(b, s, isClick) {
    const t = R.time || 0, found = new Map();
    const W = R.world;
    if (isClick) {
      const n = Math.round(lerp(60, 140, sk()) * T.tune.clickRays);
      const dir = s.dir || R.forward(b.yaw, b.pitch), half = ((s.cone || 75) / 2) * DEG;
      for (let i = 0; i < n; i++) {
        const d = coneDir(dir, half);
        const h = W.raycast(s.x, s.y, s.z, d[0], d[1], d[2], s.radius, { ignore: b });
        if (h && h.actor && !found.has(h.actor.id)) found.set(h.actor.id, h);
      }
      T.stats.clicks++;
    } else {
      const n = 90, ex = b.x, ey = eyeY(b), ez = b.z;
      const rot = Math.random() * Math.PI * 2, cr = Math.cos(rot), sr = Math.sin(rot);
      for (let i = 0; i < n; i++) {
        const f = R.util.fib(i, n), dx = f[0] * cr - f[2] * sr, dz = f[0] * sr + f[2] * cr;
        const h = W.raycast(s.x, s.y, s.z, dx, f[1], dz, s.radius, { ignore: null });
        if (!h || !h.actor || h.actor === b || found.has(h.actor.id)) continue;
        // we must be able to see that dot from where we stand
        if (W.los(ex, ey, ez, h.x + h.nx * 0.05, h.y, h.z + h.nz * 0.05, true)) found.set(h.actor.id, h);
      }
    }
    for (const [id, h] of found) {
      if (h.actor === b) continue;
      // aim at the torso: a dot on a leg means the chest is higher up
      const chest = h.part === 'head' ? h.y - 0.45 : R.util.clamp(h.part === 'leg' ? h.y + 0.45 : h.y, 0.55, 1.25);
      const c = addContact(b, id, h.x - h.nx * 0.25 + gauss() * 0.1, h.z - h.nz * 0.25 + gauss() * 0.1, chest, 0.15, 'echo', t);
      c.sig = 0.15;
    }
  }

  // ---- sight: the same echo dots on bodies a player would see. A dot counts once it has appeared, if it's within
  // range, inside a ~130 degree view cone and in line of sight from the bot's eye.
  const SIGHT_RANGE = 30, SIGHT_HALF = 65 * DEG;
  function processSight() {
    const E = R.echo;
    if (!E || !E.actorHits || !R.world || !R.world.los) return;
    const H = E.actorHits, nowE = E.time, on = !R.flag || R.flag('botSight');
    let k = 0;
    for (let i = 0; i < H.length; i++) {
      const h = H[i];
      if (h.born > nowE) { H[k++] = h; continue; }
      if (!on || nowE - h.born > 0.6 || !h.actor || !h.actor.alive) continue;
      for (const b of R.actors) if (b.brain && b.alive && b !== h.actor) seeDot(b, h);
    }
    H.length = k;
  }
  function seeDot(b, h) {
    const ey = eyeY(b), dx = h.x - b.x, dz = h.z - b.z, D = hyp(dx, dz);
    if (D > SIGHT_RANGE || D < 0.3) return;
    if (Math.abs(R.util.angleWrap(yawTo(dx, dz) - b.yaw)) > SIGHT_HALF) return;
    const k = 0.08 / D;
    if (!R.world.los(b.x, ey, b.z, h.x - dx * k, h.y, h.z - dz * k, true)) return;
    const chest = h.part === 'head' ? h.y - 0.45 : R.util.clamp(h.part === 'leg' ? h.y + 0.45 : h.y, 0.55, 1.25);
    const sig = 0.15 + D * 0.012;
    addContact(b, h.actor.id, h.x - h.nx * 0.25 + gauss() * sig, h.z - h.nz * 0.25 + gauss() * sig, chest, sig, 'echo', R.time || 0);
    T.stats.sights++;
  }

  function coneDir(d, half) {
    let ux = 0, uy = 1, uz = 0;
    if (Math.abs(d[1]) > 0.9) { ux = 1; uy = 0; }
    let ax = d[1] * uz - d[2] * uy, ay = d[2] * ux - d[0] * uz, az = d[0] * uy - d[1] * ux;
    const al = hyp(ax, ay, az) || 1; ax /= al; ay /= al; az /= al;
    const bx = ay * d[2] - az * d[1], by = az * d[0] - ax * d[2], bz = ax * d[1] - ay * d[0];
    const ct = 1 - Math.random() * (1 - Math.cos(half)), st = Math.sqrt(1 - ct * ct), ph = Math.random() * 2 * Math.PI;
    const p = Math.cos(ph) * st, q = Math.sin(ph) * st;
    return [d[0] * ct + ax * p + bx * q, d[1] * ct + ay * p + by * q, d[2] * ct + az * p + bz * q];
  }

  function onShot(e) {
    if (!e || !e.actor) return;
    const a = e.actor;
    if (a.brain && T.stats) {
      if (e.hit && e.hit.actor) { T.stats.hits++; if (e.hit.part === 'head') T.stats.heads++; }
    }
    const v = e.hit && e.hit.actor;
    if (v && v.brain && v.alive) {
      // like the player's damage-direction arc: a bearing (from the shot origin at emission time), not a position
      const br = v.brain, err = lerp(18, 6, sk()) * DEG;
      br.hurtYaw = yawTo(e.ox - v.x, e.oz - v.z) + gauss() * err;
      br.hurtT = R.time || 0;
    }
  }

  function onKill(e) {
    if (!e || !T.stats) return;
    if (e.killer && e.killer.brain) {
      T.stats.kills++;
      if (e.weapon === 'knife') T.stats.knifeKills++;
      if (e.victim) e.killer.brain.contacts.delete(e.victim.id);
    }
  }

  function pickContact(b, t) {
    const br = b.brain;
    let best = null, bs = Infinity;
    for (const c of br.contacts.values()) {
      const age = t - c.t, d = hyp(c.x - b.x, c.z - b.z);
      let s = age + d / 15;
      if (c.armed && age < 3) s -= 0.4;
      if (c.kind === 'echo') s -= 0.3;
      if (c.id === br.engagedId) s -= 0.4;
      if (c.searched) s += 4;
      if (s < bs) { bs = s; best = c; }
    }
    return best;
  }

  // ======================= brain: utility actions =======================
  // Every tick each action scores itself from what the bot knows (0 = not possible). The bot runs the best one,
  // with a small bonus for keeping its current action. Personalities scale the scores (pers.w), so a new behaviour
  // is one more entry here, not another branch in a chain.
  const KEEP_BONUS = 0.08;
  const ACTIONS = [
    {
      name: 'knife',
      score(x) {
        const { c, age, cd, wp, br } = x;
        if (!c || cd >= 1.4 || wp.knifeT > 0) return 0;
        const sneaking = br.sneakId === c.id && age < 2.5 && c.sig < 1.0;
        return (age < 0.8 && c.sig < 0.75) || sneaking ? 0.95 : 0;
      },
      run(x) {
        const { b, c, cd, o } = x;
        o.look = x.aimAt(c.x, c.chest, c.z);
        o.goal = { x: c.x, z: c.z }; o.mode = 'walk';
        if (Math.abs(R.util.angleWrap(o.look.yaw - b.yaw)) < 22 * DEG && cd < 1.3 && R.weapons && R.weapons.knife) R.weapons.knife(b);
      },
    },
    {
      name: 'engage',
      score(x) {
        const { b, br, P, c, age, cd, t, wp, reloading, ey, W } = x;
        if (!c || cd <= 1.2) return 0;
        const canEngage = age < 0.8 && cd < P.engageRange && c.sig < T.tune.fireConf * (P.persName === 'aggressive' ? 1.3 : 1) && t >= br.relocateMinT && wp.ammo > 0 && !reloading;
        const continuing = c.id === br.engagedId && age < 1.3 && br.burstLeft > 0 && t - br.lastEngageT < 0.5 && wp.ammo > 0 && !reloading;
        if (!(canEngage || continuing)) return 0;
        if (!W.los(b.x, ey, b.z, c.x, c.chest, c.z, true)) return 0;
        // a knife-hunter already sneaking up on someone who faces away holds fire
        if (P.knifeHunt && br.sneakId === c.id && cd < 5 && behindness(b, c, t) > 0.3) return 0.5;
        return 0.85;
      },
      run(x) {
        const { b, br, P, c, cd, t, wp, S, o } = x;
        if (br.engagedId !== c.id || t - br.lastEngageT > 1.5) {
          br.engagedId = c.id;
          br.reactAt = t + lerp(0.45, 0.18, S) * rand(0.85, 1.25) * T.tune.reactMult;
          br.burstLeft = R.util.randInt(P.burst[0], P.burst[1]);
          sampleAim(b, c, t, cd);
        }
        br.lastEngageT = t;
        const a = x.aimAt(c.x, c.chest, c.z);
        o.look = { yaw: a.yaw + br.aimOff[0], pitch: a.pitch + br.aimOff[1] };
        // behind low cover: stand up out of it and shoot from the spot. Otherwise side-step while firing
        if (br.cover && br.cover.low && atCover(b)) { o.stand = true; o.crouchStill = false; }
        else o.strafe = strafeDir(b, c, cd, t);
        const err = Math.abs(R.util.angleWrap(o.look.yaw - b.yaw)) + Math.abs(o.look.pitch - b.pitch);
        if (t >= br.reactAt && t >= br.nextShotT && err < 2.5 * DEG && wp.fireT <= 0) {
          const r = R.weapons.fire(b);
          if (r) {
            T.stats.shots++;
            if (!br.firstShot) { br.firstShot = true; T.stats.shotSum += t - br.lifeStart; T.stats.shotN++; }
            br.burstLeft--;
            br.nextShotT = t + (R.weapons ? R.weapons.C.FIRE_INTERVAL : FIRE_INTERVAL) + rand(0.03, 0.16);
            sampleAim(b, c, t, cd);
            if (br.burstLeft <= 0) {
              if (Math.random() < P.relocateP) startRelocate(b, t, c);
              else { br.burstLeft = R.util.randInt(P.burst[0], P.burst[1]); br.nextShotT = t + rand(P.burstPause[0], P.burstPause[1]); }
            }
          }
        }
      },
    },
    {
      name: 'cover', // reloading, hurt or out of ammo with a live threat: get out of its line of fire
      score(x) {
        const { b, br, P, c, age, cd, t, wp, reloading } = x;
        if (!c || age > 5 || cd > 26 || cd < 1.5) return 0;
        const need = reloading || wp.ammo <= P.reloadAt || t - br.hurtT < 2.5 || b.health <= P.hpSeek;
        if (!need) return 0;
        const cv = coverFor(b, c, t);
        if (!cv || atCover(b)) return 0;
        return 0.83;
      },
      run(x) {
        const { b, br, c, o } = x;
        o.goal = br.cover; o.mode = 'walk';
        o.look = x.aimAt(c.x, c.chest, c.z);
        if (hyp(br.cover.x - b.x, br.cover.z - b.z) < 0.6) { o.stand = true; o.crouchStill = br.cover.low; }
      },
    },
    {
      name: 'relocate', // just revealed ourselves (or fleeing): move somewhere else
      score(x) { return x.t < x.br.relocateUntil && x.br.relocGoal ? 0.8 : 0; },
      run(x) {
        const { br, P, c, age, cd, o } = x;
        o.goal = br.relocGoal; o.mode = P.persName === 'sneaky' && cd < 6 ? 'crouch' : 'walk';
        if (c && age < 3) o.look = x.aimAt(c.x, c.chest, c.z);
      },
    },
    {
      name: 'hurt', // turn toward the damage, maybe move
      score(x) {
        const { br, c, age, t } = x;
        return t - br.hurtT < 1.2 && br.hurtYaw != null && !(c && age < 0.8) ? 0.7 : 0;
      },
      run(x) {
        const { b, br, P, t, dt, o } = x;
        o.look = { yaw: br.hurtYaw, pitch: 0 };
        if (P.persName !== 'aggressive' && t - br.hurtT < dt * 1.5) startRelocate(b, t, { x: b.x - Math.sin(br.hurtYaw) * 10, z: b.z - Math.cos(br.hurtYaw) * 10, chest: 1.3, id: -1 });
        o.stand = true; o.crouchStill = true;
      },
    },
    {
      name: 'health',
      score(x) {
        const { b, P, age } = x;
        if (!(b.health <= P.hpSeek && age > 1.5)) return 0;
        x.pk = healthTarget(b);
        return x.pk ? 0.6 + 0.08 * (1 - b.health / P.hpSeek) : 0;
      },
      run(x) {
        const { c, age, o } = x;
        o.goal = x.pk; o.mode = 'walk';
        if (c && age < 4) o.look = x.aimAt(c.x, c.chest, c.z);
      },
    },
    {
      name: 'sneak', // creep round to the back of someone whose facing we know, for a knife kill
      score(x) {
        const { b, c, age, cd, t, wp } = x;
        if (!c || c.searched || age > 4 || cd > 14 || cd < 1.0 || wp.knifeT > 0.3) return 0;
        const bh = behindness(b, c, t);
        if (bh == null) return 0;
        let s = 0.5 + 0.25 * Math.max(0, bh);
        if (bh < 0 && c.armed && t - (c.shotT || -99) < 1.5) s -= 0.3; // in front of someone shooting: no
        return s;
      },
      run(x) {
        const { b, br, c, cd, t, o } = x;
        br.sneakId = c.id;
        const fy = facingOf(c, t), fx = -Math.sin(fy), fz = -Math.cos(fy);
        const bh = behindness(b, c, t);
        if (bh > 0.3) o.goal = { x: c.x - fx * 0.9, z: c.z - fz * 0.9 };
        else {
          // circle wide round their side, not across their front
          const rx = Math.cos(fy), rz = -Math.sin(fy);
          const side = Math.sign((b.x - c.x) * rx + (b.z - c.z) * rz) || 1;
          o.goal = { x: c.x + rx * side * 3 - fx * 1.5, z: c.z + rz * side * 3 - fz * 1.5 };
          if (!R.world.walkable(o.goal.x, o.goal.z)) o.goal = { x: c.x - fx * 1.2, z: c.z - fz * 1.2 };
        }
        o.mode = 'crouch';
        if (cd < 15) o.look = x.aimAt(c.x, c.chest, c.z);
      },
    },
    {
      name: 'hold', // wait for them to make another sound
      score(x) {
        const { P, c, age, cd, reloading, wp } = x;
        return c && age < 0.8 + P.holdT && cd < 14 && !c.searched && !reloading && wp.ammo > 0 && (c.armed || P.persName !== 'aggressive') ? 0.55 : 0;
      },
      run(x) {
        const { b, P, c, age, cd, t, o } = x;
        const { br } = x;
        o.look = x.aimAt(c.x, c.chest, c.z);
        o.stand = true; o.crouchStill = P.persName !== 'aggressive';
        if (br.cover && !br.cover.none && hyp(br.cover.x - b.x, br.cover.z - b.z) < 2 && hyp(br.cover.tx - c.x, br.cover.tz - c.z) < 4) {
          // in cover: stay down, then lean or stand out now and then to look for a shot
          if (t > br.peekNext) { br.peekUntil = t + rand(0.7, 1.3); br.peekNext = br.peekUntil + rand(1.2, 2.6); }
          const peeking = t < br.peekUntil && !x.reloading;
          if (br.cover.low) o.crouchStill = !peeking;
          else if (peeking && br.cover.peek) { o.stand = false; o.goal = br.cover.peek; o.mode = 'crouch'; }
          else if (!atCover(b)) { o.stand = false; o.goal = br.cover; o.mode = 'crouch'; } // back in behind it
          else o.crouchStill = true;
        }
        maybeClick(b, t, cd < 9 && age > 1.0, o.look);
      },
    },
    {
      name: 'hunt', // investigate the contact
      score(x) {
        const { b, br, P, c, cd, t } = x;
        // non-aggressive bots let two other shooters finish their fight, then go for the death noise
        return c && !c.searched && c.keen && !(P.persName !== 'aggressive' && cd > 7 && othersFighting(br, t, b)) ? 0.45 : 0;
      },
      run(x) {
        const { b, br, P, c, age, cd, t, W, o } = x;
        o.goal = { x: c.x, z: c.z };
        o.mode = cd > P.crouchDist ? (cd > P.sprintFar ? 'sprint' : 'walk') : 'crouch';
        if (P.knifeHunt && cd < 4 && (!c.armed || t - (c.reloadT || -99) < 1.5)) o.mode = 'crouch';
        if (cd < 15) o.look = x.aimAt(c.x, c.chest, c.z);
        if (cd < 1.5 || (br.field && W.fieldAt(br.field, b.x, b.z) < 1.2)) {
          c.searched = true; br.scanT = t + rand(1.0, 2.5); br.scanYaw = b.yaw + rand(-2, 2);
        }
        if (cd < 9 && age > 1.2) maybeClick(b, t, true, o.look);
        else if (cd > 6 && cd < 18 && age > 2) maybeDart(b, t, c.x, c.z);
      },
    },
    {
      name: 'roam',
      score() { return 0.1; },
      run(x) {
        const { b, br, P, t, dt, W, o } = x;
        const it = br.interests.length ? br.interests[br.interests.length - 1] : null;
        if (t < br.scanT) {
          o.stand = true;
          o.look = { yaw: br.scanYaw, pitch: 0 };
          if (Math.abs(R.util.angleWrap(br.scanYaw - b.yaw)) < 0.1) br.scanYaw = b.yaw + rand(-2.2, 2.2);
          maybeClick(b, t, false, null);
          return;
        }
        if (it && (P.pingCurious || it.kind === 'death' || it.kind === 'impact') && !it.done) {
          br.goal = { x: it.x, z: it.z }; it.done = true; br.legMode = P.persName === 'aggressive' ? 'walk' : 'crouch';
        }
        if (!br.goal) newRoamGoal(b);
        o.goal = br.goal; o.mode = br.legMode;
        if (T.tune.listenEvery > 0 && Math.random() < dt / T.tune.listenEvery) { br.scanT = t + Math.min(12, rand(1.5, 4.0) * T.tune.pauseLen); br.scanYaw = b.yaw + rand(-1.5, 1.5); }
        if (br.goal && W.fieldAt(fieldFor(b, br.goal, t), b.x, b.z) < 1.0) {
          br.goal = null; o.goal = null;
          if (Math.random() < T.tune.pauseP) { br.scanT = t + Math.min(12, rand(1.0, 3.0) * T.tune.pauseLen); br.scanYaw = b.yaw + rand(-2.5, 2.5); }
        }
        maybeClick(b, t, false, null);
      },
    },
  ];
  T.ACTIONS = ACTIONS;

  // which way contact c is facing (yaw), from its last click/gunshot direction or else its movement; null if unknown
  function facingOf(c, t) {
    if (c.fyaw != null && t - c.fyawT < 5) return c.fyaw;
    if (c.myaw != null && t - c.myawT < 3) return c.myaw;
    return null;
  }
  // 1 = we are straight behind contact c, -1 = straight in front, null = its facing is unknown
  function behindness(b, c, t) {
    const fy = facingOf(c, t);
    if (fy == null) return null;
    const vx = b.x - c.x, vz = b.z - c.z, vl = hyp(vx, vz) || 1;
    return -((-Math.sin(fy)) * vx + (-Math.cos(fy)) * vz) / vl;
  }

  function tickBot(b, dt, t) {
    const br = b.brain, P = br.pers, W = R.world, wp = b.wpn || (R.weapons && R.weapons.ensure ? R.weapons.ensure(b) : null);
    if (!wp) return;
    for (const [id, c] of br.contacts) if (t - c.t > P.memory) br.contacts.delete(id);
    if (br.interests.length) br.interests = br.interests.filter((i) => t - i.t < 8);

    const c = pickContact(b, t);
    const ey = eyeY(b);
    const x = {
      b, br, P, W, wp, t, dt, c, ey, S: sk(),
      age: c ? t - c.t : Infinity,
      cd: c ? hyp(c.x - b.x, c.z - b.z) : Infinity,
      reloading: wp.reloadT > 0, pk: null,
      o: { goal: null, mode: 'walk', look: null, stand: false, crouchStill: false },
      aimAt(px, py, pz) {
        const dx = px - b.x, dz = pz - b.z, dy = py - ey;
        return { yaw: yawTo(dx, dz), pitch: Math.atan2(dy, hyp(dx, dz)) };
      },
    };

    if (br.pending && t > br.pending.until) br.pending = null;

    // break off a losing fight: just got hit and low -> slip away (can't shoot back until out of the way)
    if (b.health <= P.fleeHp * T.tune.flee && t - br.hurtT < 0.6 && t >= br.relocateUntil) {
      startRelocate(b, t, c);
      br.relocateMinT = br.relocateUntil = t + rand(2.5, 4);
      br.flee = true;
    }

    let best = null, bs = 0;
    const scores = br.scores || (br.scores = {});
    for (const A of ACTIONS) {
      let s = A.score(x);
      if (s > 0) s *= P.w[A.name] == null ? 1 : P.w[A.name];
      scores[A.name] = s;
      if (!(s > 0)) continue;
      if (A.name === br.state) s += KEEP_BONUS;
      if (s > bs) { bs = s; best = A; }
    }
    const state = best.name;
    if (state !== 'sneak' && state !== 'knife') br.sneakId = -1;
    best.run(x);
    br.state = state;
    const o = x.o;

    if (state !== 'engage' && state !== 'knife') {
      if (wp.ammo <= 0 || (wp.ammo <= P.reloadAt && (x.age > 2 || state === 'relocate' || state === 'cover'))) doReload(b);
      // exposed by a nearby dart ping: get out (not aggressive ones: they get ready)
      if (state !== 'relocate' && t - br.exposedT < 0.1 && P.persName !== 'aggressive' && state !== 'hold' && t >= br.relocateUntil) startRelocate(b, t, null);
    }

    // ---- pending action overrides the view
    let look = o.look;
    if (br.pending) {
      look = { yaw: br.pending.yaw, pitch: br.pending.pitch };
      const err = Math.abs(R.util.angleWrap(look.yaw - b.yaw)) + Math.abs(look.pitch - b.pitch);
      if (err < 4 * DEG) {
        if (br.pending.type === 'dart') { if (R.weapons.throwDart(b)) T.stats.darts++; }
        else clickNow(b);
        br.pending = null;
      }
    }

    // ---- movement
    if (o.strafe) {
      b.crouch = false;
      const x0 = b.x, z0 = b.z;
      moveVel(b, dt, o.strafe.x, o.strafe.z, o.strafe.s);
      b.moveMode = hyp(b.vx, b.vz) > 0.6 ? 'walk' : 'idle';
      // ran into something: step the other way
      if (hyp(b.x - x0, b.z - z0) < o.strafe.s * dt * 0.3) { br.strafeSign = -br.strafeSign; br.strafeFlipT = t + rand(0.5, 1.1); }
    } else if (o.stand || !o.goal) {
      b.crouch = o.crouchStill;
      moveVel(b, dt, 0, 0, 0);
      b.moveMode = 'idle';
    } else {
      steer(b, dt, t, o.goal, o.mode);
    }
    // ---- view
    if (!look) {
      const sp = hyp(b.vx, b.vz);
      look = sp > 0.8 ? { yaw: yawTo(b.vx, b.vz), pitch: 0 } : { yaw: b.yaw, pitch: 0 };
    }
    turn(b, look.yaw, look.pitch, dt, state === 'engage' || state === 'knife');

    footsteps(b, dt);
    if (R.weapons && R.weapons.tryPickups) R.weapons.tryPickups(b);
  }

  function othersFighting(br, t, b) {
    let n = 0;
    for (const id in br.lastShots) if (t - br.lastShots[id] < 3 && +id !== b.id) n++;
    return n >= 2;
  }

  function sampleAim(b, c, t, cd) {
    const br = b.brain;
    const stale = Math.max(0, t - c.t);
    const sig = lerp(4.2, 1.3, sk()) * br.pers.aimMult * T.tune.aimErr * (1 + stale * 1.6) * (1 + cd / 25);
    br.aimOff[0] = gauss() * sig * DEG;
    br.aimOff[1] = gauss() * sig * 0.6 * DEG;
  }

  function doReload(b) {
    const w = b.wpn;
    if (!w || w.reloadT > 0 || w.ammo >= (w.mag || 12)) return;
    if (R.weapons && R.weapons.reload) R.weapons.reload(b);
  }

  function clickNow(b) {
    if (R.weapons && R.weapons.click) return R.weapons.click(b);
    const w = b.wpn;
    if (w.clickT > 0) return false;
    w.clickT = 0.55;
    const ey = eyeY(b);
    R.sound('click', b.x, ey, b.z, b, { dir: R.forward(b.yaw, b.pitch) });
    return true;
  }

  // probe with the tongue click: forward=true clicks right now along `look` (already facing the area)
  function maybeClick(b, t, hunting, look) {
    const br = b.brain;
    if (t < br.nextClickT || br.pending) return;
    const every = br.pers.clickEvery * (hunting ? 0.35 : T.tune.roamClick);
    br.nextClickT = t + every * rand(0.6, 1.4);
    if (hunting && look) br.pending = { type: 'click', yaw: look.yaw, pitch: Math.max(-0.15, Math.min(0.1, look.pitch)), until: t + 1.0 };
    else clickNow(b);
  }

  function maybeDart(b, t, x, z) {
    const br = b.brain;
    if (t < br.nextDartT || br.pending || !(b.wpn.darts > 0)) return;
    br.nextDartT = t + br.pers.dartEvery * rand(0.7, 1.4);
    const dx = x - b.x, dz = z - b.z, D = hyp(dx, dz);
    const pitch = 0.5 * Math.asin(Math.min(1, (D * DART_G) / (DART_V * DART_V)));
    br.pending = { type: 'dart', yaw: yawTo(dx, dz), pitch, until: t + 1.5 };
  }

  function healthTarget(b) {
    const G = R.game;
    let best = null, bd = Infinity;
    if (G && G.pickups) {
      for (const p of G.pickups) {
        if (p.kind !== 'health' || !p.active) continue;
        const d = hyp(p.x - b.x, p.z - b.z);
        if (d < bd) { bd = d; best = p; }
      }
      if (best) return { x: best.x, z: best.z };
    }
    const h = b.brain.humHint;
    if (h && (R.time || 0) - h.t < 15) return { x: h.x, z: h.z };
    return null;
  }

  function startRelocate(b, t, c) {
    const br = b.brain, W = R.world;
    // a threat with a known position: break line of sight rather than just moving
    if (c) {
      const cv = coverFor(b, c, t, true);
      if (cv) {
        br.relocGoal = { x: cv.x, z: cv.z };
        br.relocateUntil = t + rand(2.0, 3.5);
        br.relocateMinT = t + rand(0.7, 1.2);
        br.goal = null;
        return;
      }
    }
    const f = W.flowField(b.x, b.z, 12);
    const cell = (W.w * R.TILE) / W.navW;
    let best = null, bs = -Infinity;
    for (let k = 0; k < 40; k++) {
      const i = Math.floor(Math.random() * f.length);
      const d = f[i];
      if (!(d >= 3.5 && d <= 11)) continue;
      const x = ((i % W.navW) + 0.5) * cell, z = (((i / W.navW) | 0) + 0.5) * cell;
      let s = Math.random() * 2;
      if (c) s += hyp(x - c.x, z - c.z) - hyp(b.x - c.x, b.z - c.z) * 0.5; // prefer away / sideways
      if (s > bs) { bs = s; best = { x, z }; }
    }
    if (!best) return;
    br.relocGoal = best;
    br.relocateUntil = t + rand(2.0, 3.5);
    br.relocateMinT = t + rand(0.7, 1.2);
    br.goal = null;
  }

  // ======================= cover =======================
  // A cover spot hides the bot from a threat's eye line: 'high' cover hides it standing, 'low' cover only crouched.
  // A good spot is close by path, not toward the threat, and has a peek: a step to one side (high) or standing up
  // (low) that gives back line of sight to shoot from.
  const THREAT_EYE = 1.5;
  function hiddenAt(c, x, z, y) { return !R.world.los(c.x, THREAT_EYE, c.z, x, y, z, true); }
  function coverFor(b, c, t, fresh) {
    const br = b.brain;
    const cv = br.cover;
    // reuse while the threat hasn't moved much and the spot still hides us
    if (!fresh && cv && t - br.coverT < 2.5 && hyp(cv.tx - c.x, cv.tz - c.z) < 2.5) return cv.none ? null : cv;
    br.cover = findCover(b, c) || { none: true, tx: c.x, tz: c.z };
    br.coverT = t;
    return br.cover.none ? null : br.cover;
  }
  function findCover(b, c) {
    const W = R.world;
    const f = W.flowField(b.x, b.z, 9);
    const cell = (W.w * R.TILE) / W.navW;
    const d0 = hyp(b.x - c.x, b.z - c.z);
    let best = null, bs = -Infinity;
    // sample cells in a box around the bot (path distance still decides what's reachable)
    const ci = Math.floor(b.x / cell), cj = Math.floor(b.z / cell), rc = Math.ceil(8 / cell), navH = (f.length / W.navW) | 0;
    for (let k = 0; k < 48; k++) {
      const gi = ci + Math.round(rand(-rc, rc)), gj = cj + Math.round(rand(-rc, rc));
      if (gi < 0 || gj < 0 || gi >= W.navW || gj >= navH) continue;
      const i = gj * W.navW + gi;
      const pd = f[i];
      if (!(pd <= 8)) continue;
      const x = ((i % W.navW) + 0.5) * cell, z = (((i / W.navW) | 0) + 0.5) * cell;
      const dc = hyp(x - c.x, z - c.z);
      if (dc < 3) continue;
      const low = !hiddenAt(c, x, z, 1.45);
      if (low && (!hiddenAt(c, x, z, 1.0) ? true : !hiddenAt(c, x, z, 0.65))) continue; // not hidden even crouched
      let peek = null;
      if (!low) {
        // a step to the side that sees the threat
        const ux = (x - c.x) / dc, uz = (z - c.z) / dc;
        for (const sd of [1, -1]) for (const st of [0.8, 1.3]) {
          const px = x - uz * sd * st, pz = z + ux * sd * st;
          if (W.walkable(px, pz) && !hiddenAt(c, px, pz, 1.35)) { peek = { x: px, z: pz }; break; }
        }
        if (peek == null) continue;
      }
      let s = -pd * 0.55 + (low ? 0 : 0.8) + Math.min(3, dc - d0) * 0.4 + Math.random() * 0.5;
      if (dc < 5) s -= 2;
      if (s > bs) { bs = s; best = { x, z, low, peek, tx: c.x, tz: c.z }; }
    }
    return best;
  }
  function atCover(b) {
    const cv = b.brain.cover;
    return !!cv && !cv.none && hyp(cv.x - b.x, cv.z - b.z) < 0.7;
  }
  // side-step across the threat's line of fire; flips every ~0.5-1.3 s, leans toward known cover, keeps a range
  function strafeDir(b, c, cd, t) {
    const br = b.brain, P = br.pers;
    if (t > br.strafeFlipT) {
      br.strafeSign = Math.random() < 0.65 ? -br.strafeSign : br.strafeSign;
      br.strafeFlipT = t + rand(0.5, 1.3);
    }
    const ux = (b.x - c.x) / (cd || 1), uz = (b.z - c.z) / (cd || 1);
    let px = -uz * br.strafeSign, pz = ux * br.strafeSign;
    const cv = br.cover;
    if (cv && !cv.none && hyp(cv.x - b.x, cv.z - b.z) < 6) {
      const side = (cv.x - b.x) * -uz + (cv.z - b.z) * ux;
      if (Math.abs(side) > 0.5 && t > br.strafeFlipT - 0.3) { px = -uz * Math.sign(side); pz = ux * Math.sign(side); }
    }
    // range: aggressive bots press in from far, everyone backs off when very close
    const radial = cd < 4 ? 0.5 : P.persName === 'aggressive' && cd > 11 ? -0.35 : 0;
    const dx = px + ux * radial, dz = pz + uz * radial, l = hyp(dx, dz) || 1;
    return { x: dx / l, z: dz / l, s: P.strafe * (0.8 + 0.4 * Math.sin(t * 1.7 + b.id)) };
  }

  function newRoamGoal(b) {
    const br = b.brain, W = R.world;
    let g = null;
    for (let k = 0; k < 12; k++) {
      const p = W.randomWalkable();
      g = p;
      const d = hyp(p.x - b.x, p.z - b.z);
      if (d > 7 && d < 34) break;
    }
    br.goal = g;
    br.legMode = Math.random() < br.pers.roamCrouchP ? 'crouch' : 'walk';
  }

  // ======================= motor =======================
  function fieldFor(b, g, t) {
    const br = b.brain;
    const fg = br.fieldGoal;
    if (!br.field || !fg || (hyp(fg.x - g.x, fg.z - g.z) > 1.0 && t - br.fieldT > 0.25) || hyp(fg.x - g.x, fg.z - g.z) > 4) {
      br.field = R.world.flowField(g.x, g.z);
      br.fieldGoal = { x: g.x, z: g.z }; br.fieldT = t;
    }
    return br.field;
  }

  function steer(b, dt, t, goal, mode) {
    const br = b.brain, W = R.world;
    const f = fieldFor(b, goal, t);
    const rem = W.fieldAt(f, b.x, b.z);
    let dx = 0, dz = 0;
    if (rem === Infinity) {
      // unreachable: give up on this goal
      br.goal = null; br.relocateUntil = 0;
      const c = pickContact(b, t); if (c && hyp(c.x - goal.x, c.z - goal.z) < 0.5) c.searched = true;
    } else if (rem > 0.3) {
      const p1 = W.stepToward(f, b.x, b.z);
      let p = p1;
      if (p1) { const p2 = W.stepToward(f, p1.x, p1.z); if (p2) p = p2; }
      if (p) { dx = p.x - b.x; dz = p.z - b.z; }
      if (rem < 1.5) { dx = goal.x - b.x; dz = goal.z - b.z; if (!W.walkable(goal.x, goal.z) && p) { dx = p.x - b.x; dz = p.z - b.z; } }
    }
    // unstick
    if (t < br.sideUntil) { dx = br.sideX; dz = br.sideZ; }
    br.stuckT += dt;
    if (br.stuckT > 1.0) {
      const moved = hyp(b.x - br.stuckX, b.z - br.stuckZ);
      const expect = SPEED[mode] * br.stuckT;
      if ((dx || dz) && moved < Math.min(0.5, expect * 0.3)) {
        br.stuck++;
        const a = Math.random() * Math.PI * 2;
        br.sideX = Math.cos(a); br.sideZ = Math.sin(a); br.sideUntil = t + 0.45;
        if (br.stuck >= 3) { br.goal = null; br.relocateUntil = 0; br.stuck = 0; br.field = null; }
      } else if (moved > 1) br.stuck = 0;
      br.stuckT = 0; br.stuckX = b.x; br.stuckZ = b.z;
    }
    const l = hyp(dx, dz);
    b.crouch = mode === 'crouch';
    if (l < 1e-4) { moveVel(b, dt, 0, 0, 0); b.moveMode = 'idle'; return; }
    moveVel(b, dt, dx / l, dz / l, SPEED[mode]);
    b.moveMode = hyp(b.vx, b.vz) > 0.5 ? mode : 'idle';
  }

  function moveVel(b, dt, ux, uz, speed) {
    const tvx = ux * speed, tvz = uz * speed;
    const dvx = tvx - b.vx, dvz = tvz - b.vz, dl = hyp(dvx, dvz), mx = ACCEL * dt;
    if (dl <= mx) { b.vx = tvx; b.vz = tvz; } else { b.vx += (dvx / dl) * mx; b.vz += (dvz / dl) * mx; }
    if (Math.abs(b.vx) + Math.abs(b.vz) < 1e-4) { b.vx = b.vz = 0; return; }
    const x0 = b.x, z0 = b.z;
    R.world.moveActor(b, b.vx * dt, b.vz * dt);
    if (dt > 0) { b.vx = (b.x - x0) / dt; b.vz = (b.z - z0) / dt; }
  }

  function turn(b, yawT, pitchT, dt, combat) {
    const S = sk();
    const rate = lerp(5.5, 10, S) * (combat ? 1 : 0.7);
    const dy = R.util.angleWrap(yawT - b.yaw);
    const vy = Math.min(rate, 0.8 + Math.abs(dy) * 9);
    b.yaw = R.util.angleWrap(b.yaw + Math.sign(dy) * Math.min(Math.abs(dy), vy * dt));
    const dp = pitchT - b.pitch;
    const vp = Math.min(rate, 0.8 + Math.abs(dp) * 9);
    b.pitch = R.util.clamp(b.pitch + Math.sign(dp) * Math.min(Math.abs(dp), vp * dt), -1.4, 1.4);
  }

  function footsteps(b, dt) {
    const br = b.brain, sp = hyp(b.vx, b.vz);
    const mode = b.moveMode;
    if (sp < 0.6 || mode === 'idle' || !STEP_INT[mode]) { br.stepT = Math.min(br.stepT, 0.15); return; }
    br.stepT += dt;
    const iv = STEP_INT[mode];
    if (br.stepT >= iv) {
      br.stepT -= iv;
      R.sound(STEP_KIND[mode], b.x, 0.05, b.z, b, { mult: R.FLOOR_MULT[R.world.floorMatAt(b.x, b.z)] });
    }
  }
})();
