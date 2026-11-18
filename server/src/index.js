// REVERB multiplayer server: a Cloudflare Worker with one Durable Object per room (Room) and one for stats (Stats).
//
//   POST /api/rooms                 -> {code}            create a room (the creator becomes host when they connect)
//   GET  /api/rooms/:code           -> {open, players, max, phase}
//   GET  /api/rooms/:code/ws?name=&uid=   WebSocket into the room
//   GET  /admin                     monitoring console (asks for ADMIN_TOKEN)
//   GET  /api/admin/stats           JSON for the console (Authorization: Bearer ADMIN_TOKEN)
//   GET  /health
//
// The Room runs the real match: the same game scripts as the browser (built into sim.gen.js), with bots, hits,
// respawns, pickups and the clock. Browsers own their movement and send it ~30 Hz; shots, knife, darts and
// reloads are requests the room resolves. See docs/MULTIPLAYER.md for the protocol and the scaling notes.
import { DurableObject } from 'cloudflare:workers';
import { createSim } from './sim.gen.js';
import { ADMIN_HTML } from './admin.js';

const CODE_CHARS = 'BCDFGHJKMNPQRSTVWXZ23456789'; // no vowels (no words), no 0/O/1/I/L
const CODE_LEN = 4;
const TICK_HZ = 30;
const PROTOCOL = 1;

// ---------------------------------------------------------------------------------------------------------
// Worker entry
// ---------------------------------------------------------------------------------------------------------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin');
    const cors = corsHeaders(origin, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const p = url.pathname.replace(/\/+$/, '');

    if (p === '/health') return json({ ok: true, protocol: PROTOCOL }, 200, cors);
    if (p === '/admin') return new Response(ADMIN_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (p === '/api/admin/stats') {
      if (!env.ADMIN_TOKEN || req.headers.get('Authorization') !== 'Bearer ' + env.ADMIN_TOKEN) return json({ error: 'unauthorized' }, 401);
      return json(await stats(env).summary());
    }

    if (p === '/api/rooms' && req.method === 'POST') {
      if (!originOk(origin, env)) return json({ error: 'origin not allowed' }, 403, cors);
      // kill switch: `wrangler secret put ROOMS_DISABLED` (any value) stops new rooms; running rooms finish
      if (env.ROOMS_DISABLED) return json({ error: 'online play is paused, try again later' }, 503, cors);
      for (let tries = 0; tries < 8; tries++) {
        const code = randomCode();
        if (await room(env, code).claim(code)) return json({ code }, 200, cors);
      }
      return json({ error: 'could not allocate a room code' }, 503, cors);
    }

    const m = p.match(/^\/api\/rooms\/([A-Za-z0-9]{4})(\/ws)?$/);
    if (m) {
      const code = m[1].toUpperCase();
      if (m[2]) {
        if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
        if (!originOk(origin, env)) return new Response('origin not allowed', { status: 403 });
        const fwd = new Request(req.url, req);
        fwd.headers.set('X-Room-Code', code);
        return room(env, code).fetch(fwd);
      }
      return json(await room(env, code).info(), 200, cors);
    }
    return json({ error: 'not found' }, 404, cors);
  },
};

const room = (env, code) => env.ROOMS.get(env.ROOMS.idFromName(code));
const stats = (env) => env.STATS.get(env.STATS.idFromName('global'));

function randomCode() {
  const b = new Uint8Array(CODE_LEN);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += CODE_CHARS[x % CODE_CHARS.length];
  return s;
}
function allowed(env) { return (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean); }
function originOk(origin, env) {
  const list = allowed(env);
  if (!list.length || list.includes('*')) return true;
  return list.includes(origin || 'null');
}
function corsHeaders(origin, env) {
  const h = { 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'content-type' };
  if (originOk(origin, env)) h['Access-Control-Allow-Origin'] = origin || '*';
  return h;
}
function json(o, status, headers) {
  return new Response(JSON.stringify(o), { status: status || 200, headers: { 'content-type': 'application/json', ...(headers || {}) } });
}
const log = (o) => console.log(JSON.stringify(o));

// ---------------------------------------------------------------------------------------------------------
// Room
// ---------------------------------------------------------------------------------------------------------
const DEFAULTS = { map: 0, maxPlayers: 6, botFill: true, botSkill: 0.5, killLimit: 15, timeLimit: 6 };
const LIMITS = { map: [0, 2], maxPlayers: [2, 8], botSkill: [0, 1], killLimit: [1, 50], timeLimit: [2, 20] };
const HUMAN_COLORS = ['#7fe8ff', '#8affc1', '#a9b8ff', '#e9f59a', '#ffffff', '#7fb4ff', '#c2ffe9', '#d6c2ff'];
// sounds a client makes itself and forwards (everything else the room generates)
const CLIENT_SOUNDS = new Set(['step', 'sprint', 'crouch', 'click']);
const OVER_TO_LOBBY = 8; // seconds the room stays 'over' before it returns to the lobby
const MAX_MSGS_PER_SEC = 120;

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.code = null;
    this.clients = new Map(); // cid -> client
    this.nextCid = 1;
    this.hostCid = 0;
    this.phase = 'lobby';     // lobby | playing | over
    this.settings = { ...DEFAULTS };
    this.claimedAt = 0;
    this.sim = null;
    this.timer = null;
    this.events = [];
    this.tick = 0;
    this.lastBeat = 0;
    this.matchStartedAt = 0;
    this.overAt = 0;
  }

  // ---- RPC from the Worker
  async claim(code) {
    if (this.clients.size || (this.claimedAt && Date.now() - this.claimedAt < 120000)) return false;
    this.code = code;
    this.claimedAt = Date.now();
    this.settings = { ...DEFAULTS };
    this.phase = 'lobby';
    stats(this.env).event('room_created', code, null, null).catch(() => {});
    log({ evt: 'room_created', room: code });
    return true;
  }
  async info() {
    const open = !!this.code && (this.clients.size > 0 || Date.now() - this.claimedAt < 120000);
    return { open, players: this.humanCount(), max: this.settings.maxPlayers, phase: this.phase };
  }

  // ---- WebSocket connect
  async fetch(req) {
    const url = new URL(req.url);
    const code = req.headers.get('X-Room-Code');
    if (!this.code || this.code !== code) {
      // never claimed (or evicted since): only allow if this is a fresh claim race; otherwise reject
      return new Response('no such room', { status: 404 });
    }
    const pair = new WebSocketPair();
    const [clientWs, ws] = Object.values(pair);
    ws.accept();
    const reject = (msg) => { ws.send(JSON.stringify({ t: 'error', msg })); ws.close(4000, msg); };
    if (this.humanCount() >= this.settings.maxPlayers) { reject('room is full'); return new Response(null, { status: 101, webSocket: clientWs }); }
    if (+url.searchParams.get('v') !== PROTOCOL) { reject('game version mismatch, reload the page'); return new Response(null, { status: 101, webSocket: clientWs }); }

    const c = {
      cid: this.nextCid++, ws,
      name: cleanName(url.searchParams.get('name')) || 'Player',
      uid: (url.searchParams.get('uid') || '').slice(0, 40),
      color: this.freeColor(), actor: null, joinedAt: Date.now(),
      winStart: Date.now(), winCount: 0, rtt: 0,
    };
    // unique display names in a room
    const names = new Set([...this.clients.values()].map((o) => o.name));
    if (names.has(c.name)) { let i = 2; while (names.has(c.name + i)) i++; c.name = c.name + i; }
    this.clients.set(c.cid, c);
    if (!this.hostCid || !this.clients.has(this.hostCid)) this.hostCid = c.cid;

    ws.addEventListener('message', (e) => this.onMessage(c, e.data));
    ws.addEventListener('close', () => this.onClose(c));
    ws.addEventListener('error', () => this.onClose(c));

    this.send(c, { t: 'welcome', cid: c.cid, code: this.code, protocol: PROTOCOL });
    if (this.phase === 'playing') this.joinMatch(c);
    this.broadcastLobby();
    stats(this.env).event('player_joined', this.code, c.uid, { name: c.name, humans: this.humanCount() }).catch(() => {});
    log({ evt: 'player_joined', room: this.code, cid: c.cid, name: c.name, humans: this.humanCount() });
    this.beat(true);
    return new Response(null, { status: 101, webSocket: clientWs });
  }

  humanCount() { return this.clients.size; }
  freeColor() {
    const used = new Set([...this.clients.values()].map((c) => c.color));
    return HUMAN_COLORS.find((x) => !used.has(x)) || HUMAN_COLORS[0];
  }
  send(c, o) { try { c.ws.send(JSON.stringify(o)); } catch (e) { /* closed */ } }
  broadcast(o) { const s = JSON.stringify(o); for (const c of this.clients.values()) { try { c.ws.send(s); } catch (e) { /* closed */ } } }

  broadcastLobby() {
    this.broadcast({
      t: 'lobby', code: this.code, phase: this.phase, host: this.hostCid, settings: this.settings,
      players: [...this.clients.values()].map((c) => ({ cid: c.cid, name: c.name, color: c.color, rtt: Math.round(c.rtt) })),
    });
  }

  onClose(c) {
    if (!this.clients.has(c.cid)) return;
    this.clients.delete(c.cid);
    const secs = Math.round((Date.now() - c.joinedAt) / 1000);
    stats(this.env).event('player_left', this.code, c.uid, { name: c.name, secs }).catch(() => {});
    log({ evt: 'player_left', room: this.code, cid: c.cid, secs, humans: this.humanCount() });
    if (c.actor && this.sim) this.leaveMatch(c);
    if (this.hostCid === c.cid) this.hostCid = this.clients.size ? this.clients.keys().next().value : 0;
    if (!this.clients.size) {
      this.stopMatch();
      this.phase = 'lobby';
      this.claimedAt = 0; // the code can be reused
      stats(this.env).event('room_closed', this.code, null, null).catch(() => {});
      stats(this.env).beat(this.code, null).catch(() => {});
      log({ evt: 'room_closed', room: this.code });
      return;
    }
    this.broadcastLobby();
    this.beat(true);
  }

  onMessage(c, data) {
    // crude flood guard: a 30 Hz client sends ~35 msgs/s
    const now = Date.now();
    if (now - c.winStart > 1000) { c.winStart = now; c.winCount = 0; }
    if (++c.winCount > MAX_MSGS_PER_SEC) { if (c.winCount > MAX_MSGS_PER_SEC * 3) c.ws.close(4001, 'too many messages'); return; }
    if (typeof data !== 'string' || data.length > 2000) return;
    let m;
    try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    switch (m.t) {
      case 'ping': this.send(c, { t: 'pong', c: m.c }); break;
      case 'rtt': c.rtt = clampNum(m.ms, 0, 5000, 0); break;
      case 'name': {
        const n = cleanName(m.name);
        if (n) { c.name = n; if (c.actor) c.actor.name = n; this.broadcastLobby(); if (this.sim) this.sendRoster(); }
        break;
      }
      case 'settings':
        if (c.cid !== this.hostCid || this.phase === 'playing') return;
        this.settings = sanitizeSettings({ ...this.settings, ...(m.settings || {}) });
        this.broadcastLobby();
        break;
      case 'start':
        if (c.cid !== this.hostCid || this.phase === 'playing') return;
        this.startMatch();
        break;
      case 'end': // host ends the match early: normal results, then the lobby
        if (c.cid !== this.hostCid || this.phase !== 'playing' || !this.sim) return;
        log({ evt: 'match_ended_by_host', room: this.code });
        this.sim.game.endMatch();
        break;
      case 'close': // host shuts the room: everyone is sent out (onClose cleans up as each socket goes)
        if (c.cid !== this.hostCid) return;
        log({ evt: 'room_closed_by_host', room: this.code });
        for (const o of [...this.clients.values()]) { try { o.ws.close(4002, 'the host closed the room'); } catch (e) { /* gone */ } this.onClose(o); }
        break;
      case 'ready': this.onReady(c); break;
      case 'st': this.onState(c, m); break;
      case 'snd': this.onClientSound(c, m); break;
      case 'act': this.onAction(c, m); break;
    }
  }

  // ---------------- match ----------------
  ensureSim() {
    if (this.sim) return this.sim;
    const R = createSim();
    for (const n of ['echo', 'weapons', 'bots', 'game']) if (R[n] && R[n].init) R[n].init();
    R.flags.applyAll();
    R.player = null;
    R.game.requireLock = false;
    const E = this.events;
    const id = (a) => (a ? a.id : 0);
    const r2 = (v) => Math.round(v * 100) / 100;
    R.bus.on('sound', (ev) => {
      const base = R.SOUNDS[ev.kind];
      const mult = base ? r2(ev.radius / base.radius) : 1;
      E.push(['s', ev.kind, r2(ev.x), r2(ev.y), r2(ev.z), id(ev.actor), mult, ev.dir ? ev.dir.map((v) => Math.round(v * 1000) / 1000) : 0]);
    });
    R.bus.on('damage', (e) => E.push(['d', id(e.target), id(e.attacker), e.amount, e.part, r2(e.x), r2(e.y), r2(e.z)]));
    R.bus.on('kill', (e) => E.push(['k', id(e.victim), id(e.killer), e.weapon, e.headshot ? 1 : 0]));
    R.bus.on('spawn', (e) => {
      const a = e.actor;
      if (!a) return;
      a.spawnSeq = (a.spawnSeq || 0) + 1;
      E.push(['sp', a.id, r2(a.x), r2(a.z), r2(a.yaw), a.spawnSeq]);
    });
    R.bus.on('pickup', (e) => E.push(['p', id(e.actor), e.kind]));
    this.sim = R;
    return R;
  }

  makeHuman(c) {
    const R = this.sim;
    const a = R.makeActor({ name: c.name, isBot: false, color: c.color });
    a.cid = c.cid;
    a.moveMode = 'idle';
    R.weapons.ensure(a);
    c.actor = a;
    return a;
  }

  startMatch() {
    const R = this.ensureSim(), G = R.game, S = this.settings;
    this.events.length = 0;
    const humans = [];
    for (const c of this.clients.values()) humans.push(this.makeHuman(c));
    G.humans = humans;
    G.rules = { killLimit: S.killLimit, matchTime: S.timeLimit * 60 };
    G.botCount = S.botFill ? Math.max(0, S.maxPlayers - humans.length) : 0;
    R.bots.skill = S.botSkill;
    R.time = 0;
    G.start(S.map);
    G.humans = null;
    for (const a of humans) hold(a); // out of play until they click in (see onReady)
    this.events.length = 0; // initial spawns are in the start message
    this.phase = 'playing';
    this.tick = 0;
    this.matchStartedAt = Date.now();
    this.sendRoster('start');
    this.broadcastLobby();
    this.runTimer();
    stats(this.env).event('match_started', this.code, null, { humans: humans.length, bots: G.botCount, map: S.map }).catch(() => {});
    log({ evt: 'match_started', room: this.code, humans: humans.length, bots: G.botCount, settings: S });
    this.beat(true);
  }

  roster() {
    return this.sim.actors.map((a) => ({ id: a.id, name: a.name, isBot: !!a.isBot, color: a.color, cid: a.cid || 0 }));
  }
  sendRoster(kind) {
    const R = this.sim, G = R.game;
    const base = { t: kind || 'roster', actors: this.roster(), map: this.settings.map, killLimit: G.killLimit, matchTime: G.matchTime };
    if (kind !== 'start') { this.broadcast(base); return; }
    // each client learns which actor is theirs, plus every actor's starting pose
    const poses = R.actors.map((a) => [a.id, rnd(a.x), rnd(a.z), rnd(a.yaw), a.spawnSeq || 0]);
    for (const c of this.clients.values()) this.send(c, { ...base, you: c.actor ? c.actor.id : 0, poses });
  }

  joinMatch(c) {
    const R = this.sim, G = R.game;
    const a = this.makeHuman(c);
    // bot fill: a human takes a bot's slot
    if (this.settings.botFill) {
      const bots = R.actors.filter((x) => x.isBot);
      if (bots.length && R.actors.length >= this.settings.maxPlayers) this.removeActor(bots.find((b) => !b.alive) || bots[bots.length - 1]);
    }
    R.actors.push(a);
    a.kills = 0; a.deaths = 0;
    hold(a);
    const base = { t: 'start', actors: this.roster(), map: this.settings.map, killLimit: G.killLimit, matchTime: G.matchTime };
    const poses = R.actors.map((x) => [x.id, rnd(x.x), rnd(x.z), rnd(x.yaw), x.spawnSeq || 0]);
    this.send(c, { ...base, you: a.id, poses, timeLeft: G.timeLeft });
    this.sendRoster();
  }

  leaveMatch(c) {
    const R = this.sim, a = c.actor;
    c.actor = null;
    if (!a) return;
    this.removeActor(a);
    if (this.settings.botFill && this.phase === 'playing' && R.actors.length < this.settings.maxPlayers && this.clients.size) {
      const b = R.bots.addOne();
      b.kills = 0; b.deaths = 0;
      R.game.respawnActor(b);
    }
    this.sendRoster();
  }

  removeActor(a) {
    const R = this.sim;
    a.alive = false;
    const i = R.actors.indexOf(a);
    if (i >= 0) R.actors.splice(i, 1);
  }

  runTimer() {
    if (this.timer) return;
    let last = Date.now(), acc = 0;
    const dt = 1 / TICK_HZ;
    this.timer = setInterval(() => {
      const now = Date.now();
      acc = Math.min(acc + (now - last) / 1000, dt * 4); // never try to catch up more than ~4 ticks
      last = now;
      try {
        while (acc >= dt) { acc -= dt; this.step(dt); }
      } catch (e) {
        log({ evt: 'tick_error', room: this.code, err: String(e && e.stack || e) });
      }
    }, 1000 / TICK_HZ);
  }
  stopMatch() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.sim = null; // a fresh sim each match: nothing leaks between matches
    for (const c of this.clients.values()) c.actor = null;
  }

  step(dt) {
    const R = this.sim;
    if (!R) return;
    const G = R.game;
    if (this.phase === 'playing') {
      R.time += dt;
      G.update(dt);
      this.tick++;
      if (G.state === 'over') this.finishMatch();
      this.sendSnapshot();
    } else if (this.phase === 'over' && Date.now() - this.overAt > OVER_TO_LOBBY * 1000) {
      this.phase = 'lobby';
      this.stopMatch();
      this.broadcastLobby();
      this.beat(true);
    }
    if (Date.now() - this.lastBeat > 10000) this.beat();
  }

  finishMatch() {
    const R = this.sim, G = R.game;
    this.phase = 'over';
    this.overAt = Date.now();
    const ranking = G.ranking().map((a) => a.id);
    this.sendSnapshot(); // flush the final kill
    this.broadcast({ t: 'over', ranking, winner: G.winner ? G.winner.id : 0 });
    const secs = Math.round((Date.now() - this.matchStartedAt) / 1000);
    const w = G.winner;
    stats(this.env).event('match_ended', this.code, null, { secs, winnerBot: w ? !!w.isBot : null, humans: this.humanCount() }).catch(() => {});
    log({ evt: 'match_ended', room: this.code, secs, winner: w && w.name, winnerBot: w && !!w.isBot });
    this.broadcastLobby();
  }

  sendSnapshot() {
    const R = this.sim, G = R.game;
    const acts = [];
    for (const a of R.actors) {
      const fl = (a.alive ? 1 : 0) | (a.crouch ? 2 : 0) | (a.moveMode === 'sprint' ? 4 : 0);
      acts.push([a.id, rnd(a.x), rnd(a.z), r3(a.yaw), r3(a.pitch), rnd(a.vx), rnd(a.vz), fl, a.kills, a.deaths]);
    }
    let pk = 0;
    G.pickups.forEach((p, i) => { if (p.active) pk |= 1 << i; });
    const base = { t: 's', tm: Math.round(R.time * 1000) / 1000, tl: Math.round(G.timeLeft * 10) / 10, a: acts, pk, e: this.events };
    // per-client 'me' block: private numbers the HUD needs
    for (const c of this.clients.values()) {
      const a = c.actor;
      const me = a ? { hp: Math.max(0, Math.round(a.health)), darts: a.wpn ? a.wpn.darts : 0, rt: a.alive ? 0 : rnd(a.respawnT || 0) } : null;
      this.send(c, { ...base, me });
    }
    this.events.length = 0; // same array: the bus handlers hold a reference to it
  }

  // ---- client inputs
  // the browser has pointer lock and is really playing: spawn on the next tick (game.js respawn loop)
  onReady(c) {
    const a = c.actor;
    if (!a || !a.waiting || this.phase !== 'playing') return;
    a.waiting = false;
    a.respawnT = 0.01;
  }

  onState(c, m) {
    const a = c.actor;
    if (!a || this.phase !== 'playing' || !a.alive) return;
    if ((m.sq | 0) !== (a.spawnSeq | 0)) return; // stale: sent before the client saw its respawn
    const x = +m.x, z = +m.z;
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    // trust the client's movement up to sprint speed (+ slack for packets that bunch up); ignore teleports
    const t = Date.now(), el = Math.min(1, (t - (a._stAt || t)) / 1000);
    a._stAt = t;
    if (Math.hypot(x - a.x, z - a.z) <= 7.5 * el + 0.75) {
      a.x = x; a.z = z;
      this.sim.world._resolve(a); // keep them out of walls
    }
    a.yaw = clampNum(m.yaw, -10, 10, a.yaw);
    a.pitch = clampNum(m.pitch, -1.5, 1.5, a.pitch);
    a.vx = clampNum(m.vx, -8, 8, 0); a.vz = clampNum(m.vz, -8, 8, 0);
    a.crouch = !!m.cr;
    a.moveMode = ['idle', 'walk', 'sprint', 'crouch'][m.mm | 0] || 'idle';
  }

  onClientSound(c, m) {
    const a = c.actor;
    if (!a || this.phase !== 'playing' || !a.alive || !CLIENT_SOUNDS.has(m.k)) return;
    const x = +m.x, y = +m.y, z = +m.z;
    if (![x, y, z].every(Number.isFinite) || Math.hypot(x - a.x, z - a.z) > 2.5) return;
    const ex = { mult: clampNum(m.m, 0.3, 2.5, 1) };
    if (Array.isArray(m.d) && m.d.length === 3 && m.d.every(Number.isFinite)) ex.dir = m.d;
    this.sim.sound(m.k, x, y, z, a, ex);
  }

  onAction(c, m) {
    const a = c.actor, R = this.sim;
    if (!a || this.phase !== 'playing' || !a.alive) return;
    if (Number.isFinite(m.yaw)) a.yaw = m.yaw;
    if (Number.isFinite(m.pitch)) a.pitch = clampNum(m.pitch, -1.5, 1.5, 0);
    if (m.cr != null) a.crouch = !!m.cr;
    const W = R.weapons, w = W.ensure(a);
    switch (m.a) {
      case 'fire':
        // the client already checked its own cooldowns; forgive a little jitter between its clock and ours, no more
        // (a client with a faster local fireInterval flag gets its extra shots dropped here)
        if (w.fireT > 0 && w.fireT < 0.06) w.fireT = 0;
        if (w.reloadT > 0 && w.reloadT < 0.3) { w.reloadT = 0; w.ammo = W.C.MAG; }
        W.fire(a);
        break;
      case 'knife':
        if (w.knifeT > 0 && w.knifeT < 0.15) w.knifeT = 0;
        W.knife(a);
        break;
      case 'dart':
        if (w.dartT > 0 && w.dartT < 0.15) w.dartT = 0;
        W.throwDart(a);
        break;
      case 'reload': W.reload(a); break;
    }
  }

  // ---- stats heartbeat
  beat(force) {
    const now = Date.now();
    if (!force && now - this.lastBeat < 10000) return;
    this.lastBeat = now;
    const bots = this.sim ? this.sim.actors.filter((a) => a.isBot).length : 0;
    stats(this.env).beat(this.code, { humans: this.humanCount(), bots, phase: this.phase, map: this.settings.map }).catch(() => {});
  }
}

// a human who hasn't clicked into the match yet: dead to the sim, never respawned until onReady
function hold(a) {
  a.alive = false; a._dead = true; a.waiting = true; a.respawnT = 1e9; a.health = 100;
}

function rnd(v) { return Math.round((v || 0) * 100) / 100; }
function r3(v) { return Math.round((v || 0) * 1000) / 1000; }
function clampNum(v, lo, hi, def) { v = +v; return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def; }
function cleanName(s) {
  return String(s || '').replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, 16);
}
function sanitizeSettings(s) {
  const o = {};
  for (const k in DEFAULTS) {
    if (k === 'botFill') { o[k] = !!s[k]; continue; }
    const [lo, hi] = LIMITS[k];
    o[k] = clampNum(s[k], lo, hi, DEFAULTS[k]);
    if (k !== 'botSkill') o[k] = Math.round(o[k]);
  }
  return o;
}

// ---------------------------------------------------------------------------------------------------------
// Stats: one global Durable Object (SQLite) that rooms report to. Fine to tens of thousands of rooms; see
// docs/MULTIPLAYER.md for when to move counting to Workers Analytics Engine.
// ---------------------------------------------------------------------------------------------------------
const LIVE_TTL = 35000; // a room that hasn't beaten in this long is gone

export class Stats extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.live = new Map(); // code -> {humans, bots, phase, map, updated, since}
    this.sql.exec(`CREATE TABLE IF NOT EXISTS players (uid TEXT PRIMARY KEY, first INTEGER, last INTEGER, sessions INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, type TEXT, room TEXT, detail TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS daily (day TEXT, key TEXT, n INTEGER, PRIMARY KEY (day, key))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS samples (ts INTEGER PRIMARY KEY, rooms INTEGER, players INTEGER, bots INTEGER)`);
  }

  count(key, n) {
    const day = new Date().toISOString().slice(0, 10);
    this.sql.exec(`INSERT INTO daily (day, key, n) VALUES (?, ?, ?) ON CONFLICT(day, key) DO UPDATE SET n = n + excluded.n`, day, key, n || 1);
  }

  async event(type, room, uid, detail) {
    const now = Date.now();
    this.sql.exec(`INSERT INTO events (ts, type, room, detail) VALUES (?, ?, ?, ?)`, now, type, room || '', detail ? JSON.stringify(detail) : '');
    this.count(type);
    if (type === 'player_joined' && uid) {
      const known = this.sql.exec(`SELECT uid FROM players WHERE uid = ?`, uid).toArray().length > 0;
      if (known) this.sql.exec(`UPDATE players SET last = ?, sessions = sessions + 1 WHERE uid = ?`, now, uid);
      else { this.sql.exec(`INSERT INTO players (uid, first, last, sessions) VALUES (?, ?, ?, 1)`, uid, now, now); this.count('new_players'); }
    }
    if (type === 'player_left' && detail && detail.secs) this.count('player_seconds', detail.secs);
    if (Math.random() < 0.01) this.sql.exec(`DELETE FROM events WHERE id < (SELECT MAX(id) FROM events) - 20000`);
    await this.ensureAlarm();
  }

  async beat(code, info) {
    if (!info) this.live.delete(code);
    else {
      const prev = this.live.get(code);
      this.live.set(code, { ...info, updated: Date.now(), since: prev ? prev.since : Date.now() });
    }
    await this.ensureAlarm();
  }

  liveTotals() {
    const now = Date.now();
    let rooms = 0, players = 0, bots = 0;
    for (const [code, r] of this.live) {
      if (now - r.updated > LIVE_TTL) { this.live.delete(code); continue; }
      rooms++; players += r.humans; bots += r.bots;
    }
    return { rooms, players, bots };
  }

  // sample concurrency once a minute while anything is live
  async ensureAlarm() {
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + 60000);
  }
  async alarm() {
    const t = this.liveTotals();
    const ts = Math.floor(Date.now() / 60000) * 60000;
    this.sql.exec(`INSERT OR REPLACE INTO samples (ts, rooms, players, bots) VALUES (?, ?, ?, ?)`, ts, t.rooms, t.players, t.bots);
    this.sql.exec(`DELETE FROM samples WHERE ts < ?`, Date.now() - 14 * 86400000);
    if (t.rooms > 0) await this.ctx.storage.setAlarm(Date.now() + 60000);
  }

  async summary() {
    const now = Date.now();
    const live = this.liveTotals();
    const today = new Date().toISOString().slice(0, 10);
    const daily = this.sql.exec(`SELECT day, key, n FROM daily WHERE day >= ? ORDER BY day`, new Date(now - 30 * 86400000).toISOString().slice(0, 10)).toArray();
    const totals = {};
    for (const r of this.sql.exec(`SELECT key, SUM(n) AS n FROM daily GROUP BY key`).toArray()) totals[r.key] = r.n;
    const uniq = this.sql.exec(`SELECT COUNT(*) AS n FROM players`).one().n;
    const active24 = this.sql.exec(`SELECT COUNT(*) AS n FROM players WHERE last > ?`, now - 86400000).one().n;
    const samples = this.sql.exec(`SELECT ts, rooms, players, bots FROM samples WHERE ts > ? ORDER BY ts`, now - 48 * 3600000).toArray();
    const peak = this.sql.exec(`SELECT MAX(players) AS p, MAX(rooms) AS r FROM samples`).one();
    const recent = this.sql.exec(`SELECT ts, type, room, detail FROM events ORDER BY id DESC LIMIT 100`).toArray();
    const rooms = [...this.live.entries()].map(([code, r]) => ({ code, ...r })).sort((a, b) => b.humans - a.humans);
    return { now, today, live, rooms, uniquePlayers: uniq, active24h: active24, totals, daily, samples, peak: { players: peak.p || 0, rooms: peak.r || 0 }, recent };
  }
}
