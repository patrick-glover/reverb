// Runs the real browser client (core, player, weapons, game, net.js, …) in node with a stub DOM against a running
// server. net.js hosts a room through its own lobby buttons; a raw WebSocket client ("Rook") joins, the host starts
// the match, the local player walks, fires and gets knifed. Checks what the client did with the room's messages.
// Usage: node test/client.mjs [http://localhost:8787]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stepToward } from './nav.mjs';

const BASE = process.argv[2] || 'http://localhost:8787';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };

// ---- stub browser
const els = {};
const mkEl = (id) => ({ id, style: {}, value: '', checked: false, textContent: '', innerHTML: '', onclick: null, onchange: null,
  addEventListener() {}, appendChild() {}, remove() {}, focus() {}, querySelectorAll: () => [], getContext: () => null, tagName: 'DIV' });
const handlers = {};
globalThis.window = globalThis;
window.addEventListener = (t, f) => (handlers[t] = handlers[t] || []).push(f);
globalThis.document = {
  addEventListener: (t, f) => (handlers['doc:' + t] = handlers['doc:' + t] || []).push(f),
  createElement: () => mkEl(''), getElementById: (id) => (id.startsWith('mp_') ? (els[id] = els[id] || mkEl(id)) : null),
  head: mkEl('head'), body: mkEl('body'), activeElement: null, exitPointerLock() {},
};
globalThis.location = { search: '', hostname: 'localhost', protocol: 'http:', pathname: '/', origin: 'http://localhost:8000' };
globalThis.history = { replaceState() {} };
const store = {}; globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => (store[k] = String(v)) };
globalThis.requestAnimationFrame = () => 0;
const errs = []; const ce = console.error; console.error = (...a) => { errs.push(a.map(String).join(' ')); };
for (const f of ['flags', 'core', 'body', 'props', 'maps', 'echo', 'weapons', 'player', 'bots', 'game', 'net']) {
  (0, eval)(fs.readFileSync(path.join(ROOT, f + '.js'), 'utf8'));
}
const R = window.R;
for (const n of ['echo', 'weapons', 'player', 'bots', 'game', 'net']) R[n].init && R[n].init();
R.flags.applyAll();
const G = R.game, N = R.net;
const key = (code, down) => (handlers[down ? 'keydown' : 'keyup'] || []).forEach((f) => f({ code, target: {}, preventDefault() {} }));
let running = true;
(async () => { while (running) { R.time += 1 / 60; G.update(1 / 60); R.input._end(); await sleep(16); } })();

// ---- host through the overlay
N.openHost();
ok(N.overlayOpen, 'host overlay opens');
els.mp_name.value = 'Hal';
els.mp_go.onclick();
for (let i = 0; i < 50 && !(N.active && N.players.length); i++) await sleep(50);
ok(N.active && N.code && N.isHost(), 'hosted room ' + N.code + ' and is host');

// ---- raw guest joins
const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/rooms/${N.code}/ws?name=Rook&uid=test-rook&v=1`, { headers: { Origin: 'http://localhost:8000' } });
const g = { last: null, start: null, events: [] };
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === 'start') { g.start = m; ws.send(JSON.stringify({ t: 'ready' })); } if (m.t === 's') { g.last = m; g.events.push(...m.e); } };
await new Promise((r) => (ws.onopen = r));
await sleep(300);
ok(N.players.length === 2, 'lobby shows guest');
els.mp_fill.checked = false; els.mp_fill.onchange();
await sleep(200);
ok(N.settings.botFill === false, 'host turned bot fill off via the overlay');
els.mp_start.onclick();
for (let i = 0; i < 40 && !N.inMatch; i++) await sleep(50);
ok(N.inMatch && !N.overlayOpen, 'match started, overlay hidden');
ok(G.state === 'paused', 'waiting for a click (paused) since pointer is not locked');
const P = R.player;
ok(!P.alive && P.netWaiting, 'not spawned while on the click-to-play screen');
R.input.locked = true; G.resume();
for (let i = 0; i < 40 && !P.alive; i++) await sleep(50);
ok(P.alive && !P.netWaiting && G.state === 'playing', 'spawned after clicking in');
const rook = R.actors.find((a) => a !== P);
ok(R.actors.length === 2 && rook && rook.name === 'Rook', 'actors: you + Rook proxy');

// ---- walk: hold W for 1 s, server should see us move
const p0 = { x: P.x, z: P.z };
key('KeyW', true); await sleep(1000); key('KeyW', false);
await sleep(300);
const moved = Math.hypot(P.x - p0.x, P.z - p0.z);
const myRow = g.last.a.find((r) => r[0] === g.start.you ? false : true && r[0] !== g.start.you);
ok(moved > 1, 'local player walked ' + moved.toFixed(2) + ' m');
ok(myRow && Math.hypot(myRow[1] - P.x, myRow[2] - P.z) < 0.5, 'room has our position (' + (myRow && myRow.slice(1, 3)) + ')');
ok(g.events.some((e) => e[0] === 's' && (e[1] === 'step' || e[1] === 'sprint') && e[5] !== g.start.you), 'our footsteps reached the guest');

// ---- fire once: predicted locally, gunshot reaches the guest
const ammo0 = P.wpn.ammo;
R.input.mouse.down[0] = false; await sleep(50);
R.input.mouse.down[0] = true; await sleep(80); R.input.mouse.down[0] = false;
await sleep(300);
ok(P.wpn.ammo === ammo0 - 1, 'ammo predicted locally (' + ammo0 + ' -> ' + P.wpn.ammo + ')');
ok(g.events.some((e) => e[0] === 's' && e[1] === 'gunshot'), 'gunshot broadcast by the room');

// ---- guest moves: proxy follows (interpolated)
const rookId = g.start.you;
let rx = g.last.a.find((r) => r[0] === rookId)[1], rz = g.last.a.find((r) => r[0] === rookId)[2];
const sq = (g.events.filter((e) => e[0] === 'sp' && e[1] === rookId).pop() || [])[5] || 0;
for (let i = 0; i < 8; i++) { ws.send(JSON.stringify({ t: 'st', x: rx, z: rz, yaw: 0, pitch: 0, vx: 0, vz: 0, cr: 0, mm: 0, sq })); await sleep(40); }
await sleep(300);
ok(Math.hypot(rook.x - rx, rook.z - rz) < 0.3, 'proxy sits where the guest is');

// ---- guest walks over and knifes us
const kills = () => G.killFeed.length;
for (let i = 0; i < 600 && P.alive; i++) {
  const me = g.last.a.find((r) => r[0] !== rookId);
  const dx = me[1] - rx, dz = me[2] - rz, d = Math.hypot(dx, dz);
  if (d > 0.8) { const n = stepToward(R, rx, rz, me[1], me[2], 0.4); rx = n.x; rz = n.z; }
  const yaw = Math.atan2(-dx, -dz);
  ws.send(JSON.stringify({ t: 'st', x: rx, z: rz, yaw, pitch: 0, vx: 0, vz: 0, cr: 0, mm: 0, sq }));
  await sleep(60);
  if (d < 1.2) { ws.send(JSON.stringify({ t: 'act', a: 'knife', yaw, pitch: 0 })); await sleep(650); }
}
ok(!P.alive && G.state === 'dead', 'we died (state ' + G.state + ')');
ok(kills() === 1 && G.killFeed[0].killer === rook, 'kill feed: Rook killed us');
ok(G.lastDeath && G.lastDeath.weapon === 'knife', 'death screen knows it was a knife');
ok(rook.kills === 1 && P.deaths === 1, 'scores from snapshots (Rook ' + rook.kills + ', our deaths ' + P.deaths + ')');
await sleep(3500);
ok(P.alive && G.state === 'playing', 'respawned by the room');

// ---- leave
G.pause(); G.toMenu();
await sleep(300);
ok(!N.active && G.state === 'menu', 'Q from pause leaves the room');
ws.close();
running = false;
ok(errs.length === 0, 'no console errors' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
