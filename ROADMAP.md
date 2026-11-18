# Roadmap

Current: **v0.6.0-dev**, live at patrickglover.io/reverb (GitHub Pages from `main`).

## Multiplayer (0.6.0-dev, live)

Room codes on a Cloudflare Worker (`reverb-api.patrickglover.io`), one Durable Object per room running the
match headless. Details, protocol and the scaling plan are in `docs/MULTIPLAYER.md`. Server changes: `npm run deploy`
in `server/` (restarts live rooms).

Next for multiplayer, roughly in order:
- The room generates footsteps from movement (closes the silent-walk cheat).
- Send movement only when it changes, at 20 Hz (about half the request cost).
- Reconnect after a refresh; host kick.
- Quick play (matchmaker per region) and Analytics Engine for stats, if it gets popular.
- Lag compensation for shots.
- Bot brain experiments: an external decision model as a slow "commander" over the utility brain (not per tick).

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
