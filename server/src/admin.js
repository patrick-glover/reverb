// Monitoring console served at /admin. Reads /api/admin/stats with the ADMIN_TOKEN (kept in this browser's
// localStorage). Refreshes every 10 s.
export const ADMIN_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reverb Console</title>
<style>
:root{--bg:#05080b;--panel:#0b1117;--line:#1a2630;--ink:#d9ecf3;--ink2:#8fa6b2;--ink3:#5d7380;--accent:#7fe8ff;--warn:#ffb43c}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:13px/1.45 ui-monospace,"SF Mono",Menlo,Consolas,monospace;padding:20px 16px 40px}
h1{font-size:15px;letter-spacing:.2em;margin:0;color:var(--accent);font-weight:500}
h2{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--ink3);font-weight:400;margin:0 0 10px}
.top{display:flex;gap:12px;align-items:baseline;flex-wrap:wrap;margin-bottom:18px}
.top .sub{color:var(--ink3)}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-bottom:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:14px}
.tile .v{font-size:28px;font-weight:300;font-variant-numeric:tabular-nums}
.tile .k{color:var(--ink2);font-size:11px;margin-top:2px}
.tile .s{color:var(--ink3);font-size:11px}
.two{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));margin-bottom:12px}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th{text-align:left;font-weight:400;color:var(--ink3);font-size:11px;padding:4px 6px;border-bottom:1px solid var(--line)}
td{padding:4px 6px;border-bottom:1px solid #0f1820;vertical-align:top}
td.n{text-align:right}
.scroll{max-height:360px;overflow:auto}
.chart{position:relative}
.chart svg{display:block;width:100%;height:150px}
.tip{position:absolute;pointer-events:none;background:#000c;border:1px solid var(--line);border-radius:4px;padding:4px 7px;font-size:11px;display:none;white-space:nowrap}
.muted{color:var(--ink3)}
.ev-player_joined{color:var(--accent)} .ev-match_started{color:#8affc1} .ev-match_ended{color:#e9f59a} .ev-room_created{color:var(--ink2)}
#login{max-width:340px}
input,button{font:inherit;color:var(--ink);background:#101820;border:1px solid var(--line);border-radius:4px;padding:6px 9px}
button{cursor:pointer}
.err{color:var(--warn);margin-left:8px}
</style></head><body>
<div class="top"><h1>REVERB CONSOLE</h1><span class="sub" id="upd"></span><span class="err" id="err"></span></div>
<div id="login" class="card" style="display:none">
  <h2>Admin token</h2>
  <form id="lf"><input id="tok" type="password" placeholder="ADMIN_TOKEN" style="width:100%;margin-bottom:8px"><button>Open console</button></form>
</div>
<div id="main" style="display:none">
  <div class="grid">
    <div class="card tile"><div class="v" id="t_live">–</div><div class="k">playing now</div><div class="s" id="t_live_s"></div></div>
    <div class="card tile"><div class="v" id="t_rooms">–</div><div class="k">live rooms</div><div class="s" id="t_bots"></div></div>
    <div class="card tile"><div class="v" id="t_uniq">–</div><div class="k">unique players, all time</div><div class="s" id="t_24"></div></div>
    <div class="card tile"><div class="v" id="t_sess">–</div><div class="k">sessions, all time</div><div class="s" id="t_sess_s"></div></div>
    <div class="card tile"><div class="v" id="t_match">–</div><div class="k">matches played</div><div class="s" id="t_match_s"></div></div>
    <div class="card tile"><div class="v" id="t_peak">–</div><div class="k">peak concurrent players</div><div class="s" id="t_peak_s"></div></div>
  </div>
  <div class="two">
    <div class="card"><h2>Concurrent players, last 48 h (1-min samples)</h2><div class="chart" id="c_players"></div></div>
    <div class="card"><h2>Live rooms, last 48 h</h2><div class="chart" id="c_rooms"></div></div>
  </div>
  <div class="two">
    <div class="card"><h2>Live rooms</h2><div class="scroll"><table id="rooms"></table></div></div>
    <div class="card"><h2>Per day (UTC), last 30 days</h2><div class="scroll"><table id="daily"></table></div></div>
  </div>
  <div class="card"><h2>Recent events</h2><div class="scroll"><table id="events"></table></div></div>
</div>
<script>
const $ = (id) => document.getElementById(id);
let token = ''; try { token = localStorage.getItem('reverb.admin') || ''; } catch (e) {}
$('lf').onsubmit = (e) => { e.preventDefault(); token = $('tok').value.trim(); try { localStorage.setItem('reverb.admin', token); } catch (e) {} load(); };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n) => (n == null ? '–' : Number(n).toLocaleString());
const ago = (ts) => { const s = Math.round((Date.now() - ts) / 1000); return s < 60 ? s + 's' : s < 3600 ? Math.round(s / 60) + 'm' : Math.round(s / 3600) + 'h'; };
const hhmm = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const MAPS = ['Apartment', 'Office', 'Warehouse'];

async function load() {
  if (!token) { $('login').style.display = ''; $('main').style.display = 'none'; return; }
  let d;
  try {
    const r = await fetch('/api/admin/stats', { headers: { Authorization: 'Bearer ' + token } });
    if (r.status === 401) { token = ''; $('err').textContent = 'wrong token'; $('login').style.display = ''; $('main').style.display = 'none'; return; }
    d = await r.json();
  } catch (e) { $('err').textContent = 'fetch failed: ' + e.message; return; }
  $('err').textContent = ''; $('login').style.display = 'none'; $('main').style.display = '';
  render(d);
}

function render(d) {
  const T = d.totals || {};
  const today = {}; for (const r of d.daily) if (r.day === d.today) today[r.key] = r.n;
  $('upd').textContent = 'updated ' + new Date(d.now).toLocaleTimeString();
  $('t_live').textContent = fmt(d.live.players);
  $('t_live_s').textContent = 'humans across all rooms';
  $('t_rooms').textContent = fmt(d.live.rooms);
  $('t_bots').textContent = fmt(d.live.bots) + ' bots running';
  $('t_uniq').textContent = fmt(d.uniquePlayers);
  $('t_24').textContent = fmt(d.active24h) + ' active in 24 h · ' + fmt(today.new_players || 0) + ' new today';
  $('t_sess').textContent = fmt(T.player_joined || 0);
  const hrs = (T.player_seconds || 0) / 3600;
  $('t_sess_s').textContent = fmt(today.player_joined || 0) + ' today · ' + hrs.toFixed(1) + ' h played';
  $('t_match').textContent = fmt(T.match_started || 0);
  $('t_match_s').textContent = fmt(today.match_started || 0) + ' today · ' + fmt(T.room_created || 0) + ' rooms made';
  $('t_peak').textContent = fmt(d.peak.players);
  $('t_peak_s').textContent = 'in a 1-min sample, last 14 days · ' + fmt(d.peak.rooms) + ' rooms';

  line($('c_players'), d.samples, 'players', 'players');
  line($('c_rooms'), d.samples, 'rooms', 'rooms');

  $('rooms').innerHTML = '<tr><th>code</th><th>phase</th><th>map</th><th class="n">humans</th><th class="n">bots</th><th class="n">open</th></tr>' +
    (d.rooms.length ? d.rooms.map((r) => '<tr><td>' + esc(r.code) + '</td><td>' + esc(r.phase) + '</td><td>' + esc(MAPS[r.map] || r.map) +
      '</td><td class="n">' + r.humans + '</td><td class="n">' + r.bots + '</td><td class="n">' + ago(r.since) + '</td></tr>').join('')
      : '<tr><td colspan="6" class="muted">no live rooms</td></tr>');

  const days = {}; for (const r of d.daily) (days[r.day] = days[r.day] || {})[r.key] = r.n;
  const keys = Object.keys(days).sort().reverse();
  $('daily').innerHTML = '<tr><th>day</th><th class="n">sessions</th><th class="n">new players</th><th class="n">rooms</th><th class="n">matches</th><th class="n">hours</th></tr>' +
    (keys.length ? keys.map((k) => { const x = days[k]; return '<tr><td>' + k + '</td><td class="n">' + fmt(x.player_joined || 0) + '</td><td class="n">' + fmt(x.new_players || 0) +
      '</td><td class="n">' + fmt(x.room_created || 0) + '</td><td class="n">' + fmt(x.match_started || 0) + '</td><td class="n">' + ((x.player_seconds || 0) / 3600).toFixed(1) + '</td></tr>'; }).join('')
      : '<tr><td colspan="6" class="muted">nothing yet</td></tr>');

  $('events').innerHTML = '<tr><th>when</th><th>event</th><th>room</th><th>detail</th></tr>' +
    d.recent.map((e) => '<tr><td class="muted">' + ago(e.ts) + '</td><td class="ev-' + esc(e.type) + '">' + esc(e.type) + '</td><td>' + esc(e.room) + '</td><td class="muted">' + esc(e.detail) + '</td></tr>').join('');
}

// single-series line with a hover crosshair; missing minutes count as 0 (the room sampler only runs while rooms are live)
function line(el, samples, key, unit) {
  const W = 600, H = 150, L = 34, Rr = 8, Tp = 8, B = 20;
  const end = Math.floor(Date.now() / 60000) * 60000, start = end - 48 * 3600000;
  const byTs = new Map(samples.map((s) => [s.ts, s[key]]));
  const pts = []; for (let t = start; t <= end; t += 60000) pts.push([t, byTs.get(t) || 0]);
  const max = Math.max(4, ...pts.map((p) => p[1]));
  const x = (t) => L + ((t - start) / (end - start)) * (W - L - Rr), y = (v) => Tp + (1 - v / max) * (H - Tp - B);
  let path = ''; pts.forEach((p, i) => { path += (i ? 'L' : 'M') + x(p[0]).toFixed(1) + ' ' + y(p[1]).toFixed(1); });
  let grid = '';
  for (const f of [0, 0.5, 1]) { const v = Math.round(max * f), yy = y(v); grid += '<line x1="' + L + '" x2="' + (W - Rr) + '" y1="' + yy + '" y2="' + yy + '" stroke="#1a2630"/><text x="' + (L - 6) + '" y="' + (yy + 3) + '" fill="#5d7380" font-size="10" text-anchor="end">' + v + '</text>'; }
  for (let h = 0; h <= 48; h += 12) { const t = end - h * 3600000; grid += '<text x="' + x(t) + '" y="' + (H - 5) + '" fill="#5d7380" font-size="10" text-anchor="middle">' + (h ? '-' + h + 'h' : 'now') + '</text>'; }
  el.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' + grid +
    '<path d="' + path + '" fill="none" stroke="#7fe8ff" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>' +
    '<line class="xh" y1="' + Tp + '" y2="' + (H - B) + '" stroke="#8fa6b2" stroke-width="1" vector-effect="non-scaling-stroke" style="display:none"/>' +
    '<circle class="dot" r="4" fill="#7fe8ff" stroke="#0b1117" stroke-width="2" style="display:none"/></svg><div class="tip"></div>';
  const svg = el.querySelector('svg'), xh = el.querySelector('.xh'), dot = el.querySelector('.dot'), tip = el.querySelector('.tip');
  svg.onmousemove = (e) => {
    const r = svg.getBoundingClientRect(), fx = ((e.clientX - r.left) / r.width) * W;
    const t = start + Math.round(((fx - L) / (W - L - Rr)) * (end - start) / 60000) * 60000;
    const p = pts[Math.max(0, Math.min(pts.length - 1, (t - start) / 60000))];
    if (!p) return;
    xh.setAttribute('x1', x(p[0])); xh.setAttribute('x2', x(p[0])); xh.style.display = '';
    dot.setAttribute('cx', x(p[0])); dot.setAttribute('cy', y(p[1])); dot.style.display = '';
    tip.style.display = 'block'; tip.textContent = hhmm(p[0]) + '  ' + p[1] + ' ' + unit;
    const px = (x(p[0]) / W) * r.width;
    tip.style.left = Math.min(r.width - tip.offsetWidth, Math.max(0, px - tip.offsetWidth / 2)) + 'px'; tip.style.top = '-6px';
  };
  svg.onmouseleave = () => { xh.style.display = dot.style.display = 'none'; tip.style.display = 'none'; };
}
load(); setInterval(load, 10000);
</script></body></html>`;
