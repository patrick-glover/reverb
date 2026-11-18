// ui.js — REVERB HUD & menus (R.ui). 2D canvas in CSS px; R.ui.draw(ctx, dt) is called by core each frame.
// Plain script, no THREE. Handles menu/pause/over input too (core resets input after draw).
(function () {
  'use strict';
  const R = (window.R = window.R || {});

  // Chakra Petch for small text, dot-matrix Doto for big text (both embedded in vendor/fonts.css)
  const FONT = '"Chakra Petch", ui-monospace, "SF Mono", Menlo, Consolas, monospace';
  const DISPLAY = '"Doto", ' + FONT;
  const DISPLAY_MIN = 15;   // px: text this big (with a letter or digit in it) uses Doto
  const DISPLAY_SCALE = 1.12; // Doto reads a little small next to Chakra Petch
  const C = {
    white: '#e8f4ff',
    cyan: '#7fe8ff',
    dim: 'rgba(170,215,235,0.55)',
    faint: 'rgba(150,200,225,0.28)',
    red: '#ff3b3b',
    redSoft: 'rgba(255,60,60,',
  };
  const SENS_MIN = 0.0006, SENS_MAX = 0.0066, SENS_DEF = 0.0022, SENS_STEP = 0.0002;
  const HURT_FADE = 1.2;

  const U = (R.ui = {
    t: 0,
    hot: [],             // clickable rects rebuilt each draw: {x,y,w,h,fn,drag}
    hurts: [],           // {ax, az, rel, t, amt}
    hitT: 0, hitHead: false, killT: 0,
    kick: 0,             // crosshair bloom from own shots
    dragging: null,
    init,
    draw,
  });

  // ---------------- 5x7 dot font for the logo ----------------
  const GLYPH = {
    R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
    E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
    V: ['10001', '10001', '10001', '10001', '01010', '01010', '00100'],
    B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  };
  const SUB = 2; // each font pixel = SUB x SUB dots
  let logoDots = null, logoCols = 0, logoRows = 0;
  function buildLogo() {
    const word = 'REVERB';
    const pts = [];
    let col = 0;
    for (const ch of word) {
      const g = GLYPH[ch];
      for (let y = 0; y < 7; y++) for (let x = 0; x < 5; x++) {
        if (g[y][x] !== '1') continue;
        for (let sy = 0; sy < SUB; sy++) for (let sx = 0; sx < SUB; sx++) {
          pts.push({ c: col + x * SUB + sx, r: y * SUB + sy, seed: Math.random() * 6.283 });
        }
      }
      col += 5 * SUB + 3;
    }
    logoCols = col - 3; logoRows = 7 * SUB;
    logoDots = pts;
  }

  function init() {
    buildLogo();
    // canvas text doesn't trigger font loading on its own
    try { for (const f of ['300 12px "Chakra Petch"', '400 12px "Chakra Petch"', '500 12px "Chakra Petch"', '800 16px "Doto"']) document.fonts.load(f); } catch (e) { /* no FontFace API */ }
    try {
      const s = window.localStorage && parseFloat(window.localStorage.getItem('reverb.sens'));
      if (s > 0 && R.settings) R.settings.sens = clamp(s, SENS_MIN, SENS_MAX);
    } catch (e) { /* ignore */ }
    if (!R.bus) return;
    R.bus.on('damage', (e) => {
      if (!e) return;
      const P = R.player;
      if (P && e.target === P) {
        const a = e.attacker && e.attacker !== P ? e.attacker : null;
        U.hurts.push({ ax: a ? a.x : null, az: a ? a.z : null, rel: a ? null : (typeof P.hurtDir === 'number' ? P.hurtDir : 0), t: U.t, amt: e.amount || 20 });
        if (U.hurts.length > 8) U.hurts.shift();
      } else if (P && e.attacker === P) {
        U.hitT = 0.22; U.hitHead = e.part === 'head';
      }
    });
    R.bus.on('kill', (e) => { if (e && R.player && e.killer === R.player && e.victim !== R.player) U.killT = 0.55; });
    R.bus.on('shot', (e) => { if (e && e.actor === R.player) U.kick = Math.min(14, U.kick + 7); });
    R.bus.on('match:start', () => { U.hurts.length = 0; U.hitT = U.killT = U.kick = 0; });
  }

  // ---------------- helpers ----------------
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function font(size, weight, s) {
    if (size >= DISPLAY_MIN && /[A-Za-z0-9]/.test(s || '')) return '800 ' + Math.round(size * DISPLAY_SCALE) + 'px ' + DISPLAY;
    return (weight || '400') + ' ' + size + 'px ' + FONT;
  }
  function text(ctx, s, x, y, size, color, align, alpha, spacing, weight) {
    ctx.font = font(size, weight, s);
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    ctx.fillStyle = color || C.white;
    if (spacing && 'letterSpacing' in ctx) {
      ctx.letterSpacing = spacing + 'px';
      // letterSpacing adds trailing space; compensate for centered/right text
      const off = align === 'center' ? spacing / 2 : align === 'right' ? spacing : 0;
      ctx.fillText(s, x + off, y);
      ctx.letterSpacing = '0px';
    } else ctx.fillText(s, x, y);
    ctx.globalAlpha = 1;
  }
  function textW(ctx, s, size, weight) { ctx.font = font(size, weight, s); return ctx.measureText(s).width; }
  function line(ctx, x0, y0, x1, y1) { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); }
  function dot(ctx, x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
  function overlay(ctx, a) { ctx.globalAlpha = 1; ctx.fillStyle = 'rgba(0,0,0,' + a + ')'; ctx.fillRect(0, 0, R.screen.w, R.screen.h); }
  function hot(x, y, w, h, fn, drag) { U.hot.push({ x, y, w, h, fn, drag }); }
  function hitHot(mx, my) {
    for (let i = U.hot.length - 1; i >= 0; i--) {
      const r = U.hot[i];
      if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h) return r;
    }
    return null;
  }
  function fmtTime(s) {
    s = Math.max(0, Math.ceil(s));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  function nameOf(a) { return a ? (a === R.player ? 'YOU' : String(a.name || 'BOT').toUpperCase()) : '???'; }
  function colorOf(a) { return a ? (a === R.player ? C.cyan : a.color || C.white) : C.white; }
  function input() { return R.input || { down: () => false, pressed: () => false, mouse: { x: 0, y: 0, down: [], clicked: [] } }; }
  function setSens(v) {
    if (!R.settings) R.settings = {};
    R.settings.sens = clamp(Math.round(v / 0.00005) * 0.00005, SENS_MIN, SENS_MAX);
    try { window.localStorage && window.localStorage.setItem('reverb.sens', String(R.settings.sens)); } catch (e) { /* ignore */ }
  }
  const sens = () => (R.settings && R.settings.sens) || SENS_DEF;
  function dieWith(G) { return G || { state: 'menu' }; }

  // ---------------- main ----------------
  function draw(ctx, dt) {
    U.t += dt;
    U.hot = [];
    const G = dieWith(R.game);
    const st = G.state;
    U.hitT = Math.max(0, U.hitT - dt);
    U.killT = Math.max(0, U.killT - dt);
    U.kick = Math.max(0, U.kick - dt * 40);
    ctx.save();
    ctx.lineCap = 'round';
    if (st === 'menu') drawMenu(ctx, G);
    else if (st === 'playing') { drawHUD(ctx, G); if (input().down('Tab')) drawScoreboardPanel(ctx, G); }
    else if (st === 'dead') { drawHUD(ctx, G, true); drawDeath(ctx, G); if (input().down('Tab')) drawScoreboardPanel(ctx, G); }
    else if (st === 'paused') { drawHUD(ctx, G, true); drawPause(ctx, G); }
    else if (st === 'over') drawOver(ctx, G);
    ctx.restore();
    handleInput(G);
  }

  function handleInput(G) {
    const I = input();
    const st = G.state;
    if (R.net && R.net.overlayOpen) { if (R.input) R.input.lockOnClick = false; U.dragging = null; return; }
    const m = I.mouse || { x: 0, y: 0, down: [], clicked: [] };
    const over = hitHot(m.x, m.y);
    const menuish = st === 'menu' || st === 'over' || st === 'paused';

    // dragging (slider)
    if (U.dragging && m.down && m.down[0]) U.dragging.drag(m.x);
    else U.dragging = null;

    if (menuish && m.clicked && m.clicked[0]) {
      if (over) { over.fn(m.x, m.y); if (over.drag) U.dragging = over; }
      else if (st === 'menu') G.start && G.start();
      else if (st === 'over' && G.stateT > 1.2) G.start && G.start();
      else if (st === 'paused' && !G.requireLock) G.resume && G.resume();
    }

    if (st === 'menu' || st === 'over') {
      if (I.pressed('ArrowLeft') || I.pressed('KeyA')) G.setMap && G.setMap(G.mapIndex - 1);
      if (I.pressed('ArrowRight') || I.pressed('KeyD')) G.setMap && G.setMap(G.mapIndex + 1);
      if ((I.pressed('Enter') || I.pressed('Space')) && (st === 'menu' || G.stateT > 1.2)) {
        if (I.requestLock) I.requestLock();
        G.start && G.start();
      }
    }
    if (menuish) {
      if (I.pressed('Minus') || I.pressed('NumpadSubtract')) setSens(sens() - SENS_STEP);
      if (I.pressed('Equal') || I.pressed('NumpadAdd')) setSens(sens() + SENS_STEP);
    }
    if ((st === 'paused' || st === 'over') && I.pressed('KeyQ')) G.toMenu && G.toMenu();
    if (st === 'paused' && I.pressed('KeyX') && R.net && R.net.inMatch && R.net.isHost()) R.net.endMatch();

    // pointer lock on click: not when clicking a control, nor during the post-match click guard
    if (R.input) {
      if (st === 'playing' || st === 'dead') R.input.lockOnClick = !R.input.locked;
      else if (st === 'over' && (G.stateT <= 1.2 || (R.net && R.net.active))) R.input.lockOnClick = false;
      else R.input.lockOnClick = !over;
    }
  }

  // ---------------- menu ----------------
  function drawLogo(ctx, cx, cy, maxW) {
    if (!logoDots) buildLogo();
    const sp = Math.max(3, Math.min(11, maxW / logoCols));
    const w = logoCols * sp, h = logoRows * sp;
    const x0 = cx - w / 2 + sp / 2, y0 = cy - h / 2 + sp / 2;
    const PERIOD = 3.4;
    const cyc = Math.floor(U.t / PERIOD), ph = (U.t % PERIOD) / PERIOD;
    // ripple origin hops between letters each cycle
    const ox = cx + Math.sin(cyc * 2.39) * w * 0.32, oy = cy;
    const maxR = w * 0.95;
    const wr = ph * maxR, ww = sp * 3.2, fade = 1 - ph;
    ctx.globalCompositeOperation = 'lighter';
    for (const d of logoDots) {
      const x = x0 + d.c * sp, y = y0 + d.r * sp;
      const dx = x - ox, dy = y - oy, dist = Math.hypot(dx, dy) || 1;
      const k = Math.exp(-((dist - wr) * (dist - wr)) / (ww * ww)) * fade;
      const sh = 0.5 + 0.5 * Math.sin(U.t * 3.1 + d.seed);
      const a = 0.42 + 0.14 * sh + 0.6 * k;
      const push = k * sp * 0.45;
      const px = x + (dx / dist) * push, py = y + (dy / dist) * push;
      ctx.globalAlpha = clamp(a, 0, 1);
      ctx.fillStyle = k > 0.25 ? '#ffffff' : C.cyan;
      dot(ctx, px, py, sp * (0.26 + 0.14 * k));
    }
    // the wavefront itself: a sparse ring of faint dots, like rays striking nothing
    const n = 120;
    ctx.fillStyle = C.cyan;
    for (let i = 0; i < n; i++) {
      const an = (i / n) * Math.PI * 2 + cyc;
      const rr = wr * (1 + 0.02 * Math.sin(i * 7.1 + cyc));
      ctx.globalAlpha = 0.22 * fade * (0.5 + 0.5 * Math.sin(i * 3.7 + U.t * 2));
      dot(ctx, ox + Math.cos(an) * rr, oy + Math.sin(an) * rr * 0.55, 1);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    return { w, h, sp };
  }

  function drawArrowSelector(ctx, cx, y, label, onPrev, onNext) {
    text(ctx, label, cx, y, 15, C.white, 'center', 0.95, 4);
    const half = Math.max(110, textW(ctx, label, 15) / 2 + 40);
    const m = input().mouse;
    for (const s of [-1, 1]) {
      const ax = cx + s * half;
      const hov = m && Math.abs(m.x - ax) < 18 && Math.abs(m.y - y) < 14;
      ctx.strokeStyle = hov ? C.white : C.cyan; ctx.globalAlpha = hov ? 1 : 0.6; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(ax - s * 4, y - 7); ctx.lineTo(ax + s * 4, y); ctx.lineTo(ax - s * 4, y + 7); ctx.stroke();
      ctx.globalAlpha = 1;
      hot(ax - 18, y - 14, 36, 28, s < 0 ? onPrev : onNext);
    }
  }

  function drawSensSlider(ctx, cx, y) {
    const v = sens();
    text(ctx, 'SENSITIVITY', cx, y - 18, 10, C.dim, 'center', 1, 3);
    const tw = 180, x0 = cx - tw / 2;
    const f = (v - SENS_MIN) / (SENS_MAX - SENS_MIN);
    ctx.strokeStyle = C.faint; ctx.lineWidth = 1;
    line(ctx, x0, y, x0 + tw, y);
    // tick dots
    ctx.fillStyle = C.cyan;
    for (let i = 0; i <= 20; i++) { ctx.globalAlpha = i / 20 <= f ? 0.8 : 0.2; dot(ctx, x0 + (tw * i) / 20, y, 1.2); }
    ctx.globalAlpha = 1; ctx.fillStyle = C.white;
    dot(ctx, x0 + tw * f, y, 3.5);
    text(ctx, 'x' + (v / SENS_DEF).toFixed(2), x0 + tw + 34, y, 11, C.cyan, 'center', 0.9);
    // - / + buttons
    text(ctx, '−', x0 - 22, y, 15, C.cyan, 'center', 0.8);
    hot(x0 - 34, y - 12, 24, 24, () => setSens(v - SENS_STEP));
    text(ctx, '+', x0 + tw + 8, y, 15, C.cyan, 'center', 0.8);
    hot(x0 + tw - 2, y - 12, 18, 24, () => setSens(v + SENS_STEP));
    const set = (mx) => setSens(SENS_MIN + clamp((mx - x0) / tw, 0, 1) * (SENS_MAX - SENS_MIN));
    hot(x0 - 4, y - 10, tw + 8, 20, (mx) => set(mx), set);
  }

  const CONTROLS = [
    ['WASD', 'move'], ['SHIFT', 'sprint (loud)'], ['C / CTRL', 'crouch (quiet)'], ['E', 'click — echolocate'],
    ['LMB', 'fire'], ['RMB / Q', 'sonar dart'], ['F', 'knife'], ['R', 'reload'], ['TAB', 'scores'], ['M', 'mute'],
  ];
  function drawControls(ctx, cx, y, alpha) {
    const colW = 210, rows = Math.ceil(CONTROLS.length / 2), lh = 17;
    for (let i = 0; i < CONTROLS.length; i++) {
      const col = i < rows ? 0 : 1, row = i % rows;
      const x = cx - colW + col * colW + 8, yy = y + row * lh;
      text(ctx, CONTROLS[i][0], x + 72, yy, 11, C.cyan, 'right', 0.85 * alpha);
      text(ctx, CONTROLS[i][1], x + 84, yy, 11, C.dim, 'left', alpha);
    }
    return rows * lh;
  }

  function drawMenu(ctx, G) {
    const W = R.screen.w, H = R.screen.h;
    overlay(ctx, 0.72);
    const compact = H < 560;
    const logo = drawLogo(ctx, W / 2, H * (compact ? 0.17 : 0.22), Math.min(W * 0.62, 640));
    let y = H * (compact ? 0.17 : 0.22) + logo.h / 2 + 26;
    y += compact ? 40 : 54;
    text(ctx, 'MAP', W / 2, y - 22, 10, C.dim, 'center', 1, 3);
    drawArrowSelector(ctx, W / 2, y, G.mapName ? G.mapName().toUpperCase() : 'MAP',
      () => G.setMap && G.setMap(G.mapIndex - 1), () => G.setMap && G.setMap(G.mapIndex + 1));
    y += compact ? 50 : 62;
    drawSensSlider(ctx, W / 2, y);
    y += compact ? 32 : 44;
    y += drawControls(ctx, W / 2, y, 0.9) + (compact ? 14 : 26);
    const pulse = 0.55 + 0.45 * Math.sin(U.t * 2.6);
    const online = !!(R.net && R.net.available());
    const playY = Math.min(y, H - (online ? 76 : 44));
    text(ctx, 'CLICK TO PLAY', W / 2, playY, 16, C.white, 'center', pulse, 6, '400');
    if (online) drawOnlineButtons(ctx, W / 2, playY + 34);
    text(ctx, 'you vs 5 — first to ' + (G.killLimit || 15) + ' kills — headphones on', W / 2, H - 18, 10, C.faint, 'center', 1, 2);
  }

  // HOST ONLINE · JOIN WITH CODE (open the lobby overlay in net.js)
  function drawOnlineButtons(ctx, cx, y) {
    const m = input().mouse || { x: -1, y: -1 };
    const items = [['HOST ONLINE', () => R.net.openHost()], ['JOIN WITH CODE', () => R.net.openJoin()]];
    const gap = 46, ws = items.map(([s]) => textW(ctx, s, 12, '400') + s.length * 3);
    let x = cx - (ws[0] + ws[1] + gap) / 2;
    items.forEach(([s, fn], i) => {
      const w = ws[i], hov = m.x > x - 8 && m.x < x + w + 8 && Math.abs(m.y - y) < 14;
      text(ctx, s, x + w / 2, y, 12, hov ? C.white : C.cyan, 'center', hov ? 1 : 0.75, 3, '400');
      ctx.strokeStyle = hov ? C.white : C.cyan; ctx.globalAlpha = hov ? 0.8 : 0.3; ctx.lineWidth = 1;
      line(ctx, x, y + 11, x + w, y + 11); ctx.globalAlpha = 1;
      hot(x - 8, y - 14, w + 16, 28, fn);
      if (i === 0) { text(ctx, '·', x + w + gap / 2, y, 12, C.faint, 'center', 1); }
      x += w + gap;
    });
  }

  // ---------------- HUD ----------------
  function drawHUD(ctx, G, passive) {
    const W = R.screen.w, H = R.screen.h, P = R.player;
    const cx = W / 2, cy = H / 2;
    if (P) {
      drawVignette(ctx, P);
      if (P.alive && !passive) drawCrosshair(ctx, P, cx, cy);
      drawDamageArcs(ctx, P, cx, cy);
      drawHealth(ctx, P, H);
      drawAmmo(ctx, P, W, H);
    }
    drawTop(ctx, G, W);
    drawFeed(ctx, G, W);
  }

  function drawVignette(ctx, P) {
    const W = R.screen.w, H = R.screen.h;
    if (!P.alive) return;
    const hp = P.health;
    let a = 0;
    if (hp < 40) a = (1 - hp / 40) * (0.32 + 0.12 * Math.sin(U.t * (hp < 20 ? 7 : 4)));
    const last = U.hurts[U.hurts.length - 1];
    if (last) a = Math.max(a, 0.35 * clamp(1 - (U.t - last.t) / 0.5, 0, 1));
    if (a <= 0.005) return;
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.hypot(W, H) * 0.55);
    g.addColorStop(0, 'rgba(255,0,0,0)');
    g.addColorStop(1, 'rgba(200,0,0,' + clamp(a, 0, 0.6).toFixed(3) + ')');
    ctx.globalAlpha = 1; ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }

  function drawCrosshair(ctx, P, cx, cy) {
    const spd = Math.hypot(P.vx || 0, P.vz || 0);
    const rec = typeof P.recoil === 'number' ? clamp(Math.abs(P.recoil) * 40, 0, 12) : 0;
    const gap = 4 + spd * 0.9 + U.kick + rec;
    ctx.strokeStyle = C.white; ctx.lineWidth = 1; ctx.globalAlpha = 0.75;
    line(ctx, cx - gap - 5, cy, cx - gap, cy);
    line(ctx, cx + gap, cy, cx + gap + 5, cy);
    line(ctx, cx, cy - gap - 5, cx, cy - gap);
    line(ctx, cx, cy + gap, cx, cy + gap + 5);
    ctx.globalAlpha = 0.95; ctx.fillStyle = C.white;
    ctx.fillRect(cx - 0.75, cy - 0.75, 1.5, 1.5);
    // click cooldown ring
    const cd = typeof P.clickCooldown === 'number' ? P.clickCooldown : 0;
    if (cd > 0) {
      const f = clamp(cd / 0.55, 0, 1);
      ctx.strokeStyle = C.cyan; ctx.globalAlpha = 0.5; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(cx, cy, 20, -Math.PI / 2, -Math.PI / 2 + f * Math.PI * 2); ctx.stroke();
    }
    // reload wheel: faint track, white fill sweeping clockwise from the top
    const w = P.wpn;
    if (w && w.reloadT > 0) {
      const f = clamp(1 - w.reloadT / (w.reloadTime || 1.5), 0, 1);
      ctx.lineWidth = 2; ctx.strokeStyle = C.white;
      ctx.globalAlpha = 0.15; ctx.beginPath(); ctx.arc(cx, cy, 13, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 0.8; ctx.beginPath(); ctx.arc(cx, cy, 13, -Math.PI / 2, -Math.PI / 2 + f * Math.PI * 2); ctx.stroke();
    }
    // hit marker
    const pm = typeof P.hitMarkerT === 'number' ? P.hitMarkerT : typeof P.lastHitMarker === 'number' && P.lastHitMarker < 1 ? P.lastHitMarker : 0;
    const pk = typeof P.killMarkerT === 'number' ? P.killMarkerT : 0;
    const hm = Math.max(U.hitT / 0.22, U.killT / 0.55, clamp(pm / 0.2, 0, 1), clamp(pk / 0.5, 0, 1));
    if (hm > 0) {
      const k = U.killT > 0 || pk > 0, s0 = k ? 7 : 6, s1 = k ? 15 : 11;
      ctx.strokeStyle = k || U.hitHead ? C.red : C.white;
      ctx.globalAlpha = clamp(hm, 0, 1); ctx.lineWidth = k ? 2 : 1.5;
      for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) line(ctx, cx + sx * s0, cy + sy * s0, cx + sx * s1, cy + sy * s1);
    }
    ctx.globalAlpha = 1;
  }

  // relative screen angle (0 = ahead, +pi/2 = right) of a world point from the player
  function relAngle(P, x, z) {
    const dx = x - P.x, dz = z - P.z;
    const fx = -Math.sin(P.yaw), fz = -Math.cos(P.yaw);
    const rx = Math.cos(P.yaw), rz = -Math.sin(P.yaw);
    return Math.atan2(dx * rx + dz * rz, dx * fx + dz * fz);
  }

  function drawDamageArcs(ctx, P, cx, cy) {
    const RAD = Math.min(R.screen.w, R.screen.h) * 0.13 + 30;
    for (const h of U.hurts) {
      const age = U.t - h.t;
      if (age > HURT_FADE) continue;
      const f = 1 - age / HURT_FADE;
      const th = h.ax != null ? relAngle(P, h.ax, h.az) : -(h.rel || 0); // fallback: hurtDir assumed +left like yaw
      const ca = th - Math.PI / 2;
      const span = 0.3 + clamp(h.amt / 100, 0, 1) * 0.35;
      ctx.strokeStyle = C.red;
      ctx.globalAlpha = 0.9 * f * f + 0.1 * f; ctx.lineWidth = 3 + 3 * f;
      ctx.beginPath(); ctx.arc(cx, cy, RAD, ca - span / 2, ca + span / 2); ctx.stroke();
      // inner chevron pointing outward
      ctx.lineWidth = 1.5; ctx.globalAlpha = 0.8 * f;
      const ix = cx + Math.cos(ca) * (RAD - 12), iy = cy + Math.sin(ca) * (RAD - 12);
      const tx = cx + Math.cos(ca) * (RAD - 6), ty = cy + Math.sin(ca) * (RAD - 6);
      const nx = -Math.sin(ca) * 5, ny = Math.cos(ca) * 5;
      ctx.beginPath(); ctx.moveTo(ix + nx, iy + ny); ctx.lineTo(tx, ty); ctx.lineTo(ix - nx, iy - ny); ctx.stroke();
      // world-anchored marker at where the shot came from (it was loud; you heard it)
      if (h.ax != null && R.view && typeof R.view.project === 'function') {
        let p = null;
        try { p = R.view.project(h.ax, 1.3, h.az); } catch (e) { p = null; }
        if (p && p.visible) {
          ctx.globalAlpha = 0.7 * f; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(p.x, p.y - 6); ctx.lineTo(p.x + 6, p.y); ctx.lineTo(p.x, p.y + 6); ctx.lineTo(p.x - 6, p.y); ctx.closePath(); ctx.stroke();
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawHealth(ctx, P, H) {
    const hp = Math.max(0, Math.round(P.alive ? P.health : 0));
    const low = hp < 35;
    const pulse = low ? 0.6 + 0.4 * Math.sin(U.t * 8) : 1;
    const col = low ? C.red : C.white;
    const x = 28, y = H - 40;
    text(ctx, String(hp), x, y, 28, col, 'left', 0.9 * pulse, 0, '200');
    text(ctx, 'HP', x + textW(ctx, String(hp), 28, '200') + 6, y + 6, 10, low ? C.red : C.dim, 'left', 0.9);
    const bw = 130, by = y + 22;
    ctx.globalAlpha = 0.25; ctx.fillStyle = C.white; ctx.fillRect(x, by, bw, 2);
    ctx.globalAlpha = 0.85 * pulse; ctx.fillStyle = col; ctx.fillRect(x, by, bw * clamp(hp / 100, 0, 1), 2);
    ctx.globalAlpha = 1;
  }

  function drawAmmo(ctx, P, W, H) {
    const w = P.wpn || {};
    const mag = w.mag || 12;
    const ammo = w.ammo == null ? mag : w.ammo;
    const x1 = W - 28, y = H - 34;
    const reloading = w.reloadT > 0 || P.reloading;
    // pips (right-aligned)
    for (let i = 0; i < mag; i++) {
      const px = x1 - (mag - 1 - i) * 7 - 2;
      const full = i < ammo;
      ctx.fillStyle = full ? C.white : C.faint;
      ctx.globalAlpha = full ? (reloading ? 0.35 : 0.85) : 0.5;
      ctx.fillRect(px, y - 6, 2, 12);
    }
    const left = x1 - (mag - 1) * 7 - 2;
    text(ctx, ammo === 0 && !reloading ? 'R  RELOAD' : 'PISTOL', left - 14, y, 10, ammo === 0 && !reloading ? C.red : C.dim, 'right',
      ammo === 0 && !reloading ? 0.6 + 0.4 * Math.sin(U.t * 6) : 0.9, 2);
    if (reloading) {
      const tot = w.reloadTime || 1.5;
      const f = clamp(1 - (w.reloadT || 0) / tot, 0, 1);
      const rx = left - 14 - textW(ctx, 'PISTOL', 10) - 22, ry = y;
      ctx.strokeStyle = C.faint; ctx.lineWidth = 1.5; ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.arc(rx, ry, 8, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = C.cyan;
      ctx.beginPath(); ctx.arc(rx, ry, 8, -Math.PI / 2, -Math.PI / 2 + f * Math.PI * 2); ctx.stroke();
    }
    // darts
    const darts = w.darts == null ? (typeof P.darts === 'number' ? P.darts : 0) : w.darts;
    const dy = y - 26;
    for (let i = 0; i < 5; i++) {
      const dx = x1 - i * 13 - 3;
      const have = i < darts;
      ctx.strokeStyle = C.cyan; ctx.fillStyle = C.cyan; ctx.lineWidth = 1;
      ctx.globalAlpha = have ? 0.85 : 0.18;
      ctx.beginPath(); ctx.moveTo(dx, dy - 4); ctx.lineTo(dx + 4, dy); ctx.lineTo(dx, dy + 4); ctx.lineTo(dx - 4, dy); ctx.closePath();
      if (have) ctx.fill(); else ctx.stroke();
    }
    text(ctx, 'DART', x1 - 5 * 13 - 6, dy, 10, C.dim, 'right', 0.9, 2);
    ctx.globalAlpha = 1;
  }

  function drawTop(ctx, G, W) {
    const tl = G.timeLeft == null ? 0 : G.timeLeft;
    text(ctx, fmtTime(tl), W / 2, 22, 17, tl < 30 ? C.red : C.white, 'center', 0.85, 2, '300');
    const P = R.player;
    const rank = G.ranking ? G.ranking() : [];
    const lead = rank[0];
    const mine = P ? P.kills : 0;
    let s;
    if (!lead) s = '';
    else if (lead === P || (lead.kills === mine && P)) {
      const second = rank.find((a) => a !== P);
      s = 'YOU ' + mine + '  ·  ' + (second ? nameOf(second) + ' ' + second.kills : '');
      text(ctx, s, W / 2, 42, 11, C.cyan, 'center', 0.75, 1);
    } else {
      text(ctx, 'YOU ' + mine, W / 2 - 10, 42, 11, C.cyan, 'right', 0.75, 1);
      text(ctx, '·', W / 2, 42, 11, C.dim, 'center', 0.75);
      text(ctx, nameOf(lead) + ' ' + lead.kills, W / 2 + 10, 42, 11, colorOf(lead), 'left', 0.75, 1);
    }
    text(ctx, 'FIRST TO ' + (G.killLimit || 15), W / 2, 58, 9, C.faint, 'center', 1, 2);
  }

  function drawFeed(ctx, G, W) {
    const feed = G.killFeed || [];
    const now = G.time || 0;
    let y = 22;
    for (let i = feed.length - 1; i >= 0; i--) {
      const e = feed[i];
      const age = now - e.t;
      if (age > 5) continue;
      const a = age > 4 ? 5 - age : 1;
      const parts = [];
      if (e.killer && e.killer !== e.victim) parts.push([nameOf(e.killer), colorOf(e.killer)]);
      parts.push([e.weapon === 'knife' ? ' ⟋ ' : ' ▸ ', C.dim]);
      parts.push([nameOf(e.victim), colorOf(e.victim)]);
      if (e.headshot) parts.push([' HS', C.red]);
      let x = W - 20;
      for (let k = parts.length - 1; k >= 0; k--) {
        const [s, col] = parts[k];
        text(ctx, s, x, y, 11, col, 'right', 0.85 * a);
        x -= textW(ctx, s, 11);
      }
      y += 17;
    }
  }

  // ---------------- scoreboard ----------------
  function drawScoreboard(ctx, G, cx, y, alpha) {
    const rank = G.ranking ? G.ranking() : R.actors.slice();
    const w = 320, x0 = cx - w / 2, lh = 22;
    text(ctx, 'NAME', x0 + 30, y, 9, C.dim, 'left', alpha, 2);
    text(ctx, 'K', x0 + w - 60, y, 9, C.dim, 'right', alpha, 2);
    text(ctx, 'D', x0 + w - 12, y, 9, C.dim, 'right', alpha, 2);
    ctx.strokeStyle = C.faint; ctx.lineWidth = 1; ctx.globalAlpha = alpha;
    line(ctx, x0, y + 10, x0 + w, y + 10);
    y += 26;
    rank.forEach((a, i) => {
      const me = a === R.player;
      if (me) { ctx.globalAlpha = 0.08 * alpha; ctx.fillStyle = C.cyan; ctx.fillRect(x0 - 6, y - lh / 2, w + 12, lh); }
      const da = (a.alive ? 1 : 0.5) * alpha;
      text(ctx, String(i + 1), x0 + 6, y, 11, C.dim, 'left', alpha);
      ctx.fillStyle = colorOf(a); ctx.globalAlpha = da; dot(ctx, x0 + 22, y, 2.5);
      text(ctx, me ? (a.name && String(a.name).toUpperCase() !== 'YOU' ? String(a.name).toUpperCase() + ' (YOU)' : 'YOU') : nameOf(a), x0 + 30, y, 12, colorOf(a), 'left', da, 1);
      text(ctx, String(a.kills || 0), x0 + w - 60, y, 12, C.white, 'right', alpha);
      text(ctx, String(a.deaths || 0), x0 + w - 12, y, 12, C.dim, 'right', alpha);
      y += lh;
    });
    ctx.globalAlpha = 1;
    return y;
  }
  function drawScoreboardPanel(ctx, G) {
    const W = R.screen.w, H = R.screen.h;
    overlay(ctx, 0.55);
    const y0 = H / 2 - 110;
    text(ctx, (G.mapName ? G.mapName().toUpperCase() : '') + '  ·  ' + fmtTime(G.timeLeft || 0), W / 2, y0 - 26, 11, C.dim, 'center', 1, 3);
    drawScoreboard(ctx, G, W / 2, y0, 1);
  }

  // ---------------- death / pause / over ----------------
  function drawDeath(ctx, G) {
    const W = R.screen.w, H = R.screen.h, P = R.player;
    overlay(ctx, 0.3);
    if (P && P.netWaiting) { text(ctx, 'JOINING THE MATCH', W / 2, H * 0.42, 13, C.cyan, 'center', 0.6 + 0.4 * Math.sin(U.t * 4), 6); return; }
    const d = G.lastDeath || {};
    const k = d.killer && d.killer !== P ? d.killer : null;
    const y = H * 0.36;
    text(ctx, k ? 'HEARD BY' : 'SILENCED', W / 2, y, 11, C.dim, 'center', 1, 6);
    if (k) text(ctx, nameOf(k), W / 2, y + 30, 26, colorOf(k), 'center', 0.95, 6, '300');
    let tag = '';
    if (d.headshot) tag = 'HEADSHOT';
    if (d.weapon === 'knife') tag = tag ? tag + ' · KNIFE' : 'KNIFE';
    if (tag) text(ctx, tag, W / 2, y + 58, 11, C.red, 'center', 0.9, 4);
    const rt = P && typeof P.respawnT === 'number' ? Math.max(0, P.respawnT) : 0;
    text(ctx, 'respawning in ' + rt.toFixed(1), W / 2, H * 0.62, 12, C.dim, 'center', 1, 2);
    const bw = 140, f = clamp(1 - rt / 3, 0, 1);
    ctx.globalAlpha = 0.2; ctx.fillStyle = C.white; ctx.fillRect(W / 2 - bw / 2, H * 0.62 + 14, bw, 1);
    ctx.globalAlpha = 0.8; ctx.fillStyle = C.cyan; ctx.fillRect(W / 2 - bw / 2, H * 0.62 + 14, bw * f, 1);
    ctx.globalAlpha = 1;
  }

  function drawPause(ctx, G) {
    const W = R.screen.w, H = R.screen.h;
    overlay(ctx, 0.7);
    let y = H * 0.2;
    text(ctx, 'PAUSED', W / 2, y, 24, C.white, 'center', 0.95, 10, '200');
    y += 34;
    text(ctx, 'click to resume', W / 2, y, 13, C.cyan, 'center', 0.6 + 0.4 * Math.sin(U.t * 2.6), 3);
    y += 50;
    drawSensSlider(ctx, W / 2, y);
    y += 40;
    y += drawControls(ctx, W / 2, y, 0.85) + 24;
    const net = R.net && R.net.active ? R.net : null;
    text(ctx, net ? 'Q  —  leave the room' : 'Q  —  quit to menu', W / 2, y, 11, C.dim, 'center', 1, 2);
    if (net && net.isHost()) text(ctx, 'X  —  end the match for everyone', W / 2, y + 20, 11, C.dim, 'center', 1, 2);
    if (net) text(ctx, 'ONLINE · ROOM ' + net.code + ' · ' + Math.round(net.rtt || 0) + ' MS  —  the match keeps going while you\'re paused', W / 2, H - 40, 10, C.cyan, 'center', 0.7, 2);
    text(ctx, (G.mapName ? G.mapName().toUpperCase() : '') + '  ·  ' + fmtTime(G.timeLeft || 0) + ' left', W / 2, H - 22, 10, C.faint, 'center', 1, 2);
  }

  function drawOver(ctx, G) {
    const W = R.screen.w, H = R.screen.h, P = R.player;
    overlay(ctx, 0.78);
    const win = G.winner;
    let y = Math.max(40, H * 0.1);
    text(ctx, 'MATCH OVER', W / 2, y, 11, C.dim, 'center', 1, 6);
    y += 32;
    const youWin = win && win === P;
    text(ctx, win ? (youWin ? 'YOU WIN' : nameOf(win) + ' WINS') : 'DRAW', W / 2, y, 28, youWin ? C.cyan : colorOf(win), 'center', 0.95, 8, '200');
    y += 40;
    y = drawScoreboard(ctx, G, W / 2, y, 0.95) + 14;
    // stats
    const S = G.stats || {};
    const acc = G.accuracy ? G.accuracy() : null;
    const items = [
      ['KILLS', S.kills || 0], ['DEATHS', S.deaths || 0],
      ['ACCURACY', acc == null ? '—' : Math.round(acc * 100) + '%'],
      ['HEADSHOTS', S.headshots || 0], ['BEST STREAK', S.longestStreak || 0],
    ];
    const cw = Math.min(110, (W - 40) / items.length);
    items.forEach(([k, v], i) => {
      const x = W / 2 + (i - (items.length - 1) / 2) * cw;
      text(ctx, String(v), x, y, 18, C.white, 'center', 0.9, 0, '200');
      text(ctx, k, x, y + 20, 8, C.dim, 'center', 1, 2);
    });
    y += 60;
    const online = !!(R.net && R.net.active);
    if (!online) {
      drawArrowSelector(ctx, W / 2, y, G.mapName ? G.mapName().toUpperCase() : 'MAP',
        () => G.setMap && G.setMap(G.mapIndex - 1), () => G.setMap && G.setMap(G.mapIndex + 1));
      y += 40;
    }
    const ready = (G.stateT || 0) > 1.2;
    text(ctx, online ? 'CLICK FOR THE LOBBY' : 'CLICK TO PLAY AGAIN', W / 2, Math.min(y, H - 42), 15, C.white, 'center', ready ? 0.55 + 0.45 * Math.sin(U.t * 2.6) : 0.2, 6, '400');
    text(ctx, online ? 'Q  —  leave the room' : 'Q  —  menu', W / 2, H - 18, 10, C.faint, 'center', 1, 2);
  }
})();
