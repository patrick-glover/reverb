# REVERB — Design Spec & Module Contract

> **Historical.** This is the v0.1 spec the first modules were written against, kept as the design record. The game
> has moved on: bots now see echo dots that land on bodies, three.js and the fonts are vendored (no CDN),
> `flags.js`, `body.js` and `net.js` were added (so the load order differs), and online play runs matches on a
> server (`docs/MULTIPLAYER.md`). Where this file and the code, `README.md` or `docs/MULTIPLAYER.md` disagree, they win.

## Pitch
A first-person deathmatch in total darkness. Nothing is ever lit. **Every sound radiates rays** that
travel outward at a (slowed) speed of sound, and where they strike a surface they leave **glowing dots**
snapped to a fine lattice: a dot-matrix imprint on walls, chair legs, shelves, and bodies. Rays **bounce**,
so a gunshot paints the room twice: first the direct wave, then a dimmer, delayed reverb wave.
Dots that land on a player **stick to that player** and move with them, so you see a ghostly point
silhouette running away until it fades.

You vs 5 bots, free-for-all. Bots are blind too and play by the same rules: they **hear**, they never see.
Every shot you fire lights up the room for you and also tells everyone exactly where you are.

Win: first to 15 kills, or most kills when the 6:00 timer ends.

## Feel targets
- Pure black. Dots are small, crisp, additive, and slightly bloomy. White/cyan for your own sounds, red for bot sounds,
  green for world hums (pickups). Dot brightness falls off with distance travelled; bounce dots are dimmer and bluer.
- Walking is a soft sprinkle of dots around your feet. Sprinting is a bright splash. A gunshot fills the room.
- The tongue-click (E) is the signature move: a forward cone of dense dots, like real echolocation, cheap and fairly quiet.
- Headphones matter: every sound is HRTF-spatialized with room-sized reverb.

## Tech
- Plain browser JS, **no build, no ES modules**, global namespace `window.R`. Must run from `file://`.
- three.js r149 UMD from CDN (global `THREE`): `https://cdn.jsdelivr.net/npm/three@0.149.0/build/three.min.js`.
  Only `view.js` (renderer) should depend on THREE. Every other module must work in node with THREE absent.
- Load order (index.html): `three, core.js, props.js, maps.js, audio.js, echo.js, view.js, weapons.js, player.js, bots.js, game.js, ui.js`, then `R.boot()`.
  Files only define things at load time; setup happens in `init()`.
- Units: **meters, seconds**. Y up. Map grid rows = +Z, columns = +X. `R.TILE = 2` (m).
- Pointer lock for mouse look (requested by ui.js on click).

## Provided by core.js (DONE, owned by orchestrator, do not edit)
```
R.TILE=2, R.util {clamp, lerp, rand, randInt, choose, dist2(ax,az,bx,bz), dist3(...6), angleWrap(a), approach, fib(i,n)->[x,y,z] unit vector}
R.bus  {on, off, emit}
R.input {down(code), pressed(code), anyPressed(), mouse:{down:[l,m,r], clicked:[l,m,r]}, takeLook()->{dx,dy} (pointer-lock deltas, reset on read),
         wheel (accumulated, reset each frame), locked (bool), requestLock(), exitLock()}
R.screen {w, h, dpr}   CSS pixel size of window; 'resize' event on bus
R.actors []            all players incl. bots. Create with R.makeActor({name,isBot,color}) and push yourself.
R.makeActor(o) -> {id, name, isBot, color, x, y:0, z, yaw, pitch, vx, vz, r:0.35, h:1.8, eye:1.62, crouch:false,
                   health:100, alive:false, kills:0, deaths:0, lastNoise:0}
                   yaw: 0 looks toward -Z; positive yaw turns left (three.js camera convention).
R.forward(yaw,pitch) -> [dx,dy,dz] unit look vector consistent with three.js camera rotation order 'YXZ'.
R.world:
  w, h (tiles), ceiling (m), tiles (Uint8Array of chars codes), mats (Uint8Array floor material per tile: R.MAT.*)
  boxes [{min:[x,y,z], max:[x,y,z], mat:'concrete'|'wood'|'metal'|'fabric'|'glass'|'plaster', kind, solid:true}]
  reset(w,h,ceiling) ; addBox(x0,y0,z0,x1,y1,z1, mat, kind) ; setFloor(tx,tz,R.MAT.x) ; finalize()   (builds broadphase + nav)
  raycast(ox,oy,oz, dx,dy,dz, maxDist, opts={actors:true, ignore:actorOrNull})
      -> null | {t, x,y,z, nx,ny,nz, mat, box|null, actor|null, part:'head'|'body'|null, surface:'floor'|'ceiling'|'box'|'actor'}
      floor (y=0) and ceiling (y=ceiling) are implicit planes (mat 'floor'/'ceiling').
  los(ax,ay,az, bx,by,bz, ignoreActors=true) -> bool
  moveActor(actor, dx, dz) -> bool collided   (circle r vs boxes that overlap y in [0.4, actor.h]; low boxes like rugs are walkable)
  floorMatAt(x,z) -> R.MAT code  (FLOOR, CARPET, PUDDLE, METAL)
  nav: cell 0.5 m. navW, navH, nav (Uint8Array 1=blocked). walkable(x,z)
  flowField(x,z,maxDist=Inf) -> Float32Array walking distance (m) over nav cells; stepToward(field,x,z) -> {x,z}|null (8-dir, no corner cut)
  hearDist(x0,z0,x1,z1,maxDist) -> walking distance (m) or Infinity. Sound reaches you around walls, not through them.
  randomWalkable() -> {x,z}
R.MAT = {FLOOR:0, CARPET:1, PUDDLE:2, METAL:3}
R.boot(): creates #stage container (view.js puts its WebGL canvas in it) and #hud 2D canvas (full window, dpr-scaled, ctx in CSS px)
  calls init() on: audio, echo, view, weapons, player, bots, game, ui (if present), then loop:
     dt = min(1/30, frame time)
     R.game.update(dt)          // game.js orchestrates all simulation (see below)
     R.view.render(dt)
     R.ui.draw(R.hudCtx, dt)
     input end-of-frame reset
```

## Map format (maps.js → `R.maps = [mapDef,...]`, builder in props.js)
```js
{ name:'Apartment', ceiling:3.0,
  grid:[ '##########', '#S..T...S#', ... ],   // equal-length rows, border all walls, 1 char = 2 m tile
}
```
Legend (props.js implements `R.props.build(mapDef)` which calls R.world.reset/addBox/setFloor/finalize and returns
`{spawns:[{x,z,yaw}], pickups:[{x,z,kind:'health'|'darts'}]}`):
```
#  wall (full height box)        .  floor            S  spawn point          +  health pickup     d  dart pickup
_  carpet floor (quiet)          ~  puddle floor (loud)   =  metal grate floor (loud, ringing)
T  table (+ 2-4 chairs around)   c  single chair     B  bookshelf (snaps to nearest wall)   C  crate stack (1-3 crates, varied)
P  pillar (0.6m, full height)    O  couch            K  counter/kitchen run (snaps to wall)  b  bed
L  floor lamp/coat stand         D  desk + office chair   G  glass partition (thin, 1.2m tall)  |  half wall (1.1m tall)
```
Props are made of several thin boxes (legs, tops, backs, shelves), so they give satisfying dot patterns. Light randomness
(seeded per map) for offsets and sizes. Props must never block a doorway/1-tile corridor (keep >=0.9 m clearance).

## Shared gameplay numbers
```
Player move: walk 4.2 m/s, sprint (Shift) 6.8, crouch (C or Ctrl) 1.9. Accel 30 m/s^2, no jumping. Eye 1.62, crouch eye 1.05.
Health 100, regen none. Respawn after 3 s at the spawn point farthest from living enemies.
```
**Sound table** (radius = how far it is heard (walking distance) AND max dot reach; rays = echo ray budget; bounces):
| kind | source of | radius m | rays | bounces | notes |
|---|---|---|---|---|---|
| step | walking footstep every 0.42 s | 7 | 260 | 1 | x floor mult |
| sprint | sprint footstep every 0.30 s | 13 | 600 | 1 | x floor mult |
| crouch | crouch footstep every 0.6 s | 2.2 | 70 | 0 | x floor mult |
| click | tongue click, E, cooldown 0.55 s | 9 | 2400 | 1 | 75° forward cone, from eye |
| gunshot | pistol shot | 34 | 6000 | 2 | from muzzle |
| impact | bullet hitting a surface | 6 | 300 | 0 | at hit point |
| reload | reload | 4 | 120 | 0 | |
| ping | sonar dart pulse (x3, 0.7 s apart) | 18 | 3500 | 1 | world-ish, but bots know it's a dart |
| melee | knife swing | 3 | 150 | 0 | |
| hurt | taking damage | 8 | 400 | 1 | from victim |
| death | dying | 14 | 1500 | 1 | from victim |
| pickup | taking a pickup | 6 | 300 | 0 | |
| hum | pickup idle hum, every 2.5 s | 4 | 160 | 0 | source 'world' |
Floor multipliers: carpet 0.45, puddle 2.0, metal grate 1.6.

**Weapons** (weapons.js; shared by player and bots):
- Pistol: hitscan, 34 dmg body, x2.4 head, fire interval 0.26 s, mag 12, reload 1.5 s, infinite reserve, 0.6° spread (x3 while sprinting).
- Sonar dart (right mouse / Q): projectile 22 m/s with gravity 6 m/s², sticks where it lands, pulses 'ping' 3 times. 3 charges, max 5.
- Knife (F / V): 1.0 m range cone 35°, 100 dmg if behind the target (dot of target forward and attack dir > 0.3), else 55. 0.6 s cooldown.

## Events on R.bus
```
'sound'   {x,y,z, kind, radius, rays, bounces, source:'player'|'bot'|'world', actor|null, dir:[dx,dy,dz]|null, cone:deg|null}
          Emit via R.weapons/R.player/etc using helper R.sound(kind, x,y,z, actor, extra) (defined in core: fills radius/rays/bounces from R.SOUNDS
          and applies opts.mult to radius and rays).
'shot'    {actor, ox,oy,oz, dx,dy,dz, hit}
'damage'  {target, attacker, amount, part, x,y,z}
'kill'    {victim, killer, weapon:'pistol'|'knife', headshot}
'spawn'   {actor}
'pickup'  {actor, kind}
'match:start' {} , 'match:end' {winner}
```

## Module ownership
### props.js + maps.js — World builder (agent A)
`R.props.build(mapDef)` as above. `R.maps`: 3 maps: **Apartment** (cramped rooms, lots of furniture), **Office** (desks, glass
partitions, half walls), **Warehouse** (big open hall, crate stacks, metal-grate catwalk floor, pillars). ~ 18x14 to 26x20 tiles.
6+ spawns per map, spread out. 2-3 health and 2 dart pickups. Validator (node, scratch): build all maps, every spawn/pickup
walkable and mutually reachable on nav, no prop overlapping a spawn, door clearance OK.

### echo.js — Echo simulation (agent B)
`R.echo` : `init()` subscribes 'sound'; `reset()`; `update(dt)`.
For each sound: generate ray directions (Fibonacci sphere, or cone for `cone`), random-rotated per sound. Rays travel at
**R.echo.SPEED = 26 m/s** (visual). Compute hits with R.world.raycast **amortized** (global budget ~20000 raycasts/frame; core raycast measures ~0.15-0.5 us each,
queue the rest; reveal time is in the future anyway). Each hit becomes a dot scheduled at `t = pathLength / SPEED`,
with intensity `= (1 - pathLength/radius)^1.3 * (bounce ? 0.45 : 1)`; skip if pathLength > radius. Bounce = mirror reflection with
some jitter. **Lattice snap**: snap dot position to a 6 cm grid in the hit surface's tangent plane (gives the dot-matrix look).
Dots on an actor are stored in the actor's local frame (offset + yaw) and follow it; they live 1.1 s.
Static dots live ~3.2 s (fade curve: quick bright attack, slow exponential tail).
Data out for view.js: ring buffer `R.echo.dots` with typed arrays: `pos(Float32 x3), color(Float32 x3), born(Float32), life(Float32), size(Float32)`, `capacity` (300k),
`head`, plus `R.echo.actorDots` list resolved each frame to world positions (`R.echo.actorDotsPos` typed arrays + count).
Also exposes `R.echo.roomSize` (smoothed mean free distance of player-sourced rays, for audio reverb) and `R.echo.time`.
Colors: player-sourced white-cyan, bot red-orange, world green, dart ping cyan-blue; bounces shift toward blue and dimmer.

### view.js — Renderer (agent B, same agent)
`R.view` : `init()` creates THREE.WebGLRenderer in #stage, camera (fov 78), Points with custom ShaderMaterial (additive, size attenuation,
round soft dots, age-based alpha, dpr-aware), uploads only the changed ranges of the ring buffer each frame. Camera from R.player (eye height
incl. crouch, yaw, pitch, small head-bob, recoil kick, damage shake). A faint **viewmodel**: the pistol drawn as a sparse dot outline
lit briefly when you fire/click. Muzzle flash is a burst of dots near the muzzle, not a light. Post: subtle CRT/film grain overlay via
a full-screen quad or CSS, keep cheap. Must hold 60 fps with 300k dots on a laptop.
`R.view.project(x,y,z) -> {x,y,visible}` screen CSS px (for UI markers).

### player.js + weapons.js — Player & combat (agent C)
`R.player` = the local actor (created in init, pushed to R.actors). `R.player.update(dt)`: look (R.input.takeLook, sensitivity
`R.settings.sens` default 0.0022), movement (WASD, sprint, crouch), footsteps per table, click (E), fire (LMB), dart (RMB/Q), knife (F/V), reload (R),
pickups (radius 1.0 m), exposes `ammo, darts, reloading, clickCooldown, recoil, hurtDir (angle of last damage relative to view), lastHitMarker`.
`R.weapons`: `fire(actor)` hitscan via R.world.raycast from eye along R.forward with spread; `throwDart(actor)`; `knife(actor)`; `update(dt)` for darts/reloads;
`damage(target, amount, attacker, part, x,y,z)` → emits 'damage', 'hurt' sound, on death emits 'kill' + 'death' sound, sets alive=false, deaths/kills.
Per-actor weapon state lives on the actor object (`actor.wpn = {ammo, reloadT, fireT, darts, knifeT}`), so bots use the exact same functions.

### bots.js — Bots (agent D)
`R.bots`: `init()`, `spawnAll(n)` creates bots (names, colors), `update(dt)`. Bots are actors that obey the SAME movement speeds,
collision (R.world.moveActor), weapons (R.weapons.*), and footstep sound rules (they emit 'sound' with source 'bot'). They NEVER read
other actors' positions directly; they only know what they **hear** ('sound' events, filtered by R.world.hearDist <= radius,
ignoring their own sounds) plus their own state. Hearing gives an estimated position with error growing with distance.
Behaviour: roam between random walkable points (walk/crouch), investigate sounds, hunt (approach crouched as they get close),
fire bursts at the freshest heard estimate when confident (recent < 0.8 s and estimated distance < 18 m), relocate after shooting,
use the click to probe when hunting, occasionally throw darts toward suspected areas, knife when an enemy is heard within 1.5 m.
Respond to being damaged (they know attacker direction from the 'gunshot' they hear). Difficulty knob `R.bots.skill` 0..1
(reaction time, aim error). Must be fun: beatable, not psychic, but dangerous when you're loud.

### audio.js — Audio (agent E)
`R.audio`: WebAudio, created on first gesture. Listener = R.player eye/yaw each frame (update(dt) called by game.js).
Every 'sound' plays a procedural one-shot through an **HRTF PannerNode** at its position plus a shared **ConvolverNode reverb** whose
impulse response is generated procedurally and crossfaded by `R.echo.roomSize` (small/medium/large IRs). Distinct SFX per kind
(gunshot crack + tail, footsteps differ by floor material via R.world.floorMatAt, click = tongue click, ping = sonar ping, knife swish,
hurt grunt-ish noise, death thud, pickup chime, hum). Ambient: very low room tone. Low-health heartbeat. Mute M. Voice limit ~32.

### game.js + ui.js — Match flow & HUD (agent F)
`R.game`: state `'menu'|'playing'|'dead'|'paused'|'over'`; `start(mapIndex)` → R.props.build, reset echo, create/position player and bots
(R.bots.spawnAll(5)), emit 'match:start'. `update(dt)` when playing/dead: R.player.update (if alive), R.bots.update, R.weapons.update,
pickup respawn (20 s), respawn timers (3 s), R.echo.update, R.audio.update, kill-limit/timer check. When paused/menu: R.echo.update and R.audio.update only.
Spawn selection: farthest from living enemies. Hums from pickups every 2.5 s.
`R.ui`: draws on the 2D HUD canvas (CSS px). Menu (title "REVERB" drawn as a dot-matrix logo, map select, sensitivity, "click to play"
requests pointer lock), crosshair, health, ammo, dart charges, click cooldown, kill feed, hit marker, **damage direction arc** (critical:
you can't see who shot you), Tab scoreboard, timer, death screen with killer name and respawn countdown, pause menu when pointer lock is
lost (Esc), match over screen. Style: monospace, minimal, white/cyan on black, red for damage.
```
