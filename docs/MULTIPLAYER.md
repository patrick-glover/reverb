# Multiplayer

Room codes on a Cloudflare Worker. The game site stays a static page on GitHub Pages; only the room server is new.

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
  20 Hz, with a 4 Hz keepalive). The room accepts it
  only as far as a distance budget allows (it builds at 7.5 m/s, capped at 6 m so a stalled connection catches up),
  pushes players out of walls, and works out sprint and crouch from the speed it granted.
- **Actions are predicted, then resolved by the room.** Fire, knife, dart and reload play their sound and spend
  ammo/cooldown locally at once; the room raycasts and deals damage with its own positions.
- **Sounds, not dots, cross the wire.** Every sound is a small event (`kind, x, y, z, actor, mult, dir`) and each browser
  traces its own echoes. Your own steps, clicks, shots, reloads and knife swings are made locally and skipped when the
  room echoes them back. Other players' sounds are coloured like bots (red): everyone else is an enemy.
- **Bots run only in the room** and are just more actor rows to the browsers.
- **Players join out of play.** A new match (or a mid-match join) holds you out until your first click into the
  game, then you spawn, so the click-to-play screen is never a free kill. After that, pausing does not stop the room.

### Host settings

The first player in a room is host (it passes on if they leave). In the lobby the host sets: map, max players (2–8),
fill empty slots with bots (on/off), bot skill (easy/normal/hard), kill limit, time limit. With bot fill on, a
mid-match joiner takes a bot's slot and a leaver is replaced by a bot. After a match the room shows results for 8 s,
then returns to the lobby. Invite links are `…/reverb/?room=CODE`.

Leaving: **Leave** in the lobby, **Q** on the pause or results screen, or just closing the tab. The host also has
**X** on the pause screen (end the match now for everyone: results, then the lobby) and **Close room** in the lobby
(sends everyone out). A room also closes by itself when its last player leaves.

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
| `welcome` | `cid code rk` (rejoin key) `rejoin` (true when an existing seat was taken back) |
| `lobby` | `phase host settings players[]` (`cid name color rtt away`) |
| `start` | `map actors[] you poses[] killLimit matchTime` |
| `roster` | `actors[]` after joins/leaves/bot swaps |
| `s` (30 Hz) | `tm tl a[] pk e[] me`: actor rows `[id x z yaw pitch vx vz flags kills deaths]`, pickup bits, events, private hp/darts/respawn |
| events in `s.e` | `['s',kind,x,y,z,actor,mult,dir]` sound, `['d',…]` damage, `['k',victim,killer,weapon,hs]` kill, `['sp',id,x,z,yaw,seq]` spawn, `['p',…]` pickup |
| `over` | `ranking winner` |

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
```

## Deploy

1. `cd server && npx wrangler login` (once).
2. `npx wrangler secret put ADMIN_TOKEN` (any long random string; it unlocks `/admin`).
3. `npm run deploy`. Live at `https://reverb-api.patrickglover.io` (console: `/admin`; the token is in `server/.admin-token`, not in git).
4. Put that URL in `PROD_SERVER` at the top of `net.js` and push `main`. Until then the live site hides the online buttons.
5. `ALLOWED_ORIGINS` in `wrangler.jsonc` must include the site's origin (`https://patrickglover.io` already is).

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
- **Kill switch**: `npx wrangler secret put ROOMS_DISABLED` (any value) stops new rooms; running ones finish.
  `wrangler secret delete ROOMS_DISABLED` turns it back on.

## Scaling, in case it goes viral

### What it costs

Durable Objects bill wall-clock time while a room is open (128 MB × seconds) plus requests, where incoming WebSocket
messages count 20:1 and outgoing ones are free ([pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).
Paid plan: $5/month includes 400k GB-s and 1M requests, then $12.50 per million GB-s and $0.15 per million requests.
There is no bandwidth charge.

| | per hour |
|---|---|
| one open room (duration) | 0.125 GB × 3600 s = 450 GB-s ≈ **$0.0056** |
| one player (≈33 incoming msgs/s → 5,940 billed requests) | ≈ **$0.0009** |
| a 4-player room | ≈ **$0.009** |
| 1,000 concurrent players in rooms of 4 (250 rooms) | ≈ **$2.30** |
| 10,000 concurrent players (2,500 rooms) | ≈ **$23** |

The **free plan** (100k requests and 13,000 GB-s per day) runs out at about four 4-player room-hours a day, since
requests are the binding limit. That's enough for a toy demo with friends; move to the $5 plan before posting a link anywhere.

### What breaks first, in order

1. **Spend.** Cloudflare has no hard spending cap. Set billing notifications, and use `ROOMS_DISABLED` if a bill runs away.
2. **Incoming message volume** is most of the request cost. Send state at 20 Hz and only when it changes (an idle or
   dead player sends nothing): roughly halves it. Binary encoding saves bandwidth, not money.
3. **The Stats object is a single point.** Every room beats every 10 s, plus events. Past ~2k live rooms that is a few
   hundred requests/s into one object. Move event counting to Workers Analytics Engine (no single writer, SQL API for
   the console) and shard live-room tracking (e.g. 16 shards by code hash, console sums them).
4. **Room codes.** 4 characters from 27 = 531k codes; collisions start to cost retries past ~10k live rooms. Go to 5.
5. **Abuse.** Rate-limit `POST /api/rooms` per IP (Workers Rate Limiting binding), add Turnstile on create if bots
   start making rooms. Per-socket flood guard, name cleaning and size limits are already in.
6. **Latency.** A room lives near whoever made it. Friends across an ocean will feel ~150 ms; shots are resolved
   without lag compensation. Fine for code-sharing friends; for public play pick the region with `locationHint`.
7. **Strangers can't play without a code.** If it spreads, it needs "quick play": a matchmaker object per region that
   hands out rooms with free slots.
8. **Cheating.** Hits, damage, ammo and respawns are the room's. Movement is trusted up to sprint speed. The
   game-specific hole: footsteps and clicks are sent by the client, so a modded client could walk silently. Fix by
   making the room generate footsteps from movement (the stride logic is in `player.js`).

### What doesn't need to change

Rooms scale out on their own (one object per code, spread across Cloudflare). Echo tracing never touches the
server's budget for drawing (dots are computed in each browser; the room only traces what bots need). The static
site is on a CDN already.

## Known gaps

- No reconnect: a refresh rejoins as a new player.
- No kick, no team modes, no spectating.
- Gameplay dev flags (`fireInterval`, `diffraction`, …) are server defaults online. A client's own copies only change
  what it draws (and a faster local fire interval just gets its extra shots dropped).
- Remote players' weapons are invisible apart from their sounds (same as bots).
