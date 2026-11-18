// Match end: 1 idle human + 7 hard bots, kill limit 1. Waits for 'over', then the room's return to the lobby.
const BASE = process.argv[2] || 'http://localhost:8787', O = { headers: { Origin: 'http://localhost:8000' } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { code } = await (await fetch(BASE + '/api/rooms', { method: 'POST', ...O })).json();
const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/rooms/${code}/ws?name=Idle&uid=t-idle&v=1`, O);
let over = null, phase = null, roster = null, last = null, t0 = Date.now();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === 'over') over = m; if (m.t === 'lobby') phase = m.phase; if (m.t === 'start') roster = m.actors; if (m.t === 's') last = m; };
await new Promise((r) => (ws.onopen = r));
ws.send(JSON.stringify({ t: 'settings', settings: { maxPlayers: 8, botFill: true, botSkill: 0.85, killLimit: 2, map: 0 } }));
await sleep(200); ws.send(JSON.stringify({ t: 'start' }));
while (!over && Date.now() - t0 < 300000) await sleep(500);
const name = (id) => (roster.find((a) => a.id === id) || {}).name;
console.log(over ? 'ok   match over after ' + Math.round((Date.now() - t0) / 1000) + ' s, winner ' + name(over.winner) + ', top kills ' + Math.max(...last.a.map((r) => r[8])) : 'FAIL no match end in 300 s');
const t1 = Date.now();
while (phase !== 'lobby' && Date.now() - t1 < 15000) await sleep(250);
console.log(phase === 'lobby' ? 'ok   back to lobby after ' + ((Date.now() - t1) / 1000).toFixed(1) + ' s' : 'FAIL still ' + phase);
ws.close(); process.exit(over && phase === 'lobby' ? 0 : 1);
