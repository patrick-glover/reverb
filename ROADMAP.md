# Roadmap

Current: **v0.6.0-dev**, live at playreverb.com (GitHub Pages from `main`).

## Multiplayer (0.6.0-dev, live)

Room codes on a Cloudflare Worker (`api.playreverb.com`), one Durable Object per room running the match headless.
Details, protocol and costs are in `docs/MULTIPLAYER.md`. Server changes: `npm run deploy` in `server/` (restarts
live rooms).

Done since 0.6.0-dev went live (2026-11-18): moved to playreverb.com; server-side movement budget and sound rate
limits; rooms that really close; unique names; safer lobby overlay and connect errors; http→https redirect;
content-hash cache stamps; reconnect after a refresh or a dropped connection (seat held 30 s); movement sent only
when it changes (20 Hz, 4 Hz keepalive).

Next, roughly in order. Cost figures are from `node tools/cost-model.js`: a room bills for every second it is open,
so the bill follows room-hours, not players.

1. **First playtest with friends.** Pick between lag compensation and the backlog from what they say.
2. **Lag compensation for shots.** Friends on ~100 ms connections will feel shots that look like hits and miss.
3. **Rate limits** (audit S1). Before sharing the link widely. Idle rooms now close (a match ends after 3 minutes
   with no human moving or acting, a room closes after 10 minutes of nobody doing anything), but a script that
   keeps sending movement can still hold rooms open (about $0.006/hour each; 10,000 is $58/hour on the Paid plan).
   - Per-IP limits on create, lookup and connect (Workers Rate Limiting binding); require an `Origin` in production.
   - On the Paid plan: set the Workers and Durable Objects spend limits and a billing notification in the dashboard.
     On the free plan there's no bill; abuse just uses up the day's allowance and online play stops until 00:00 UTC.
4. **Solo play goes offline.** One human with bots in an online room costs about $0.007 per player-hour; the same
   match offline runs in the browser for nothing. When the host starts with nobody else in the room, offer the
   offline match instead (or require a second human to start), and say so on the HOST ONLINE screen.
5. **Quick play: regions.** Quick play is in (0.7.0-dev): one global matcher hands out public rooms with free slots.
   Next is a matcher per region so strangers get a nearby room. Fuller rooms are also the biggest cost lever: from 1
   to 6 humans per room, the cost per player-hour drops from $0.0071 to $0.0016.
6. **Interest management** (audit S5): only send an actor while it is near a recent sound. Today every snapshot
   carries every position, so a wallhack is reading the console.
7. **The room generates footsteps from movement**, closing the silent-walk cheat.
8. **Host kick or lock room; 5-character room codes.**
9. **Analytics Engine for stats** and sharded live-room tracking, past ~2,000 live rooms.
10. Bot brain experiments: an external decision model as a slow "commander" over the utility brain (not per tick).

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
- Pushing `main` deploys the site live: run `node tools/stamp.js` first. Server changes also need `npm run deploy` in
  `server/`, which restarts live rooms.
