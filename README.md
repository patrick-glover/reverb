# REVERB

*Every sound is light.*

A first-person deathmatch in total darkness. Nothing is ever lit. Every sound (footsteps, tongue clicks, gunshots) casts rays that travel at a slowed speed of sound and leave glowing dot-matrix imprints where they hit walls, furniture, and bodies. The rays bounce, so a gunshot paints the room twice: first the direct wave, then a dimmer reverb. Dots that land on a player freeze where they hit, leaving a ghost image of where that body was. You hold the gun out in front of you, so every shot also paints your own hands and arms.

**Play it at [playreverb.com](https://playreverb.com).** Solo against bots, or online with friends using a room code.

You vs 5 bots, free-for-all. The bots play by the same rules: they **hear** every sound, and they see only the echo dots that land on bodies in front of them, just like you. Every shot you fire lights up the room for you and also tells everyone where you are, and which way you're facing.

Sound bends round corners: a gunshot in the next room spills dimmer dots through the doorway, and you hear it coming from the doorway, not through the wall.

![Gunshot wavefront](docs/gunshot-wavefront.png)
![Tongue-click echolocation cone](docs/click-cone.png)
![Warehouse](docs/warehouse.png)

## Play
Go to [playreverb.com](https://playreverb.com), or open `index.html` in Chrome. No build step and no server needed for solo play: three.js and the fonts (Doto, Chakra Petch) are vendored in `vendor/`, so it runs offline straight from disk. Click to capture the mouse. **Headphones strongly recommended**: all audio is HRTF-spatialized with room-sized reverb.

| Key | Action |
|---|---|
| WASD | move |
| Shift | sprint (loud) |
| C / Ctrl | crouch (quiet) |
| E | tongue click: a forward echolocation cone |
| LMB | fire |
| RMB / Q | sonar dart: pings 3x where it lands |
| F | knife (backstabs kill) |
| Space | jump |
| R | reload |
| Tab | scoreboard |
| M | mute |
| ` | dev flags panel |

Floors matter: carpet muffles your steps, puddles and metal grates make them louder.

**Online:** HOST ONLINE on the menu makes a room and gives you a code and an invite link; friends use JOIN WITH CODE. Bots fill empty slots if the host wants them. If your connection drops or you refresh, you get your seat and score back within 30 s. Running the room server locally, deploying it, and what it costs are covered in `docs/MULTIPLAYER.md`.

## Development
Version lives in `flags.js` (`R.VERSION`) and changes are logged in `CHANGELOG.md`. Pushing `main` publishes the site; run `node tools/stamp.js` first so browsers pick up the changed files (it puts a content hash on each script URL in `index.html`).

Experimental features sit behind flags so old and new behaviour can be compared in the same build. Press ` in game to open the flags panel; changes save in the browser. To test a specific setup without touching saved settings, add it to the URL: `index.html?flags=stickyDots=0,bots=2,perf=1`. **Copy test URL** in the panel builds that link from your current changes.

To add a flag: add an entry to `DEFS` in `flags.js`, then read it with `R.flag('name')` where the behaviour branches. Flags that set a module constant get an `apply` function instead.

## How it's built
Plain browser JS, global `R` namespace, three.js r149 only for drawing the points.

| File | What |
|---|---|
| `flags.js` | version, feature flags, dev panel |
| `body.js` | humanoid bodies: capsule skeleton, walk cycle, pistol grip, ray tests |
| `core.js` | world (boxes, 3D raycasting, ~0.15 µs/ray), collision, nav grid, sound hearing by walking distance and round corners, input, loop |
| `echo.js` / `view.js` | ray-traced echo simulation (wavefront timing, bounces, lattice-snapped dots, ghost images on bodies) and the WebGL point renderer |
| `props.js` / `maps.js` | furniture built from thin boxes; Apartment, Office, Warehouse |
| `player.js` / `weapons.js` | FPS controller, footsteps, pistol, sonar darts, knife |
| `bots.js` | bots that hunt by sound and echo dots; each tick they score their possible actions and run the best |
| `audio.js` | procedural SFX, HRTF panning, occlusion, convolution reverb |
| `game.js` / `ui.js` | match flow, respawns, pickups, HUD with damage-direction arc |
| `net.js` | online play: lobby overlay, sending own movement, predicted shots, applying the room's snapshots and events |
| `server/` | Cloudflare Worker + Durable Objects: one room per code running the match headless, stats and `/admin` console |

`ROADMAP.md` has the plan and backlog. In `tools/`: `sim.js` runs a headless bot match for checking changes, `stamp.js` sets the cache stamps, and `cost-model.js` prints what the room server costs at different levels of popularity.

`SPEC.md` is the original design document: the contract the first modules were written against. The code, this README and `docs/MULTIPLAYER.md` are current where they differ.

Built with Claude Code: one Opus 5.5 orchestrator wrote the spec and core, and six Opus 5.5 agents built the modules in parallel.
