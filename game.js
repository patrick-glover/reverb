// game.js — REVERB match flow (R.game). State machine, spawns, respawns, pickups, timer, stats.
// Plain script, no THREE, runs in node (window must exist).
(function () {
  'use strict';
  const R = (window.R = window.R || {});

  const MATCH_TIME = 360;
  const KILL_LIMIT = 15;
  const RESPAWN_T = 3;
  const PICKUP_RESPAWN = 20;
  const HUM_EVERY = 2.5;
  const PICKUP_R = 1.0;
  const FEED_MAX = 7;
  const LOCK_GRACE = 0.6; // seconds without pointer lock while playing before auto-pausing

  // call a module function without letting one broken module stop the frame; log each failure site once
  const failed = {};
  function safe(tag, fn) {
    try { fn(); } catch (e) {
      if (!failed[tag]) { failed[tag] = 1; console.error('[game] ' + tag, e); }
    }
  }
  const has = (m, f) => R[m] && typeof R[m][f] === 'function';

  const G = (R.game = {
    state: 'menu',
    mapIndex: 0,
    timeLeft: MATCH_TIME,
    matchTime: MATCH_TIME,
    killLimit: KILL_LIMIT,
    killFeed: [],
    pickups: [],
    spawns: [],
    time: 0,            // sim clock (advances only while the match simulates)
    stateT: 0,          // time spent in current state (real time)
    winner: null,
    lastDeath: null,    // {killer, weapon, headshot, t} of the local player's most recent death
    requireLock: true,  // set false to run the match without pointer lock (tests / automation)
    botCount: 5,
    stats: null,
    _lockLost: 0,

    init() {
      if (R.bus) {
        R.bus.on('kill', onKill);
        R.bus.on('shot', onShot);
        R.bus.on('damage', onDamage);
        R.bus.on('pickup', onPickupEvent);
        R.bus.on('lock', onLock);
      }
      try {
        const m = window.localStorage && parseInt(window.localStorage.getItem('reverb.map'), 10);
        if (m >= 0) G.mapIndex = m;
      } catch (e) { /* storage unavailable */ }
      G.mapIndex = clampMap(G.mapIndex);
      G.stats = freshStats();
      setState('menu');
    },

    mapCount() { return (R.maps && R.maps.length) || 0; },
    mapName(i) {
      const m = R.maps && R.maps[i == null ? G.mapIndex : i];
      return (m && m.name) || 'Map ' + ((i == null ? G.mapIndex : i) + 1);
    },
    setMap(i) {
      G.mapIndex = clampMap(i);
      try { window.localStorage && window.localStorage.setItem('reverb.map', String(G.mapIndex)); } catch (e) { /* ignore */ }
    },

    start(mapIndex) {
      if (mapIndex != null) G.setMap(mapIndex);
      const mapDef = R.maps && R.maps[G.mapIndex];
      const player = R.player || null;

      // actors: keep only the local player object
      R.actors.length = 0;
      if (player) R.actors.push(player);

      // world
      let built = null;
      if (mapDef && has('props', 'build')) safe('props.build', () => { built = R.props.build(mapDef); });
      built = built || {};
      G.spawns = (built.spawns && built.spawns.length) ? built.spawns.slice() : fallbackSpawns();
      G.pickups = (built.pickups || []).map((p, i, arr) => ({
        x: p.x, z: p.z, kind: p.kind, active: true, respawnT: 0,
        humT: (HUM_EVERY * (i + 0.5)) / Math.max(1, arr.length), // staggered hums
      }));
      if (has('echo', 'reset')) safe('echo.reset', () => R.echo.reset());

      // bots
      if (has('bots', 'spawnAll')) {
        let ret = null;
        safe('bots.spawnAll', () => { ret = R.bots.spawnAll(G.botCount); });
        if (Array.isArray(ret)) for (const b of ret) if (R.actors.indexOf(b) < 0) R.actors.push(b);
      }
      if (player && R.actors.indexOf(player) < 0) R.actors.unshift(player);

      // reset scores and place everyone one at a time (each spawn avoids those already placed)
      for (const a of R.actors) { a.kills = 0; a.deaths = 0; a.alive = false; a.respawnT = 0; a._dead = false; }
      // place bots first so the player gets a spawn far from them
      const order = R.actors.filter((a) => a !== player);
      if (player) order.push(player);
      for (const a of order) spawnActor(a, true);

      G.killFeed.length = 0;
      G.timeLeft = G.matchTime;
      G.killLimit = KILL_LIMIT;
      G.time = 0;
      G.winner = null;
      G.lastDeath = null;
      G.stats = freshStats();
      G._lockLost = 0;
      setState('playing');
      if (R.input) R.input.lockOnClick = true;
      R.bus && R.bus.emit('match:start', { map: G.mapIndex });
    },

    // full simulation step, called by core each frame
    update(dt) {
      G.stateT += dt;
      const s = G.state;
      if (s === 'playing' || s === 'dead') {
        simulate(dt);
        if (has('body', 'update')) safe('body.update', () => R.body.update(dt));
        // pointer lock watchdog (the 'lock' event covers the normal Esc case)
        if (G.requireLock && R.input && !R.input.locked) {
          G._lockLost += dt;
          if (G._lockLost > LOCK_GRACE && G.state !== 'over') G.pause();
        } else G._lockLost = 0;
      }
      if (has('echo', 'update')) safe('echo.update', () => R.echo.update(dt));
      if (has('audio', 'update')) safe('audio.update', () => R.audio.update(dt));
      // lock on click everywhere except a running, locked match (ui.js refines this for menu controls)
      if (R.input) R.input.lockOnClick = !((G.state === 'playing' || G.state === 'dead') && R.input.locked);
    },

    pause() {
      if (G.state !== 'playing' && G.state !== 'dead') return;
      setState('paused');
    },
    resume() {
      if (G.state !== 'paused') return;
      G._lockLost = 0;
      setState(R.player && !R.player.alive ? 'dead' : 'playing');
    },
    toMenu() {
      if (R.input && R.input.locked) R.input.exitLock();
      for (const a of R.actors) if (a.isBot) a.alive = false;
      setState('menu');
    },
    endMatch() {
      if (G.state === 'over' || G.state === 'menu') return;
      const ranked = G.ranking();
      G.winner = ranked[0] || null;
      G.stats.timePlayed = G.matchTime - G.timeLeft;
      setState('over');
      if (R.input && R.input.locked) R.input.exitLock();
      R.bus && R.bus.emit('match:end', { winner: G.winner });
    },

    // actors sorted by kills desc, deaths asc
    ranking() {
      return R.actors.slice().sort((a, b) => (b.kills - a.kills) || (a.deaths - b.deaths) || (a.isBot - b.isBot));
    },
    leader() { return G.ranking()[0] || null; },
    accuracy() {
      const s = G.stats;
      return s && s.shots > 0 ? s.hits / s.shots : null;
    },

    // exposed for bots.js / tests
    chooseSpawn,
    spawnActor,
    respawnActor: (a) => spawnActor(a, false),
  });

  function clampMap(i) {
    const n = G.mapCount();
    if (!n) return 0;
    i = i | 0;
    return ((i % n) + n) % n;
  }
  function setState(s) {
    if (G.state !== s) G.stateT = 0;
    G.state = s;
  }
  function freshStats() {
    return { kills: 0, deaths: 0, shots: 0, hits: 0, headshots: 0, knifeKills: 0, damageDealt: 0, damageTaken: 0,
      streak: 0, longestStreak: 0, timePlayed: 0 };
  }
  function fallbackSpawns() {
    const out = [];
    const W = R.world;
    for (let i = 0; i < 8; i++) {
      const p = W && W.nav && W.nav.length ? W.randomWalkable() : { x: 2 + i * 2, z: 2 };
      out.push({ x: p.x, z: p.z, yaw: Math.random() * Math.PI * 2 });
    }
    return out;
  }

  // ---------------- spawning ----------------
  function walkDistField(sp) {
    const W = R.world;
    if (!W || !W.navW || typeof W.flowField !== 'function' || typeof W.fieldAt !== 'function') return null;
    let f = null;
    try { f = W.flowField(sp.x, sp.z); } catch (e) { return null; }
    return (x, z) => W.fieldAt(f, x, z);
  }
  // spawn farthest from living enemies; random among the top 3
  function chooseSpawn(actor) {
    const spawns = G.spawns;
    if (!spawns.length) return null;
    const enemies = R.actors.filter((o) => o !== actor && o.alive);
    const scored = spawns.map((sp) => {
      let score;
      if (!enemies.length) score = Math.random() * 10;
      else {
        const fd = enemies.length > 0 ? walkDistField(sp) : null;
        score = Infinity;
        for (const e of enemies) {
          const eu = Math.hypot(e.x - sp.x, e.z - sp.z);
          let d = eu;
          if (fd) { const w = fd(e.x, e.z); if (isFinite(w)) d = Math.min(w, eu * 3); }
          // line-of-sight-ish penalty: straight-line proximity matters too
          d = Math.min(d, eu * 1.6);
          if (d < score) score = d;
        }
      }
      return { sp, score };
    });
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0].score;
    // candidates: top 3, but never much worse than the best one
    const top = scored.slice(0, 3).filter((c) => c.score >= best * 0.6 || c === scored[0]);
    return top[Math.floor(Math.random() * top.length)].sp;
  }

  function spawnActor(a, initial) {
    const sp = chooseSpawn(a) || { x: a.x, z: a.z, yaw: 0 };
    const yaw = sp.yaw != null ? sp.yaw : Math.random() * Math.PI * 2;
    if (a === R.player && typeof a.respawn === 'function') {
      safe('player.respawn', () => a.respawn(sp.x, sp.z, yaw));
    }
    a.x = sp.x; a.z = sp.z; a.y = 0;
    if (a !== R.player || typeof a.respawn !== 'function') { a.yaw = yaw; a.pitch = 0; }
    a.vx = 0; a.vz = 0; a.crouch = false;
    a.health = 100; a.alive = true; a.respawnT = 0; a._dead = false;
    if (has('weapons', 'resetActor')) safe('weapons.resetActor', () => R.weapons.resetActor(a));
    else resetWpn(a);
    if (a.isBot && has('bots', 'onRespawn')) safe('bots.onRespawn', () => R.bots.onRespawn(a, !!initial));
    // player.respawn() emits its own 'spawn'
    if (!(a === R.player && typeof a.respawn === 'function')) R.bus && R.bus.emit('spawn', { actor: a, initial: !!initial });
  }
  function resetWpn(a) {
    const w = a.wpn || (a.wpn = {});
    w.ammo = w.mag || 12; w.reloadT = 0; w.fireT = 0; w.knifeT = 0;
    w.darts = Math.max(3, w.darts == null ? 3 : Math.min(w.darts, 3));
    if (w.reloading != null) w.reloading = false;
  }

  // ---------------- simulation ----------------
  function simulate(dt) {
    G.time += dt;
    const P = R.player;
    if (P && P.alive && typeof P.update === 'function') safe('player.update', () => P.update(dt));
    if (has('bots', 'update')) safe('bots.update', () => R.bots.update(dt));
    if (has('weapons', 'update')) safe('weapons.update', () => R.weapons.update(dt));
    if (G.state === 'over') return; // a kill inside the updates may have ended the match

    // respawns
    for (const a of R.actors) {
      if (a.alive) { a._dead = false; continue; }
      if (!a._dead) { a._dead = true; if (!(a.respawnT > 0)) a.respawnT = RESPAWN_T; } // first frame seen dead
      a.respawnT -= dt;
      if (a.respawnT <= 0) spawnActor(a, false);
    }

    updatePickups(dt);

    // player life state
    if (P) {
      if (!P.alive && G.state === 'playing') setState('dead');
      else if (P.alive && G.state === 'dead') setState('playing');
    }

    // end conditions
    G.timeLeft = Math.max(0, G.timeLeft - dt);
    let maxK = 0;
    for (const a of R.actors) if (a.kills > maxK) maxK = a.kills;
    if (maxK >= G.killLimit || G.timeLeft <= 0) G.endMatch();
  }

  function updatePickups(dt) {
    for (const p of G.pickups) {
      if (!p.active) {
        if (!(p.respawnT > 0) && !p._counting) p.respawnT = PICKUP_RESPAWN; // deactivated by someone else
        p._counting = true;
        p.respawnT -= dt;
        if (p.respawnT <= 0) { p.active = true; p.respawnT = 0; p._counting = false; p.humT = 0.05; }
        continue;
      }
      // fallback collection (only if player.js / bots.js didn't take it this frame)
      for (const a of R.actors) {
        if (!a.alive) continue;
        if (Math.hypot(a.x - p.x, a.z - p.z) > PICKUP_R) continue;
        if (!wants(a, p.kind)) continue;
        applyPickup(a, p);
        break;
      }
      if (!p.active) continue;
      p.humT -= dt;
      if (p.humT <= 0) {
        p.humT += HUM_EVERY;
        if (R.sound) R.sound('hum', p.x, 0.3, p.z, null);
      }
    }
  }
  function wants(a, kind) {
    if (kind === 'health') return a.health < 100;
    if (kind === 'darts') return !a.wpn || (a.wpn.darts == null ? true : a.wpn.darts < 5);
    return true;
  }
  function applyPickup(a, p) {
    p.active = false; p.respawnT = PICKUP_RESPAWN; p._counting = true;
    p._taken = G.time;
    if (p.kind === 'health') a.health = Math.min(100, a.health + 50);
    else if (p.kind === 'darts') { const w = a.wpn || (a.wpn = {}); w.darts = Math.min(5, (w.darts || 0) + 2); }
    if (R.sound) R.sound('pickup', p.x, 0.5, p.z, a);
    G._selfPickup = true;
    R.bus && R.bus.emit('pickup', { actor: a, kind: p.kind, pickup: p });
    G._selfPickup = false;
  }
  // R.game.takePickup(actor, pickup): for player.js / bots.js to claim a pickup (applies the effect)
  G.takePickup = function (a, p) { if (p && p.active) applyPickup(a, p); };

  // ---------------- events ----------------
  function onPickupEvent(e) {
    if (G._selfPickup || !e || !e.actor) return;
    // someone else applied a pickup: mark the matching pad as taken
    let best = null, bd = 2.0;
    for (const p of G.pickups) {
      if (!p.active || (e.kind && p.kind !== e.kind)) continue;
      const d = Math.hypot(e.actor.x - p.x, e.actor.z - p.z);
      if (d < bd) { bd = d; best = p; }
    }
    if (e.pickup && G.pickups.indexOf(e.pickup) >= 0) best = e.pickup.active ? e.pickup : null;
    if (best) { best.active = false; best.respawnT = PICKUP_RESPAWN; best._counting = true; }
  }

  function onKill(e) {
    if (!e || !e.victim) return;
    if (G.state !== 'playing' && G.state !== 'dead' && G.state !== 'paused') return;
    const v = e.victim, k = e.killer || null;
    G.killFeed.push({ killer: k, victim: v, weapon: e.weapon || 'pistol', headshot: !!e.headshot, t: G.time });
    while (G.killFeed.length > FEED_MAX) G.killFeed.shift();
    const P = R.player, S = G.stats;
    if (k === P && v !== P) {
      S.kills++; S.streak++;
      if (S.streak > S.longestStreak) S.longestStreak = S.streak;
      if (e.headshot) S.headshots++;
      if (e.weapon === 'knife') S.knifeKills++;
    }
    if (v === P) {
      S.deaths++; S.streak = 0;
      G.lastDeath = { killer: k, weapon: e.weapon || 'pistol', headshot: !!e.headshot, t: G.time };
      if (G.state === 'playing') setState('dead');
    }
  }
  function onShot(e) {
    if (!e || e.actor !== R.player || !G.stats) return;
    G.stats.shots++;
    if (e.hit && e.hit.actor && e.hit.actor !== R.player) G.stats.hits++;
  }
  function onDamage(e) {
    if (!e || !G.stats) return;
    if (e.attacker === R.player && e.target !== R.player) G.stats.damageDealt += e.amount || 0;
    if (e.target === R.player) G.stats.damageTaken += e.amount || 0;
  }
  function onLock(e) {
    if (!e) return;
    if (!e.locked) { if (G.state === 'playing' || G.state === 'dead') G.pause(); }
    else if (G.state === 'paused') G.resume();
  }
})();
