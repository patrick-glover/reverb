# Changelog

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
