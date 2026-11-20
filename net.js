// net.js — REVERB online play (R.net). Room codes on a Cloudflare Worker (server/), one Durable Object per room.
// The room runs the real match (bots, hits, respawns, pickups, clock). This browser owns its own movement and
// sends it when it changes (up to 20 Hz, 4 Hz keepalive); shots, knife, darts and reloads are predicted locally (sound, ammo, cooldowns) and resolved by
// the room. Everything else arrives as sound/damage/kill/spawn events and 10-number actor rows, and every
// client traces its own echoes from the sound events, so dots are never sent over the wire.
// The lobby is a DOM overlay (text inputs); the menu draws HOST / JOIN buttons that open it.
(function () {
  'use strict';
  const R = (window.R = window.R || {});

  const PROTOCOL = 2;
  // the room server (server/, a Cloudflare Worker); localhost and file:// use the local dev server instead
  const PROD_SERVER = 'https://api.playreverb.com';
  const SEND_HZ = 20;
  const KEEPALIVE = 0.25;  // s: resend unchanged movement this often
  const REJOIN_FOR = 25000; // ms to keep trying after a drop (the room holds the seat 30 s)
  const INTERP = 0.1;      // remote actors are drawn this far (s) behind the newest snapshot
  const MOVE_MODES = ['idle', 'walk', 'sprint', 'crouch'];
  // own sounds this browser already made itself (the room's copy is skipped)
  const SELF_PREDICTED = new Set(['step', 'sprint', 'crouch', 'click', 'gunshot', 'reload', 'melee', 'dartThrow']);
  // own sounds the room can't know about unless we tell it (footsteps it makes itself from our movement)
  const FORWARD = new Set(['click']);

  const PALETTE = R.PALETTE; // core.js: the 8 colours players pick from (bots get the rest)
  const now = () => performance.now();
  const lsGet = (k) => { try { return window.localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { window.localStorage.setItem(k, v); } catch (e) { /* ignore */ } };
  // rejoin ticket for this tab: survives a refresh, not a new tab (sessionStorage)
  const REJOIN_KEY = 'reverb.rejoin';
  const ticketGet = () => { try { return JSON.parse(window.sessionStorage.getItem(REJOIN_KEY) || 'null'); } catch (e) { return null; } };
  const ticketSet = (t) => { try { if (t) window.sessionStorage.setItem(REJOIN_KEY, JSON.stringify(t)); else window.sessionStorage.removeItem(REJOIN_KEY); } catch (e) { /* ignore */ } };

  function serverBase() {
    let q = null;
    try { q = new URLSearchParams(window.location.search).get('server'); } catch (e) { /* ignore */ }
    const h = window.location.hostname;
    const local = window.location.protocol === 'file:' || h === 'localhost' || h === '127.0.0.1';
    // ?server= is a dev override only: on the live site it would let a link point the game at any server
    if (q && local && /^https?:\/\//i.test(q)) return q.replace(/\/+$/, '');
    if (local) return 'http://localhost:8787';
    return PROD_SERVER;
  }

  const N = (R.net = {
    active: false,    // in a room (lobby, match or results)
    inMatch: false,   // a match is running and this browser is in it
    overlayOpen: false,
    code: null, cid: 0, hostCid: 0, phase: 'off', settings: null, players: [],
    rtt: 0, ws: null, error: '',
    _starting: false,
    available: () => !!serverBase(),
    isHost: () => !!N.cid && N.cid === N.hostCid,
    quick: false,     // this room is a quick play room (no host, matches back to back)
    online: null,     // {players, rooms} from the server, for the menu's "N playing online"
    countdown: 0,     // s until play starts (the room holds everyone still while it runs)
    goAt: -1e9,       // performance.now() when the countdown ran out (the HUD flashes GO)
    ready: false,     // our lobby ready toggle
    init, update, openHost, openJoin, openQuick, leave, backToLobby,
    myColor: () => myColor(), // your saved colour (offline menu swatches use these too)
    setColor: (c) => setMyColor(c),
    endMatch: () => send({ t: 'end' }),       // host: finish the running match now (results, then lobby)
    closeRoom: () => { N._closing = true; send({ t: 'close' }); }, // host: send everyone out and shut the room
  });

  // ---------------- state ----------------
  let byId = new Map();       // server actor id -> local actor (R.player or a proxy)
  let youId = 0;
  let serverT = 0, recvAt = 0; // newest snapshot's server clock and when it arrived
  let sendAcc = 0, pingAcc = 0, rttAcc = 0, sentReady = false;
  let lastSt = '', lastStAt = 0; // last movement message sent, and when
  let lastBeep = 99;            // the last countdown second we beeped for (snapshots can nudge the clock back up)
  let ticket = null;            // {code, rk, name}: lets this tab take its seat back after a drop or refresh
  let rejoinUntil = 0;          // while > now, a lost connection retries instead of failing
  let mode = 'menu';          // overlay screen: host | join | lobby | msg
  let el = null;

  // signed player id the server issued in a welcome ('<id>.<sig>'); sent back on every connect
  const playerToken = () => { const t = lsGet('reverb.pid'); return t && /^[0-9a-f]{32}\.[\w-]+$/.test(t) ? t : ''; };
  const myName = () => lsGet('reverb.name') || '';
  // chosen colour, saved in this browser; also tints your own dart pings offline
  const myColor = () => { const c = lsGet('reverb.color'); return PALETTE.includes(c) ? c : PALETTE[0]; };
  const setMyColor = (c) => { if (!PALETTE.includes(c)) return; lsSet('reverb.color', c); if (R.player) R.player.color = c; };

  // ---------------- init: wrap weapons for prediction, forward own sounds ----------------
  function init() {
    if (R.player) R.player.color = myColor();
    const W = R.weapons;
    if (W && !W._netWrapped) {
      W._netWrapped = true;
      const orig = { fire: W.fire, knife: W.knife, throwDart: W.throwDart, reload: W.reload, tryPickups: W.tryPickups };
      const mine = (a) => N.inMatch && a === R.player;
      W.fire = function (a) {
        if (!mine(a)) return orig.fire.call(W, a);
        const w = W.ensure(a), C = W.C;
        if (a.alive === false || w.fireT > 0 || w.reloadT > 0) return false;
        if (w.ammo <= 0) { W.reload(a); return false; }
        w.ammo--; w.fireT = C.FIRE_INTERVAL;
        const f = R.forward(a.yaw, a.pitch), m = W.muzzle(a);
        R.sound('gunshot', m[0], m[1], m[2], a, { dir: f.slice() });
        act('fire', a);
        R.bus.emit('shot', { actor: a, ox: m[0], oy: m[1], oz: m[2], dx: f[0], dy: f[1], dz: f[2], hit: null });
        if (w.ammo <= 0) W.reload(a);
        return { miss: true };
      };
      W.knife = function (a) {
        if (!mine(a)) return orig.knife.call(W, a);
        const w = W.ensure(a);
        if (a.alive === false || w.knifeT > 0) return false;
        w.knifeT = W.C.KNIFE_COOLDOWN;
        const f = R.forward(a.yaw, 0), e = W.eye(a);
        R.sound('melee', e[0] + f[0] * 0.6, e[1] - 0.3, e[2] + f[2] * 0.6, a);
        act('knife', a);
        return null;
      };
      W.throwDart = function (a) {
        if (!mine(a)) return orig.throwDart.call(W, a);
        const w = W.ensure(a);
        if (a.alive === false || w.darts <= 0 || w.dartT > 0) return false;
        w.darts--; w.dartT = W.C.DART_COOLDOWN;
        const f = R.forward(a.yaw, a.pitch), e = W.eye(a);
        R.sound('dartThrow', e[0] + f[0] * 0.4, e[1], e[2] + f[2] * 0.4, a);
        act('dart', a);
        return true;
      };
      W.reload = function (a) {
        const ok = orig.reload.call(W, a);
        if (ok && mine(a)) act('reload', a);
        return ok;
      };
      W.tryPickups = function (a) { return mine(a) ? null : orig.tryPickups.call(W, a); }; // the room hands them out
    }
    R.bus.on('sound', (ev) => {
      if (!N.inMatch || !ev || ev.actor !== R.player || !FORWARD.has(ev.kind)) return;
      const base = R.SOUNDS[ev.kind];
      send({ t: 'snd', k: ev.kind, x: r2(ev.x), y: r2(ev.y), z: r2(ev.z), m: base ? r2(ev.radius / base.radius) : 1, d: ev.dir ? ev.dir.map(r3) : undefined });
    });
    // invite links: ?room=CODE opens the join screen
    let code = null;
    try { code = new URLSearchParams(window.location.search).get('room'); } catch (e) { /* ignore */ }
    const t = ticketGet();
    if (t && t.code && t.rk && (!code || code.toUpperCase() === t.code)) { ticket = t; startRejoin(); } // refreshed mid-session
    else if (code && N.available()) openJoin(code);
    pollOnline();
  }

  // how many people are playing online, for the menu (only while it's showing, and the tab is visible)
  let onlineAt = 0;
  function pollOnline() {
    const G = R.game;
    const due = !N.active && G && G.state === 'menu' && !document.hidden && Date.now() - onlineAt > 30000;
    if (due) {
      onlineAt = Date.now();
      fetch(serverBase() + '/api/quick', { signal: timeoutSignal() }).then((r) => r.json())
        .then((j) => { N.online = j && Number.isFinite(j.players) ? j : null; }, () => { N.online = null; });
    }
    setTimeout(pollOnline, 2000);
  }

  function act(a, actor) {
    send({ t: 'act', a, yaw: r3(actor.yaw), pitch: r3(actor.pitch), cr: actor.crouch ? 1 : 0 });
  }
  function send(o) {
    const ws = N.ws;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(o));
  }
  const r2 = (v) => Math.round(v * 100) / 100;
  const r3 = (v) => Math.round(v * 1000) / 1000;

  // ---------------- connection ----------------
  // every host/join attempt gets a number; Cancel (or a newer attempt) makes older async steps give up
  let attempt = 0, connectTimer = 0;
  const CONNECT_TIMEOUT = 10000;
  const timeoutSignal = () => { try { return AbortSignal.timeout(CONNECT_TIMEOUT); } catch (e) { return undefined; } };

  async function createRoom(name) {
    const base = serverBase(), my = ++attempt;
    N._quickConnecting = false;
    ticket = null; ticketSet(null); rejoinUntil = 0;
    setMsg('creating room…');
    let code;
    try {
      const r = await fetch(base + '/api/rooms', { method: 'POST', signal: timeoutSignal() });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.status);
      code = j.code;
    } catch (e) { return my === attempt && fail('could not reach the game server (' + (e.message || e) + ')'); }
    if (my === attempt) connect(code, name);
  }

  // quick play: the server hands out a public room with a free slot, or makes one; a room that turns out to be
  // gone or full (someone beat us to the last seat) is retried a couple of times
  let quickTries = 0;
  async function quickPlay(name, retry) {
    const my = ++attempt;
    quickTries = retry ? quickTries + 1 : 0;
    N._lastForm = 'quick'; N._quickConnecting = false;
    ticket = null; ticketSet(null); rejoinUntil = 0;
    setMsg('finding a match…');
    let code;
    try {
      const r = await fetch(serverBase() + '/api/quick', { method: 'POST', signal: timeoutSignal() });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.status);
      code = j.code;
    } catch (e) { return my === attempt && fail('could not reach the game server (' + (e.message || e) + ')'); }
    if (my === attempt) { N._quickConnecting = true; connect(code, name); }
  }
  const retryQuick = () => {
    const go = N._quickConnecting && quickTries < 2;
    N._quickConnecting = false;
    if (!go) return false;
    quickPlay(N._connName || myName() || 'Player', true);
    return true;
  };

  async function joinRoom(code, name) {
    code = String(code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(code)) return fail('room codes are 4 letters/numbers');
    const my = ++attempt;
    N._quickConnecting = false;
    ticket = null; ticketSet(null); rejoinUntil = 0;
    setMsg('looking for ' + code + '…');
    try {
      const r = await fetch(serverBase() + '/api/rooms/' + code, { signal: timeoutSignal() });
      const j = await r.json();
      if (my !== attempt) return;
      if (!j.open) return fail('no room called ' + code);
      if (j.players >= j.max) return fail('room ' + code + ' is full');
    } catch (e) { return my === attempt && fail('could not reach the game server (' + (e.message || e) + ')'); }
    if (my === attempt) connect(code, name);
  }

  function connect(code, name, rk) {
    closeWs();
    N._connName = name;
    const url = serverBase().replace(/^http/, 'ws') + '/api/rooms/' + code + '/ws?v=' + PROTOCOL +
      '&name=' + encodeURIComponent(name) + '&pt=' + encodeURIComponent(playerToken()) + '&color=' + encodeURIComponent(myColor()) +
      (rk ? '&rk=' + encodeURIComponent(rk) : '');
    let ws;
    try { ws = new WebSocket(url); } catch (e) { return fail('could not connect'); }
    N.ws = ws;
    // no welcome in time (server down, socket hanging): give up rather than sit on "creating room…"
    connectTimer = setTimeout(() => {
      if (N.ws !== ws || N.active) return;
      closeWs();
      lost('the game server did not answer');
    }, CONNECT_TIMEOUT);
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (err) { return; } onMessage(m); };
    ws.onclose = (e) => {
      // closes we asked for (closeWs) clear N.ws first, so anything reaching past here was not requested
      if (N.ws !== ws) return;
      N.ws = null;
      clearTimeout(connectTimer);
      const was = N.active;
      dropOut();
      if (N._closing) { N._closing = false; ticket = null; ticketSet(null); hideOverlay(); try { history.replaceState(null, '', location.pathname); } catch (err) { /* ignore */ } return; }
      // 4000+ is the room telling us to go (full, closed, version, flood, opened in another tab): no retry
      if (e.code >= 4000) {
        ticket = null; ticketSet(null); rejoinUntil = 0;
        if (!was && retryQuick()) return;
        return fail(e.reason || 'disconnected from the room');
      }
      if (!was && retryQuick()) return;
      // otherwise the connection broke (refresh elsewhere, wifi, server restart): take the seat back if we had one
      if (was && ticket) { startRejoin(); return; }
      // refused before welcome (403 origin, 404 room gone, network) arrives as a bare 1006 with no reason
      lost(e.reason || (was ? 'disconnected from the room' : 'could not connect to the room'));
    };
  }
  // a connect attempt failed: retry while a rejoin is running, else show the error
  function lost(msg) {
    if (ticket && Date.now() < rejoinUntil) {
      const my = attempt, code = ticket.code;
      // stop at once if the room itself is gone; keep trying while it's there or the server can't be reached
      fetch(serverBase() + '/api/rooms/' + code, { signal: timeoutSignal() }).then((r) => r.json()).then((j) => {
        if (my === attempt && !j.open) { rejoinUntil = 0; lost('room ' + code + ' has closed'); }
        else if (my === attempt) setTimeout(() => { if (my === attempt && !N.ws) tryRejoin(); }, 1000);
      }, () => { if (my === attempt) setTimeout(() => { if (my === attempt && !N.ws) tryRejoin(); }, 2000); });
      return;
    }
    if (ticket) {
      N._joinCode = ticket.code; N._lastForm = 'join';
      ticket = null; ticketSet(null); rejoinUntil = 0;
      return fail(msg && /closed/.test(msg) ? msg : 'lost the connection to the room');
    }
    fail(msg);
  }
  function startRejoin() {
    rejoinUntil = Date.now() + REJOIN_FOR;
    attempt++;
    tryRejoin();
  }
  function tryRejoin() {
    setMsg('connection lost, rejoining ' + ticket.code + '…');
    connect(ticket.code, ticket.name || myName() || 'Player', ticket.rk);
  }

  function closeWs() {
    clearTimeout(connectTimer);
    const ws = N.ws;
    N.ws = null;
    if (ws) try { ws.close(1000); } catch (e) { /* ignore */ }
  }

  // leave the room for good (pause menu Q, Leave button)
  function leave() {
    send({ t: 'bye' }); // gone on purpose: the room frees the seat now instead of holding it
    ticket = null; ticketSet(null); rejoinUntil = 0;
    closeWs();
    dropOut();
    hideOverlay();
  }
  // local cleanup when the room is gone; puts the game back on the menu
  function dropOut() {
    const G = R.game;
    const wasMatch = N.inMatch || (G && G.state !== 'menu');
    N.active = false; N.inMatch = false; N.phase = 'off'; N.code = null; N.cid = 0; N.hostCid = 0; N.players = []; N.quick = false;
    clearProxies();
    if (G && wasMatch && G.state !== 'menu') G.toMenu();
  }
  function clearProxies() {
    for (const a of byId.values()) if (a !== R.player) { a.alive = false; const i = R.actors.indexOf(a); if (i >= 0) R.actors.splice(i, 1); }
    byId = new Map(); youId = 0;
  }

  // ---------------- messages ----------------
  function onMessage(m) {
    switch (m.t) {
      case 'welcome':
        clearTimeout(connectTimer);
        N.active = true; N.cid = m.cid; N.code = m.code; N.error = '';
        N._quickConnecting = false;
        rejoinUntil = 0;
        if (m.rk) { ticket = { code: m.code, rk: m.rk, name: N._connName || myName() || 'Player' }; ticketSet(ticket); }
        if (m.pt) lsSet('reverb.pid', m.pt); // a new (or re-issued) player id
        try { history.replaceState(null, '', location.pathname + '?room=' + m.code); } catch (e) { /* ignore */ }
        break;
      case 'lobby':
        N.phase = m.phase; N.hostCid = m.host; N.settings = m.settings; N.players = m.players; N.quick = !!m.quick;
        { const me = (m.players || []).find((p) => p.cid === N.cid); N.ready = !!(me && me.rdy); }
        if (!N.inMatch && R.game.state !== 'over') { mode = 'lobby'; showOverlay(); }
        render();
        break;
      case 'start': onStart(m); break;
      case 'roster': onRoster(m.actors); break;
      case 's': onSnapshot(m); break;
      case 'over': onOver(m); break;
      case 'pong': {
        const rtt = now() - m.c;
        N.rtt = N.rtt ? N.rtt * 0.7 + rtt * 0.3 : rtt;
        break;
      }
      case 'error': N.error = m.msg; break;
    }
  }

  function onStart(m) {
    const G = R.game, P = R.player;
    if (!G || !P) return;
    hideOverlay();
    clearProxies();
    // build the map and reset the match locally, without bots; then mirror the room's actors
    G.rules = { killLimit: m.killLimit, matchTime: m.matchTime };
    const bc = G.botCount;
    G.botCount = 0;
    N._starting = true;
    try { G.start(m.map); } finally { N._starting = false; G.botCount = bc; G.rules = {}; }
    N.inMatch = true;
    youId = m.you;
    byId.set(youId, P);
    onRoster(m.actors);
    for (const [id, x, z, yaw] of m.poses || []) {
      const a = byId.get(id);
      if (a && a !== P) placeProxy(a, x, z, yaw);
    }
    // we're out of play until we click in: the room spawns us after our 'ready' (see update)
    P.alive = false; P.netWaiting = true; P.respawnT = 0;
    sentReady = false;
    if (m.timeLeft != null && m.timeLeft >= 0) G.timeLeft = m.timeLeft;
    N.countdown = +m.cd > 0 ? +m.cd : 0; lastBeep = 99; N.ready = false;
    serverT = 0; recvAt = now();
    if (!(R.input && R.input.locked)) G.pause(); // 'click to play' (pointer lock needs a click)
  }

  function onRoster(list) {
    const P = R.player, keep = new Set();
    for (const r of list) {
      keep.add(r.id);
      if (r.id === youId) { if (P && r.color) P.color = r.color; continue; }
      let a = byId.get(r.id);
      if (!a) {
        a = R.makeActor({ name: r.name, isBot: r.isBot, color: r.color });
        a.netId = r.id; a.buf = []; a.moveMode = 'idle'; a.alive = false;
        byId.set(r.id, a);
        R.actors.push(a);
      }
      a.name = r.name; a.color = r.color;
    }
    for (const [id, a] of byId) {
      if (keep.has(id) || a === P) continue;
      a.alive = false;
      const i = R.actors.indexOf(a); if (i >= 0) R.actors.splice(i, 1);
      byId.delete(id);
    }
  }

  function placeProxy(a, x, z, yaw) {
    a.x = x; a.z = z; a.yaw = yaw; a.pitch = 0; a.vx = a.vz = 0; a.alive = true; a.buf = [];
  }

  function onSnapshot(m) {
    if (!N.inMatch) return;
    const G = R.game, P = R.player;
    serverT = m.tm; recvAt = now();
    if (typeof m.tl === 'number' && m.tl >= 0) G.timeLeft = m.tl;
    if (typeof m.cd === 'number') setCountdown(m.cd);
    for (const row of m.a) {
      const a = byId.get(row[0]);
      if (!a) continue;
      if (m.pg) a.ping = m.pg[row[0]] || 0;
      if (row.length < 11) {
        // out of sight: the room only says whether they're alive. They're nowhere as far as echoes and bodies go
        // (alive = false), while netAlive keeps the scoreboard honest.
        a.kills = row[2]; a.deaths = row[3];
        if (a !== P) { a.netAlive = !!(row[1] & 1); a.alive = false; a.netHidden = true; a.buf = []; }
        continue;
      }
      a.kills = row[8]; a.deaths = row[9];
      if (a === P) continue;
      const fl = row[7];
      a.buf.push({ t: m.tm, x: row[1], y: row[10] || 0, z: row[2], yaw: row[3], pitch: row[4], vx: row[5], vz: row[6] });
      if (a.buf.length > 30) a.buf.shift();
      const alive = !!(fl & 1);
      // back in sight (or alive again): snap to where they are instead of sliding from where we last saw them
      if (alive && (!a.alive || a.netHidden)) { a.x = row[1]; a.z = row[2]; a.buf = [a.buf[a.buf.length - 1]]; }
      a.netHidden = false; a.netAlive = alive;
      a.alive = alive;
      a.crouch = !!(fl & 2);
      a.moveMode = fl & 4 ? 'sprint' : a.crouch ? 'crouch' : Math.hypot(row[5], row[6]) > 0.25 ? 'walk' : 'idle';
    }
    if (m.me && P) {
      P.health = m.me.hp;
      if (P.wpn) P.wpn.darts = m.me.darts;
      if (!P.alive) P.respawnT = m.me.rt;
    }
    if (G.pickups) G.pickups.forEach((p, i) => { p.active = !!((m.pk >> i) & 1); });
    for (const e of m.e) try { onEvent(e); } catch (err) { console.error('[net] event', e, err); }
  }

  function onEvent(e) {
    const P = R.player, G = R.game, W = R.weapons;
    const get = (id) => (id ? byId.get(id) || null : null);
    switch (e[0]) {
      case 's': {
        const [, kind, x, y, z, aid, mult, dir] = e;
        const a = get(aid);
        if (a === P && SELF_PREDICTED.has(kind)) return;
        // in the browser 'bot' colouring means "someone else": every other player is an enemy
        R.sound(kind, x, y, z, a, { mult, dir: dir || null, source: a ? (a === P ? 'player' : 'bot') : 'world' });
        return;
      }
      case 'd': {
        const [, tid, aid, amount, part, x, y, z] = e;
        const t = get(tid), a = get(aid);
        if (!t) return;
        if (t === P) {
          P.health = Math.max(0, P.health - amount);
          P.hurtT = 1.0;
          // the room adds where the shooter stood (they may be out of sight, so their proxy isn't there)
          const hx = e[8] != null ? e[8] : a && a.x, hz = e[9] != null ? e[9] : a && a.z;
          if (hx != null) { P.hurtX = hx; P.hurtZ = hz; P.hurtDir = W.relAngle(P, hx, hz); }
        }
        if (a === P && t !== P) { P.hitMarkerT = 0.25; if (G.stats) G.stats.hits++; }
        R.bus.emit('damage', { target: t, attacker: a, amount, part, x, y, z });
        return;
      }
      case 'k': {
        const [, vid, kid, weapon, hs] = e;
        const v = get(vid), k = get(kid);
        if (!v) return;
        v.alive = false; v.netAlive = false;
        if (v === P) { P.health = 0; P.respawnT = 3; P.killer = k; }
        if (k === P && v !== P) P.killMarkerT = 0.6;
        R.bus.emit('kill', { victim: v, killer: k, weapon, headshot: !!hs });
        return;
      }
      case 'sp': {
        const [, id, x, z, yaw, seq] = e;
        const a = get(id);
        if (!a) return;
        if (a === P) { P.respawn(x, z, yaw); P.spawnSeq = seq; P.netWaiting = false; }
        else if (x == null) { a.netAlive = true; a.alive = false; a.netHidden = true; a.buf = []; } // spawned out of sight
        else { placeProxy(a, x, z, yaw); a.netHidden = false; a.netAlive = true; }
        return;
      }
    }
  }

  function onOver(m) {
    const G = R.game;
    if (!N.inMatch) return;
    N.inMatch = false;
    G.endMatch();
    const w = byId.get(m.winner);
    if (w) G.winner = w;
  }

  // countdown: beep on 3, 2, 1 and a higher one at GO; never twice for the same second
  function setCountdown(cd) {
    const was = N.countdown;
    N.countdown = Math.max(0, cd);
    const sec = Math.ceil(N.countdown);
    if (was > 0 && N.countdown === 0) {
      N.goAt = now();
      if (R.audio && R.audio.countdown) R.audio.countdown(true);
      lastBeep = 0;
    } else if (sec < lastBeep && sec > 0) {
      if (sec <= 3 && R.audio && R.audio.countdown) R.audio.countdown(false);
      lastBeep = sec;
    }
  }

  // ---------------- per frame (game.js calls this while an online match runs) ----------------
  function update(dt) {
    const P = R.player;
    if (N.countdown > 0) setCountdown(N.countdown - dt);
    // remote actors: interpolate between the two snapshots around renderT
    const renderT = serverT + Math.min(0.25, (now() - recvAt) / 1000) - INTERP;
    for (const a of byId.values()) {
      if (a === P || !a.alive || !a.buf || !a.buf.length) continue;
      const b = a.buf;
      let i = b.length - 1;
      while (i > 0 && b[i].t > renderT) i--;
      const s0 = b[i], s1 = b[i + 1];
      if (!s1) { a.x = s0.x; a.y = s0.y || 0; a.z = s0.z; a.yaw = s0.yaw; a.pitch = s0.pitch; a.vx = s0.vx; a.vz = s0.vz; continue; }
      const k = Math.max(0, Math.min(1, (renderT - s0.t) / Math.max(1e-3, s1.t - s0.t)));
      a.x = s0.x + (s1.x - s0.x) * k; a.z = s0.z + (s1.z - s0.z) * k;
      a.y = (s0.y || 0) + ((s1.y || 0) - (s0.y || 0)) * k;
      a.yaw = s0.yaw + R.util.angleWrap(s1.yaw - s0.yaw) * k;
      a.pitch = s0.pitch + (s1.pitch - s0.pitch) * k;
      a.vx = s1.vx; a.vz = s1.vz;
    }
    // first unpaused frame of the match: ask the room to spawn us
    const st = R.game.state;
    if (!sentReady && (st === 'playing' || st === 'dead')) { sentReady = true; send({ t: 'ready' }); }
    // own movement to the room
    // own movement to the room: only when it changed (up to SEND_HZ), plus a slow keepalive
    sendAcc += dt;
    if (sendAcc >= 1 / SEND_HZ && P && P.alive) {
      sendAcc = 0;
      const st = { t: 'st', x: r2(P.x), y: r2(P.y || 0), z: r2(P.z), yaw: r3(P.yaw), pitch: r3(P.pitch), vx: r2(P.vx), vz: r2(P.vz),
        cr: P.crouch ? 1 : 0, mm: Math.max(0, MOVE_MODES.indexOf(P.moveMode)), sq: P.spawnSeq || 0 };
      const key = JSON.stringify(st), t = now();
      if (key !== lastSt || t - lastStAt > KEEPALIVE * 1000) { send(st); lastSt = key; lastStAt = t; }
    }
    pingTick(dt);
  }
  function pingTick(dt) {
    pingAcc += dt; rttAcc += dt;
    if (pingAcc > 2) { pingAcc = 0; send({ t: 'ping', c: now() }); }
    if (rttAcc > 5) { rttAcc = 0; send({ t: 'rtt', ms: Math.round(N.rtt) }); }
  }
  // the lobby has no game loop hook; keep pings going
  setInterval(() => { if (N.active && !N.inMatch) pingTick(1); }, 1000);

  // back from the results screen
  function backToLobby() {
    if (!N.active) return;
    const G = R.game;
    if (G && G.state !== 'menu') { G.state = 'menu'; G.stateT = 0; }
    clearProxies();
    mode = 'lobby'; showOverlay(); render();
  }

  // ---------------- overlay (DOM) ----------------
  const CSS = `
  #mp{position:fixed;inset:0;z-index:15;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);cursor:default;
    font:14px "Chakra Petch",ui-monospace,"SF Mono",Menlo,monospace;color:#cfe6ee;padding:16px;box-sizing:border-box}
  #mp .box{width:min(440px,100%);max-height:100%;overflow:auto;background:rgba(6,10,14,.96);border:1px solid #1d2a36;border-radius:8px;padding:20px 22px;box-sizing:border-box}
  #mp h2{margin:0 0 14px;font-size:12px;letter-spacing:.24em;color:#7fe8ff;font-weight:500}
  #mp h3{margin:16px 0 8px;font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#6f8796;font-weight:400}
  #mp label{display:block;color:#8fa6b2;font-size:11px;margin:10px 0 4px}
  #mp input,#mp select,#mp button{font:inherit;color:#e8f4ff;background:#0e161d;border:1px solid #23323e;border-radius:4px;padding:7px 9px;box-sizing:border-box}
  #mp input[type=text]{width:100%}
  #mp input[type=checkbox]{accent-color:#7fe8ff;width:15px;height:15px;vertical-align:-2px;margin:0 6px 0 0}
  #mp button{cursor:pointer}
  #mp button.go{background:#7fe8ff;color:#001018;border-color:#7fe8ff;font-weight:600;letter-spacing:.08em}
  #mp button:disabled{opacity:.4;cursor:default}
  #mp .row{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap}
  #mp .row button{flex:1}
  #mp .code{font:800 54px "Doto","Chakra Petch",monospace;letter-spacing:.3em;color:#fff;text-align:center;margin:4px 0 2px;padding-left:.3em}
  #mp .sub{color:#6f8796;font-size:11px;text-align:center}
  #mp .err{color:#ff8a7a;margin-top:10px;min-height:1em}
  #mp ul{list-style:none;margin:0;padding:0}
  #mp li{display:flex;gap:8px;align-items:center;padding:5px 0;border-bottom:1px solid #121c24}
  #mp li .sw{width:8px;height:8px;border-radius:50%}
  #mp .pal{display:flex;gap:8px;margin:6px 0 2px;flex-wrap:wrap}
  #mp .pal button{flex:none;width:24px;height:24px;min-width:0;padding:0;border-radius:50%;border:2px solid transparent;box-shadow:0 0 0 1px #0a1016 inset;cursor:pointer}
  #mp .pal button.on{border-color:#fff;box-shadow:0 0 10px currentColor}
  #mp .pal button:disabled{opacity:.18;cursor:default}
  #mp li .tag{color:#6f8796;font-size:11px}
  #mp li .rt{margin-left:auto;color:#6f8796;font-size:11px;font-variant-numeric:tabular-nums}
  #mp .grid{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}
  #mp .grid select{width:100%}
  #mp .wait{color:#8fa6b2;text-align:center;margin-top:16px}`;

  function ensureEl() {
    if (el) return el;
    if (!document.getElementById('mpcss')) { const s = document.createElement('style'); s.id = 'mpcss'; s.textContent = CSS; document.head.appendChild(s); }
    el = document.createElement('div');
    el.id = 'mp';
    // don't let clicks here grab pointer lock or reach the canvas menu
    for (const ev of ['mousedown', 'pointerdown', 'wheel', 'contextmenu']) el.addEventListener(ev, (e) => e.stopPropagation());
    document.body.appendChild(el);
    return el;
  }
  function showOverlay() {
    ensureEl().style.display = 'flex';
    N.overlayOpen = true;
    if (R.input && R.input.locked) R.input.exitLock();
  }
  function hideOverlay() { if (el) el.style.display = 'none'; N.overlayOpen = false; }

  function openHost() { mode = 'host'; N.error = ''; showOverlay(); render(); }
  // straight in if we know their name; otherwise ask once
  function openQuick() { N.error = ''; if (myName()) quickPlay(myName()); else { mode = 'quick'; showOverlay(); render(); } }
  function openJoin(code) { mode = 'join'; N.error = ''; N._joinCode = code || ''; showOverlay(); render(); }
  function setMsg(s) { mode = 'msg'; N._msg = s; showOverlay(); render(); }
  function fail(msg) {
    N.error = msg;
    if (mode === 'msg' || mode === 'lobby') mode = N._lastForm || 'join';
    showOverlay(); render();
  }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const safeColor = (c) => (/^#[0-9a-f]{3,8}$/i.test(c) ? c : '#ffffff');
  const SKILLS = [[0.25, 'easy'], [0.5, 'normal'], [0.85, 'hard']];

  function render() {
    if (!el || !N.overlayOpen) return;
    let h = '<div class="box">';
    if (mode === 'host' || mode === 'join' || mode === 'quick') {
      N._lastForm = mode;
      h += `<h2>${mode === 'host' ? 'HOST ONLINE GAME' : mode === 'quick' ? 'QUICK PLAY' : 'JOIN A GAME'}</h2>`;
      h += `<label for="mp_name">Your name</label><input type="text" id="mp_name" maxlength="16" value="${esc(myName())}" placeholder="Player" autocomplete="off">`;
      h += `<label>Your color</label>${swatches(myColor(), null)}`;
      if (mode === 'join') h += `<label for="mp_code">Room code</label><input type="text" id="mp_code" maxlength="4" value="${esc(N._joinCode || '')}" placeholder="ABCD" autocomplete="off" style="text-transform:uppercase;letter-spacing:.3em">`;
      h += `<div class="err">${esc(N.error)}</div>`;
      h += `<div class="row"><button id="mp_cancel">Cancel</button><button class="go" id="mp_go">${mode === 'host' ? 'Create room' : mode === 'quick' ? 'Find a match' : 'Join'}</button></div>`;
    } else if (mode === 'msg') {
      h += `<div class="wait">${esc(N._msg)}</div>`;
      h += '<div class="row"><button id="mp_abort">Cancel</button></div>';
    } else if (mode === 'lobby' && N.quick) {
      // quick play: no host, no settings; the next match starts by itself
      h += `<h2>QUICK PLAY</h2><div class="code">${esc(N.code)}</div><div class="sub">friends can join this match with the code, or</div>`;
      h += `<div class="row" style="margin-top:8px"><button id="mp_copy">Copy invite link</button></div>`;
      h += `<h3>Players · ${N.players.length}/${+(N.settings || {}).maxPlayers || '?'} · bots fill the rest</h3><ul>`;
      for (const p of N.players) {
        const tags = [p.cid === N.cid ? 'you' : '', p.away ? 'reconnecting' : ''].filter(Boolean).join(' · ');
        h += `<li><span class="sw" style="background:${safeColor(p.color)}"></span>${esc(p.name)} <span class="tag">${tags}</span><span class="rt">${+p.rtt ? Math.round(+p.rtt) + ' ms' : ''}</span></li>`;
      }
      h += '</ul>';
      h += `<label>Your color${N.phase === 'lobby' ? '' : ' · dart pings glow in it'}</label>${swatches(myLobbyColor(), takenColors())}`;
      h += `<div class="err">${esc(N.error)}</div>`;
      h += `<div class="wait">${N.phase === 'playing' ? 'match in progress, joining…' : 'next match starts in a few seconds…'}</div>`;
      h += '<div class="row"><button id="mp_leave">Leave</button></div>';
    } else if (mode === 'lobby') {
      const host = N.isHost(), S = N.settings || {}, dis = host && N.phase === 'lobby' ? '' : ' disabled';
      h += `<h2>ROOM</h2><div class="code">${esc(N.code)}</div><div class="sub">share the code, or</div>`;
      h += `<div class="row" style="margin-top:8px"><button id="mp_copy">Copy invite link</button></div>`;
      h += `<h3>Players · ${N.players.length}/${+S.maxPlayers || '?'}</h3><ul>`;
      for (const p of N.players) {
        const tags = [p.cid === N.hostCid ? 'host' : '', p.cid === N.cid ? 'you' : '', p.away ? 'reconnecting' : '', N.phase === 'lobby' && p.rdy ? '✓ ready' : ''].filter(Boolean).join(' · ');
        h += `<li><span class="sw" style="background:${safeColor(p.color)}"></span>${esc(p.name)} <span class="tag">${tags}</span><span class="rt">${+p.rtt ? Math.round(+p.rtt) + ' ms' : ''}</span></li>`;
      }
      h += '</ul>';
      h += `<label>Your color${N.phase === 'lobby' ? '' : ' · dart pings glow in it'}</label>${swatches(myLobbyColor(), takenColors())}`;
      const maps = (R.maps || []).map((m, i) => `<option value="${i}"${i === S.map ? ' selected' : ''}>${esc(m.name)}</option>`).join('');
      const opts = (vals, cur, fmt) => vals.map((v) => `<option value="${v}"${v === cur ? ' selected' : ''}>${fmt ? fmt(v) : v}</option>`).join('');
      h += `<h3>Match${host ? '' : ' · set by host'}</h3><div class="grid">`;
      h += `<div><label for="mp_map">Map</label><select id="mp_map"${dis}>${maps}</select></div>`;
      h += `<div><label for="mp_max">Max players</label><select id="mp_max"${dis}>${opts([2, 3, 4, 5, 6, 7, 8], S.maxPlayers)}</select></div>`;
      h += `<div><label for="mp_kill">Kill limit</label><select id="mp_kill"${dis}>${opts([5, 10, 15, 20, 30], S.killLimit)}</select></div>`;
      h += `<div><label for="mp_time">Time limit</label><select id="mp_time"${dis}>${opts([3, 5, 6, 10, 15, 0], S.timeLimit, (v) => (v ? v + ' min' : 'none'))}</select></div>`;
      h += `<div><label for="mp_skill">Bot skill</label><select id="mp_skill"${dis}>${SKILLS.map(([v, n]) => `<option value="${v}"${Math.abs(v - S.botSkill) < 0.01 ? ' selected' : ''}>${n}</option>`).join('')}</select></div>`;
      h += `<div><label for="mp_fill" style="margin-top:30px"><input type="checkbox" id="mp_fill"${S.botFill ? ' checked' : ''}${dis}>fill empty slots with bots</label></div>`;
      h += '</div>';
      h += `<div class="err">${esc(N.error)}</div>`;
      if (N.phase !== 'lobby') h += `<div class="wait">${N.phase === 'playing' ? 'match in progress, joining…' : 'match just ended…'}</div>`;
      const nReady = N.players.filter((p) => p.rdy).length;
      const readyBtn = N.phase === 'lobby' ? `<button id="mp_ready"${N.ready ? ' class="go"' : ''}>${N.ready ? 'Ready ✓' : 'Ready up'}</button>` : '';
      h += `<div class="row"><button id="mp_leave">Leave</button>${host ? '<button id="mp_close">Close room</button>' : ''}${readyBtn}${host ? `<button class="go" id="mp_start"${N.phase === 'lobby' ? '' : ' disabled'}>Start now</button>` : ''}</div>`;
      if (N.phase === 'lobby') h += `<div class="wait">${nReady}/${N.players.length} ready · starts when everyone is ready${host ? ', or start now' : ' or the host starts it'}</div>`;
    }
    h += '</div>';
    // keep focus/typing in a re-rendered form
    const focus = document.activeElement && document.activeElement.id;
    el.innerHTML = h;
    if (focus && document.getElementById(focus) && focus.startsWith('mp_') && (focus === 'mp_name' || focus === 'mp_code')) {
      const f = document.getElementById(focus); f.focus(); f.selectionStart = f.selectionEnd = f.value.length;
    }
    wire();
  }

  // colour swatches: `taken` (a Set) greys out other players' colours; null on the join form
  function swatches(cur, taken) {
    return '<div class="pal">' + PALETTE.map((c) => {
      const dis = taken && taken.has(c) && c !== cur;
      return `<button class="sw${c === cur ? ' on' : ''}" data-c="${c}" style="background:${c};color:${c}" title="${dis ? 'taken' : c}"${dis ? ' disabled' : ''}></button>`;
    }).join('') + '</div>';
  }
  function takenColors() { return new Set(N.players.filter((p) => p.cid !== N.cid).map((p) => p.color)); }
  function myLobbyColor() { const me = N.players.find((p) => p.cid === N.cid); return me ? me.color : myColor(); }

  function wire() {
    const $ = (id) => document.getElementById(id);
    const nameVal = () => { const v = ($('mp_name').value || '').trim().slice(0, 16) || 'Player'; lsSet('reverb.name', v); return v; };
    if ($('mp_cancel')) $('mp_cancel').onclick = () => { hideOverlay(); try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ } };
    // stop a host/join in progress and go back to the form
    if ($('mp_abort')) $('mp_abort').onclick = () => {
      attempt++; send({ t: 'bye' }); closeWs(); dropOut();
      if (ticket) { N._joinCode = ticket.code; N._lastForm = 'join'; }
      ticket = null; ticketSet(null); rejoinUntil = 0;
      fail('');
    };
    if ($('mp_go')) {
      const go = () => (mode === 'host' ? createRoom(nameVal()) : mode === 'quick' ? quickPlay(nameVal()) : joinRoom($('mp_code').value, nameVal()));
      $('mp_go').onclick = go;
      for (const id of ['mp_name', 'mp_code']) if ($(id)) $(id).onkeydown = (e) => { if (e.key === 'Enter') go(); if (e.key === 'Escape') $('mp_cancel').onclick(); };
      const first = mode === 'join' && !N._joinCode ? $('mp_code') : $('mp_name');
      if (first && document.activeElement === document.body) first.focus();
    }
    if ($('mp_copy')) $('mp_copy').onclick = (e) => {
      const u = location.origin + location.pathname + '?room=' + N.code;
      const b = e.target;
      const done = (ok) => { b.textContent = ok ? 'Copied' : u; setTimeout(() => (b.textContent = 'Copy invite link'), 1500); };
      try { navigator.clipboard.writeText(u).then(() => done(true), () => done(false)); } catch (err) { done(false); }
    };
    if ($('mp_leave')) $('mp_leave').onclick = () => { leave(); try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ } };
    if ($('mp_start')) $('mp_start').onclick = () => send({ t: 'start' });
    for (const b of document.querySelectorAll('#mp .pal button')) b.onclick = () => {
      const c = b.dataset.c;
      setMyColor(c);
      if (N.active) send({ t: 'color', c }); // the room confirms (or refuses a taken one) in its next lobby message
      render();
    };
    if ($('mp_ready')) $('mp_ready').onclick = () => { N.ready = !N.ready; send({ t: 'lready', on: N.ready }); render(); };
    if ($('mp_close')) $('mp_close').onclick = () => N.closeRoom();
    const set = (id, key, conv) => { if ($(id)) $(id).onchange = () => send({ t: 'settings', settings: { [key]: conv($(id)) } }); };
    set('mp_map', 'map', (e) => +e.value);
    set('mp_max', 'maxPlayers', (e) => +e.value);
    set('mp_kill', 'killLimit', (e) => +e.value);
    set('mp_time', 'timeLimit', (e) => +e.value);
    set('mp_skill', 'botSkill', (e) => +e.value);
    set('mp_fill', 'botFill', (e) => e.checked);
  }
})();
