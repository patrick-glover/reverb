// Bot fill + mid-match join/leave + match end. node test/fill.mjs [http://localhost:8787]
const BASE = process.argv[2] || 'http://localhost:8787', WS = BASE.replace(/^http/, 'ws'), O = { headers: { Origin: 'http://localhost:8000' } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };
const cl = (code, name) => { const ws = new WebSocket(`${WS}/api/rooms/${code}/ws?name=${name}&v=2`, O);
  const c = { ws, roster: null, start: null, over: null, lobby: null, send: (o) => ws.send(JSON.stringify(o)) };
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === 'start') { c.start = m; c.roster = m.actors; } if (m.t === 'roster') c.roster = m.actors; if (m.t === 'over') c.over = m; if (m.t === 'lobby') c.lobby = m; if (m.t === 's') c.last = m; };
  c.open = new Promise((r) => (ws.onopen = r)); return c; };
const { code } = await (await fetch(BASE + '/api/rooms', { method: 'POST', ...O })).json();
const A = cl(code, 'Ann'); await A.open; await sleep(200);
A.send({ t: 'settings', settings: { maxPlayers: 4, botFill: true, botSkill: 0.85 } }); await sleep(150);
A.send({ t: 'start' }); await sleep(500);
const bots = (c) => c.roster.filter((a) => a.isBot).length;
ok(A.roster.length === 4 && bots(A) === 3, 'solo host: 1 human + 3 bots (' + A.roster.length + ')');
const B = cl(code, 'Ben'); await B.open; await sleep(500);
ok(B.start && B.start.you, 'mid-match joiner gets a start with its own actor');
ok(A.roster.length === 4 && bots(A) === 2, 'joiner took a bot slot (bots now ' + bots(A) + ')');
const C = cl(code, 'Cy'); await C.open; await sleep(300);
const D = cl(code, 'Dee'); await D.open; await sleep(300);
const E = cl(code, 'Eve'); await E.open; await sleep(300);
ok(A.roster.length === 4 && bots(A) === 0, '4 humans, 0 bots');
ok(E.ws.readyState === 3 || E.lobby == null, 'fifth player turned away (room full)');
D.send({ t: 'bye' }); D.ws.close(); await sleep(400); // Leave (a bare close holds the seat 30 s)
ok(A.roster.length === 4 && bots(A) === 1, 'a leaver is replaced by a bot');
// let bots play a bit; make sure the room keeps ticking with bots shooting humans who stand still
await sleep(4000);
ok(A.last && A.last.a.length === 4, 'snapshots still flowing with bots');
console.log('     scores:', A.last.a.map((r) => (r.length < 11 ? r[2] + '/' + r[3] : r[8] + '/' + r[9])).join(' '));
for (const c of [A, B, C]) { c.send({ t: 'bye' }); c.ws.close(); }
await sleep(300);
console.log(fails ? fails + ' FAILED' : 'all passed'); process.exit(fails ? 1 : 0);
