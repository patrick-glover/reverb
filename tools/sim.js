// Headless bot-only match for checking bot/echo changes without a browser.
// Usage: node tools/sim.js . <seconds> [flags e.g. botSight=0,diffraction=0] [map index 0-2]
// Prints kills, shots, hits, how often each bot action ran, avg frame cost and any console errors.
const dir = process.argv[2], SECS = +process.argv[3] || 120;
global.window = global; global.location = { search: process.argv[4] ? '?flags=' + process.argv[4] : '' };
global.localStorage = { getItem: () => null, setItem() {} };
const fs = require('fs');
const errs = [];
const ce = console.error; console.error = (...a) => { errs.push(a.map(String).join(' ')); };
for (const f of ['flags', 'core', 'body', 'props', 'maps', 'audio', 'echo', 'weapons', 'bots', 'game']) eval(fs.readFileSync(dir + '/' + f + '.js', 'utf8'));
const R = global.R;
for (const n of ['audio', 'echo', 'weapons', 'bots', 'game']) R[n] && R[n].init && R[n].init();
R.flags.applyAll();
R.player = null;
R.game.botCount = 6;
R.game.start(+process.argv[5] || 0); R.game.requireLock = false;
const states = {}, dt = 1 / 60;
let ms = 0;
for (let i = 0; i < SECS * 60; i++) {
  R.time += dt;
  const t0 = performance.now();
  R.game.update(dt);
  ms += performance.now() - t0;
  for (const b of R.actors) if (b.brain && b.alive) states[b.brain.state] = (states[b.brain.state] || 0) + 1;
  if (R.game.state === 'over') break;
}
const st = R.bots.stats, tot = Object.values(states).reduce((a, b) => a + b, 0);
console.log('map', R.game.mapIndex, 'sim', Math.round(R.time) + 's', 'state', R.game.state, 'avg frame', (ms / (R.time * 60)).toFixed(2) + 'ms');
console.log('kills', st.kills, 'knife', st.knifeKills, 'shots', st.shots, 'hits', st.hits, 'sights', st.sights, 'clicks', st.clicks, 'darts', st.darts);
console.log('actions', Object.entries(states).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ' + (100 * v / tot).toFixed(1) + '%').join('  '));
console.log('errors', errs.length, errs.slice(0, 5).join('\n'));
