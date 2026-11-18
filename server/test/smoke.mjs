// Headless end-to-end check against a running server (npm run dev in another terminal).
// Two clients: A hosts, B joins with the code; A starts a 2-human match with bots off; B walks up to A and
// knifes them until A dies. Then checks snapshots, events, the stats endpoint and the room info endpoint.
// Usage: node test/smoke.mjs [http://localhost:8787]
import { loadWorld, stepToward } from './nav.mjs';
const BASE = process.argv[2] || 'http://localhost:8787';
const WS = BASE.replace(/^http/, 'ws');
const ORIGIN = 'http://localhost:8000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) fails++; };

function client(code, name) {
  const ws = new WebSocket(`${WS}/api/rooms/${code}/ws?name=${name}&uid=test-${name}&v=1`, { headers: { Origin: ORIGIN } });
  const c = { ws, name, msgs: [], snaps: 0, events: [], last: null, start: null, lobby: null, over: null, you: 0, cid: 0 };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    c.msgs.push(m.t);
    if (m.t === 'welcome') c.cid = m.cid;
    if (m.t === 'lobby') c.lobby = m;
    if (m.t === 'start') { c.start = m; c.you = m.you; }
    if (m.t === 's') { c.snaps++; c.last = m; c.events.push(...m.e); }
    if (m.t === 'over') c.over = m;
    if (m.t === 'error') console.log(name, 'error', m.msg);
  };
  c.send = (o) => ws.send(JSON.stringify(o));
  c.open = new Promise((r) => (ws.onopen = r));
  return c;
}

const res = await fetch(BASE + '/api/rooms', { method: 'POST', headers: { Origin: ORIGIN } });
const { code } = await res.json();
ok(/^[A-Z0-9]{4}$/.test(code), 'created room ' + code);

const A = client(code, 'Alice');
await A.open; await sleep(200);
const B = client(code, 'Bob');
await B.open; await sleep(300);
ok(A.lobby && A.lobby.players.length === 2, 'lobby shows 2 players');
ok(A.lobby.host === A.cid, 'first player is host');

B.send({ t: 'settings', settings: { killLimit: 3 } }); // not host: ignored
A.send({ t: 'settings', settings: { botFill: false, killLimit: 4, timeLimit: 3, map: 1 } });
await sleep(200);
ok(B.lobby.settings.killLimit === 4 && B.lobby.settings.botFill === false, 'host settings reach guest, guest settings ignored');

A.send({ t: 'start' });
await sleep(500);
A.send({ t: 'ready' }); B.send({ t: 'ready' }); // both "clicked in"
ok(A.start && B.start, 'both got start');
ok(A.start.actors.length === 2, 'two actors, no bots (got ' + (A.start && A.start.actors.length) + ')');
ok(A.you && B.you && A.you !== B.you, 'each client has its own actor');
await sleep(1000);
ok(B.snaps > 20, 'snapshots streaming (' + B.snaps + ' in ~1.5 s)');

const W = loadWorld(); W.props.build(W.maps[1]); // map 1, set above
const pos = (c, id) => c.last.a.find((r) => r[0] === id);
// B walks to A (3 m hops; good enough for a test, ignores walls) then knifes
let seq = 0;
for (const e of B.events) if (e[0] === 'sp' && e[1] === B.you) seq = e[5];
const sp0 = B.start.poses.find((p) => p[0] === B.you); if (sp0) seq = Math.max(seq, sp0[4]);
let bx = pos(B, B.you)[1], bz = pos(B, B.you)[2];
B.send({ t: 'snd', k: 'step', x: bx, y: 0.05, z: bz, m: 1 });
let knifes = 0;
for (let i = 0; i < 600 && !B.events.some((e) => e[0] === 'k'); i++) {
  const a = pos(B, A.you);
  const dx = a[1] - bx, dz = a[2] - bz, d = Math.hypot(dx, dz);
  if (d > 0.8) { const n = stepToward(W, bx, bz, a[1], a[2], 0.4); bx = n.x; bz = n.z; }
  const yaw = Math.atan2(-dx, -dz);
  B.send({ t: 'st', x: bx, z: bz, yaw, pitch: 0, vx: 0, vz: 0, cr: 0, mm: 0, sq: seq });
  await sleep(60);
  if (d < 1.2) { B.send({ t: 'act', a: 'knife', yaw, pitch: 0 }); knifes++; await sleep(650); }
}
const kill = B.events.find((e) => e[0] === 'k');
ok(B.events.some((e) => e[0] === 's' && e[1] === 'step' && e[5] === B.you), 'client footstep relayed as a sound event');
ok(B.events.some((e) => e[0] === 's' && e[1] === 'melee'), 'knife swing sound broadcast');
ok(B.events.some((e) => e[0] === 'd' && e[1] === A.you && e[2] === B.you), 'damage event A <- B');
ok(kill && kill[1] === A.you && kill[2] === B.you, 'kill event (after ' + knifes + ' knife swings)');
ok(A.last && A.last.me && A.last.me.hp === 0, 'A sees own hp 0');
await sleep(3600);
ok(A.events.some((e) => e[0] === 'sp' && e[1] === A.you), 'A respawned after 3 s');

const info = await (await fetch(BASE + '/api/rooms/' + code)).json();
ok(info.open && info.players === 2 && info.phase === 'playing', 'room info: ' + JSON.stringify(info));
const st = await fetch(BASE + '/api/admin/stats', { headers: { Authorization: 'Bearer dev' } });
const sj = st.status === 200 ? await st.json() : null;
ok(sj && sj.live.players >= 2, 'stats: live players ' + (sj && sj.live.players) + ', unique ' + (sj && sj.uniquePlayers));
ok((await fetch(BASE + '/api/admin/stats')).status === 401, 'stats need the token');

A.ws.close(); await sleep(300);
ok(B.lobby.host === B.cid, 'host passes to B when A leaves');
B.ws.close(); await sleep(300);
const info2 = await (await fetch(BASE + '/api/rooms/' + code)).json();
ok(!info2.open, 'room closes when empty');
console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
