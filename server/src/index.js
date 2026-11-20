// REVERB multiplayer server: a Cloudflare Worker with one Durable Object per room (Room) and one for stats (Stats).
//
//   POST /api/rooms                 -> {code}            create a room (the creator becomes host when they connect)
//   POST /api/quick                 -> {code}            quick play: a public room with a free slot (made if none)
//   GET  /api/quick                 -> {players, rooms}  how many people are in public and private rooms now
//   GET  /api/rooms/:code           -> {open, players, max, phase}
//   GET  /api/rooms/:code/ws?name=&pt=    WebSocket into the room (pt: the signed player id from an earlier welcome)
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
import { nameAllowed } from './names.js';

const CODE_CHARS = 'BCDFGHJKMNPQRSTVWXZ23456789'; // no vowels (no words), no 0/O/1/I/L
const CODE_LEN = 4;
const TICK_HZ = 30;
const PROTOCOL = 2;

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
      if (await limited(env.RL_CREATE, req)) return tooMany(cors);
      // kill switch: `wrangler secret put ROOMS_DISABLED` (any value) stops new rooms; running rooms finish
      if (env.ROOMS_DISABLED) return json({ error: 'online play is paused, try again later' }, 503, cors);
      for (let tries = 0; tries < 8; tries++) {
        const code = randomCode();
        if (await room(env, code).claim(code)) return json({ code }, 200, cors);
      }
      return json({ error: 'could not allocate a room code' }, 503, cors);
    }

    if (p === '/api/quick' && req.method === 'GET') {
      if (await limited(env.RL_LOOKUP, req)) return tooMany(cors);
      // every menu polls this: answer from this isolate's copy for ONLINE_TTL instead of asking the one Stats object
      // each time (a Worker's Cache-Control header alone caches nothing)
      if (!onlineCache || Date.now() - onlineCache.at > ONLINE_TTL) {
        // summary() fallback: a Stats object still on the previous deploy's code has no playing() yet
        const st = stats(env);
        const n = await st.playing().catch(async () => (await st.summary()).live);
        onlineCache = { at: Date.now(), body: { players: n.players, rooms: n.rooms } };
      }
      return json(onlineCache.body, 200, { ...cors, 'Cache-Control': 'public, max-age=15' });
    }
    if (p === '/api/quick' && req.method === 'POST') {
      if (!originOk(origin, env)) return json({ error: 'origin not allowed' }, 403, cors);
      if (await limited(env.RL_CREATE, req)) return tooMany(cors);
      if (env.ROOMS_DISABLED) return json({ error: 'online play is paused, try again later' }, 503, cors);
      const found = await matcher(env).find();
      if (found) return json({ code: found }, 200, cors);
      // none with room: make one here (a room lives near whoever first touches it, so near this player)
      for (let tries = 0; tries < 8; tries++) {
        const code = randomCode();
        if (await room(env, code).claim(code, true)) { await matcher(env).add(code, QUICK.maxPlayers); return json({ code }, 200, cors); }
      }
      return json({ error: 'could not allocate a room code' }, 503, cors);
    }

    const m = p.match(/^\/api\/rooms\/([A-Za-z0-9]{4})(\/ws)?$/);
    if (m) {
      const code = m[1].toUpperCase();
      if (m[2]) {
        if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
        if (!originOk(origin, env)) return new Response('origin not allowed', { status: 403 });
        if (await limited(env.RL_CONNECT, req)) return new Response('too many requests', { status: 429 });
        const fwd = new Request(req.url, req);
        fwd.headers.set('X-Room-Code', code);
        // the room trusts these headers, so they are always set here (never the client's own)
        const pid = await playerId(env, url.searchParams.get('pt'));
        fwd.headers.set('X-Player-Id', pid.id);
        if (pid.token) fwd.headers.set('X-Player-Token', pid.token); else fwd.headers.delete('X-Player-Token');
        return room(env, code).fetch(fwd);
      }
      if (await limited(env.RL_LOOKUP, req)) return tooMany(cors);
      return json(await room(env, code).info(), 200, cors);
    }
    return json({ error: 'not found' }, 404, cors);
  },
};

// per-IP rate limits (wrangler.jsonc `ratelimits`). They stop one script from waking rooms and spending the daily
// allowance; a refused request still counts as a Worker request, so a WAF rate-limiting rule on api.playreverb.com is
// the layer in front of this. Loopback (wrangler dev, the test scripts) is never limited.
async function limited(rl, req) {
  if (!rl) return false;
  const ip = req.headers.get('CF-Connecting-IP') || '';
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return false;
  try { return !(await rl.limit({ key: ip })).success; } catch (e) { return false; }
}
// Signed player ids. A browser keeps the token `<id>.<sig>` it was given in a welcome and sends it back as `pt`;
// sig is HMAC-SHA256 of the id under the PLAYER_ID_SECRET secret, so ids can't be made up or borrowed, only issued.
// That makes the id something bans, per-player limits and (later) accounts can key on. A missing or bad token gets a
// fresh id. Without the secret nothing verifies, so every connection is a new player (and it's logged).
const PID_RE = /^[0-9a-f]{32}$/;
let pidKey = null, pidKeySecret = null, pidWarned = false;
async function pidHmac(env) {
  const secret = env.PLAYER_ID_SECRET;
  if (!secret) return null;
  if (pidKey && pidKeySecret === secret) return pidKey;
  pidKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  pidKeySecret = secret;
  return pidKey;
}
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function unb64u(s) {
  try { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, (ch) => ch.charCodeAt(0)); } catch (e) { return null; }
}
async function playerId(env, token) {
  const key = await pidHmac(env);
  if (!key && !pidWarned) { pidWarned = true; log({ evt: 'pid_secret_missing' }); }
  const [id, sig] = String(token || '').split('.');
  if (key && PID_RE.test(id || '') && sig) {
    const raw = unb64u(sig);
    if (raw && await crypto.subtle.verify('HMAC', key, raw, new TextEncoder().encode('pid:' + id))) return { id };
  }
  const nid = randomKey();
  if (!key) return { id: nid };
  const nsig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('pid:' + nid));
  return { id: nid, token: nid + '.' + b64u(nsig) };
}
const tooMany = (cors) => json({ error: 'too many requests, slow down' }, 429, { ...cors, 'Retry-After': '30' });
const ONLINE_TTL = 15000;
let onlineCache = null;

const room = (env, code) => env.ROOMS.get(env.ROOMS.idFromName(code));
const stats = (env) => env.STATS.get(env.STATS.idFromName('global'));
const matcher = (env) => env.MATCHER.get(env.MATCHER.idFromName('global'));

function randomKey() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
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
// quick play rooms: fixed settings, no host, matches back to back on a random map
const QUICK = { ...DEFAULTS, maxPlayers: 6 };
const LIMITS = { map: [0, 2], maxPlayers: [2, 8], botSkill: [0, 1], killLimit: [1, 50], timeLimit: [0, 20] }; // timeLimit 0 = no time limit
// players pick from these; bots in a match take the rest. Keep in sync with R.PALETTE in core.js.
const HUMAN_COLORS = ['#ff4d58', '#ff851a', '#ffd11a', '#94ff1a', '#42f0cd', '#1ac2ff', '#8989f5', '#ff1ad1'];
// sounds a client makes itself and forwards (everything else the room generates)
const CLIENT_SOUNDS = new Set(['click']); // footsteps are the room's own (see footsteps)
const OVER_TO_LOBBY = 8; // seconds the room stays 'over' before it returns to the lobby
const COUNTDOWN = 5; // seconds from a match starting to play starting: everyone clicks in, nobody moves, bots wait
// flood guard: an honest client sends ~35 messages a second at most (movement 20 Hz, steps, fire, ping). Over
// MAX_MSGS_PER_SEC the rest of that second is dropped; FLOOD_STRIKES seconds over it in a row, or FLOOD_HARD in one
// second, closes the socket (4001, never retried). Every message is billed on arrival, dropped or not, so a script
// has to be disconnected, not just ignored. A burst after a stalled connection is a single second over.
const MAX_MSGS_PER_SEC = 60, FLOOD_STRIKES = 2, FLOOD_HARD = 150;
// lobby messages (name, colour, ready, settings) each go out to the whole room: a token bucket per client
const LOBBY_RATE = [0.25, 6]; // seconds per token, burst
// a socket that drops without saying 'bye' (refresh, wifi blip, closed laptop) keeps its seat, actor and score this
// long; the browser comes back with the rejoin key from its welcome message
const HOLD_MS = 30000;
const CLAIM_TTL = 120000; // a claimed room with nobody in it stays joinable this long
// idle rooms (a room bills for every second it's open, and bots keep a match ticking): a match where no human has
// moved, aimed or acted for MATCH_IDLE_MS ends (results, then the lobby); a room where nobody has done anything for
// LOBBY_IDLE_MS is closed. Movement keepalives don't count as activity, only changes do.
const MATCH_IDLE_MS = 3 * 60000, LOBBY_IDLE_MS = 10 * 60000, IDLE_CHECK_MS = 30000;
// movement: the client owns its position, but it can only spend distance the room has granted it.
// Budget accrues at a little over sprint speed, so packet rate buys nothing. The cap covers about 0.9 s of sprinting
// so a connection that stalls and then delivers a burst is followed in full (the old check allowed an 8 m hop too).
const JUMP_MAX = 0.95; // m: a jump peaks at about 0.84 (player.js JUMP_V, GRAV)
// a jump is ~0.65 s in the air; jumping off furniture adds a fall. Off the ground longer than this, the room puts you
// back on it (no hovering over cover) but keeps you counted as airborne (shots stay wild).
const AIR_MAX = 1.5;
const MOVE_RATE = 7.5, MOVE_CAP = 6, CROUCH_MAX = 2.6, SPRINT_MIN = 5.5;
// client-forwarded sounds: token bucket per kind {seconds per token, burst}. click matches CLICK_COOLDOWN (0.55 s);
// footsteps come once per stride (0.3 s sprinting at the fastest) and may arrive bunched up.
const SOUND_RATE = { click: [0.5, 1] };
const SOUND_MULT = [0.45, 2.0]; // R.FLOOR_MULT range
const SOUND_REACH = 1.0;        // metres a forwarded sound may sit from where the sender last said it was
// footsteps the room makes from granted movement: one per stride, stride = nominal speed x interval (player.js M:
// WALK 4.2, SPRINT 6.8, CROUCH 1.9, STEP_INT, GRAV; keep in sync)
const STRIDE = { step: 4.2 * 0.42, sprint: 6.8 * 0.30, crouch: 1.9 * 0.6 }, GRAV = 16;
// who sees whom (anti-wallhack): a client gets another actor's position only while it could see them. Checked every
// tick by line of sight from its eye, from where it's heading (VIS_LEAD s ahead) and from VIS_SIDE m either side
// (peeking a corner), to the other actor's feet, chest and head; or within VIS_NEAR m. A sighting holds VIS_HOLD ms
// so a body half-in a doorway doesn't flicker. Sounds go to a client that could hear them (the audio's own reach:
// radius x directivity x 1.15) or see where they were made.
const VIS_LEAD = 0.25, VIS_SIDE = 0.5, VIS_NEAR = 2.5, VIS_HOLD = 600, SND_MARGIN = 2.5;
// action pacing: the room times each player's fire/knife/dart/reload on its own clock. A request may come up to `tol`
// seconds early (network jitter), but that time is owed and paid back by later requests that come late; once the owed
// time passes 2 x tol, early requests are refused. Honest jitter nets out, a client with a faster cooldown runs dry.

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
    this.idleTimer = 0;
    this.events = [];
    this.tick = 0;
    this.lastBeat = 0;
    this.matchStartedAt = 0;
    this.overAt = 0;
    this.pub = false;         // quick play room: no host, matches run back to back
  }

  // ---- RPC from the Worker
  async claim(code, pub) {
    if (this.clients.size || (this.claimedAt && Date.now() - this.claimedAt < CLAIM_TTL)) return false;
    this.code = code;
    this.claimedAt = Date.now();
    this.pub = !!pub;
    this.settings = pub ? { ...QUICK, map: randomMap() } : { ...DEFAULTS };
    this.phase = 'lobby';
    stats(this.env).event('room_created', code, null, pub ? { quick: true } : null).catch(() => {});
    log({ evt: 'room_created', room: code, quick: !!pub });
    return true;
  }
  async info() {
    const open = this.isOpen();
    return { open, players: this.humanCount(), max: this.settings.maxPlayers, phase: this.phase, quick: this.pub };
  }

  // live = someone is in it, or it was claimed recently and the creator has yet to connect
  isOpen() { return !!this.code && (this.clients.size > 0 || Date.now() - this.claimedAt < CLAIM_TTL); }

  // ---- WebSocket connect
  async fetch(req) {
    const url = new URL(req.url);
    const code = req.headers.get('X-Room-Code');
    // never claimed, closed (last player left), expired claim, or evicted: only POST /api/rooms opens a room
    if (!this.isOpen() || this.code !== code) return new Response('no such room', { status: 404 });
    // kill switch: nobody may (re)fill an empty room; people already in a room can still rejoin it
    if (this.env.ROOMS_DISABLED && !this.clients.size) return new Response('online play is paused', { status: 503 });
    const pair = new WebSocketPair();
    const [clientWs, ws] = Object.values(pair);
    ws.accept();
    const reject = (msg) => { ws.send(JSON.stringify({ t: 'error', msg })); ws.close(4000, msg); };
    if (+url.searchParams.get('v') !== PROTOCOL) { reject('game version mismatch, reload the page'); return new Response(null, { status: 101, webSocket: clientWs }); }

    // rejoin: the key matches a seat in this room (held, or one whose old socket we haven't seen die yet)
    const rk = url.searchParams.get('rk');
    const back = rk ? [...this.clients.values()].find((o) => o.key === rk) : null;
    if (back) { this.rebind(back, ws, req.headers.get('X-Player-Token')); return new Response(null, { status: 101, webSocket: clientWs }); }

    if (this.humanCount() >= this.settings.maxPlayers) { reject('room is full'); return new Response(null, { status: 101, webSocket: clientWs }); }

    const c = {
      cid: this.nextCid++, ws,
      name: 'Player',
      uid: req.headers.get('X-Player-Id') || '',
      color: this.freeColor(url.searchParams.get('color')), actor: null, joinedAt: Date.now(),
      winStart: Date.now(), winCount: 0, rtt: 0,
      key: randomKey(), heldTimer: 0, lastActive: Date.now(),
    };
    const asked = cleanName(url.searchParams.get('name')) || 'Player';
    const nameOk = this.nameOk(asked, c);
    c.name = this.uniqueName(nameOk ? asked : 'Player', c.cid);
    this.clients.set(c.cid, c);
    if (!this.pub && (!this.hostCid || !this.clients.has(this.hostCid))) this.hostCid = c.cid;

    this.listen(c, ws);
    if (!this.idleTimer) this.idleTimer = setInterval(() => this.checkIdle(), IDLE_CHECK_MS);
    this.send(c, { t: 'welcome', cid: c.cid, code: this.code, protocol: PROTOCOL, rk: c.key, pt: req.headers.get('X-Player-Token') || undefined });
    if (!nameOk) this.send(c, { t: 'error', msg: `that name isn't allowed here, so you're ${c.name}` });
    if (this.phase === 'playing') this.joinMatch(c);
    else if (this.pub && this.phase === 'lobby') this.startMatch(); // quick play: straight into a match with bots
    this.broadcastLobby();
    stats(this.env).event('player_joined', this.code, c.uid, { name: c.name, humans: this.humanCount() }).catch(() => {});
    log({ evt: 'player_joined', room: this.code, cid: c.cid, name: c.name, humans: this.humanCount() });
    this.beat(true);
    return new Response(null, { status: 101, webSocket: clientWs });
  }

  listen(c, ws) {
    ws.addEventListener('message', (e) => { if (c.ws === ws) this.onMessage(c, e.data); });
    ws.addEventListener('close', () => this.onSocketGone(c, ws));
    ws.addEventListener('error', () => this.onSocketGone(c, ws));
  }

  // a socket closed: a 'bye' (or the room shutting it) means gone for good; anything else holds the seat
  onSocketGone(c, ws) {
    if (c.ws !== ws || !this.clients.has(c.cid)) return; // replaced by a rejoin, or already gone
    if (c.bye) { this.onClose(c); return; }
    c.ws = null;
    if (c.actor && this.phase === 'playing') hold(c.actor); // out of play (no free kills) until they click back in
    clearTimeout(c.heldTimer);
    c.heldTimer = setTimeout(() => { if (!c.ws) this.onClose(c); }, HOLD_MS);
    log({ evt: 'player_held', room: this.code, cid: c.cid });
    this.broadcastLobby();
  }

  // same seat, new socket: keeps cid (so host stays host), name, colour, actor and score
  rebind(c, ws, pt) {
    clearTimeout(c.heldTimer); c.heldTimer = 0;
    const old = c.ws;
    c.ws = ws; // set first: the old socket's close event is then ignored
    if (old) try { old.close(4003, 'opened in another tab'); } catch (e) { /* gone */ }
    c.winStart = Date.now(); c.winCount = 0; c.bye = false; c.lastActive = Date.now();
    this.listen(c, ws);
    this.send(c, { t: 'welcome', cid: c.cid, code: this.code, protocol: PROTOCOL, rk: c.key, rejoin: true, pt: pt || undefined });
    if (this.phase === 'playing') {
      if (c.actor) this.rejoinMatch(c); else this.joinMatch(c);
    }
    this.broadcastLobby();
    log({ evt: 'player_rejoined', room: this.code, cid: c.cid, held: !old });
  }

  humanCount() { return this.clients.size; }
  // send everyone out for good (4002: the client shows the reason and doesn't try to rejoin)
  closeAll(reason) {
    for (const o of [...this.clients.values()]) { o.bye = true; try { o.ws.close(4002, reason); } catch (e) { /* gone */ } this.onClose(o); }
  }
  checkIdle() {
    if (!this.code || !this.clients.size) return;
    if (this.pub) {
      // quick play never stops for one AFK player: they're sent out instead (the match goes on for everyone else,
      // and with nobody left the room closes)
      const now = Date.now();
      for (const c of [...this.clients.values()]) {
        if (now - c.lastActive <= MATCH_IDLE_MS || !c.ws) continue;
        log({ evt: 'player_removed_idle', room: this.code, cid: c.cid });
        c.bye = true;
        try { c.ws.close(4002, 'removed from quick play after 3 minutes without moving'); } catch (e) { /* gone */ }
        this.onClose(c);
      }
      return;
    }
    let last = 0;
    for (const c of this.clients.values()) if (c.lastActive > last) last = c.lastActive;
    const idle = Date.now() - last;
    if (this.phase === 'playing' && this.sim && idle > MATCH_IDLE_MS) {
      log({ evt: 'match_ended_idle', room: this.code, idleSecs: Math.round(idle / 1000) });
      this.sim.game.endMatch();
    } else if (this.phase !== 'playing' && idle > LOBBY_IDLE_MS) {
      log({ evt: 'room_closed_idle', room: this.code, idleSecs: Math.round(idle / 1000) });
      this.closeAll('the room closed after 10 minutes with nobody playing');
    }
  }
  // name moderation (names.js): slurs and hate nowhere, swearing not in quick play (strangers). Blocked names are
  // logged, so the lists can be tuned from Workers Logs (evt name_blocked).
  nameOk(name, c) {
    if (nameAllowed(name, this.pub)) return true;
    log({ evt: 'name_blocked', room: this.code, cid: c.cid, uid: c.uid, name, quick: this.pub });
    return false;
  }
  // unique display names in a room (case-insensitive: the HUD upper-cases them); never a bot's name or "YOU"
  uniqueName(name, cid) {
    const taken = new Set(['YOU', 'BOT']);
    for (const o of this.clients.values()) if (o.cid !== cid) taken.add(o.name.toUpperCase());
    for (const n of botNames()) taken.add(n.toUpperCase());
    if (this.sim) for (const a of this.sim.actors) if (a.isBot) taken.add(String(a.name).toUpperCase());
    if (!taken.has(name.toUpperCase())) return name;
    const stem = name.slice(0, 14);
    let i = 2;
    while (taken.has((stem + i).toUpperCase())) i++;
    return stem + i;
  }
  // the wanted colour if it's in the palette and nobody else has it, else the first free one
  freeColor(want, cid) {
    const used = new Set([...this.clients.values()].filter((c) => c.cid !== cid).map((c) => c.color));
    if (HUMAN_COLORS.includes(want) && !used.has(want)) return want;
    return HUMAN_COLORS.find((x) => !used.has(x)) || HUMAN_COLORS[0];
  }
  send(c, o) { try { c.ws.send(JSON.stringify(o)); } catch (e) { /* closed */ } }
  broadcast(o) { const s = JSON.stringify(o); for (const c of this.clients.values()) { try { c.ws.send(s); } catch (e) { /* closed */ } } }

  broadcastLobby() {
    this.broadcast({
      t: 'lobby', code: this.code, phase: this.phase, host: this.hostCid, settings: this.settings, quick: this.pub,
      players: [...this.clients.values()].map((c) => ({ cid: c.cid, name: c.name, color: c.color, rtt: Math.round(c.rtt), away: c.ws ? 0 : 1, rdy: c.ready ? 1 : 0 })),
    });
  }

  onClose(c) {
    if (!this.clients.has(c.cid)) return;
    this.clients.delete(c.cid);
    clearTimeout(c.heldTimer);
    const secs = Math.round((Date.now() - c.joinedAt) / 1000);
    stats(this.env).event('player_left', this.code, c.uid, { name: c.name, secs }).catch(() => {});
    log({ evt: 'player_left', room: this.code, cid: c.cid, secs, humans: this.humanCount() });
    if (c.actor && this.sim) this.leaveMatch(c);
    if (this.hostCid === c.cid) this.hostCid = this.clients.size && !this.pub ? this.clients.keys().next().value : 0;
    if (!this.clients.size) {
      clearInterval(this.idleTimer); this.idleTimer = 0;
      this.stopMatch();
      this.phase = 'lobby';
      this.claimedAt = 0; // the code can be reused
      const code = this.code;
      this.code = null;   // closed: a socket to this code now gets 404 until someone claims it again
      this.settings = { ...DEFAULTS };
      if (this.pub) matcher(this.env).report(code, null).catch(() => {});
      this.pub = false;
      stats(this.env).event('room_closed', code, null, null).catch(() => {});
      stats(this.env).beat(code, null).catch(() => {});
      log({ evt: 'room_closed', room: code });
      return;
    }
    this.broadcastLobby();
    this.beat(true);
    this.startIfAllReady(); // the one holding it up may just have left
  }

  // lobby ready check: a hosted room starts by itself once every player has readied up (the host can start sooner)
  startIfAllReady() {
    if (this.pub || this.phase !== 'lobby' || !this.clients.size || this.env.ROOMS_DISABLED) return;
    for (const c of this.clients.values()) if (!c.ready) return;
    log({ evt: 'all_ready', room: this.code, humans: this.clients.size });
    this.startMatch();
  }

  onMessage(c, data) {
    const now = Date.now();
    if (now - c.winStart > 1000) {
      // a whole second over the limit is a strike; a second back under it clears them
      c.strikes = c.winCount > MAX_MSGS_PER_SEC ? (c.strikes || 0) + 1 : 0;
      c.winStart = now; c.winCount = 0;
    }
    if (++c.winCount > MAX_MSGS_PER_SEC) {
      if (c.winCount > FLOOD_HARD || (c.strikes || 0) >= FLOOD_STRIKES) {
        if (!c.bye) log({ evt: 'flood_closed', room: this.code, cid: c.cid, n: c.winCount, strikes: c.strikes || 0 });
        c.bye = true;
        try { c.ws.close(4001, 'too many messages'); } catch (e) { /* gone */ }
      }
      return;
    }
    if (typeof data !== 'string' || data.length > 2000) return;
    let m;
    try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.t !== 'ping' && m.t !== 'rtt' && m.t !== 'st' && m.t !== 'snd') c.lastActive = now; // 'st' counts only when it changes (onState)
    if ((m.t === 'name' || m.t === 'color' || m.t === 'lready' || m.t === 'settings') && !bucket(c, 'lobby', LOBBY_RATE, now / 1000)) return;
    switch (m.t) {
      case 'ping': this.send(c, { t: 'pong', c: m.c }); break;
      case 'bye': c.bye = true; break; // leaving on purpose: no seat to hold when the socket closes
      case 'rtt': c.rtt = clampNum(m.ms, 0, 5000, 0); break;
      case 'name': {
        let n = cleanName(m.name);
        if (n && !this.nameOk(n, c)) { this.send(c, { t: 'error', msg: "that name isn't allowed here" }); this.broadcastLobby(); return; }
        if (n) n = this.uniqueName(n, c.cid);
        if (n && n !== c.name) { c.name = n; if (c.actor) c.actor.name = n; this.broadcastLobby(); if (this.sim) this.sendRoster(); }
        break;
      }
      case 'settings':
        if (c.cid !== this.hostCid || this.phase === 'playing') return;
        this.settings = sanitizeSettings({ ...this.settings, ...(m.settings || {}) });
        this.broadcastLobby();
        break;
      case 'color': { // pick a palette colour (taken ones are refused)
        const col = String(m.c || '').toLowerCase();
        if (!HUMAN_COLORS.includes(col) || col === c.color || this.freeColor(col, c.cid) !== col) { this.broadcastLobby(); return; }
        c.color = col;
        if (c.actor) c.actor.color = col;
        this.broadcastLobby();
        if (this.sim) { this.recolorBots(); this.sendRoster(); }
        break;
      }
      case 'lready': // lobby ready toggle
        if (this.phase !== 'lobby') return;
        c.ready = !!m.on;
        this.broadcastLobby();
        this.startIfAllReady();
        break;
      case 'start': // only from the lobby: during results the old sim is still alive
        if (c.cid !== this.hostCid || this.phase !== 'lobby') return;
        if (this.env.ROOMS_DISABLED) { this.send(c, { t: 'error', msg: 'online play is paused, try again later' }); this.broadcastLobby(); return; }
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
        this.closeAll('the host closed the room');
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
    // each event keeps what sendSnapshot needs to decide who gets it (see VIS_*): w is what goes on the wire
    R.bus.on('sound', (ev) => {
      const base = R.SOUNDS[ev.kind];
      const mult = base ? r2(ev.radius / base.radius) : 1;
      E.push({ w: ['s', ev.kind, r2(ev.x), r2(ev.y), r2(ev.z), id(ev.actor), mult, ev.dir ? ev.dir.map((v) => Math.round(v * 1000) / 1000) : 0], snd: ev, by: ev.actor || null });
    });
    R.bus.on('damage', (e) => E.push({ w: ['d', id(e.target), id(e.attacker), e.amount, e.part, r2(e.x), r2(e.y), r2(e.z)], tgt: e.target, att: e.attacker || null }));
    R.bus.on('kill', (e) => E.push({ w: ['k', id(e.victim), id(e.killer), e.weapon, e.headshot ? 1 : 0] }));
    R.bus.on('spawn', (e) => {
      const a = e.actor;
      if (!a) return;
      a.spawnSeq = (a.spawnSeq || 0) + 1;
      for (const c of this.clients.values()) if (c.seen) c.seen.delete(a.id); // a sighting doesn't follow you to a new spawn
      a._air = false; a._lastY = a.y || 0; a._stepAcc = 0.5; // footsteps start fresh too
      E.push({ w: ['sp', a.id, r2(a.x), r2(a.z), r2(a.yaw), a.spawnSeq], sp: a });
    });
    // (pickups travel as the pk bits; who took one isn't sent, since the pickup's place would give them away)
    this.sim = R;
    return R;
  }

  // players' colours win: a bot wearing a player's colour (or another bot's) moves to a free one
  recolorBots() {
    const R = this.sim;
    if (!R) return;
    for (const b of R.actors) {
      if (!b.isBot) continue;
      if (R.actors.some((o) => o !== b && o.color === b.color && (!o.isBot || R.actors.indexOf(o) < R.actors.indexOf(b)))) b.color = R.freeColor(R.actors, b);
    }
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
    G.rules = { killLimit: S.killLimit, matchTime: S.timeLimit * 60 }; // 0 = no limit
    G.botCount = S.botFill ? Math.max(0, S.maxPlayers - humans.length) : 0;
    R.bots.skill = S.botSkill;
    R.time = 0;
    G.start(S.map);
    G.humans = null;
    for (const a of humans) hold(a); // out of play until they click in (see onReady)
    this.events.length = 0; // initial spawns are in the start message
    this.phase = 'playing';
    this.countdown = COUNTDOWN;
    for (const c of this.clients.values()) c.ready = false; // next lobby starts un-ready
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
    const base = { t: kind || 'roster', actors: this.roster(), map: this.settings.map, killLimit: G.killLimit, matchTime: wireTime(G.matchTime) };
    if (kind !== 'start') { this.broadcast(base); return; }
    // each client learns which actor is theirs, plus every actor's starting pose
    // each client learns its own pose only; everyone else arrives in snapshots once they're in sight
    for (const c of this.clients.values()) this.send(c, { ...base, you: c.actor ? c.actor.id : 0, poses: ownPose(c.actor), cd: this.countdown || 0 });
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
    this.recolorBots();
    a.kills = 0; a.deaths = 0;
    hold(a);
    const base = { t: 'start', actors: this.roster(), map: this.settings.map, killLimit: G.killLimit, matchTime: wireTime(G.matchTime) };
    this.send(c, { ...base, you: a.id, poses: ownPose(a), timeLeft: isFinite(G.timeLeft) ? G.timeLeft : -1, cd: this.countdown || 0 });
    this.sendRoster();
  }

  // back after a drop, mid-match: the same actor (kills, deaths), held until they click in like a new joiner
  rejoinMatch(c) {
    const R = this.sim, G = R.game, a = c.actor;
    hold(a);
    const base = { t: 'start', actors: this.roster(), map: this.settings.map, killLimit: G.killLimit, matchTime: wireTime(G.matchTime) };
    this.send(c, { ...base, you: a.id, poses: ownPose(a), timeLeft: isFinite(G.timeLeft) ? G.timeLeft : -1, cd: this.countdown || 0 });
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
    if (this.phase === 'playing' && this.countdown > 0) {
      // countdown: the world holds still; humans who click in now spawn the moment it ends (onReady)
      this.countdown = Math.max(0, this.countdown - dt);
      this.tick++;
      if (G.state === 'over') { this.countdown = 0; this.finishMatch(); return; } // the host ended it before GO
      if (this.tick % 3 === 0 || this.countdown === 0) this.sendSnapshot();
    } else if (this.phase === 'playing') {
      R.time += dt;
      G.update(dt);
      this.tick++;
      if (G.state === 'over') this.finishMatch();
      this.sendSnapshot();
    } else if (this.phase === 'over' && Date.now() - this.overAt > OVER_TO_LOBBY * 1000) {
      this.phase = 'lobby';
      this.stopMatch();
      if (this.pub && this.clients.size && !this.env.ROOMS_DISABLED) {
        // quick play: the next match starts by itself on another map
        this.settings.map = randomMap(this.settings.map);
        this.startMatch();
        return;
      }
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

  // Each client gets its own snapshot: full rows only for actors it can see (updateVis), short rows
  // [id, flags, kills, deaths] for the rest, and only the events it could hear or see (see VIS_*).
  sendSnapshot() {
    const R = this.sim, G = R.game, now = Date.now();
    this.updateVis(now);
    const full = new Map(), short = new Map();
    for (const a of R.actors) {
      const fl = (a.alive ? 1 : 0) | (a.crouch ? 2 : 0) | (a.moveMode === 'sprint' ? 4 : 0);
      full.set(a, [a.id, rnd(a.x), rnd(a.z), r3(a.yaw), r3(a.pitch), rnd(a.vx), rnd(a.vz), fl, a.kills, a.deaths, rnd(a.y || 0)]);
      short.set(a, [a.id, a.alive ? 1 : 0, a.kills, a.deaths]);
    }
    let pk = 0;
    G.pickups.forEach((p, i) => { if (p.active) pk |= 1 << i; });
    const base = { t: 's', cd: this.countdown > 0 ? Math.round(this.countdown * 10) / 10 : 0, tm: Math.round(R.time * 1000) / 1000, tl: isFinite(G.timeLeft) ? Math.round(G.timeLeft * 10) / 10 : -1, pk };
    // every 2 s: each human's ping (as their browser last reported it), by actor id, for the scoreboard
    if (this.tick % (TICK_HZ * 2) === 1) {
      base.pg = {};
      for (const c of this.clients.values()) if (c.actor) base.pg[c.actor.id] = Math.round(c.rtt);
    }
    for (const c of this.clients.values()) {
      const v = c.actor;
      const sees = (a) => a === v || (a.alive && c.seen && (c.seen.get(a.id) || 0) > now);
      const acts = R.actors.map((a) => (sees(a) ? full.get(a) : short.get(a)));
      const e = [];
      for (const ev of this.events) {
        if (ev.snd) { if (this.hears(v, ev)) e.push(ev.w); }
        else if (ev.tgt) {
          // damage: to the two people in it and anyone who can see the target; the victim also learns where the
          // shot came from (the hurt arrow), which its gunshot gave away anyway
          if (ev.tgt === v && ev.att) e.push([...ev.w, rnd(ev.att.x), rnd(ev.att.z)]);
          else if (ev.att === v || sees(ev.tgt)) e.push(ev.w);
        } else if (ev.sp) e.push(sees(ev.sp) ? ev.w : ['sp', ev.sp.id, null, null, null, ev.sp.spawnSeq]);
        else e.push(ev.w);
      }
      // private numbers the HUD needs
      const me = v ? { hp: Math.max(0, Math.round(v.health)), darts: v.wpn ? v.wpn.darts : 0, rt: v.alive ? 0 : rnd(v.respawnT || 0) } : null;
      this.send(c, { ...base, a: acts, e, me });
    }
    this.events.length = 0; // same array: the bus handlers hold a reference to it
  }

  // where client c could see from this tick: its eye, where it's heading and a step either side (peeking), each kept
  // only if the eye itself can see it (no looking out from inside a wall)
  viewPoints(v) {
    const W = this.sim.world, ey = (v.y || 0) + (v.alive ? this.sim.weapons.eyeY(v) : 0.45);
    const eye = [v.x, ey, v.z], pts = [eye];
    const rx = Math.cos(v.yaw || 0), rz = -Math.sin(v.yaw || 0); // weapons.right
    const cand = [[v.x + rx * VIS_SIDE, v.z + rz * VIS_SIDE], [v.x - rx * VIS_SIDE, v.z - rz * VIS_SIDE]];
    if (Math.hypot(v.vx || 0, v.vz || 0) > 0.3) cand.push([v.x + (v.vx || 0) * VIS_LEAD, v.z + (v.vz || 0) * VIS_LEAD]);
    for (const [x, z] of cand) if (W.los(eye[0], ey, eye[2], x, ey, z)) pts.push([x, ey, z]);
    return pts;
  }
  // refresh every client's sightings (c.seen: actor id -> ms until which it counts as seen)
  updateVis(now) {
    const R = this.sim, W = R.world;
    for (const c of this.clients.values()) {
      const v = c.actor;
      if (!c.seen) c.seen = new Map();
      if (!v || v.waiting) { c.seen.clear(); continue; } // not in play yet: nothing to see
      let pts = null;
      for (const a of R.actors) {
        if (a === v || !a.alive) continue;
        if ((c.seen.get(a.id) || 0) > now + VIS_HOLD / 2) continue; // seen a moment ago: still fresh
        let ok = Math.hypot(a.x - v.x, a.z - v.z) < VIS_NEAR;
        if (!ok) {
          pts = pts || this.viewPoints(v);
          const ay = a.y || 0, ty = [ay + 0.3, ay + (a.crouch ? 0.7 : 1.0), ay + R.weapons.eyeY(a) + 0.1];
          for (const p of pts) { for (const y of ty) if (W.los(p[0], p[1], p[2], a.x, y, a.z)) { ok = true; break; } if (ok) break; }
        }
        if (ok) c.seen.set(a.id, now + VIS_HOLD);
      }
    }
  }
  // could client actor v hear (the audio's own cut-off) or see where this sound was made?
  hears(v, ev) {
    if (!v) return false;
    const s = ev.snd;
    if (ev.by === v) return true;
    const ey = (v.y || 0) + (v.alive ? this.sim.weapons.eyeY(v) : 0.45);
    const R = this.sim, gain = R.soundGain ? R.soundGain(s, v.x, v.z) : 1;
    if (Math.hypot(s.x - v.x, (s.y || 0) - ey, s.z - v.z) <= (s.radius || 6) * gain * 1.15 + SND_MARGIN) return true;
    return R.world.los(v.x, ey, v.z, s.x, Math.max(0.3, s.y || 0), s.z);
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
    // trust the client's movement only as far as its distance budget goes (see MOVE_RATE). A longer claim moves
    // the actor that far toward it, so an honest client that lagged catches up and a cheat stays at sprint speed.
    const t = Date.now(), el = Math.min(1, (t - (a._stAt || t)) / 1000);
    a._stAt = t;
    const sk = x + ',' + z + ',' + m.yaw + ',' + m.pitch + ',' + m.cr;
    if (sk !== c.lastSt) { c.lastSt = sk; c.lastActive = t; } // keepalives repeat the same claim: not activity
    a._cx = x; a._cz = z; a._cseq = a.spawnSeq | 0; // the client's own idea of where it is (this life); see onClientSound
    a._budget = Math.min(MOVE_CAP, (a._budget == null ? MOVE_CAP : a._budget) + MOVE_RATE * el);
    // height (jumping, standing on furniture): no higher than a jump above the highest top under them, and back on
    // that top after AIR_MAX in the air
    const W = this.sim.world;
    const wantY = clampNum(m.y, 0, 3, 0), g = W.groundAt(a, 3), up = wantY > g + 0.05;
    a._airT = up ? (a._airT || 0) + el : 0;
    const grounded = up && a._airT > AIR_MAX;
    a.y = grounded ? g : Math.min(wantY, g + JUMP_MAX);
    const dx = x - a.x, dz = z - a.z, d = Math.hypot(dx, dz);
    let moved = 0;
    if (d > 0) {
      const k = Math.min(1, a._budget / d);
      const ox = a.x, oz = a.z;
      W.moveActor(a, dx * k, dz * k); // swept in 0.1 m steps: a claim on the far side of a wall stops at the wall
      moved = Math.hypot(a.x - ox, a.z - oz);
      a._budget -= d * k;
    }
    // smoothed speed the room actually granted: move mode and crouch come from this, not from the client's say-so
    a._sd = (a._sd || 0) * 0.7 + moved;
    a._st = (a._st || 0) * 0.7 + el;
    const spd = a._st > 0 ? a._sd / a._st : 0;
    a.yaw = clampNum(m.yaw, -10, 10, a.yaw);
    a.pitch = clampNum(m.pitch, -1.5, 1.5, a.pitch);
    a.vx = clampNum(m.vx, -8, 8, 0); a.vz = clampNum(m.vz, -8, 8, 0);
    a._spd = spd;
    // speed over just this message, so spread (weapons.speedOf) drops the moment you stop instead of ~0.5 s later.
    // Faking it means actually holding still for a message.
    a._spdNow = moved / Math.max(el, 0.05);
    a.air = grounded || a.y > W.groundAt(a, a.y) + 0.05; // shots in the air are wild (weapons.spreadDeg)
    a.crouch = !!m.cr && spd < CROUCH_MAX; // no small hitbox at running speed
    let mm = ['idle', 'walk', 'sprint', 'crouch'][m.mm | 0] || 'idle';
    if (spd > SPRINT_MIN) mm = 'sprint';                 // sprinting is sprinting, whatever the client says
    else if (mm === 'crouch' && !a.crouch) mm = 'walk';
    else if (mm === 'idle' && spd > 1) mm = 'walk';
    a.moveMode = mm;
    this.footsteps(a, moved);
  }

  // footsteps, made by the room from the movement it granted (player.js does the same for the local echo), so a
  // modded client can't walk silently: one per stride on the ground, a step on take-off, a landing thump by fall speed
  footsteps(a, moved) {
    const W = this.sim.world, y = a.y || 0;
    const air = y > W.groundAt(a, y) + 0.05;
    const mult = () => this.sim.FLOOR_MULT[W.floorMatAt(a.x, a.z)] || 1;
    const snd = (kind, m) => this.sim.sound(kind, a.x, y + 0.05, a.z, a, { mult: m });
    if (air) {
      if (!a._air && y > (a._lastY || 0) + 0.02) snd('step', mult()); // jumped (stepping off an edge is silent)
      a._peakY = a._air ? Math.max(a._peakY || 0, y) : y;
      a._stepAcc = Math.min(a._stepAcc == null ? 0.5 : a._stepAcc, 0.5);
    } else if (a._air) {
      const fall = Math.sqrt(2 * GRAV * Math.max(0, (a._peakY || y) - y));
      snd('sprint', Math.min(2, mult() * (0.8 + fall * 0.06)));
      a._stepAcc = 0;
    } else if (a.moveMode === 'idle' || moved <= 0) {
      a._stepAcc = Math.min(a._stepAcc == null ? 0.5 : a._stepAcc, 0.5);
    } else {
      const kind = a.moveMode === 'sprint' ? 'sprint' : a.moveMode === 'crouch' ? 'crouch' : 'step';
      a._stepAcc = (a._stepAcc == null ? 0.5 : a._stepAcc) + moved / STRIDE[kind];
      if (a._stepAcc >= 1) { a._stepAcc -= Math.floor(a._stepAcc); snd(kind, mult()); }
    }
    a._air = air; a._lastY = y;
  }

  onClientSound(c, m) {
    const a = c.actor;
    if (!a || this.phase !== 'playing' || !a.alive || !CLIENT_SOUNDS.has(m.k)) return;
    const x = +m.x, y = +m.y, z = +m.z;
    if (![x, y, z].every(Number.isFinite)) return;
    // near where the client last said it was in this life (so a lagging client's steps still count), as long as that
    // claim is within one movement budget of the room's copy; before its first claim, near the room's copy
    const fresh = a._cx != null && a._cseq === (a.spawnSeq | 0);
    const ax = fresh ? a._cx : a.x, az = fresh ? a._cz : a.z;
    if (Math.hypot(x - ax, z - az) > SOUND_REACH || Math.hypot(ax - a.x, az - a.z) > MOVE_CAP) return;
    const hasDir = Array.isArray(m.d) && m.d.length === 3 && m.d.every(Number.isFinite);
    if (m.k === 'click' && !hasDir) return; // a click is a forward cone, never all-round
    // token bucket per kind: an honest client can't beat the click cooldown or its own stride
    if (!bucket(c, m.k, SOUND_RATE[m.k], Date.now() / 1000)) return;
    const ex = { mult: m.k === 'click' ? 1 : clampNum(m.m, SOUND_MULT[0], SOUND_MULT[1], 1) };
    if (hasDir) ex.dir = m.d;
    this.sim.sound(m.k, x, y, z, a, ex);
  }

  onAction(c, m) {
    const a = c.actor, R = this.sim;
    if (!a || this.phase !== 'playing' || !a.alive) return;
    if (Number.isFinite(m.yaw)) a.yaw = clampNum(m.yaw, -10, 10, a.yaw);
    if (Number.isFinite(m.pitch)) a.pitch = clampNum(m.pitch, -1.5, 1.5, 0);
    if (m.cr != null) a.crouch = !!m.cr && (a._spd || 0) < CROUCH_MAX;
    const W = R.weapons, C = W.C, w = W.ensure(a), now = Date.now() / 1000;
    const reloading = w.reloadT > 0;
    switch (m.a) {
      case 'fire':
        // the client already checked its own cooldowns; the room's clock decides (see pace). A reload the client
        // thinks is done may finish now, then the shot needs its own fire cooldown to be up.
        if (w.reloadT > 0) {
          if (!pace(w, 'reload', now, 0.3, w.reloadT)) return;
          w.reloadT = 0; w.ammo = C.MAG;
        }
        if (!pace(w, 'fire', now, 0.06, w.fireT)) return;
        w.fireT = 0;
        if (W.fire(a)) paced(w, 'fire', now, C.FIRE_INTERVAL);
        break;
      case 'knife':
        if (!pace(w, 'knife', now, 0.15, w.knifeT)) return;
        w.knifeT = 0;
        if (W.knife(a) !== false) paced(w, 'knife', now, C.KNIFE_COOLDOWN);
        break;
      case 'dart':
        if (!pace(w, 'dart', now, 0.15, w.dartT)) return;
        w.dartT = 0;
        if (W.throwDart(a)) paced(w, 'dart', now, C.DART_COOLDOWN);
        break;
      case 'reload': W.reload(a); break;
    }
    // a reload started just now (asked for, or the last bullet): its clock starts here
    if (!reloading && w.reloadT > 0) paced(w, 'reload', now, C.RELOAD);
  }

  // ---- stats heartbeat
  beat(force) {
    const now = Date.now();
    if (!force && now - this.lastBeat < 10000) return;
    this.lastBeat = now;
    const bots = this.sim ? this.sim.actors.filter((a) => a.isBot).length : 0;
    stats(this.env).beat(this.code, { humans: this.humanCount(), bots, phase: this.phase, map: this.settings.map, quick: this.pub }).catch(() => {});
    if (this.pub) matcher(this.env).report(this.code, { humans: this.humanCount(), max: this.settings.maxPlayers, phase: this.phase }).catch(() => {});
  }
}

function ownPose(a) { return a ? [[a.id, rnd(a.x), rnd(a.z), rnd(a.yaw), a.spawnSeq || 0]] : []; }

// match length on the wire: JSON has no Infinity, so an unlimited match travels as 0 (and timeLeft as -1)
function wireTime(t) { return isFinite(t) ? t : 0; }

// action pacing (see the note at the top): may this action go ahead at `now` (s, wall clock)? An early one adds what
// it skipped to the debt, a late one pays the debt down. Refused requests change nothing.
// With no record yet (first use this life) the sim's own cooldown `simT` decides, with the same jitter allowance.
function pace(w, key, now, tol, simT) {
  const P = (w._pace || (w._pace = {})), s = P[key];
  if (!s) return !(simT > tol);
  const early = s.readyAt - now; // > 0: before the cooldown is up
if (early > tol || (early > 0 && s.owe + early > tol * 2)) return false;
  s.owe = Math.max(0, s.owe + early);
  return true;
}
// an action happened at `now`: the next one is due after `cd` seconds
function paced(w, key, now, cd) {
  const P = (w._pace || (w._pace = {}));
  const s = P[key] || (P[key] = { owe: 0, readyAt: -Infinity });
  s.readyAt = now + cd;
}

// a human who hasn't clicked into the match yet: dead to the sim, never respawned until onReady
function hold(a) {
  a.alive = false; a._dead = true; a.waiting = true; a.respawnT = 1e9; a.health = 100;
}

// a random map index, different from `not` when there's a choice
function randomMap(not) {
  const n = LIMITS.map[1] + 1;
  let m = Math.floor(Math.random() * n);
  if (n > 1 && m === not) m = (m + 1 + Math.floor(Math.random() * (n - 1))) % n;
  return m;
}
// token bucket on a client: [seconds per token, burst]; true (and a token spent) if there was one
function bucket(c, key, [per, burst], now) {
  const b = (c.buckets || (c.buckets = {}));
  const s = b[key] || (b[key] = { tok: burst, at: now });
  s.tok = Math.min(burst, s.tok + (now - s.at) / per); s.at = now;
  if (s.tok < 1) return false;
  s.tok -= 1;
  return true;
}
function rnd(v) { return Math.round((v || 0) * 100) / 100; }
function r3(v) { return Math.round((v || 0) * 1000) / 1000; }
function clampNum(v, lo, hi, def) { v = +v; return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def; }
// the bots' name list, read once from the game scripts (bots.js) so the two can't drift apart
let BOT_NAMES = null;
function botNames() {
  if (!BOT_NAMES) { try { BOT_NAMES = (createSim().bots.NAMES || []).slice(); } catch (e) { BOT_NAMES = []; } }
  return BOT_NAMES;
}
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

// ntfy push alerts (secret NTFY_TOPIC; no topic, no alerts). Checked once a minute while anything is live: one push
// each time live players or rooms climb past a new level. A level re-arms once the count falls to half of it.
// Many rooms with few players in them is the abuse case (open sockets holding rooms), so that push is urgent.
const ALERT_LEVELS = { players: [3, 10, 25, 50, 100, 250, 500, 1000, 2500], rooms: [5, 20, 50, 100, 250, 500, 1000, 2500] };
export function alertCheck(armed, t) {
  const out = [];
  for (const k of ['players', 'rooms']) {
    const L = ALERT_LEVELS[k];
    let cur = armed[k] || 0;
    while (cur > 0 && t[k] <= cur / 2) cur = L[L.indexOf(cur) - 1] || 0;
    let hit = 0;
    for (const l of L) if (t[k] >= l) hit = l;
    if (hit > cur) { out.push({ k, level: hit }); cur = hit; }
    armed[k] = cur;
  }
  return out;
}
async function ntfy(env, title, msg, urgent) {
  if (!env.NTFY_TOPIC) return;
  await fetch('https://ntfy.sh/' + env.NTFY_TOPIC, {
    method: 'POST', body: msg,
    headers: { Title: title, Priority: urgent ? 'urgent' : 'default', Tags: urgent ? 'warning' : 'video_game', Click: 'https://api.playreverb.com/admin' },
  }).catch((e) => log({ evt: 'ntfy_failed', err: String(e) }));
}

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

  // the menu's "N playing online" line
  async playing() {
    const t = this.liveTotals();
    return { players: t.players, rooms: t.rooms };
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
    if (this.env.NTFY_TOPIC) {
      const armed = (await this.ctx.storage.get('alertArmed')) || {};
      const hits = alertCheck(armed, t);
      await this.ctx.storage.put('alertArmed', armed);
      if (hits.length) {
        const abuse = t.rooms >= 20 && t.rooms > t.players;
        const what = hits.map((h) => (h.k === 'players' ? `${t.players} playing (passed ${h.level})` : `${t.rooms} rooms open (passed ${h.level})`)).join(', ');
        await ntfy(this.env, abuse ? 'REVERB: rooms piling up' : 'REVERB traffic', `${what}. Now: ${t.players} players, ${t.rooms} rooms, ${t.bots} bots.` +
          (abuse ? ' More rooms than players: check /admin, ROOMS_DISABLED is the kill switch.' : ''), abuse);
      }
    }
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

// ---------------------------------------------------------------------------------------------------------
// Matcher: one global object that knows which quick play rooms have free slots. Rooms report on every join,
// leave and heartbeat (about 10 s); a room that stops reporting is dropped. Nothing is stored: after an
// eviction the list rebuilds itself from the next heartbeats. Each hand-out holds a slot for RESERVE_MS so a
// burst of players doesn't all get sent to the same last seat.
// ---------------------------------------------------------------------------------------------------------
const RESERVE_MS = 10000;
export class Matcher extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.rooms = new Map(); // code -> {humans, max, phase, updated, held: [ts…]}
  }
  // the fullest room that still has a slot (people want people), or null
  async find() {
    const now = Date.now();
    let best = null, bestN = -1;
    for (const [code, r] of this.rooms) {
      if (now - r.updated > LIVE_TTL) { this.rooms.delete(code); continue; }
      r.held = r.held.filter((t) => now - t < RESERVE_MS);
      const n = r.humans + r.held.length;
      if (n < r.max && n > bestN) { best = code; bestN = n; }
    }
    if (best) this.rooms.get(best).held.push(now);
    return best;
  }
  // a room just made for someone: their slot is held until they connect
  async add(code, max) {
    this.rooms.set(code, { humans: 0, max, phase: 'lobby', updated: Date.now(), held: [Date.now()] });
  }
  async report(code, info) {
    if (!info) { this.rooms.delete(code); return; }
    const r = this.rooms.get(code) || { held: [] };
    // someone arrived: their reservation (the oldest) is used up
    if (info.humans > (r.humans || 0)) r.held.splice(0, info.humans - (r.humans || 0));
    Object.assign(r, info, { updated: Date.now() });
    this.rooms.set(code, r);
  }
}
