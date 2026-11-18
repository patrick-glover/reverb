# Roadmap

Current: **v0.6.0-dev**, live at playreverb.com (GitHub Pages from `main`).

## Multiplayer (0.6.0-dev, live)

Room codes on a Cloudflare Worker (`api.playreverb.com`), one Durable Object per room running the
match headless. Details, protocol and the scaling plan are in `docs/MULTIPLAYER.md`. Server changes: `npm run deploy`
in `server/` (restarts live rooms).

Done since 0.6.0-dev went live (2026-11-18): server-side movement budget and sound rate limits, rooms that really
close, unique names, safer lobby overlay and connect errors, http→https redirect, content-hash cache stamps
(`node tools/stamp.js` before pushing), reconnect after a refresh or a dropped connection (seat held 30 s), and
movement sent only when it changes (20 Hz, 4 Hz keepalive).

Next for multiplayer, roughly in order:
- First playtest with friends; decide between lag compensation and the backlog from what they say.
- Lag compensation for shots (friends on ~100 ms connections will feel it).
- Rate limits and idle timeouts on the room server (audit S1: cost, not gameplay; before sharing widely).
- Interest management: only send an actor while it is near a recent sound (audit S5: today a wallhack is the console).
- The room generates footsteps from movement (closes the silent-walk cheat).
- Host kick or lock room; longer room codes.
- Quick play (matchmaker per region) and Analytics Engine for stats, if it gets popular.
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
