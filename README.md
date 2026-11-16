# Back Forty

A 2D side-scrolling sandbox about running an illegal cannabis grow on a patch
of desert and going legit before the law, rivals or your own habits catch up.

Grow and breed strains, dry and sell your harvest to five buyers with their own
moods and schedules, keep your heat down, hire a crew, make friends in town,
launder cash through a farm stand and apply for a license. Once licensed,
Legacy mode lets you keep playing.

Plain Canvas 2D and vanilla JavaScript ES modules: no runtime dependencies and
no build step. The full design lives in [`plan.md`](plan.md).

## Play

### Desktop app (recommended)

Needs [Node.js](https://nodejs.org/) 20 or newer.

```sh
npm install
npm start
```

F11 toggles fullscreen. The app keeps its own saves.

### In a browser

ES modules do not load from `file://`, so serve the folder and open it in
Chrome or Firefox:

```sh
python3 -m http.server 8000
```

Then go to `http://localhost:8000`. To move a game between the browser and the
app, use **Export save** in the pause menu and **Import save** on the title
screen.

## Controls

| Key | Action |
|---|---|
| A / D | Walk (hold Shift to sprint) |
| W / Space | Jump; climb a ladder |
| S | Climb down; drop through a platform |
| E | Use what is in front of you: shops, buyers, people, pots, racks, bed, water |
| Left click | Water / feed / tend the aimed plant with the selected tool; hold to dig |
| Right click | Place the selected item or tile (pots, racks, lamps, dirt, ladders...) |
| 1–8, mouse wheel | Pick a hotbar slot |
| Tab | Phone: orders, contacts, ledger, heat, crew, allies, journal |
| I | Inventory (assign items to the hotbar) |
| Q | Pick which seeds to plant |
| C | Take a cutting (clone); cull a male plant |
| Alt (hold) | Show water / pH / nutrient bars over your plants |
| B | Get on or off the bicycle |
| R | Reload |
| Esc | Pause menu: save, load, export, settings |
| F3 | Performance overlay |
| F11 | Fullscreen (desktop app) |

Settings has volume sliders, **Mute music** and **Effects** (Auto / High / Low).

## Develop

```sh
npm test                    # unit tests (node --test)
node tools/balance.js 1     # headless balance bot: one 45-day run, seed 1
node tools/balance.js --sweep 10
```

Every tunable number is in `src/config.js`. The simulation (`src/sim/`,
`src/world/`, `src/entities/player.js`) never touches `window`, `document`,
canvas or audio, so it runs unchanged in Node for the tests and the balance bot.

```
index.html, style.css    page, HUD and menu styles
electron/main.cjs        desktop wrapper (serves the game from an app:// scheme)
src/
  main.js                boot, fixed-step loop, save/load wiring
  config.js              every tunable number
  state.js               new game, save format, old-save migration
  sim/                   plants, genetics, economy, heat, threats, crew, allies,
                         addiction, license, edibles, time
  world/                 tiles, world generation, physics, pathfinding, rooms
  entities/              player, combat, NPCs, dog, spawning
  render/                renderer, lighting, particles, sprite atlas
  audio/                 synthesized sound effects and music
  ui/                    HUD, menus, title/pause/settings screens, input
tests/                   node:test suites
tools/
  balance.js             headless balance bot
  extract_art.py         cuts art/ sheets into assets/ and src/render/artdata.js
assets/                  art the game loads
art/                     source art sheets
```

`build.sh` and `chain.sh` are the scripts the milestones in `plan.md` were
originally built with; you don't need them to play or develop.

## License

- **Code:** MIT. See [LICENSE](LICENSE).
- **Art** (`assets/`, `art/`): CC BY-NC 4.0, free to share and adapt for
  non-commercial use with credit. See [LICENSE-ART](LICENSE-ART).

The pixel art was generated with Google's Nano Banana Pro image model and
hand-picked, cut and assembled for the game.
