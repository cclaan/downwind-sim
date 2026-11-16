# Hood River level

A stand-alone prototype of a second level for the downwind foil game: SUP-foiling the
wind-against-current bumps off the Hatchery at Hood River. It shares nothing with the v1
game in the parent folder and never builds into the site's `static/` folder.

The point of this prototype is the mechanics: paddling up onto a bump, carving across
slow steep faces, pumping to link bumps. Everything is tunable live.

## Run

```bash
npm install
npm run dev        # http://localhost:5183 (also served on the LAN for a phone)
npm test           # headless physics acceptance checks, about 20 s
npm run build      # type-check and bundle into ./dist
```

## Controls

| Key | On the water | On foil |
|---|---|---|
| Left / Right (A / D) | steer | lean into a carve (tap = a little, hold = full) |
| Up / Down (W / S) | | front foot / back foot: Up rides lower, Down rides higher (the panel's "Up is front foot" switch flips it) |
| Space | tap = sprint stroke, hold = cruise | tap = hard pump, hold = steady pumps |
| R / F | restart floating / restart already flying | |
| C, M, H, P | camera, mute, help, tuning panel | |
| V | variometer sound: beeps while the water is feeding the foil | |

Touch: left thumb is a floating stick (lean, ride height), right thumb paddles and pumps.

URL options: `?conditions=classic|nuking|light|clean`, `?foil=s980|s1300|s720|surf`,
`?at=hatchery|tunnel|swell`, `?q=low|mid|high`, `?cam=chase|high|drone|side`,
`?handling=carve|rail|glide`,
`?scenario=auto|reader|sturn|carve|longturns|pump|paddleup|glide` (a scripted rider), `?start=foil`,
`?rider=man|woman|capsules` (also the intro card's Man / Woman toggle and the panel's View
folder; remembered in the browser),
and `?p=handling.bankMaxDeg:48,waves.hs:1.2` to override any simulation number
(the tuning panel's "Copy link" button writes these).

## How it works

- `src/sim/` is the whole simulation, with no rendering code, and runs headless in Node.
  - `waves.ts`: one analytic wave field (16 directional components, crest sharpening,
    forward-leaning faces) sampled by the physics on the CPU and evaluated by the water
    shader from the same numbers. It also gives the water's own motion, which is what a
    foil actually rides.
  - `physics.ts`: the rider. On foil it is a point-mass glider whose lift and drag come
    from its velocity relative to the moving water, so a bump feeds it only where the
    water under the wing is rising, turning costs speed unless the wing is loaded where the
    water moves with it, and so on. Off foil it is a floating board with hull drag, paddle
    strokes and a wing that takes the weight as speed builds. Stamina is a critical-power
    model: a quick store for sprints and a slow one for long efforts.
  - `level.ts` / `levelData.ts`: the real reach (USGS elevation, NOAA chart depths) and a
    map of where the bumps are big. Regenerate with `python3 tools/level-source/build_level.py`.
  - `params.ts`, `presets.ts`: every tunable number, and named bundles of them.
  - `autopilot.ts`: a look-ahead pilot used for tests, demos and reference clips.
- `src/render/rider/`: the rider. `animator.ts` solves a skeleton every frame from the
  simulation state (strokes, pumps, carves, crashes); `skinned.ts` poses a character model
  from it (the man or the woman in `public/characters/`, 512 px textures, made game-ready by
  `tools/pack-character.py`), and the capsule figure stands in until the model has loaded.
  `tools/char-view.html` (dev server only) shows the models side by side in a riding crouch.
- `src/main.ts` runs fixed 120 Hz physics steps, interpolates for drawing and loads the
  feature modules in `src/render`, `src/ui` and `src/audio` (each exports `create(app)`).
- `test/acceptance.ts` states what a rider should expect (glide, stall, turn radius,
  pump endurance, paddle-up) with numeric bands. `test/league.ts` ranks the scripted
  riders (straight-liner, face reader, look-ahead pilot) under any presets, to see how much
  reading the bumps pays: `npx tsx test/league.ts conditions=light foil=s720 handling=rail`.
  `test/bots.ts` prints older experiments.
- `tools/shot.mjs` renders stills and clips headlessly with a scripted rider:

```bash
node tools/shot.mjs --query "scenario=carve&cam=drone" --video 10 --out captures/carve.mp4
```

Axes: +x downwind (074 degrees true), +y up, +z toward Oregon; metres; 1:1 scale. The
simulation lives in the frame of the moving water; the land slides through it with the
river current.
