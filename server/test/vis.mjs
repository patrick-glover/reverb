// Anti-wallhack and player ids. node test/vis.mjs [http://localhost:8787]   (dev server running)
// Two players, no bots, map 0. They walk to two spots with a wall between them and stand still: neither may get the
// other's position. Then B walks into A's sight and A gets it. Then signed player ids: issued, reused, forged, spoofed.
import { loadWorld, stepToward } from './nav.mjs';
const BASE = process.argv[2] || 'http://localhost:8787', WS = BASE.replace(/^http/, 'ws');
const O = { headers: { Origin: 'http://localhost:8000' } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };

function cl(code, name, q = '', headers = {}) {
  const ws = new WebSocket(`${WS}/api/rooms/${code}/ws?name=${name}&v=2${q}`, { headers: { ...O.headers, ...headers } });
  const c = { ws, welcome: null, start: null, last: null, ev: [], seq: 0, send: (o) => ws.readyState === 1 && ws.send(JSON.stringify(o)) };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'welcome') c.welcome = m;
    if (m.t === 'start') { c.start = m; c.you = m.you; c.send({ t: 'ready' }); }
    if (m.t === 's') { c.last = m; for (const x of m.e) { c.ev.push(x); if (x[0] === 'sp' && x[1] === c.you) c.seq = x[5]; } }
  };
  c.open = new Promise((r) => (ws.onopen = r));
  return c;
}
const row = (c, id) => c.last && c.last.a.find((r) => r[0] === id);

// ---- pick the spots on map 0 with the game's own world: A at P, B at Q, a wall between (no line of sight from either
// eye or a step either side, to feet, chest or head), 4-8 m apart; and V, a spot in A's open sight
const R = loadWorld(); R.props.build(R.maps[0]);
const W = R.world, EYE = 1.62, X = W.w * R.TILE, Z = W.h * R.TILE;
const free = (x, z) => { const p = { x, z, y: 0, r: 0.3 }; W._resolve(p); return Math.hypot(p.x - x, p.z - z) < 1e-6; };
const sees = (p, q) => [[0, 0], [0.5, 0], [-0.5, 0]].some(([ox]) => W.los(p.x, EYE, p.z, p.x + ox, EYE, p.z) &&
  [0.3, 1.0, 1.72].some((y) => W.los(p.x + ox, EYE, p.z, q.x, y, q.z)));
let P = null, Q = null, V = null;
for (let i = 0; i < 200000 && !V; i++) {
  const p = { x: 1 + Math.random() * (X - 2), z: 1 + Math.random() * (Z - 2) }, a = Math.random() * 6.28, d = 4 + Math.random() * 4;
  const q = { x: p.x + Math.cos(a) * d, z: p.z + Math.sin(a) * d };
  if (!free(p.x, p.z) || !free(q.x, q.z) || sees(p, q) || sees(q, p)) continue;
  for (let k = 0; k < 40; k++) { // somewhere 4-6 m from P, in plain sight
    const b = Math.random() * 6.28, e = 4 + Math.random() * 2, v = { x: p.x + Math.cos(b) * e, z: p.z + Math.sin(b) * e };
    if (free(v.x, v.z) && W.los(p.x, EYE, p.z, v.x, 1.0, v.z) && W.los(v.x, EYE, v.z, p.x, 1.0, p.z)) { P = p; Q = q; V = v; break; }
  }
}
ok(!!V, 'found a wall between two spots on map 0');

const { code } = await (await fetch(BASE + '/api/rooms', { method: 'POST', ...O })).json();
const A = cl(code, 'Ana'); await A.open; await sleep(150);
const B = cl(code, 'Ben'); await B.open; await sleep(150);
A.send({ t: 'settings', settings: { botFill: false, map: 0, killLimit: 50, timeLimit: 0 } }); await sleep(150);
A.send({ t: 'start' });
for (let i = 0; i < 200 && !(row(A, A.you) && row(A, A.you)[7] & 1 && row(B, B.you) && row(B, B.you)[7] & 1); i++) await sleep(50);
ok(row(A, A.you)[7] & 1 && row(B, B.you)[7] & 1, 'both spawned');
ok(A.start.poses.length === 1 && A.start.poses[0][0] === A.you, 'start carries only your own pose');

// walk both to their spots along the nav grid (4 m/s), then stand still facing yaw 0
async function walkTo(c, t) {
  let [, x, z] = row(c, c.you);
  for (let i = 0; i < 400 && Math.hypot(t.x - x, t.z - z) > 0.05; i++) {
    const n = stepToward(R, x, z, t.x, t.z, 0.24); x = n.x; z = n.z;
    c.send({ t: 'st', x, z, y: 0, yaw: 0, pitch: 0, vx: 0, vz: 0, cr: 0, mm: 1, sq: c.seq });
    await sleep(60);
  }
  c.send({ t: 'st', x: t.x, z: t.z, y: 0, yaw: 0, pitch: 0, vx: 0, vz: 0, cr: 0, mm: 0, sq: c.seq });
}
await Promise.all([walkTo(A, P), walkTo(B, Q)]);
await sleep(1200); // past the sighting hold
const ra = row(A, A.you), rb = row(B, B.you);
ok(Math.hypot(ra[1] - P.x, ra[2] - P.z) < 0.3 && Math.hypot(rb[1] - Q.x, rb[2] - Q.z) < 0.3, `in place, ${Math.hypot(P.x - Q.x, P.z - Q.z).toFixed(1)} m apart with a wall between`);
ok(row(A, B.you).length === 4 && row(B, A.you).length === 4, 'neither gets the other\'s position (short rows)');
ok(row(A, B.you)[1] === 1, 'the short row still says B is alive');
const n0 = A.ev.length; await sleep(1000);
ok(!A.ev.slice(n0).some((e) => e[5] === B.you), 'standing still behind the wall, B makes no events A gets');

// B walks into A's sight
await walkTo(B, V); await sleep(300);
const seen = row(A, B.you);
ok(seen && seen.length === 11 && Math.hypot(seen[1] - V.x, seen[2] - V.z) < 0.5, 'in plain sight, A gets B\'s position');

A.send({ t: 'bye' }); B.send({ t: 'bye' }); A.ws.close(); B.ws.close();
await sleep(300);

// ---- signed player ids
const r2 = await (await fetch(BASE + '/api/rooms', { method: 'POST', ...O })).json();
const c1 = cl(r2.code, 'Id1'); await c1.open; await sleep(300);
const pt = c1.welcome && c1.welcome.pt;
ok(/^[0-9a-f]{32}\.[\w-]+$/.test(pt || ''), 'a new player is issued a signed id');
c1.send({ t: 'bye' }); c1.ws.close(); await sleep(200);
const r3 = await (await fetch(BASE + '/api/rooms', { method: 'POST', ...O })).json();
const c2 = cl(r3.code, 'Id2', '&pt=' + encodeURIComponent(pt)); await c2.open; await sleep(300);
ok(c2.welcome && !c2.welcome.pt, 'a valid id is kept (no new one issued)');
const forged = 'f'.repeat(32) + '.' + pt.split('.')[1];
const c3 = cl(r3.code, 'Id3', '&pt=' + encodeURIComponent(forged)); await c3.open; await sleep(300);
ok(c3.welcome && c3.welcome.pt && !c3.welcome.pt.startsWith('f'.repeat(32)), 'a made-up id with a borrowed signature is replaced');
const c4 = cl(r3.code, 'Id4', '', { 'X-Player-Id': 'e'.repeat(32) }); await c4.open; await sleep(300);
ok(c4.welcome && c4.welcome.pt && !c4.welcome.pt.startsWith('e'.repeat(32)), 'an X-Player-Id header from the client is ignored');
for (const c of [c2, c3, c4]) { c.send({ t: 'bye' }); c.ws.close(); }
await sleep(200);
console.log(fails ? fails + ' FAILED' : 'all passed'); process.exit(fails ? 1 : 0);
