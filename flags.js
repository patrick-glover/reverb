// flags.js — REVERB version + feature flags + dev panel (R.flags, R.flag). Loads before core.js.
// A flag is a named switch or number. Code reads it with R.flag('name'). Values persist in localStorage
// ('reverb.flags') and can be overridden per page load with ?flags=name=value,name2=value (not saved).
// Toggle the dev panel with ` (backquote). Opening it releases the mouse, which pauses the match.
(function () {
  'use strict';
  const R = (window.R = window.R || {});
  R.VERSION = '0.7.0-dev';

  // ---- registry -------------------------------------------------------------------------------------
  // type 'bool' | 'num'. apply(v) runs at boot and on every change (for flags that set a module constant).
  // when: 'live' (takes effect now) | 'match' (next match start)
  const DEFS = [
    { key: 'humanoid', group: 'Bodies', label: 'Humanoid bodies', type: 'bool', def: true, when: 'live',
      help: 'On: 13-capsule bodies with a walk cycle, used by echoes and bullets alike. Off: original cylinder + head sphere.' },
    { key: 'stickyDots', group: 'Echo', label: 'Dots stick to bodies', type: 'bool', def: false, when: 'live',
      help: 'Off: dots that hit a player freeze where the sound hit, as a ghost image. On: they follow the body (pre-0.4).' },
    { key: 'selfEcho', group: 'Echo', label: 'Gunshots light the shooter', type: 'bool', def: true, when: 'live',
      help: 'On: the gun is held out in front and its blast and reverb paint the shooter\'s own arms and body. Off: the shooter is invisible to their own shot.' },
    { key: 'muzzleFlash', group: 'Combat', label: 'Muzzle flash', type: 'bool', def: false, when: 'live',
      help: 'On: a white spark burst at your own muzzle (pre-0.4). Off: a shot only shows through its echoes.' },
    { key: 'csSpread', group: 'Combat', label: 'Movement and recoil spread', type: 'bool', def: true, when: 'live',
      help: 'On: Counter-Strike style. Shots are accurate standing still and get wider when you move, jump or keep firing; the crosshair shows the real spread. Off: fixed 0.6 deg, x3 when sprinting (pre-0.7).' },
    { key: 'dryFire', group: 'Combat', label: 'Empty gun clicks', type: 'bool', def: true, when: 'live',
      help: 'On: the last round leaves the slide locked back; the next trigger pull dry-clicks and starts the reload. Off: reload starts on the last shot.' },
    { key: 'jump', group: 'Movement', label: 'Jump (Space)', type: 'bool', def: true, when: 'live',
      help: 'On: Space jumps (onto low furniture too). Landing is a loud step. Shots in the air are wild.' },
    { key: 'momentum', group: 'Movement', label: 'A little momentum', type: 'bool', def: true, when: 'live',
      help: 'On: you take about 0.2 s to stop. Off: about 0.14 s (pre-0.7).' },
    { key: 'fireInterval', group: 'Combat', label: 'Pistol fire interval (s)', type: 'num', def: 0.2, min: 0.08, max: 0.5, step: 0.01, when: 'live',
      apply: (v) => R.weapons && (R.weapons.C.FIRE_INTERVAL = v) },
    { key: 'diffraction', group: 'Acoustics', label: 'Sound bends round corners', type: 'bool', def: true, when: 'live',
      help: 'On: loud sounds re-emit dimmer dots from doorways and corners into the rooms beyond, and a sound out of sight is heard (by you and bots) from the opening it comes round. Off: straight rays only, heard from the true position.' },
    { key: 'directivity', group: 'Acoustics', label: 'Gunshots louder in front', type: 'bool', def: true, when: 'live',
      help: 'On: a gunshot reaches about twice as far ahead of the gun as behind it, for dots, audio and bot hearing. Off: the same in every direction.' },
    { key: 'edges', group: 'Echo', label: 'Prop edge highlights', type: 'bool', def: true, when: 'live',
      apply: (v) => R.echo && (R.echo.EDGES = v) },
    { key: 'soundSpeed', group: 'Echo', label: 'Wavefront speed (m/s)', type: 'num', def: 26, min: 8, max: 120, step: 1, when: 'live',
      apply: (v) => R.echo && (R.echo.SPEED = v) },
    { key: 'bounceDim', group: 'Echo', label: 'Bounce brightness', type: 'num', def: 0.45, min: 0, max: 1, step: 0.05, when: 'live',
      apply: (v) => R.echo && (R.echo.BOUNCE_DIM = v) },
    { key: 'botSight', group: 'Bots', label: 'Bots see echo dots', type: 'bool', def: true, when: 'live',
      help: 'On: bots spot dots that land on bodies, from anyone\'s sound, if the dot is in front of them and in line of sight (what you see). Off: bots only see dots from their own clicks and darts.' },
    { key: 'bots', group: 'Match', label: 'Bot count', type: 'num', def: 5, min: 0, max: 10, step: 1, when: 'match',
      apply: (v) => R.game && (R.game.botCount = v) },
    { key: 'godMode', group: 'Debug', label: 'Player takes no damage', type: 'bool', def: false, when: 'live' },
    { key: 'perf', group: 'Debug', label: 'Performance overlay', type: 'bool', def: false, when: 'live' },
  ];
  const byKey = {};
  for (const d of DEFS) byKey[d.key] = d;

  const STORE = 'reverb.flags';
  let saved = {};
  try { saved = JSON.parse(window.localStorage.getItem(STORE) || '{}') || {}; } catch (e) { saved = {}; }
  const url = {};
  try {
    const q = new URLSearchParams(window.location.search).get('flags');
    if (q) for (const part of q.split(',')) {
      const [k, v] = part.split('=');
      if (byKey[k]) url[k] = parse(byKey[k], v == null ? '1' : v);
    }
  } catch (e) { /* no URL */ }

  function parse(d, v) {
    if (d.type === 'bool') return v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(d.max, Math.max(d.min, n)) : d.def;
  }
  const values = {};
  for (const d of DEFS) values[d.key] = d.key in url ? url[d.key] : d.key in saved ? parse(d, saved[d.key]) : d.def;

  function persist() {
    const out = {};
    for (const d of DEFS) if (values[d.key] !== d.def) out[d.key] = values[d.key];
    try { window.localStorage.setItem(STORE, JSON.stringify(out)); } catch (e) { /* ignore */ }
  }

  const F = (R.flags = {
    defs: DEFS,
    get: (k) => values[k],
    set(k, v) {
      const d = byKey[k]; if (!d) return;
      values[k] = parse(d, v);
      delete url[k];
      persist();
      if (d.apply) try { d.apply(values[k]); } catch (e) { console.error('[flags] ' + k, e); }
      if (R.bus) R.bus.emit('flag', { key: k, value: values[k] });
      render();
    },
    reset() { for (const d of DEFS) { values[d.key] = d.def; if (d.apply) d.apply(d.def); } persist(); render(); },
    changed: () => DEFS.filter((d) => values[d.key] !== d.def).map((d) => d.key),
    applyAll() { for (const d of DEFS) if (d.apply) try { d.apply(values[d.key]); } catch (e) { console.error('[flags] ' + d.key, e); } },
    toggle() { panel ? close() : open(); },
  });
  R.flag = F.get;

  // ---- dev panel (DOM) ------------------------------------------------------------------------------
  let panel = null, perfEl = null;
  const CSS = `
    #devpanel{position:fixed;top:12px;right:12px;width:300px;max-height:calc(100% - 24px);overflow:auto;z-index:20;
      background:rgba(6,10,14,.94);border:1px solid #1d2a36;border-radius:6px;color:#cfe6ee;cursor:default;
      font:12px ui-monospace,"SF Mono",Menlo,Consolas,monospace;padding:12px 14px;box-sizing:border-box}
    #devpanel h2{margin:0 0 2px;font-size:13px;color:#7fe8ff;letter-spacing:.08em}
    #devpanel .ver{color:#6f8796;margin-bottom:10px}
    #devpanel h3{margin:12px 0 6px;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#6f8796;font-weight:400}
    #devpanel .row{display:grid;grid-template-columns:1fr auto;gap:2px 8px;align-items:center;padding:4px 0}
    #devpanel .row.mod label{color:#ffd34d}
    #devpanel .help,#devpanel .when{grid-column:1/-1;color:#6f8796;font-size:11px;line-height:1.4}
    #devpanel input[type=range]{width:110px;accent-color:#7fe8ff}
    #devpanel input[type=checkbox]{accent-color:#7fe8ff;width:15px;height:15px}
    #devpanel .num{display:flex;gap:6px;align-items:center}
    #devpanel .num output{min-width:34px;text-align:right;font-variant-numeric:tabular-nums}
    #devpanel .foot{display:flex;gap:8px;margin-top:12px}
    #devpanel button{font:inherit;color:#cfe6ee;background:#101820;border:1px solid #1d2a36;border-radius:4px;padding:5px 9px;cursor:pointer}
    #devpanel .hint{color:#6f8796;margin-top:10px;line-height:1.5}
    #devperf{position:fixed;left:10px;top:10px;z-index:19;pointer-events:none;color:#7fe8ff;white-space:pre;
      font:11px ui-monospace,"SF Mono",Menlo,Consolas,monospace;background:rgba(0,0,0,.55);padding:6px 8px;border-radius:4px}`;
  function ensureCss() {
    if (document.getElementById('devcss')) return;
    const s = document.createElement('style'); s.id = 'devcss'; s.textContent = CSS; document.head.appendChild(s);
  }
  function open() {
    ensureCss();
    panel = document.createElement('div');
    panel.id = 'devpanel';
    // keep clicks in the panel from grabbing the mouse (core requests pointer lock on document mousedown)
    for (const ev of ['mousedown', 'pointerdown', 'wheel']) panel.addEventListener(ev, (e) => e.stopPropagation());
    document.body.appendChild(panel);
    if (R.input) R.input.exitLock();
    render();
  }
  function close() { if (panel) panel.remove(); panel = null; }

  function render() {
    if (!panel) return;
    const groups = {};
    for (const d of DEFS) (groups[d.group] = groups[d.group] || []).push(d);
    let h = `<h2>DEV FLAGS</h2><div class="ver">v${R.VERSION}</div>`;
    for (const g in groups) {
      h += `<h3>${g}</h3>`;
      for (const d of groups[g]) {
        const v = values[d.key], mod = v !== d.def ? ' mod' : '';
        const when = d.when === 'match' ? '<div class="when">applies next match</div>' : '';
        const help = d.help ? `<div class="help">${d.help}</div>` : '';
        if (d.type === 'bool') {
          h += `<div class="row${mod}"><label for="f_${d.key}">${d.label}</label><input type="checkbox" id="f_${d.key}" data-k="${d.key}"${v ? ' checked' : ''}>${help}${when}</div>`;
        } else {
          h += `<div class="row${mod}"><label for="f_${d.key}">${d.label}</label><span class="num"><input type="range" id="f_${d.key}" data-k="${d.key}" min="${d.min}" max="${d.max}" step="${d.step}" value="${v}"><output>${v}</output></span>${help}${when}</div>`;
        }
      }
    }
    h += `<div class="foot"><button id="f_reset">Reset all</button><button id="f_copy">Copy test URL</button></div>`;
    h += `<div class="hint">Changed flags are yellow. \` closes this panel; click the game to resume.</div>`;
    panel.innerHTML = h;
    panel.querySelectorAll('input').forEach((el) => {
      const k = el.dataset.k;
      if (el.type === 'checkbox') el.onchange = () => F.set(k, el.checked);
      else {
        el.oninput = () => { el.nextElementSibling.textContent = el.value; };
        el.onchange = () => F.set(k, el.value);
      }
    });
    panel.querySelector('#f_reset').onclick = () => F.reset();
    panel.querySelector('#f_copy').onclick = (e) => {
      const ch = F.changed().map((k) => k + '=' + (typeof values[k] === 'boolean' ? (values[k] ? 1 : 0) : values[k]));
      const u = window.location.origin + window.location.pathname + (ch.length ? '?flags=' + ch.join(',') : '');
      const b = e.target;
      const done = (ok) => { b.textContent = ok ? 'Copied' : u; setTimeout(() => (b.textContent = 'Copy test URL'), 1500); };
      try { navigator.clipboard.writeText(u).then(() => done(true), () => done(false)); } catch (err) { done(false); }
    };
  }

  // perf overlay: fps + echo cost, updated ~4x/s
  let frames = 0, acc = 0, lastT = 0;
  function perfTick(t) {
    const dt = lastT ? (t - lastT) / 1000 : 0; lastT = t;
    if (values.perf) {
      frames++; acc += dt;
      if (!perfEl) { ensureCss(); perfEl = document.createElement('div'); perfEl.id = 'devperf'; document.body.appendChild(perfEl); }
      if (acc >= 0.25) {
        const E = R.echo || {}, s = E.stats || {};
        perfEl.textContent =
          `v${R.VERSION}  ${Math.round(frames / acc)} fps\n` +
          `echo ${(s.ms || 0).toFixed(2)} ms  casts ${s.casts || 0}  jobs ${s.jobs || 0}  corners ${s.diffr || 0}\n` +
          `actor dots ${E.actorDotsCount || 0}  flags: ${F.changed().join(' ') || 'defaults'}`;
        frames = 0; acc = 0;
      }
    } else if (perfEl) { perfEl.remove(); perfEl = null; }
    requestAnimationFrame(perfTick);
  }

  if (typeof document !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Backquote' && !e.repeat) { e.preventDefault(); F.toggle(); }
    });
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(perfTick);
  }
})();
