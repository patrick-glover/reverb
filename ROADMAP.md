# Roadmap

Current: **v0.5.0** (live at patrickglover.io/reverb, GitHub Pages from `main`).

## Next: multiplayer

Not started. Notes from planning:

- **Sync sound events, not dots.** Dots are only ever drawn locally, so the network carries sound events (`R.sound` args: kind, position, direction, actor id). That's a few bytes each, and every client traces its own echo rays. The `R.bus` 'sound' event is the natural hook.
- **Actor state**: position, yaw/pitch, velocity, crouch, alive, sent ~20 Hz with interpolation. Bodies (`body.js`) pose from velocity, so remote walk cycles come for free.
- **One authority for hits**: `R.weapons.fire` raycasts and calls `damage`. In MP the host (or server) must resolve shots, damage, kills, respawns and pickups (`game.js`), and clients send inputs or fire requests.
- **Bots** run only on the authority and replicate like players. `bots.js` already never reads live positions of others, only sounds and `R.echo.actorHits`. On a host, `actorHits` only covers sounds the host traced; fine if the host traces everything it simulates.
- **Open decision, transport:**
  - WebRTC peer-to-peer with one player hosting. Keeps it a static site on Pages, but needs a signalling step (copy/paste or a tiny relay).
  - A small authoritative server, e.g. a Cloudflare Worker with a Durable Object per room over WebSocket. Cleaner authority and anti-cheat, but it's a backend to run.
- **Open questions:** lobby/room codes, how many players per match, whether bots fill empty slots, and how the per-browser dev flags interact (gameplay flags must come from the host).

## Backlog (from the v0.4–0.5 brainstorms)

Acoustics:
- Bullet crack: a supersonic round paints a streak of dots along its flight path.
- Material absorption on bounce: fabric and carpet swallow echoes; metal and glass throw strong ones. (Today material only changes hit brightness; `BOUNCE_DIM` is the same for all.)
- Low-frequency transmission: gunshot thump through thin walls as a faint blurry patch.
- Reverb length from room size and absorption (more bounces in big hard rooms).
- Gunshot deafness and loud sounds drowning out quiet ones: quiet sounds paint less, and bots can't hear steps, for about 1 s after a nearby shot.
- Resonating objects: metal shelves and lockers ping when hit.
- Front–back confusion in bot hearing.

Movement (picks: slide, lean, creep):
- Slide (sprint then crouch: fast, loud scrape streak)
- Lean/peek (needs rebinding Q/E, currently dart and click)
- Creep (silent half-speed)
- Mantle/vault, jump with landing noise, wall-tap decoy, dash, momentum

Bots:
- Track prediction (lead shots, predict exits)
- "Where could they be" search map after losing contact
- Move under cover of noise (needs the deafness item above)
- Count the player's 12-round magazine and push on reload
- Decoys (shoot a wall, throw a dart away from themselves)
- Habit learning within a match
- Tuning: with `botSight` on, bots fire about 3× more and get about 50% more kills than v0.3. Levers are `SIGHT_RANGE` and `SIGHT_HALF` in `bots.js`.

## Working conventions
- New behaviour goes behind a flag in `flags.js` so old and new can be compared live; bump `R.VERSION` and add a `CHANGELOG.md` entry.
- Check bot and echo changes headless: `node tools/sim.js . 180 "" 2` (seconds, flags, map). Compare against flags off, e.g. `botSight=0,diffraction=0,directivity=0`.
- Pushing `main` deploys live.
