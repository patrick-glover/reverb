// Reconnect: a socket closed without 'bye' keeps its seat (cid, actor, score, host) for 30 s; 'bye' frees it at once.
// Usage (dev server running): node test/rejoin.mjs   (takes about 35 s: it waits out one hold)
const BASE = 'http://localhost:8787', WS = 'ws://localhost:8787';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };
function cl(code, name, rk) {
  const ws = new WebSocket(`${WS}/api/rooms/${code}/ws?name=${name}&uid=x-${name}&v=1${rk ? '&rk=' + rk : ''}`, { headers: { Origin: 'http://localhost:8000' } });
  const c = { ws, welcome: null, lobby: null, start: null, closed: null, snaps: 0, send: (o) => ws.send(JSON.stringify(o)) };
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === 'welcome') c.welcome = m; if (m.t === 'lobby') c.lobby = m; if (m.t === 'start') c.start = m; if (m.t === 's') { c.snaps++; c.last = m; } };
  ws.onclose = (e) => (c.closed = { code: e.code, reason: e.reason });
  c.open = new Promise((r) => { ws.onopen = () => r(true); ws.onerror = () => r(false); });
  return c;
}
const info = async (code) => (await fetch(`${BASE}/api/rooms/${code}`)).json();
const newRoom = async () => (await (await fetch(BASE + '/api/rooms', { method: 'POST', headers: { Origin: 'http://localhost:8000' } })).json()).code;

// 1. mid-match drop and rejoin keeps seat, actor and score; host keeps host
{
  const code = await newRoom();
  const A = cl(code, 'Ann'); await A.open; await sleep(150);
  const B = cl(code, 'Bob'); await B.open; await sleep(150);
  ok(!!A.welcome.rk && !!B.welcome.rk && A.welcome.rk !== B.welcome.rk, 'welcome carries a per-seat rejoin key');
  A.send({ t: 'settings', settings: { botFill: true, map: 2, timeLimit: 2 } }); await sleep(150);
  A.send({ t: 'start' }); await sleep(400);
  A.send({ t: 'ready' }); B.send({ t: 'ready' }); await sleep(500);
  const bId = B.start.you, bCid = B.welcome.cid, actorsBefore = A.last.a.length;
  B.ws.close(); await sleep(300);                                         // no bye: like a refresh
  const away = A.lobby.players.find((p) => p.cid === bCid);
  ok(away && away.away === 1, 'dropped player stays in the lobby list marked away');
  ok(A.last.a.length === actorsBefore, 'no bot took the seat while held');
  ok(!(A.last.a.find((r) => r[0] === bId)[7] & 1), 'held actor is out of play');
  const B2 = cl(code, 'Bob', B.welcome.rk); await B2.open; await sleep(400);
  ok(B2.welcome && B2.welcome.cid === bCid && B2.welcome.rejoin, 'rejoin gets the same cid');
  ok(B2.start && B2.start.you === bId, 'rejoin gets the same actor mid-match');
  ok(!A.lobby.players.find((p) => p.cid === bCid).away, 'no longer marked away');
  B2.send({ t: 'ready' }); await sleep(400);
  ok(!!(B2.last.a.find((r) => r[0] === bId)[7] & 1), 'back in play after ready');
  // host drop + rejoin keeps host
  A.ws.close(); await sleep(300);
  const A2 = cl(code, 'Ann', A.welcome.rk); await A2.open; await sleep(300);
  ok(A2.lobby.host === A.welcome.cid, 'host still host after rejoin');
  // a second socket with the same key takes over; the old one is told why
  const A3 = cl(code, 'Ann', A.welcome.rk); await A3.open; await sleep(300);
  ok(A2.closed && A2.closed.code === 4003, 'older tab closed with 4003 when the seat is taken over');
  // bye frees the seat at once
  B2.send({ t: 'bye' }); B2.ws.close(); await sleep(300);
  ok(!A3.lobby.players.find((p) => p.cid === bCid), 'bye removes the player immediately');
  A3.send({ t: 'close' }); await sleep(300);
}
// 2. lone host refreshes in the lobby: room survives, rejoin works
{
  const code = await newRoom();
  const A = cl(code, 'Solo'); await A.open; await sleep(150);
  A.ws.close(); await sleep(300);
  ok((await info(code)).open, 'room stays open while its only player is held');
  const A2 = cl(code, 'Solo', A.welcome.rk); await A2.open; await sleep(200);
  ok(A2.welcome && A2.welcome.cid === A.welcome.cid, 'lone host rejoins the same seat');
  // 3. hold expires
  A2.ws.close(); await sleep(31500);
  ok(!(await info(code)).open, 'room closes once the held seat expires (30 s)');
  const A3 = cl(code, 'Solo', A.welcome.rk); await A3.open; await sleep(300);
  ok(!A3.welcome, 'rejoin after expiry refused');
}
console.log(fails ? fails + ' FAILED' : 'all passed'); process.exit(fails ? 1 : 0);
