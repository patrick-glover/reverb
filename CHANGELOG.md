# Changelog

## 0.8.0-dev
From the first playtest.
- Offline: a 3 s GET READY countdown at the start of a match (everything holds still, you can look around), with the same beeps and GO as online.
- Offline: TIME LIMIT on the menu (3, 5, 6, 10 or 15 min, or none), saved in this browser.
- Offline: COLOR swatches on the menu, the same choice as online: your name color, your dart pings, and bots avoid it.
- Wider knife swing (flag `wideMelee`): reaches 1.45 m in a 65° cone either side (was 1.0 m and 35°), for bots too.
- Hits feel like hits. The marker pops in and settles, grows with hits in a row, turns gold on a headshot and bursts red on a kill. Damage numbers float off the crosshair. A kill shows ELIMINATED (or KNIFED) and the name under the crosshair, plus HEADSHOT, and DOUBLE / TRIPLE / QUAD KILL / RAMPAGE for kills within 4 s of each other. The hit sound has a low thock under the tick and climbs a semitone per hit in a row; headshots ring; kill streaks climb an arpeggio.
- Sonar darts make sounds of their own: a quiet whoosh when thrown (it paints a little around you and bots can hear it) and a thunk and arming chirp where they stick (which paints a small patch, so you see where it landed).
- Online: pick your color from 8 swatches when joining or hosting, and in the lobby (taken colors are greyed out). Your dart pings glow in your color for everyone; it's saved in this browser and used offline too.
- One palette of 8 colors for everyone (red, orange, gold, lime, mint, sky, periwinkle, magenta), picked by search to be as far apart as possible and clear of the pale cyan your own sounds use. Players pick first and bots take the colors left over, so nobody in a match shares a color; a bot wearing a color a joining player picks switches to a free one.
- Flag `playerColorSounds` (off by default): every sound anyone else makes, bot or human, paints in the color their name shows in on the scoreboard instead of the red-orange enemy color, so you can tell who's who. Works offline against bots too.
- Online: no time limit option (Time limit: none). The match runs to the kill limit; the timer shows ∞.
- Online: ready up. Everyone in the lobby has a Ready button and the match starts as soon as everyone is ready; the host can still start at any time. The match then counts down 5 s with everything held still (beeps on 3, 2, 1, then GO). Instead of a pause screen you get CLICK TO DEPLOY with the countdown, the rules and the controls; click in during the countdown and you spawn at GO.

## 0.7.0-dev
- Counter-Strike style spread (flag `csSpread`). Standing still is accurate (0.25°, crouched 0.15°); walking opens it to about 3°, sprinting 5°, and a shot in the air is wild. Each shot adds about 1°, which recovers in a few tenths of a second, so tapping beats spamming. The crosshair gap is the real spread now. Bots play by the same rule.
- Jump with **Space** (flag `jump`): about 0.84 m, enough to get up onto beds and tables. Landing is as loud as a sprinting step. Online, the room checks your height against what's under you.
- A little momentum (flag `momentum`): with no keys held you coast to a stop in about 0.2 s instead of 0.14 s. Pressing the opposite key still stops you fast.
- Empty gun (flag `dryFire`): the last round leaves the slide locked back, and the next trigger pull dry-clicks and starts the reload.
- The pistol's slide cycles back on every shot.
- Pistol fires about a third faster: 0.15 s between shots (was 0.2), for bots too.
- Reload progress wheel around the crosshair.
- Online: idle rooms close. A match ends after 3 minutes with no human moving or acting, and a room closes after 10 minutes of nobody doing anything, with a message saying why.
- Online: **QUICK PLAY** on the menu. No code needed: you're put into a public match that has a free slot, or a new one with bots, and you're playing in seconds. Public rooms have no host, run match after match on rotating maps, and send idle players out instead of stopping. Their invite links work, so friends can follow you in.
- The menu shows how many people are playing online right now (only when anyone is).
- FPS (and your ping, online) in the top right; turn it off from the pause menu.
- Online: the scoreboard (TAB) has a ping column; bots show BOT.
- Online: traffic alerts to ntfy (secret `NTFY_TOPIC`) when live players or rooms pass a new level.
- Online: spread reacts the moment you stop, so a stop-and-shoot isn't judged as moving.
- Bodies hold the pistol in a proper two-handed stance: arms pushed out nearly straight, grip just under the eye line, a slight lean into the gun. Standing still, the feet plant shoulder-width apart with the gun-side foot back. Arms and legs are hit and echo shapes, so they're where they look.
- Bots strafe while they shoot instead of standing in the open, and look for cover: a spot out of your line of sight (tall cover, or low cover they crouch behind) when reloading, hurt or after a burst. In cover they stay down and lean or stand out now and then for a shot.

## 0.6.0-dev
- Online play with room codes. **HOST ONLINE** makes a 4-character room and an invite link (`?room=CODE`); **JOIN WITH CODE** joins one. The host sets map, max players (2–8), bot fill, bot skill, kill limit and time limit in the lobby. Bots fill empty slots and swap out as people join and leave mid-match.
- The room server (`server/`) is a Cloudflare Worker with one Durable Object per room. It runs the actual match from the same game scripts (bots, hits, respawns, pickups, clock). Browsers send their own movement and predict their own shots; only sound events cross the wire, and each browser traces its own echoes.
- New players are held out of a match until they click in, so the click-to-play screen can't get you killed.
- `/admin` monitoring console: players and rooms live, unique players, sessions, hours played, matches, peak concurrency, 48 h charts, per-day table and an event log. JSON logs via `wrangler tail`.
- Host controls: **X** on the pause screen ends the match for everyone (results, then the lobby); **Close room** in the lobby sends everyone out.
- New type: dot-matrix **Doto** for big text (map name, CLICK TO PLAY, timer, HP, killer names, room code) and **Chakra Petch** for everything else, replacing the system monospace. Both are embedded in `vendor/fonts.css` (SIL OFL) so the game still runs offline from `file://`.
- The "every sound is light" tagline is gone from the menu.
- Typing in text fields no longer triggers game keys.
- Online hardening: the room limits movement and forwarded sounds to what a real player can do, a room that empties is closed for good, the host can't restart during results, and names stay unique in a room. Joining or hosting that fails now shows an error with a way back instead of hanging.
- Reconnect: refresh the page or lose your connection mid-match and you get your seat, score and host role back (the room holds it for 30 s). The lobby shows who is reconnecting.
- Movement goes to the room only when it changes (up to 20 Hz, down from a steady 30), roughly halving the server's message bill.
- New home: **playreverb.com** (room server at api.playreverb.com). Old patrickglover.io/reverb links redirect there.
- See `docs/MULTIPLAYER.md` for the protocol, deploying and the scaling plan.

## 0.5.0
- Sound bends round corners (flag `diffraction`). Loud sounds find the edge of their shadow (door jambs, wall corners) and re-emit a dimmer cone of dots into the rooms beyond, delayed by the walk there. A sound out of sight is heard from the opening it comes round, at the length of the path it took, with less muffling than sound through a wall. Bots hear it the same way and walk to the opening instead of the true position; an estimate like that is never sharp enough for them to shoot at.
- Gunshots are louder in front (flag `directivity`): the muzzle blast reaches about twice as far ahead of the gun as behind it, for dots, audio and bot hearing.
- Bots see echo dots (flag `botSight`): any dot that lands on a body, from anyone's sound, is spotted by bots that face it with a clear line of sight within 30 m. With selfEcho, every gunshot now lights up the shooter for whoever is looking.
- Bots decide by scoring: each tick, every action (knife, engage, relocate, hurt, health, sneak, hold, hunt, roam) scores itself and the best one runs, with a small bonus for keeping the current one. Personalities scale the scores (`PERS.*.w`). With the new flags off, behaviour matches 0.4.
- New bot action **sneak**: bots track which way a contact faces (from a click or gunshot they heard directly, or from its movement), then crouch round its side to its back for a knife kill. Sneaky bots favour it; knife-hunters hold fire while sneaking up on someone facing away.
- Shared per-sound walking-distance field (`R.world.soundField`): bots, audio and echo compute it once per sound.

## 0.4.0
- Pistol fires faster: 0.2 s between shots (was 0.26), for bots too. Flag `fireInterval` tunes it live.
- Gunshots light the shooter. Bodies hold the pistol two-handed in front of the face, following view pitch, and lower it while sprinting. Gunshot rays and their reverb can now hit the shooter's own body, so every shot paints your hands and arms in first person. Flag `selfEcho`, default on.
- Dots no longer stick to bodies: a dot that hits a player freezes where it landed as a ghost image. `stickyDots` now defaults to off.
- No muzzle flash: a shot is seen only through its echoes. Flag `muzzleFlash` brings the old spark burst back.
- The local player's own echo dots are hidden only on the head (the camera), no longer on everything above the chest.

## 0.3.0
- Humanoid bodies (`body.js`): 13 capsules (torso, head, arms, legs, feet) with a procedural walk, sprint and crouch cycle driven by each actor's velocity. Echoes, bullets, darts and bot hearing all hit the posed body. Flag `humanoid`, default on; off restores the cylinder + head sphere.
- Echo splats stay on the limb that was hit instead of wrapping a cylinder.
- Bots that hear a dot on a leg aim higher, at the torso.
- Bodies are slimmer than the old cylinder (about 30% fewer rays land on one), so hits and headshots are harder for everyone.

## 0.2.0-dev
- Feature flags with an in-game dev panel (`` ` ``) and `?flags=` URL overrides.
- Flag `stickyDots`: off freezes echo dots where they hit a body instead of following it. Default on (original behaviour).
- Flags exposing echo tuning (wavefront speed, bounce brightness, edge highlights), bot count, god mode and a performance overlay.
- three.js r149 vendored in `vendor/`: the game runs offline from `file://`.

## 0.1.0
- First playable: echolocation deathmatch, three maps, five sound-hunting bots.
