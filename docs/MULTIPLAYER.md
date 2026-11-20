# Multiplayer

Room codes on a Cloudflare Worker. The game is a static site on GitHub Pages at `https://playreverb.com`; the room
server is a Cloudflare Worker at `https://api.playreverb.com`. Both names are in the `playreverb.com` zone on
Cloudflare: the site's records are DNS-only and point at GitHub Pages, which issues the certificate.

## Ops

| What | How |
|---|---|
| Console | https://api.playreverb.com/admin (token in `server/.admin-token`). Local: http://localhost:8787/admin (token in `server/.dev.vars`) |
| Live logs | `cd server && npm run tail`, or Cloudflare dashboard → Workers → reverb → Logs |
| Kill switch | `cd server && npx wrangler secret put ROOMS_DISABLED` (any value): no new rooms or matches, running matches finish. `npx wrangler secret delete ROOMS_DISABLED` to turn rooms back on |
| Deploy server | `cd server && npm run deploy` (restarts every live room: deploy when it's quiet) |
| Check a server | `cd server && npm run smoke` (local by default; `npm run smoke -- https://api.playreverb.com` for live) |
| Costs | `node tools/cost-model.js` |
| Traffic alerts | ntfy push when live players pass 3, 10, 25, 50, 100… or rooms pass 5, 20, 50… (urgent if rooms outnumber players). Topic in `server/.ntfy-topic`, set as the `NTFY_TOPIC` secret; subscribe to it in the ntfy app. `wrangler secret delete NTFY_TOPIC` turns alerts off |
| Idle rooms | Closed automatically: a match ends after 3 min with no human moving or acting, a room closes after 10 min of nobody doing anything (`MATCH_IDLE_MS`, `LOBBY_IDLE_MS` in `server/src/index.js`) |
| Spend safety | Free plan today: no bill possible, online play just stops at the daily allowance until 00:00 UTC. On the Paid plan, set Billing → Spend limits for Workers and Durable Objects, plus a billing notification |

More detail in [Monitoring](#monitoring) and [Costs and scaling](#costs-and-scaling).

```
 browser (GitHub Pages)                       Cloudflare
 ┌──────────────────────┐   POST /api/rooms   ┌─────────────┐
 │ net.js               │ ──────────────────▶ │ Worker      │──┐ idFromName(code)
 │  lobby overlay       │   WebSocket          │ (index.js)  │  ▼
 │  own movement ≤20 Hz │ ◀═════════════════▶ │             │ ┌──────────────────────┐
 │  echoes, audio, view │   snapshots 30 Hz    └─────────────┘ │ Room DO (one per code)│
 └──────────────────────┘   + sound/hit events                 │  runs the real match: │
                                                               │  bots, hits, respawns │
                              /admin ──────────▶ Stats DO ◀─── │  pickups, clock       │
                                                 (SQLite)  beat └──────────────────────┘
```

## How a match works

- **The room runs the match.** `server/build-sim.js` bundles the same game scripts the browser loads (`core`, `props`,
  `maps`, `echo`, `weapons`, `bots`, `game`, …) into `createSim()`, so each room gets its own private `R`.
  A tick costs about 2 ms at 30 Hz with 7 bots (99% of ticks under 4 ms; echo tracing is capped at 3 ms).
- **Browsers own their movement.** Position, look, velocity, crouch and move mode go up when they change (at most
  20 Hz, with a 4 Hz keepalive). The room accepts it only as far as a distance budget allows (it builds at 7.5 m/s,
  capped at 6 m so a stalled connection catches up), sweeps the move in 0.1 m steps so a claim can't cross a wall,
  and works out sprint and crouch from the speed it granted. Height is capped at a jump above what you stand on, and
  after 1.5 s in the air the room puts you back on the ground (still counted as airborne for spread).
- **Forwarded sounds are checked.** Steps and clicks come from the browser, so the room rate-limits them per kind
  (a click per 0.5 s, steps in bursts of 3 at 0.25 s), keeps them within 1 m of the sender, clamps their loudness to
  the floor-material range, and drops clicks without a direction.
- **Actions are predicted, then resolved by the room.** Fire, knife, dart and reload play their sound and spend
  ammo/cooldown locally at once; the room raycasts and deals damage with its own positions. The room times each
  player's actions on its own clock: one may arrive a little early (60 ms for fire, 150 ms knife/dart, 300 ms for a
  reload to finish), but the time skipped is owed and repaid by later late ones, so a client running faster cooldowns
  is held to the real rate after a shot or two.
- **Flooding is cut off.** Over 60 messages in a second the rest are dropped; three seconds over in a row, or 150 in
  one second, closes the socket (4001). Name, colour, ready and settings changes go to the whole room, so each client
  gets 6 at once and then 4 a second.
- **Sounds, not dots, cross the wire.** Every sound is a small event (`kind, x, y, z, actor, mult, dir`) and each browser
  traces its own echoes. Your own steps, clicks, shots, reloads and knife swings are made locally and skipped when the
  room echoes them back. Other players' sounds are coloured like bots (red): everyone else is an enemy.
- **Bots run only in the room** and are just more actor rows to the browsers.
- **Players join out of play.** A new match (or a mid-match join) holds you out until your first click into the
  game, then you spawn, so the click-to-play screen is never a free kill. After that, pausing does not stop the room.

### Quick play

**QUICK PLAY** on the menu asks `POST /api/quick` for a room. A single `Matcher` object (one for the whole world) keeps
the public rooms that have a free slot and hands out the fullest one, holding that slot for 10 s so a burst of players
doesn't all go for the same last seat. With none free, the Worker makes a new public room near the player who asked.
Public rooms report to the Matcher on every join, leave and 10 s heartbeat; nothing is stored, so after an eviction
the list rebuilds from the next heartbeats.

A public room has no host and fixed settings (6 players, bots fill the rest, normal skill, 15 kills, 6 min). The first
player is put straight into a match with 5 bots; later players join mid-match in a bot's slot. After the results the
next match starts by itself on another map. Instead of ending the match after 3 idle minutes, a public room sends the
idle player out (with nobody left, it closes). Its code and invite link work like any room's, so friends can follow
you in. The browser retries quick play twice if the room it got is gone or full.

`GET /api/quick` returns `{players, rooms}` (everyone online, public and private, cached 15 s). The menu shows
"N PLAYERS ONLINE NOW" from it, only when N > 0.

### Host settings

The first player in a room is host (it passes on if they leave). In the lobby the host sets: map, max players (2–8),
fill empty slots with bots (on/off), bot skill (easy/normal/hard), kill limit, time limit. With bot fill on, a
mid-match joiner takes a bot's slot and a leaver is replaced by a bot. After a match the room shows results for 8 s,
then returns to the lobby. Invite links are `https://playreverb.com/?room=CODE`.

Leaving: **Leave** in the lobby, or **Q** on the pause or results screen. Closing the tab also works, but the seat is
held for 30 s first (see Reconnect). The host also has **X** on the pause screen (end the match now for everyone:
results, then the lobby) and **Close room** in the lobby (sends everyone out). A room closes by itself when its last
player has gone; the code then returns 404 until `POST /api/rooms` hands it out again.

**Reconnect.** `welcome` carries a rejoin key (`rk`), kept in the tab's `sessionStorage`. A socket that closes without
a `bye` (refresh, wifi drop, server restart) keeps its seat for 30 s: same cid (so the host stays host), name,
colour, actor and score, with the actor held out of play. The lobby marks it `away`. The browser retries for 25 s
(stopping early if the room has closed), connecting with `&rk=`; mid-match it gets a fresh `start` for its old actor
and clicks back in. A second socket with the same key takes the seat over and the older one is closed with 4003.
Leave, Cancel and the host's Close send `bye`, so their seats are freed at once. Closes the room sends itself
(4000+) are never retried.

### Protocol (JSON, version 1)

| up (browser → room) | |
|---|---|
| `st` | `x z yaw pitch vx vz cr mm sq` own movement; `sq` = spawn sequence (stale packets from before a respawn are dropped) |
| `snd` | `k x y z m d` own step/sprint/crouch/click |
| `act` | `a: fire\|knife\|dart\|reload`, `yaw pitch cr` |
| `ready` | clicked into the match; spawn me |
| `bye` | leaving on purpose: free my seat when the socket closes (otherwise it is held 30 s) |
| `settings`, `start`, `end`, `close` | host only |
| `ping`, `rtt`, `name` | |

| down (room → browser) | |
|---|---|
| `welcome` | `cid code protocol rk` (rejoin key) `rejoin` (true when an existing seat was taken back) |
| `lobby` | `phase host settings quick players[]` (`cid name color rtt away`); `quick` = a public room (host is 0) |
| `start` | `map actors[] you poses[] killLimit matchTime` |
| `roster` | `actors[]` after joins/leaves/bot swaps |
| `s` (30 Hz) | `tm tl a[] pk e[] me`: actor rows `[id x z yaw pitch vx vz flags kills deaths]`, pickup bits, events, private hp/darts/respawn |
| events in `s.e` | `['s',kind,x,y,z,actor,mult,dir]` sound, `['d',…]` damage, `['k',victim,killer,weapon,hs]` kill, `['sp',id,x,z,yaw,seq]` spawn, `['p',…]` pickup (not read by the browser: pickup state travels in `pk`) |
| `over` | `ranking winner` |
| `pong`, `error` | `c` echoed for the RTT; `msg` shown in the overlay |

Close codes from the room: 4000 refused (full, version mismatch), 4001 too many messages, 4002 the host closed the
room, 4003 the seat was taken over by another tab. The browser never retries these.

## Run it locally

```sh
cd server && npm install
npm run dev                       # Worker on http://localhost:8787 (rebuilds sim.gen.js first)
cd .. && python3 -m http.server 8000
# open http://localhost:8000 in two windows: HOST ONLINE in one, JOIN WITH CODE (or the invite link) in the other
```

On localhost (or `file://`) the game talks to `localhost:8787`; there, `?server=https://…` overrides it (ignored on the live site).

Tests (dev server running):

```sh
cd server
node test/smoke.mjs    # protocol: lobby, settings, start, footsteps, knife kill, respawn, stats, host handoff
node test/client.mjs   # the real browser scripts in node: lobby buttons, spawn-on-click, walk, fire, die, respawn,
                       # movement send rate, drop and rejoin, leave
node test/fill.mjs     # bot fill, mid-match join/leave, full room
node test/over.mjs     # match end and the return to the lobby (7 hard bots, kill limit 2)
node test/host.mjs     # host ends the match, host closes the room
node test/rejoin.mjs   # seat held 30 s after a drop: same cid, actor, score and host role; bye frees it (~35 s)
node test/quick.mjs    # quick play: straight into a match, no host, matched into the same room, full rooms skipped
                       # (run on a fresh dev server: leftover quick rooms get matched into)
```

## Deploy

1. `cd server && npx wrangler login` (once).
2. `npx wrangler secret put ADMIN_TOKEN` (any long random string; it unlocks `/admin`).
3. `npm run deploy`. Live at `https://api.playreverb.com` (console: `/admin`; the token is in `server/.admin-token`, not in git).
4. `PROD_SERVER` at the top of `net.js` is the server's URL; the custom domain is in `routes` in `wrangler.jsonc`
   (keep `workers_dev: false`).
5. `ALLOWED_ORIGINS` in `wrangler.jsonc` must include the site's origin (`https://playreverb.com` and `www.` are).
   `https://patrickglover.io` and the old `reverb-api.patrickglover.io` route are kept for tabs opened before the
   move to playreverb.com, and can be removed.

Before pushing `main`, run `node tools/stamp.js`: it puts a content hash on every script and stylesheet URL in
`index.html`, so browsers never mix cached and new files after an update (Pages caches for 10 minutes).
`node tools/stamp.js --check` fails if a stamp is stale.

Deploying a new Worker version restarts every room, so live matches disconnect. Deploy when it's quiet, and bump
`PROTOCOL` in `net.js` and `index.js` together when the messages change (old tabs are told to reload).

## Monitoring

- **`/admin`** on the Worker: playing now, live rooms and bots, unique players (anonymous random id per browser),
  sessions, hours played, matches, peak concurrency, 48 h concurrency and room charts (1-minute samples), per-day
  table, live room list, last 100 events. Refreshes every 10 s.
- **Logs**: every room event is one JSON line (`{"evt":"match_started","room":"XVTZ",…}`). `npm run tail` streams them;
  Workers Logs (enabled in `wrangler.jsonc`) keeps them searchable in the dashboard.
- **Kill switch**: `npx wrangler secret put ROOMS_DISABLED` (any value) stops new rooms, refilling empty ones, and
  new matches; matches already running finish. `wrangler secret delete ROOMS_DISABLED` turns it back on.

## Costs and scaling

### What it costs

The static site costs nothing (GitHub Pages; no bandwidth charges anywhere). The room server is billed on two things
([pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), checked 2026-11-18):

- **Room time, about 80% of the bill.** A room bills 128 MB for every second it is open: $0.0058 per room-hour.
  A match ticks at 30 Hz, so a room in play never hibernates.
- **Incoming messages.** 20 messages are billed as one request ($0.15 per million). A player sends about 18 a second,
  about $0.0005 per player-hour. Outgoing messages are free.

The Workers Paid plan is $5/month and includes 400k GB-s and 1M requests; the free plan gives 13k GB-s and 100k
requests a day, and past that online play stops until 00:00 UTC (no bill). `node tools/cost-model.js` prints this
table; its header lists the assumptions (45-minute sessions, 3 humans per room, `MSGS`, `MINS` and `PER_ROOM`
change them):

| Popularity | Daily players | Player-hours / month | Rooms at peak | Free plan | Paid plan / month |
|---|---|---|---|---|---|
| Friends playtests (5 people, ~8 evenings) | ~1 | 78 | 1 | fits | $5.00 |
| Small community | 50 | 1.1k | 2 | runs out | $5.45 |
| Modest hit | 500 | 11.3k | 18 | runs out | $35.70 |
| Popular | 5,000 | 112.5k | 180 | runs out | $312 |
| Viral | 50,000 | 1.1M | ~1,800 | runs out | $3,060 |

Because the bill follows room-hours, people per room matters most: per player-hour, a room costs $0.0071 with one
human, $0.0027 with three and $0.0016 with six. Solo play belongs offline, and quick play (fuller rooms) is the main
saving at scale (see `ROADMAP.md`).

### What breaks first, in order

1. **Spend from abuse.** Idle rooms close on their own, and the Worker limits each IP (Workers Rate Limiting,
   `ratelimits` in `wrangler.jsonc`, approximate and per Cloudflare location): 12 room creations or quick-play
   requests a minute, 60 lookups, 40 WebSocket connects. Over that is a 429. A refused request is still a Worker
   request, though, so on the Free plan (100k a day) a WAF rate-limiting rule on `api.playreverb.com` (dashboard →
   Security → WAF → Rate limiting rules; the Free plan has one) is the layer that stops a flood before the Worker runs.
   A script that keeps sending movement can still hold rooms open: one held room costs $0.0058 an hour, 10,000 cost
   $58 an hour on the Paid plan. Set spend limits when you upgrade, use `ROOMS_DISABLED` if a bill runs away, and add
   Turnstile on create if bots start making rooms.
2. **The Stats object is a single point.** Every room beats every 10 s, plus events. Past ~2k live rooms that is a few
   hundred requests/s into one object. Move event counting to Workers Analytics Engine (no single writer, SQL API for
   the console) and shard live-room tracking (e.g. 16 shards by code hash, console sums them).
3. **Room codes.** 4 characters from 27 = 531k codes; collisions start to cost retries past ~10k live rooms, and a
   lookup says whether a code is live. Go to 5 or 6 characters.
4. **Latency.** A room lives near whoever made it. Friends across an ocean will feel ~150 ms; shots are resolved
   without lag compensation. Fine for code-sharing friends; for public play pick the region with `locationHint`.
5. **One matcher for the world.** Quick play goes through a single `Matcher` object and ignores distance. Past a
   few hundred public rooms, or with players on several continents, split it per region (pick by `request.cf.continent`).
6. **Cheating.** Hits, damage, ammo, respawns and pickups are the room's; movement is held to a 7.5 m/s budget and
   forwarded sounds are rate-limited. Two holes remain. Every snapshot carries every actor's exact position, so a
   wallhack is reading `R.actors` in the console (fix: only send an actor while it is near a recent sound). And
   footsteps come from the client, so a modded client can walk silently (fix: the room generates footsteps from
   movement; the stride logic is in `player.js`).

### What doesn't need to change

Rooms scale out on their own (one object per code, spread across Cloudflare). Echo tracing never touches the
server's budget for drawing (dots are computed in each browser; the room only traces what bots need). The static
site is on a CDN already.

## Known gaps

- No kick, no team modes, no spectating. Quick play is one global pool: no regions yet (rooms are made near the
  first player, so a later player across an ocean gets their ping).
- No lag compensation: you hit where the room has the target, not where you saw it.
- A held seat (30 s after a drop) is out of play: no bot fills it until it expires.
- Gameplay dev flags (`fireInterval`, `diffraction`, …) are server defaults online. A client's own copies only change
  what it draws (and a faster local fire interval just gets its extra shots dropped).
- Remote players' weapons are invisible apart from their sounds (same as bots).
