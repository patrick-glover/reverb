// view.js — REVERB renderer (three.js r149, global THREE)
// Pure black world. Only echo dots are drawn: one big THREE.Points over R.echo's static ring buffer (attributes
// share the echo typed arrays; only dirty ranges are uploaded), one small dynamic Points for dots stuck to actors,
// a depth-only prepass of the level geometry so dots behind walls stay hidden, a dot-outline pistol viewmodel with
// a dot muzzle flash, and a cheap grain/vignette post pass.
(function () {
  'use strict';
  const R = (window.R = window.R || {});

  const FOV = 78, CROUCH_EYE = 1.05;
  const VM_POS = [0.165, -0.118, -0.37], VM_ROT = [0.05, 0.34, -0.03];

  // ---------------------------------------------------------------- shaders
  const DOT_VS = `
    uniform float uTime, uScale, uMinPx, uMaxPx;
    attribute vec3 color;
    attribute float born, life, size;
    varying vec3 vCol;
    void main() {
      float age = uTime - born;
      if (age < 0.0 || age > life) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
      // envelope: ~40 ms attack, exponential tail, guaranteed zero at end of life
      float atk = clamp(age / 0.04, 0.0, 1.0);
      float k = 3.3 / life;
      float env = atk * (exp(-age * k) * 0.92 + 0.08 * (1.0 - age / life)) * smoothstep(life, life * 0.8, age);
      float fresh = exp(-age / 0.09);
      // fresh dots flash toward white and pop slightly larger: the wavefront edge sparkles
      vec3 c = mix(color, vec3(max(color.r, max(color.g, color.b))), 0.55 * fresh);
      c *= env * (1.0 + 1.4 * fresh);
      // dots cool toward deep cyan/blue as they age: the room reads in time as well as space
      c *= mix(vec3(1.0), vec3(0.55, 0.82, 1.2), smoothstep(0.15, 1.6, age));
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      float d = length(mv.xyz);
      // pull toward the camera along the view ray (screen position unchanged) to win against the depth prepass
      mv.xyz *= max(0.0, 1.0 - (0.025 + 0.012 * d) / max(d, 1e-3));
      float px = size * (1.0 + 0.5 * fresh) * uScale / max(-mv.z, 1e-3);
      if (px < uMinPx) { c *= (px * px) / (uMinPx * uMinPx); px = uMinPx; }
      gl_PointSize = min(px, uMaxPx);
      vCol = c;
      gl_Position = projectionMatrix * mv;
    }`;
  const DOT_FS = `
    varying vec3 vCol;
    void main() {
      vec2 p = gl_PointCoord * 2.0 - 1.0;
      float r2 = dot(p, p);
      if (r2 > 1.0) discard;
      float core = smoothstep(0.34, 0.10, r2);
      float halo = exp(-r2 * 4.5) * 0.28;
      gl_FragColor = vec4(vCol * (core + halo), 1.0);
    }`;

  const VM_VS = `
    uniform float uTime, uScale, uShotT, uShotAmp, uBase;
    attribute float dm;   // distance from muzzle (m)
    attribute float ph;   // random phase
    varying float vA;
    void main() {
      float age = uTime - uShotT - dm * 0.45;
      float lit = age < 0.0 ? 0.0 : uShotAmp * smoothstep(0.0, 0.025, age) * exp(-age * 5.5);
      float shimmer = 0.75 + 0.25 * sin(uTime * 3.0 + ph * 6.2831);
      vA = uBase * shimmer + lit;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = clamp(0.0042 * uScale / -mv.z, 1.0, 6.0);
      gl_Position = projectionMatrix * mv;
    }`;
  const VM_FS = `
    uniform vec3 uColor;
    varying float vA;
    void main() {
      vec2 p = gl_PointCoord * 2.0 - 1.0;
      float r2 = dot(p, p);
      if (r2 > 1.0) discard;
      gl_FragColor = vec4(uColor * vA * (smoothstep(0.5, 0.1, r2) + exp(-r2 * 4.0) * 0.3), 1.0);
    }`;

  const FL_VS = `
    uniform float uAge, uScale;
    attribute vec3 dir;
    attribute float spd;
    varying float vA;
    void main() {
      float a = uAge;
      vec3 p = position + dir * spd * (1.0 - exp(-a * 9.0)) / 9.0;
      vA = (a < 0.0 || a > 0.22) ? 0.0 : smoothstep(0.0, 0.01, a) * exp(-a * 16.0) * (1.2 + 0.8 * spd / 3.0);
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_PointSize = vA <= 0.0 ? 0.0 : clamp(0.008 * uScale / -mv.z, 1.5, 12.0);
      gl_Position = projectionMatrix * mv;
    }`;
  const FL_FS = `
    varying float vA;
    void main() {
      vec2 p = gl_PointCoord * 2.0 - 1.0;
      float r2 = dot(p, p);
      if (r2 > 1.0) discard;
      gl_FragColor = vec4(vec3(1.0, 0.93, 0.78) * vA * (smoothstep(0.5, 0.0, r2) + exp(-r2 * 3.0) * 0.4), 1.0);
    }`;

  const POST_VS = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
  // out = src.rgb + dst * src.a  -> src.a is the vignette multiplier, src.rgb is additive grain / hurt tint
  const POST_FS = `
    uniform float uTime, uHurt, uDpr;
    uniform vec2 uRes;
    varying vec2 vUv;
    float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
    void main() {
      vec2 q = vUv - 0.5;
      q.x *= uRes.x / uRes.y;
      float r = length(q);
      float vig = mix(1.0, 0.5, smoothstep(0.35, 1.0, r));
      vec2 cell = floor(gl_FragCoord.xy / max(1.0, uDpr));
      float t = floor(uTime * 24.0);
      float g = ign(cell + vec2(t * 17.0, t * 31.0));
      float scan = 0.97 + 0.03 * sin(gl_FragCoord.y / max(1.0, uDpr) * 3.14159);
      vec3 add = vec3(0.55, 0.75, 0.8) * (g * g) * 0.03;
      add += vec3(0.55, 0.02, 0.0) * uHurt * smoothstep(0.25, 0.9, r);
      gl_FragColor = vec4(add, vig * scan);
    }`;

  // ---------------------------------------------------------------- state
  let renderer = null, scene = null, camera = null, postScene = null, postCam = null;
  let dotGeo = null, dotPts = null, dotMat = null, dotAttrs = null;
  let actGeo = null, actPts = null, actAttrs = null;
  let occl = null, occlKey = '';
  let vmGroup = null, vmMat = null, flMat = null, postMat = null;
  let lastWritten = 0, lastGen = -1, pendingRanges = [];
  let eyeY = 1.62, bobPhase = 0, bobAmt = 0, shake = 0, hurtFlash = 0, kickZ = 0, kickPitch = 0, orbitT = 0;
  let shotT = -10, shotAmp = 0, flashT = -10;
  let lastAlive = true;

  function scaleUniform() {
    const hpx = (R.screen.h || 600) * (R.screen.dpr || 1);
    return hpx / (2 * Math.tan((FOV * Math.PI) / 360));
  }

  function dotMaterial(shared) {
    return new THREE.ShaderMaterial({
      uniforms: shared || {
        uTime: { value: 0 }, uScale: { value: 600 }, uMinPx: { value: 1.6 }, uMaxPx: { value: 48 },
      },
      vertexShader: DOT_VS, fragmentShader: DOT_FS,
      blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, depthTest: true,
    });
  }

  // ---------------------------------------------------------------- occluder (depth-only level geometry)
  function buildOccluder() {
    const W = R.world;
    if (!W || !W.boxes) return;
    const key = W.boxes.length + ':' + W.w + ':' + W.h + ':' + W.ceiling + ':' + (W.boxes[0] ? W.boxes[0].min.join(',') : '');
    if (key === occlKey && occl && occl.userData.boxes === W.boxes) return;
    occlKey = key;
    if (occl) { scene.remove(occl); occl.geometry.dispose(); }
    const boxes = W.boxes.filter((b) => b.solid !== false);
    const pos = new Float32Array((boxes.length * 36 + 12) * 3);
    let o = 0;
    const quad = (a, b, c, d) => {
      for (const v of [a, b, c, a, c, d]) { pos[o++] = v[0]; pos[o++] = v[1]; pos[o++] = v[2]; }
    };
    for (const b of boxes) {
      const x0 = b.min[0], y0 = b.min[1], z0 = b.min[2], x1 = b.max[0], y1 = b.max[1], z1 = b.max[2];
      quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]);
      quad([x0, y0, z1], [x0, y1, z1], [x1, y1, z1], [x1, y0, z1]);
      quad([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]);
      quad([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]);
      quad([x0, y0, z0], [x0, y0, z1], [x1, y0, z1], [x1, y0, z0]);
      quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]);
    }
    const T = R.TILE || 2, X = (W.w || 0) * T + 50, Z = (W.h || 0) * T + 50, C = W.ceiling || 3;
    quad([-50, 0, -50], [-50, 0, Z], [X, 0, Z], [X, 0, -50]);
    quad([-50, C, -50], [X, C, -50], [X, C, Z], [-50, C, Z]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, o), 3));
    const m = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1.5, polygonOffsetUnits: 2 });
    occl = new THREE.Mesh(g, m);
    occl.frustumCulled = false;
    occl.renderOrder = -10;
    occl.userData.boxes = W.boxes;
    scene.add(occl);
  }

  // ---------------------------------------------------------------- viewmodel (pistol as sparse dot outline)
  function buildViewmodel() {
    const pts = [], STEP = 0.0065;
    const muzzle = [0, 0.017, -0.205];
    const edge = (a, b, step) => {
      const L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), n = Math.max(1, Math.round(L / (step || STEP)));
      for (let i = 0; i <= n; i++) { const t = i / n; pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]); }
    };
    // box outline from 8 corners (p[i] = [x,y,z]); corners order: 0..3 bottom ring, 4..7 top ring
    const hexa = (c) => {
      const E = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
      for (const [a, b] of E) edge(c[a], c[b]);
    };
    const box = (x0, y0, z0, x1, y1, z1) => hexa([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]]);
    const face = (x0, x1, y0, y1, z, step) => { for (let y = y0; y <= y1 + 1e-6; y += step) for (let zz = z[0]; zz <= z[1] + 1e-6; zz += step) pts.push([x0, y, zz], [x1, y, zz]); };
    // slide
    box(-0.0125, 0.0, -0.205, 0.0125, 0.033, 0.0);
    // slide serrations (rear)
    for (let z = -0.035; z <= -0.008; z += 0.007) edge([0.0125, 0.006, z], [0.0125, 0.03, z], 0.006);
    // ejection port
    edge([0.0125, 0.033, -0.11], [0.0125, 0.033, -0.07], 0.006);
    // frame / dust cover
    box(-0.011, -0.022, -0.185, 0.011, 0.0, -0.02);
    // sights
    box(-0.002, 0.033, -0.198, 0.002, 0.041, -0.19);
    box(-0.007, 0.033, -0.012, 0.007, 0.042, -0.004);
    // grip (slanted parallelepiped)
    const gy0 = -0.022, gy1 = -0.122, sl = 0.026;
    hexa([[-0.0135, gy0, -0.062], [0.0135, gy0, -0.062], [0.0135, gy0, -0.008], [-0.0135, gy0, -0.008],
          [-0.0135, gy1, -0.062 + sl], [0.0135, gy1, -0.062 + sl], [0.0135, gy1, -0.008 + sl], [-0.0135, gy1, -0.008 + sl]]);
    // grip texture: sparse lattice on the side faces
    for (let y = gy0 - 0.012; y > gy1 + 0.008; y -= 0.011) {
      const f = (y - gy0) / (gy1 - gy0);
      for (let z = -0.052; z <= -0.018; z += 0.011) pts.push([0.0136, y, z + sl * f], [-0.0136, y, z + sl * f]);
    }
    // trigger guard arc + trigger
    for (let i = 0; i <= 14; i++) {
      const a = (i / 14) * Math.PI;
      pts.push([0, -0.022 - Math.sin(a) * 0.026, -0.093 + Math.cos(a) * 0.03]);
    }
    edge([0, -0.022, -0.085], [0, -0.04, -0.079], 0.005);
    // muzzle ring
    for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2; pts.push([Math.cos(a) * 0.006, 0.017 + Math.sin(a) * 0.006, -0.2055]); }
    face(0.0126, -0.0126, 0.0055, 0.0275, [-0.195, -0.12], 0.011);
    face(0.0112, -0.0112, -0.016, -0.005, [-0.175, -0.13], 0.011);

    const n = pts.length, pos = new Float32Array(n * 3), dm = new Float32Array(n), ph = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2];
      dm[i] = Math.hypot(p[0] - muzzle[0], p[1] - muzzle[1], p[2] - muzzle[2]);
      ph[i] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('dm', new THREE.BufferAttribute(dm, 1));
    g.setAttribute('ph', new THREE.BufferAttribute(ph, 1));
    vmMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uScale: { value: 600 }, uShotT: { value: -10 }, uShotAmp: { value: 0 }, uBase: { value: 0.22 }, uColor: { value: new THREE.Color(0.78, 0.95, 1.0) } },
      vertexShader: VM_VS, fragmentShader: VM_FS,
      blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, depthTest: false,
    });
    const gun = new THREE.Points(g, vmMat);
    gun.frustumCulled = false;
    gun.renderOrder = 1000;

    // muzzle flash burst
    const FN = 140, fp = new Float32Array(FN * 3), fd = new Float32Array(FN * 3), fs = new Float32Array(FN);
    for (let i = 0; i < FN; i++) {
      fp[i * 3] = muzzle[0]; fp[i * 3 + 1] = muzzle[1]; fp[i * 3 + 2] = muzzle[2] - 0.004;
      let dx, dy, dz;
      if (i < FN * 0.6) { // forward cone
        const a = Math.random() * Math.PI * 2, s = Math.pow(Math.random(), 1.5) * 0.45;
        dx = Math.cos(a) * s; dy = Math.sin(a) * s; dz = -1;
      } else { // side star / ring
        const a = Math.random() * Math.PI * 2;
        dx = Math.cos(a); dy = Math.sin(a); dz = -0.35 - Math.random() * 0.3;
      }
      const l = Math.hypot(dx, dy, dz);
      fd[i * 3] = dx / l; fd[i * 3 + 1] = dy / l; fd[i * 3 + 2] = dz / l;
      fs[i] = i < FN * 0.6 ? 1.2 + Math.random() * 2.2 : 0.5 + Math.random() * 0.8;
    }
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.BufferAttribute(fp, 3));
    fg.setAttribute('dir', new THREE.BufferAttribute(fd, 3));
    fg.setAttribute('spd', new THREE.BufferAttribute(fs, 1));
    flMat = new THREE.ShaderMaterial({
      uniforms: { uAge: { value: 10 }, uScale: { value: 600 } },
      vertexShader: FL_VS, fragmentShader: FL_FS,
      blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, depthTest: false,
    });
    const flash = new THREE.Points(fg, flMat);
    flash.frustumCulled = false;
    flash.renderOrder = 1001;

    vmGroup = new THREE.Group();
    vmGroup.add(gun); vmGroup.add(flash);
    vmGroup.position.set(VM_POS[0], VM_POS[1], VM_POS[2]);
    vmGroup.rotation.set(VM_ROT[0], VM_ROT[1], VM_ROT[2]);
    camera.add(vmGroup);
  }

  // ---------------------------------------------------------------- dirty-range upload
  function queueRange(start, count) { if (count > 0) pendingRanges.push([start, count]); }
  function syncDots() {
    const E = R.echo, d = E && E.dots;
    if (!d) return;
    const cap = d.capacity;
    if (d.gen !== lastGen) {
      lastGen = d.gen; lastWritten = d.written; pendingRanges = [[0, cap]];
    } else if (d.written !== lastWritten) {
      const n = d.written - lastWritten;
      if (n >= cap) pendingRanges = [[0, cap]];
      else {
        const s = lastWritten % cap, e = s + n;
        if (e <= cap) queueRange(s, n); else { queueRange(s, cap - s); queueRange(0, e - cap); }
      }
      lastWritten = d.written;
    }
    if (!pendingRanges.length) return;
    // merge adjacent ranges
    pendingRanges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const r of pendingRanges) {
      const m = merged[merged.length - 1];
      if (m && r[0] <= m[0] + m[1]) m[1] = Math.max(m[1], r[0] + r[1] - m[0]); else merged.push([r[0], r[1]]);
    }
    const multi = typeof dotAttrs[0].addUpdateRange === 'function';
    let use;
    if (multi) { use = merged; pendingRanges = []; }
    else if (merged.length === 1) { use = merged; pendingRanges = []; }
    else {
      // r149: one range per attribute per frame. Cover both if the gap is small, else do one now, rest next frame.
      const a = merged[0], b = merged[merged.length - 1];
      const span = b[0] + b[1] - a[0], sum = merged.reduce((s, r) => s + r[1], 0);
      if (span < sum * 2 + 20000) { use = [[a[0], span]]; pendingRanges = []; }
      else { use = [merged[0]]; pendingRanges = merged.slice(1); }
    }
    for (const attr of dotAttrs) {
      const isz = attr.itemSize;
      if (multi) { attr.clearUpdateRanges(); for (const r of use) attr.addUpdateRange(r[0] * isz, r[1] * isz); }
      else { attr.updateRange.offset = use[0][0] * isz; attr.updateRange.count = use[0][1] * isz; }
      attr.needsUpdate = true;
    }
  }

  function syncActorDots() {
    const E = R.echo, n = (E && E.actorDotsCount) || 0;
    actGeo.setDrawRange(0, n);
    if (!n) return;
    for (const attr of actAttrs) {
      if (typeof attr.addUpdateRange === 'function') { attr.clearUpdateRanges(); attr.addUpdateRange(0, n * attr.itemSize); }
      else { attr.updateRange.offset = 0; attr.updateRange.count = n * attr.itemSize; }
      attr.needsUpdate = true;
    }
  }

  // ---------------------------------------------------------------- camera
  function updateCamera(dt) {
    const p = R.player;
    const U = R.util;
    if (!p) {
      // no player: slow orbit for testing
      if (vmGroup) vmGroup.visible = false;
      orbitT += dt;
      const W = R.world, T = R.TILE || 2;
      const cx = ((W && W.w) || 8) * T * 0.5, cz = ((W && W.h) || 8) * T * 0.5, rad = Math.min(cx, cz) * 0.6;
      camera.position.set(cx + Math.cos(orbitT * 0.15) * rad, 1.6, cz + Math.sin(orbitT * 0.15) * rad);
      camera.rotation.set(-0.08, Math.atan2(camera.position.x - cx, camera.position.z - cz), 0);
      return;
    }
    const target = p.alive === false ? 0.42 : p.crouch ? CROUCH_EYE : p.eye || 1.62;
    eyeY += (target - eyeY) * Math.min(1, dt * (p.alive === false ? 3 : 11));
    const speed = Math.hypot(p.vx || 0, p.vz || 0);
    const moving = p.alive !== false ? Math.min(1, speed / 6.8) : 0;
    bobAmt += (moving - bobAmt) * Math.min(1, dt * 8);
    bobPhase += dt * (4.5 + speed * 1.15);
    const bobY = Math.abs(Math.sin(bobPhase)) * 0.045 * bobAmt - 0.02 * bobAmt;
    const bobX = Math.sin(bobPhase) * 0.025 * bobAmt;
    const rec = p.recoil || 0;
    kickPitch += (rec * 0.045 - kickPitch) * Math.min(1, dt * 30);
    shake = Math.max(0, shake - dt * 2.2);
    hurtFlash = Math.max(0, hurtFlash - dt * 1.6);
    const sh = shake * shake;
    const sx = (Math.random() * 2 - 1) * 0.03 * sh, sy = (Math.random() * 2 - 1) * 0.03 * sh;
    const yaw = p.yaw || 0, pitch = U.clamp((p.pitch || 0) + kickPitch + sy, -1.55, 1.55);
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const ox = bobX * c, oz = -bobX * s;   // camera-right = [cos yaw, 0, -sin yaw]
    const y = (p.y || 0) + eyeY + bobY;
    camera.position.set(p.x + ox, y, p.z + oz);
    camera.rotation.set(pitch, yaw + sx, Math.sin(bobPhase * 0.5) * 0.004 * bobAmt + sx * 0.5);
    // viewmodel sway / recoil
    if (vmGroup) {
      kickZ += (rec * 0.05 - kickZ) * Math.min(1, dt * 25);
      vmGroup.visible = p.alive !== false;
      vmGroup.position.set(VM_POS[0] + bobX * 0.35, VM_POS[1] + bobY * 0.4 - (p.crouch ? 0.005 : 0), VM_POS[2] + kickZ);
      vmGroup.rotation.set(VM_ROT[0] + rec * 0.16, VM_ROT[1], VM_ROT[2]);
    }
  }

  // ---------------------------------------------------------------- public
  const V = (R.view = {
    renderer: null, camera: null, scene: null,
    xray: false,
    init() {
      if (renderer) return;
      if (typeof THREE === 'undefined') { console.error('[view] THREE missing'); return; }
      renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
      renderer.setPixelRatio(R.screen.dpr || 1);
      renderer.setSize(R.screen.w, R.screen.h);
      renderer.setClearColor(0x000000, 1);
      renderer.autoClear = false;
      (R.stage || document.body).appendChild(renderer.domElement);
      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(FOV, R.screen.w / R.screen.h, 0.03, 400);
      camera.rotation.order = 'YXZ';
      scene.add(camera);

      const E = R.echo;
      // static dots: attributes share echo's typed arrays
      dotGeo = new THREE.BufferGeometry();
      const d = E.dots;
      dotAttrs = [
        new THREE.BufferAttribute(d.pos, 3), new THREE.BufferAttribute(d.color, 3),
        new THREE.BufferAttribute(d.born, 1), new THREE.BufferAttribute(d.life, 1), new THREE.BufferAttribute(d.size, 1),
      ];
      ['position', 'color', 'born', 'life', 'size'].forEach((n, i) => { dotAttrs[i].setUsage(THREE.DynamicDrawUsage); dotGeo.setAttribute(n, dotAttrs[i]); });
      dotGeo.setDrawRange(0, d.capacity);
      dotGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
      dotMat = dotMaterial();
      dotPts = new THREE.Points(dotGeo, dotMat);
      dotPts.frustumCulled = false;
      dotPts.renderOrder = 1;
      scene.add(dotPts);
      lastGen = d.gen; lastWritten = d.written;

      // actor dots
      actGeo = new THREE.BufferGeometry();
      actAttrs = [
        new THREE.BufferAttribute(E.actorDotsPos, 3), new THREE.BufferAttribute(E.actorDotsColor, 3),
        new THREE.BufferAttribute(E.actorDotsBorn, 1), new THREE.BufferAttribute(E.actorDotsLife, 1), new THREE.BufferAttribute(E.actorDotsSize, 1),
      ];
      ['position', 'color', 'born', 'life', 'size'].forEach((n, i) => { actAttrs[i].setUsage(THREE.DynamicDrawUsage); actGeo.setAttribute(n, actAttrs[i]); });
      actGeo.setDrawRange(0, 0);
      actGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
      actPts = new THREE.Points(actGeo, dotMaterial(dotMat.uniforms));
      actPts.frustumCulled = false;
      actPts.renderOrder = 2;
      scene.add(actPts);

      buildViewmodel();

      // post
      postScene = new THREE.Scene();
      postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      postMat = new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uHurt: { value: 0 }, uDpr: { value: 1 }, uRes: { value: new THREE.Vector2(1, 1) } },
        vertexShader: POST_VS, fragmentShader: POST_FS,
        blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.SrcAlphaFactor,
        transparent: true, depthTest: false, depthWrite: false,
      });
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMat);
      quad.frustumCulled = false;
      postScene.add(quad);

      R.bus.on('resize', () => this.resize());
      R.bus.on('sound', (ev) => {
        if (!ev || !R.player || ev.actor !== R.player) return;
        const now = R.echo ? R.echo.time : 0;
        if (ev.kind === 'gunshot') { shotT = now; shotAmp = 1.1; flashT = now; }
        else if (ev.kind === 'click') { if (now - shotT > 0.25 || shotAmp < 0.5) { shotT = now; shotAmp = 0.5; } }
        else if (ev.kind === 'reload') { shotT = now; shotAmp = 0.3; }
      });
      R.bus.on('damage', (e) => {
        if (e && R.player && e.target === R.player) {
          const k = Math.min(1, (e.amount || 20) / 45);
          shake = Math.min(1, shake + 0.45 + k * 0.5);
          hurtFlash = Math.min(1, hurtFlash + 0.35 + k * 0.5);
        }
      });
      this.renderer = renderer; this.camera = camera; this.scene = scene;
      this.resize();
    },
    resize() {
      if (!renderer) return;
      const w = R.screen.w || 960, h = R.screen.h || 600;
      renderer.setPixelRatio(R.screen.dpr || 1);
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      const s = scaleUniform();
      dotMat.uniforms.uScale.value = s;
      dotMat.uniforms.uMinPx.value = 1.25 * (R.screen.dpr || 1);
      dotMat.uniforms.uMaxPx.value = 16 * (R.screen.dpr || 1);
      vmMat.uniforms.uScale.value = s;
      flMat.uniforms.uScale.value = s;
      postMat.uniforms.uDpr.value = R.screen.dpr || 1;
      postMat.uniforms.uRes.value.set(w, h);
    },
    render(dt) {
      if (!renderer) return;
      dt = dt || 0;
      const t = R.echo ? R.echo.time : (R.time || 0);
      buildOccluder();
      if (occl) occl.visible = !this.xray;
      syncDots();
      syncActorDots();
      updateCamera(dt);
      dotMat.uniforms.uTime.value = t;
      vmMat.uniforms.uTime.value = t;
      vmMat.uniforms.uShotT.value = shotT;
      vmMat.uniforms.uShotAmp.value = shotAmp;
      flMat.uniforms.uAge.value = t - flashT;
      postMat.uniforms.uTime.value = R.time || t;
      postMat.uniforms.uHurt.value = hurtFlash * 0.12;
      renderer.clear(true, true, true);
      renderer.render(scene, camera);
      renderer.render(postScene, postCam);
    },
    project(x, y, z) {
      if (!camera) return { x: 0, y: 0, visible: false };
      const v = (this._v || (this._v = new THREE.Vector3())).set(x, y, z);
      camera.updateMatrixWorld();
      const cam = v.clone().applyMatrix4(camera.matrixWorldInverse);
      v.project(camera);
      const sx = ((v.x + 1) / 2) * R.screen.w, sy = ((1 - v.y) / 2) * R.screen.h;
      const front = cam.z < 0;
      return { x: sx, y: sy, visible: front && v.x >= -1 && v.x <= 1 && v.y >= -1 && v.y <= 1 };
    },
  });
})();
