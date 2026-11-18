#!/usr/bin/env node
// tools/cost-model.js — monthly Cloudflare cost of the room server at different levels of popularity.
// Prices: Workers Paid plan, Durable Objects (checked 2026-11-18,
// https://developers.cloudflare.com/durable-objects/platform/pricing/). The static site (GitHub Pages) is free.
//
//   node tools/cost-model.js                       the table in docs/MULTIPLAYER.md
//   MSGS=25 MINS=30 PER_ROOM=4 node tools/cost-model.js   change the assumptions
//
// What is billed: a room's wall-clock time while it is open (128 MB x seconds; a match ticks at 30 Hz, so it never
// hibernates), and incoming WebSocket messages at 20 messages per request. Outgoing messages and bandwidth are free.
'use strict';

const PRICE = { base: 5, gbsIncl: 400e3, gbsPerM: 12.5, reqIncl: 1e6, reqPerM: 0.15 };
const FREE_DAY = { gbs: 13000, req: 100000 };
const GBS_PER_ROOM_HR = 0.128 * 3600;
// incoming messages per player per second: st ~14.5 (19 moving, 4 standing), steps ~2, act ~0.7, ping + rtt 0.7
const MSGS = +process.env.MSGS || 18;
const MINS = +process.env.MINS || 45;           // average session
const PER_ROOM = +process.env.PER_ROOM || 3;    // humans per room
const OVERHEAD = 1.15;                          // lobby time, 8 s results, 30 s seat holds
const up = (x) => Math.ceil(Math.max(0, x) / 1e6) * 1e6; // billable usage is rounded up to the next million

function month(dau, mins, perRoom) {
  const playerHrs = dau * (mins / 60) * 30;
  const roomHrs = (playerHrs / perRoom) * OVERHEAD;
  const statsHrs = Math.min(720, roomHrs);      // the one Stats object is live whenever any room is
  const gbs = (roomHrs + statsHrs) * GBS_PER_ROOM_HR;
  const reqs = (playerHrs * 3600 * MSGS) / 20 + roomHrs * 360 + playerHrs * 4; // messages, 10 s room beats, connects
  const dur = (up(gbs - PRICE.gbsIncl) / 1e6) * PRICE.gbsPerM;
  const req = (up(reqs - PRICE.reqIncl) / 1e6) * PRICE.reqPerM;
  const freeOk = gbs / 30 <= FREE_DAY.gbs && reqs / 30 <= FREE_DAY.req;
  return { playerHrs, roomHrs, dur, req, total: PRICE.base + dur + req, freeOk, peakRooms: Math.ceil((roomHrs / 720) * 3) };
}

const k = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : n.toFixed(0));
console.log(`assumptions: ${MSGS} msgs/s per player, ${MINS} min sessions, ${PER_ROOM} humans per room, peak = 3x average\n`);
console.log('| Popularity | Daily players | Player-hours / month | Rooms at peak | Free plan | Paid plan / month |');
console.log('|---|---|---|---|---|---|');
const rows = [['Friends playtests', 1.3, 120, 5], ['Small community', 50], ['Modest hit', 500], ['Popular', 5000], ['Viral', 50000]];
for (const [name, dau, mins, per] of rows) {
  const m = month(dau, mins || MINS, per || PER_ROOM);
  console.log(`| ${name} | ${dau < 2 ? '~1' : dau.toLocaleString('en-US')} | ${k(m.playerHrs)} | ${m.peakRooms} | ${m.freeOk ? 'fits' : 'runs out'} | $${m.total.toFixed(2)} |`);
}
console.log('\nper player-hour beyond the included usage:');
for (const per of [1, 3, 6]) {
  const d = ((GBS_PER_ROOM_HR * OVERHEAD) / per / 1e6) * PRICE.gbsPerM;
  const r = ((3600 * MSGS) / 20 / 1e6) * PRICE.reqPerM;
  console.log(`  ${per} human${per > 1 ? 's' : ''} per room: $${(d + r).toFixed(4)}`);
}
const roomHr = (GBS_PER_ROOM_HR / 1e6) * PRICE.gbsPerM;
console.log(`\none room held open: $${roomHr.toFixed(4)}/hour; 10,000 held open by a script: $${(roomHr * 10000).toFixed(0)}/hour`);
