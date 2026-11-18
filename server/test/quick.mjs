// Quick play: matchmaking into public rooms. node test/quick.mjs [http://localhost:8787]
// Needs a fresh dev server (other quick rooms left open would be matched into).
const BASE = process.argv[2] || 'http://localhost:8787', WS = BASE.replace(/^http/, 'ws'), O = { headers: { Origin: 'http://localhost:8000' } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };
const quick = async () => (await (await fetch(BASE + '/api/quick', { method: 'POST', ...O })).json()).code;
const cl = (code, name) => { const ws = new WebSocket(`${WS}/api/rooms/${code}/ws?name=${name}&uid=q-${name}&v=1`, O);
  const c = { ws, roster: null, start: null, starts: 0, over: null, lobby: null, closed: null, send: (o) => ws.send(JSON.stringify(o)) };
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === 'start') { c.start = m; c.starts++; c.roster = m.actors; } if (m.t === 'roster') c.roster = m.actors; if (m.t === 'over') c.over = m; if (m.t === 'lobby') c.lobby = m; };
  ws.onclose = (e) => { c.closed = e; };
  c.open = new Promise((r) => (ws.onopen = r)); return c; };
const bots = (c) => c.roster.filter((a) => a.isBot).length;

const code1 = await quick();
ok(/^[A-Z0-9]{4}$/.test(code1), 'quick play hands out a room (' + code1 + ')');
const info = await (await fetch(BASE + '/api/rooms/' + code1)).json();
ok(info.open && info.quick, 'the room is open and marked quick');
const A = cl(code1, 'Ann'); await A.open; await sleep(600);
ok(A.start && A.roster.length === 6 && bots(A) === 5, 'first player is straight in a match: 1 human + 5 bots');
ok(A.lobby && A.lobby.quick && A.lobby.host === 0, 'no host in a quick room');
A.send({ t: 'settings', settings: { maxPlayers: 2 } }); A.send({ t: 'end' }); await sleep(300);
ok(A.lobby.settings.maxPlayers === 6 && !A.over, 'host-only messages are ignored');
const code2 = await quick();
ok(code2 === code1, 'the next player is matched into the same room');
const B = cl(code2, 'Ben'); await B.open; await sleep(500);
ok(B.start && bots(A) === 4, 'they join mid-match and take a bot slot');
const live = await (await fetch(BASE + '/api/quick')).json();
ok(live.players >= 2, 'GET /api/quick counts players (' + live.players + ')');
// fill the room: 4 more reservations, then the 7th asker gets a new room
const codes = [];
for (let i = 0; i < 4; i++) codes.push(await quick());
ok(codes.every((c) => c === code1), 'reservations fill the remaining slots');
const code3 = await quick();
ok(code3 !== code1, 'a full room is skipped: new room ' + code3);
for (const c of [A, B]) { c.send({ t: 'bye' }); c.ws.close(); }
await sleep(400);
const gone = await (await fetch(BASE + '/api/rooms/' + code1)).json();
ok(!gone.open, 'the room closes when its last player leaves');
console.log(fails ? fails + ' FAILED' : 'all passed'); process.exit(fails ? 1 : 0);
