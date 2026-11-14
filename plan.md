# BACK FORTY — Design Doc, Architecture, and Build Plan

Working title: **Back Forty**. A 2D side-view sandbox about running an illegal cannabis grow and going legit.
This file is the complete handoff. The build model should not need to ask questions; where a choice existed, it is made here with the reason.

**Status of the numbers:** every number below is a designed starting value, not a play-tested one. All of them live in one file (`src/config.js`) and are tuned with the headless balance bot (`tools/balance.js`, Milestone 3). The 60 fps figure is a budget enforced by a measured gate at every milestone, not a measurement taken yet.

---

## 0. Decisions at a glance

| Question | Decision | Why |
|---|---|---|
| Engine | Raw Canvas 2D + vanilla JavaScript ES modules, zero runtime dependencies, no build step | Lowest CPU/GPU overhead on a 2-core Celeron + Haswell GT1; nothing to install; see §B1 |
| Internal resolution | 800×450, CSS-scaled ×2 to 1600×900 with `image-rendering: pixelated` | 4× less fill than native; fill-rate is the GT1's weak point |
| Tile size / world | 16 px tiles, one hand-authored world 400×60 tiles (6400×960 px) | 8 screens wide; fits one `Uint8Array(24000)` |
| Day length | 12 real minutes = 24 game hours (1 game hour "gh" = 30 s) | Short enough that a grow cycle is 1–1.5 real hours |
| Run length | License at about day 35–45 (6–8 real hours with sleep skipping) | |
| HUD and menus | HTML/CSS over the canvas, not drawn in canvas | Text is cheap in DOM, and menus are far easier to build correctly |
| Art and sound | 100% procedural, defined in code; no image or audio files | A code-only model can produce them; nothing to load |
| Breeding | Prestige layer after v1 (Milestone 11), same genome code as clones | See §A9 |
| Win | Legal grow license granted | |
| Lose | Third arrest, killing an officer, third overdose, or second bankruptcy | §A13 |

**Cut on purpose** (each would bloat scope or threaten 60 fps): fluid simulation, per-tile dynamic lighting, procedural world generation, crafting trees, mining for ore, vehicles other than a bicycle, automatic weapons, multiple nutrient types, photoperiod control, bud curing, multiplayer, more than one grow site.

---

# DELIVERABLE 1 — GAME DESIGN DOC

## A1. Core loop

1. **Grow**: plant seeds or clones, manage moisture, pH, nutrients and light.
2. **Harvest and dry**: cut in the ripe window, dry 24 gh on a rack.
3. **Sell**: fill buyers' timed orders (yourself or via runners); overflow goes to risky street sales.
4. **Reinvest**: more pots, lamps, an underground room, security, crew.
5. **Survive the night**: thieves at 01:00, rival sabotage at 23:00, police raids at 05:00.
6. **Manage heat**: every sale and every shortcut raises it; laying low, bribes and hiding lower it.
7. **Go legit**: launder cash through a front business, cool heat to 20 or below, pay the $50,000 license fee.

Minute-to-minute: tend plants (seconds each), walk or cycle to town, deal, buy, come home, defend.

## A2. Controls

| Input | Action |
|---|---|
| A / D | Move left / right |
| W or Space | Jump; climb ladder |
| S | Crouch (behind 1-tile cover); drop through platform |
| Shift | Sprint (stamina) |
| Mouse | Aim; hover a plant or object to inspect |
| Left click | Use held item (water, feed, dig, swing, fire) |
| Right click | Place held tile / object; secondary action |
| E | Interact (talk, open door, harvest, sleep, pick up pot) |
| R | Reload |
| 1–8, mouse wheel | Hotbar |
| Tab | Phone (orders, contacts, crew, allies, ledger, journal). Pauses the game |
| I | Inventory (pauses) |
| F | Quick-call allies (opens phone on the Allies tab) |
| Alt (hold) | Show status bars over every plant on screen |
| Esc | Pause menu (save, load, settings) |
| F3 | Perf overlay (fps, frame ms, entity/particle counts) |
| F4 | Debug: spawn stress scene (dev builds only) |

All full-screen menus pause the simulation. Single player, so pausing costs nothing and removes UI-speed pressure.

## A3. World

One world, 400×60 tiles, surface at tile row 20, bedrock at row 58. Left to right:

| X range (tiles) | Zone | Contents |
|---|---|---|
| 0–39 | Woods | Thief, saboteur and goon spawn. Not editable |
| 40–139 | **Your lot** (editable) | Shack (8×5 interior, bed, door), yard, water tap + rain barrel, 4 starting pots. You may dig down to row 57 and build anywhere in this range |
| 140–219 | Road | Walt's house (x 170), patrol cars pass here. Not editable |
| 220–399 | Town | Hardware store (240), park (265), bar (290), clinic (315), pawn shop (335), alley (350), town hall (370), motel (390). Not editable |

Only your lot is a sandbox. Reason: digging and building exist to serve the grow (hidden rooms, stashes, defenses), not as a second game.

**Movement:** walk 90 px/s, sprint 140 px/s, bicycle 220 px/s on the surface. Shack to town centre is about 37 s walking, 15 s by bike.

**Time:** day 06:00–20:00 (7 real min), night 20:00–06:00 (5 real min). Sleeping in the bed runs the simulation at 20× until 06:00 (about 15 s) and stops instantly on any alert (dog bark, camera, alarm, raid warning). Awake more than 30 gh = "Tired": tending 20% slower until you sleep.

**Scheduled events by clock:**

| Time | Event |
|---|---|
| 05:00 | Raid roll (warning at 03:00 with scanner) |
| 06:00 | Day rollover: daily heat, wages due flag reset, autosave |
| 08:00–18:00 | Hardware store, clinic open |
| 09:00–17:00 | Town hall open |
| 10:00–20:00 | Pawn shop open |
| 16:00–02:00 | Bar open |
| 20:00 | Wages paid |
| 21:00–04:00 | Alley dealer (Moss) present |
| 23:00 | Rival sabotage roll |
| 01:00 | Thief break-in roll |

**Event director (pacing guard):** no thieves before day 4, no raids before day 6, no rival before day 8. At most one hostile night event per night (thief, sabotage or goons; the first successful roll wins). After any night with a hostile event the following night is guaranteed quiet. This bounds both difficulty spikes and entity count.

**Weather:** each day at 06:00, 20% chance of rain (lasts 6 gh, outdoor plants +4 moisture/gh, footsteps and gunshot noise radius −30%), 10% chance of heatwave (outdoor moisture loss ×1.5 all day).

## A4. System 1 — Grow sim

### Genome
Every plant carries four traits, each 0–100. This one structure serves strains, clones and breeding.

| Trait | Effect |
|---|---|
| Yield (Y) | Max dry grams = 20 + 0.8·Y |
| Potency (P) | Base quality = P |
| Resilience (R) | Stress damage multiplier = 1.5 − R/100 |
| Speed (S) | Growth needs (9 − 0.05·S) days × 14 lit hours |

### Strains (v1)

| Strain | Y | P | R | S | Max yield | Grow time | Seed price | Unlock |
|---|---|---|---|---|---|---|---|---|
| Ditch Weed | 25 | 40 | 80 | 80 | 40 g | 5 days (70 lit gh) | $20 | Start |
| Blue Haze | 50 | 60 | 60 | 60 | 60 g | 6 days (84 lit gh) | $60 | Day 8 or Grower L3 |
| Widow Kush | 75 | 80 | 40 | 20 | 80 g | 8 days (112 lit gh) | $150 | Grower L5 |

Shop seeds are feminized and vary ±3 per trait from the table.

### Growth stages (share of total progress)

| Stage | Progress | Moisture loss /gh | Nutrient use /gh |
|---|---|---|---|
| Seedling | 0–15% | 2.5 | 0.5 |
| Vegetative | 15–50% | 3.5 | 1.5 |
| Flowering | 50–100% | 4.5 | 2.5 |
| Ripe | 100%, lasts 24 gh | 3.0 | 0 |
| Overripe | next 24 gh | 3.0 | 0 |
| Rotten | after that | — | — |

Progress per lit game hour = `lightFactor × (0.5 + 0.5·health/100) / totalLitHours`. No progress in darkness.

### Moisture (0–100)
- Ideal 40–70. One pour from the watering can = +35. The can holds 8 pours; refill at the tap or rain barrel (1 s).
- Loss modifiers: outdoor daytime ×1.3, under a lamp ×1.15, potting soil ×0.85, living soil ×0.85.
- Below 25 or above 85 = stress. At 0 for 6 gh straight the plant dies.
- Typical cadence: 2–3 pours per plant per day.
- Drip kit ($400, serves 6 pots, needs tap within 12 tiles): holds moisture at 55 automatically.

### pH (4.0–8.0)
- Ideal 6.0–6.8. New soil starts at 6.4.
- Drift: +0.01/gh passive; +0.10 per tap-water pour; −0.20 per nutrient dose. Rain-barrel water adds 0 per pour (reason to keep the barrel).
- Soil buffering multiplies all drift: cheap dirt ×1.0, potting soil ($15) ×0.6, living soil ($40) ×0.3.
- Correct with pH Up / pH Down ($10 for 10 doses, ±0.3 each).
- 5.5–6.0 or 6.8–7.3 = mild lockout (nutrient uptake halved, mild stress). Below 5.5 or above 7.3 = severe lockout (no uptake, severe stress).

### Nutrients (0–100)
- One nutrient stat. Ideal 40–80. One dose = +30; a 10-dose bottle is $20.
- Below 20 = deficiency stress. Above 90 = nutrient burn stress.
- Cut: separate grow/bloom nutrients. One stat already produces the over/under mistake.

### Light
- Outdoors: sun 06:00–20:00, light factor 1.0. Free, but visible and exposed.
- Indoors/underground needs lamps. A lamp lights the nearest N pots within its radius.

| Lamp | Price | Pots | Radius | Light factor | Heat per day (14 h timer) |
|---|---|---|---|---|---|
| CFL | $80 | 2 | 2 tiles | 0.7 | +0.10 |
| HPS | $300 | 4 | 3 tiles | 1.0 | +0.40 |
| LED | $700 | 4 | 3 tiles | 1.1 | +0.15 |

- Each lamp has a timer: 14 h (normal) or 18 h (29% faster growth, heat ×2).
- An indoor plant with no light for 24 gh takes stress.

### Health, care, stress
- Health 0–100, starts at 100. Each active stressor deals damage per gh × the resilience multiplier:

| Stressor | Damage /gh |
|---|---|
| Moisture <25 or >85 | 3 |
| pH mild lockout | 1 |
| pH severe lockout | 3 |
| Nutrients <20 | 1.5 |
| Nutrients >90 | 2.5 |
| No light 24 gh (indoor) | 2 |
| Pest infestation (sabotage) | 3 |

- No stressors: +1 health/gh. Health 0 = dead.
- `avgHealth` = lifetime mean health. `care` = fraction of the plant's lifetime ticks with zero stressors.

### Harvest
- Harvest takes 2 s. Timing multipliers:

| When | Yield × | Quality × |
|---|---|---|
| Early (progress 80–99%) | 0.7 | 0.8 |
| Ripe window (24 gh; 36 gh at Grower L9) | 1.0 | 1.0 |
| Overripe | 1.0 | 1.0 falling 2% per gh (to 0.52) |
| Rotten | 0 | — |

- **Dry yield (g)** = (20 + 0.8·Y) × (0.3 + 0.7·avgHealth/100) × timing × (1 + 0.03·(L−1)) × soil (living soil 1.05) × seeded (0.5 if pollinated by accident).
- **Quality (0–100)** = clamp(P × (0.5 + 0.5·care) × timingQ + 2·(L−1), 0, 100). L = Grower level.
- Wet bud must dry 24 gh on a drying rack ($50, holds 4 plants' worth). Sold wet = half price. Drying product smells (heat) and is what thieves want.
- Cut: curing. Drying already creates the vulnerable-inventory window.

### Reading plants
Hovering a plant opens its panel. Without tools you see bands only ("Dry / Slightly dry / Good / Wet / Soaked"; leaf tint for pH: yellow tips = high, dark spots = low). Tools give numbers: moisture meter $30, pH meter $60, loupe $25 (exact hours to ripe; male detection at 40% progress).

### Tending times (base)
Water 0.6 s, feed 0.8 s, pH dose 0.8 s, plant 1 s, take clone 1.5 s, harvest 2 s.
`actualTime = base × (1 − 0.04·(L−1)) × withdrawal × tired × crank`.

### Pots and limits
Pot $10 (holds cheap dirt free). Pots are carryable (one at a time; hand cart $150 carries 4). Hard cap **60 plants** (balance and perf).

## A5. System 2 — Heat

Heat is 0–100, with a `heatFloor` it can never drop below (starts 0).

| Tier | Range | World tells (no tools needed) |
|---|---|---|
| Cold | 0–24 | None |
| Warm | 25–49 | Patrol car passes the road once a day; bartender rumor "people are talking" |
| Hot | 50–74 | Patrol car 3×/day; helicopter sound at dusk; neighbors' blinds twitch |
| Burning | 75–100 | Unmarked car parked across the road; cops stop-and-search in town |

**How the player reads risk:** the HUD shows the tier as a colored meter always. Buying a police scanner ($250, pawn shop) adds the exact number, the day's itemized heat changes, and a "raid chance tonight" percentage. The bartender sells a rumor for $20 that states tonight's raid chance in words.

### What raises heat

| Source | Heat |
|---|---|
| Street sale to a stranger | +3 |
| Sale to buyer at trust 0–1 / 2–3 / 4–5 | +2 / +1 / +0.5 (Doc Renner always 0) |
| Runner delivery | +0.5 × (1.5 − Discretion/100) |
| Runner busted | +10 (+20 more if he snitches) |
| Stopped by patrol with product | +10 |
| Outdoor plant visible from the road | +0.3 per plant per day |
| Flowering or drying smell, unfiltered | +0.2 per indoor plant, +0.1 per outdoor plant, +0.5 per loaded rack, per day |
| Lamps | per table in §A4; generator ($900) removes lamp heat |
| More than 12 plants / more than 30 plants | +1 / +3 per day |
| Gunshot at your lot | +1 per shot, max +8 per incident (suppressed: +0.25) |
| Gunshot in town | +4 per shot, max +20 |
| Killing a thief or goon | +8 |
| Killing a civilian | +40 |
| Shooting an officer | +50 and heatFloor +25 permanently |
| Spending over $2,000 dirty cash in one day | +3 |
| Collapsing in town (overdose, passed out drunk) | +5 |
| Asking around for buyers | +4 |
| Selling to an undercover | +12 |
| Rival's anonymous tip | +15 |

A plant is "visible from the road" when it is above ground and not inside an enclosed room. Underground or walled-in plants are never visible.
Carbon filter ($200) removes all smell heat within 6 tiles.

### What lowers heat

| Source | Heat |
|---|---|
| Passive decay | −2 per day at Cold/Warm, −1 per day at Hot/Burning |
| Day with zero sales ("laying low") | decay doubled |
| Bribe the deputy (bar, after day 6) | −15 for $500; 5-day cooldown; price +$250 each use |
| Farm-stand front owned | extra −1 per day |
| Favor done for a townsperson | −1 |
| After a raid | −30 (−40 if they found nothing) |

### Raids
- **Roll** at 05:00: chance = 0 below 50 heat; at Hot = (heat − 50) × 1.2%; at Burning = 30% + (heat − 75) × 2.8%.
- **Warning:** scanner gives 2 gh (03:00). A deputy bribed within the last 5 days phones a tip at 23:00 (6 gh).
- **Arrival:** van stops on the road; 4 cops (6 at Burning) walk to the lot.
- **Search:** they enter every above-ground room. A room reachable only through a hidden hatch ($600) is found with chance 30% + (heat − 50)%, +20% with the K-9 unit at Burning, +30% if a runner snitched. A wall safe ($500) in a found room is opened 50% of the time. A buried stash box ($80; dig a hole, place it, cover it with dirt) is found 10% of the time.
- **Seizure:** all found plants destroyed; all found product taken; 50% of found cash (including cash on you); fine $50 per plant found, taken from bank then cash; any shortfall becomes debt, which blocks the license until paid.
- **Arrest** if any of: 20+ plants found, 450+ g found, an unregistered gun found, or you fired at police.
- **Arrest outcome:** bail $1,500 (first) or $3,000 (second) = lose 1 day; can't pay = 4 days in jail. Time skips; plants need a gardener, drip kit or a 4-heart ally. **Third arrest = game over.**
- **Lawyer retainer** ($200/day, town hall): fines and cash seizure halved, arrest thresholds ×1.5, raid chance ×0.75.
- **Player options during a warning:** carry pots underground, bury product and cash, hide guns, or leave the lot (if you are absent you cannot be arrested for plants under the 20 threshold; seizure still happens).

Police: hp 100, pistol 15 dmg, accuracy 70%. They are designed to be unwinnable as a fight (§A8).

**Patrol stops (town, daytime):** passing within 6 tiles of a patrol cop while carrying more than 100 g rolls a search: 2% Cold, 6% Warm, 15% Hot, 30% Burning (×1.5 with the duffel bag). Caught: product lost, $200 fine, +10 heat; over 448 g = arrest. Backpack holds 500 g; duffel ($100) holds 2,000 g.

## A6. System 3 — Threats

### Rival: Dale Pruitt
Runs a grow up the ridge (off-map, left). Has an **aggression** value 0–100, starting 10, active from day 8.

| Change | Aggression |
|---|---|
| Each day after day 10 | +1 |
| A buyer of yours first reaches trust 3 | +2 (once per buyer) |
| You take one of his buyers (Big Tone, Vivian) | +5 each |
| A crew member defects to him | +10 |
| You beat his saboteur or goons | −20 |
| Weekly tribute paid ($300, phone option) | −10 |
| Truce (bar event at aggression 60+, costs $2,000) | set to 10, frozen for 10 days |

Nightly roll at 23:00: chance = aggression × 0.5% (max 50%). One type is chosen:

| Sabotage | What happens | Defenses |
|---|---|---|
| **Poisoned water** (40%) | A saboteur sneaks to the tap/barrel (needs 10 s there). The next 8 pours from it add +1.0 pH and 6 gh of severe stress | Barrel lock $40 (+20 s for him); camera/dog alert lets you catch him; poisoned water looks cloudy and the pH meter flags it; dump and refill clears it |
| **Anonymous tip** (30%) | No intruder. +15 heat (+8 if the deputy is currently bribed) | **Leverage:** if one of your cameras has ever recorded his saboteur, tips are blocked for good (he knows you have footage) |
| **Pest jar** (30%) | Saboteur releases mites on one plant (4 s). Infestation deals 3 health/gh and spreads to the nearest plant within 2 tiles every 12 gh | Neem spray $15 per plant cures; spacing pots 3+ tiles apart stops spread; dog/camera/guard |

**Escalation at aggression 70+:** instead of sabotage, 25% of rolls send a **goon squad**: 2 goons (hp 80, pistol 12 dmg, accuracy 55%) who smash pots (3 s each) and fight. Beating three squads makes Dale back off for 10 days. Dale himself never appears and cannot be killed (keeps the rival a pressure system, not a boss fight).

Saboteur: hp 50, unarmed, flees when seen.

### Thieves
One thief type in v1, "ripper".

- **Break-in roll** at 01:00, from day 4: chance = (value of dry + drying product on site ÷ $200)% + 1% per flowering or ripe plant + 3% per street sale in the last 3 days + 10% if the generator is running − security. Clamped to 0–60%.
- **Security reductions:** any door lock −5, motion floodlight −5 each (max 2), camera −5 total, dog −15, guard −20.
- **Behavior:** enters from the woods, goes to the nearest door, picks the lock, then takes either up to 200 g of product from an unhidden rack/shelf or uproots the 2 ripest plants (5 s each), then runs for the woods. Finds a hidden hatch 25% of the time. Never finds a buried box.
- **Lock pick times:** no lock 0 s, padlock ($50) 15 s, deadbolt ($200) 40 s, steel door ($800) 90 s.
- **Stats:** hp 60, speed 100 px/s, knife 15 dmg (pistol 12 dmg from day 20, 30% of thieves). Flees at under 50% hp, when bitten (60%), or when a shot lands within 2 tiles (50%). From day 20, 30% of break-ins have 2 thieves.

### Countermeasures

| Item | Cost | Effect |
|---|---|---|
| Locks | above | Delay; −5% |
| Tripwire alarm | $30 | Loud ring when crossed; wakes you |
| Motion floodlight | $120 | Lights intruders; −5% |
| Camera (max 4) | $250 | Phone alert with location when an intruder enters its 8-tile cone; records leverage footage; needs to be within 10 tiles of the shack or generator |
| Dog | $300 from Walt + $10/day food | Barks within 12 tiles (wakes you), bites 10 dmg/s, hp 50. Hurt dog: vet $150 at the clinic. Unfed for 2 days: runs away |
| Guard (crew) | $120/day | hp 100, pistol; patrols between two markers you place |

If you sleep through a break-in with no alert, you find out in the morning.

## A7. System 4 — Economy

### Money
Two balances (see My Addition 1): **Cash** (dirty) and **Bank** (clean). Illegal sales pay Cash. The license fee must be paid from Bank. Start: $300 cash.

### Price
`price per gram = ($4 + $0.10 × quality) × trustMultiplier × buyerModifier`
Trust multiplier: trust 0 ×0.8, 1 ×0.9, 2 ×1.0, 3 ×1.1, 4 ×1.2, 5 ×1.3. Wet bud ×0.5.
Examples: quality 38 → $7.80/g base; quality 60 → $10; quality 90 → $13.

Product is stored as batches (strain, quality, grams). Batches of the same strain merge into a weighted-average quality.

### Buyers (5 in v1)

| Buyer | Where / when | Order size (trust 0 → 5) | Every | Min quality | Modifier | Deadline | How found |
|---|---|---|---|---|---|---|---|
| **Skeet** (student) | Park, 12:00–22:00 | 14 → 28 g | 2 days | 20 | ×1.0 | 24 gh | Starting contact |
| **Marla** (bartender) | Bar, 16:00–02:00 | 56 → 112 g | 3 days | 35 | ×1.0 | 24 gh | Skeet referral at trust 2, or buy 3 drinks and talk |
| **Doc Renner** (clinic) | Clinic back door, 18:00–21:00 | 84 → 168 g | 4 days | 55 | ×1.15, 0 heat | 24 gh | Marla referral at trust 3 |
| **Big Tone** (bikers) | Alley garage, 14:00–24:00 | 224 → 448 g | 5 days | 40 | ×0.9 | 48 gh | Asking around, or Marla trust 4. Dale's customer |
| **Vivian** (distributor) | Motel, 20:00–03:00, only on days where day mod 7 is 5, 6 or 0 | 448 → 900 g | 7 days | 60 | ×1.0 | 48 gh | Big Tone referral at trust 3. Dale's customer |

Order size = min + (max − min) × trust/5. Total demand at max trust is about 2,180 g/week, matched to a late-game 40-plant operation (about 2,300 g/week).

### Discovery (three routes, different heat)
1. **Referral** from an existing buyer at the listed trust: 0 heat. Slow and safe.
2. **Ask around** at the bar: $50, +4 heat, reveals one random undiscovered buyer in 1–2 days.
3. **Street cold sale**: approach any pedestrian (E). 20% are interested and buy 3.5–14 g at ×1.0 for +3 heat. Undercover chance: 2% Cold, 5% Warm, 10% Hot, 20% Burning. Undercover = product lost, +12 heat. Street sales never run dry; they are the overflow valve.

### Trust
Trust level 0–5 from trust points. Thresholds: 10, 30, 60, 100, 150.

| Outcome | Points |
|---|---|
| Full order on time | +10 |
| Quality at least 20 above the minimum | +5 extra |
| Partial fill (50%+) on time | +3 |
| Late (within 12 gh grace) | 0 |
| Missed | −15 |

### Missed orders
- One miss: −15 points and the next order is 25% smaller.
- Two misses in a row: the buyer "found another supplier". Dormant 6 days, returns one trust level lower. If it was Tone or Vivian they go back to Dale (aggression +5, and he gloats by phone).
- Three misses within 10 days: dormant 10 days, returns at trust 0.
- Big Tone only: a miss also sends a biker to collect a $500 "inconvenience fee"; refuse = fight (hp 90, bat).
- Skeet never leaves for more than 2 days (anti-softlock).

### Shops (prices)

| Shop | Stock |
|---|---|
| **Hardware (June)** | Pot $10, potting soil $15, living soil $40, nutrients $20/10, pH kit $10/10, moisture meter $30, pH meter $60, loupe $25, neem $15, lamps (§A4), drip kit $400, carbon filter $200, drying rack $50, generator $900, wood tile $2, concrete tile $5, ladder $5, door $20, locks, hidden hatch $600, stash box $80, tripwire $30, floodlight $120, camera $250, pickaxe $80, hand cart $150, bicycle $200, duffel $100, barrel lock $40 |
| **Pawn shop** | Weapons and ammo (§A8), scanner $250, safe $500, bandage $20 |
| **Alley (Moss)** | Seeds, drugs (§A10), unregistered guns (+50%), suppressor $900 |
| **Bar** | Drink $5, rumor $20, hiring board, deputy (bribe) |
| **Clinic** | Full heal $100, vet $150, detox $1,500, taper kit $100/day |
| **Town hall** | Bail, lawyer retainer $200/day, farm-stand permit $3,000, license application |

## A8. System 5 — Crew

- **Finding hires:** six candidates are generated at new game. They appear on the bar's hiring board (2 visible at a time, rotating every 3 days) and as pedestrians with a "?" bubble. Max crew: 4.
- **Hidden stats (0–100 each):** Reliability, Discretion, Greed, Nerve. Before hiring you see one adjective per stat ("careful", "chatty", "hungry", "jumpy"). After 3 days of work the numbers show.
- **Roles and wages (paid at 20:00):**

| Role | Wage | Does |
|---|---|---|
| Runner | $60/day + 5% of delivered value | Takes product from a shelf you mark "outgoing", delivers one order at a time, returns the cash |
| Guard | $120/day | Patrols, fights intruders (not police) |
| Gardener | $90/day | Keeps up to 20 plants in ideal ranges, but their `care` is capped at 0.85 while he tends |

- **Loyalty** 0–100, starts 50.

| Event | Loyalty |
|---|---|
| Paid on time | +2/day |
| $100 bonus | +5 (once per 3 days) |
| You bail him out | +10 |
| Unpaid | −15/day |
| Sees you in withdrawal or Addicted | −10/day |
| A raid happens | −5 |
| A crewmate is busted and you don't bail him | −8 |
| Threatened with a gun | −20 |

### What goes wrong (rolled per delivery)
- **Busted:** chance = 1% + (heat/10)% × (1 − Discretion/150), ×1.5 if carrying over 200 g. Product lost, +10 heat. **Snitch check:** loyalty under 40 → he talks: +20 heat and the next raid's hidden-room search +30%. Bail $800 brings him back next day (+10 loyalty). Unbailed: back after 5 days at −30 loyalty, or gone for good if under 20.
- **Skimming:** if Greed > loyalty, he keeps 5–15% of each payment. The phone ledger shows "received"; it shows "expected" too once you have personally sold to that buyer at least once. Options: dock pay (stops it, loyalty −10), fire, or threaten (stops for 10 days, loyalty −20, 20% he quits on the spot).
- **Late:** chance = (100 − Reliability)/4 %. The order counts as late (0 trust points).
- **Robbed:** carrying over 300 g, 5%: product gone, runner hurt (out 2 days).
- **Quitting:** loyalty under 20 → 25% per day. A quitter 30% of the time sells you out: break-in chance +15% for 5 days, or Dale aggression +10.

Runners walk the real world when on screen; off screen they are a timer (distance ÷ 90 px/s).

## A9. System 6 — Weapons and defense

### Player
HP 100, stamina 100 (sprint −10/s, melee swing −12, regen +15/s). Bandage: +30 hp over 5 s.

### Weapons

| Tier | Weapon | Price | Damage | Rate | Mag | Range | Ammo | Noise radius |
|---|---|---|---|---|---|---|---|---|
| 0 | Fists | — | 5 | 2.5/s | — | melee | — | 0 |
| 1 | Baseball bat | $40 | 18, knockback | 2/s | — | melee | — | 0 |
| 2 | .22 pistol | $350 | 14 | 3/s | 10 | 18 tiles | $1/round | 25 tiles |
| 3 | 9 mm pistol | $700 | 22 | 3/s | 12 | 22 tiles | $1.50/round | 35 tiles |
| 4 | Pump shotgun | $1,200 | 6 pellets × 9, 12° spread | 1/s | 5 | 9 tiles | $3/shell | 50 tiles |
| 5 | Hunting rifle | $2,000 | 60 | 0.7/s | 4 | 40 tiles | $4/round | 60 tiles |

Reload 1.5 s (shotgun 0.5 s per shell). Suppressor ($900, pistols only): noise ÷3.
Pawn-shop guns are registered: legal to own, but found beside plants in a raid they add a weapons charge ($1,000 fine). Alley guns are unregistered (+50% price): found in a raid = arrest. Guns in a safe or buried box follow those hiding rules.

### Combat rules
- Mouse aim, projectile bullets (600 px/s, pooled, max 32 alive), blocked by solid tiles. Spread: 2° standing, 6° moving, ×2 in withdrawal, ×1.3 drunk.
- Crouching behind a 1-tile wall blocks incoming fire unless you are firing.
- Melee knockouts are non-lethal. Reducing a human enemy to 0 hp with fists or the bat = KO (they crawl off after 20 s). With a gun = dead.
- **Downed player** (0 hp) by thieves/goons: wake at the clinic at 06:00, lose 30% of carried cash plus a $300 bill; thieves take double their normal haul. Downed by police = arrest.

### Why guns are not a solve-everything button
1. **Noise is heat:** +1 per shot at home (max +8), +4 in town.
2. **Bodies are heat:** +8 per kill, and a killed thief triggers a **blood feud**: 3 nights later, 2 armed thieves come for revenge (ignores the event director's quiet night).
3. **KO pays better:** a thief beaten non-lethally spreads the word; break-in chance −10% for 5 days.
4. **Ammo and price** are a real share of early income.
5. **Gunfights attract police:** at heat 50+, 6 or more unsuppressed shots in one incident sends a patrol car (2 cops) in 90 s.
6. **Raids find guns.**
7. **Against police:** shooting an officer = +50 heat and heatFloor +25 forever. Because the license needs heat ≤ 20, this makes the license permanently unreachable in that run; the game says so in a full-screen warning the first time you aim a loaded gun at an officer, before the shot. **Killing an officer is a lose condition** ("Fugitive").

## A10. System 7 — Survival mastery

Both mechanisms are in, because they reward different things: skill at tending (XP) and patience with a line (clones).

### Grower level
XP per harvest = dry grams × (0.5 + quality/100).

| Level | Total XP | Perk unlocked |
|---|---|---|
| 1 | 0 | — |
| 2 | 100 | — |
| 3 | 250 | Exact moisture without a meter; Blue Haze seeds |
| 4 | 500 | — |
| 5 | 900 | Exact hours-to-ripe without a loupe; Widow Kush seeds; license inspection eligible |
| 6 | 1,500 | Breeding unlocked (Milestone 11) |
| 7 | 2,300 | Clones always root (otherwise 85%) |
| 8 | 3,400 | — |
| 9 | 4,800 | Ripe window 36 gh |
| 10 | 6,500 | Stress damage −20% |

Every level: **+3% yield, +2 quality points, −4% tending time** (at L10: +27%, +18, −36%).

### Clone generations
- Take a cutting from any vegetative plant (1.5 s; mother loses 5 health). The clone starts at 15% progress (skips seedling) and copies the mother's genome.
- At the cut, each trait independently: +1 with probability 0.6 × mother's `care` so far; otherwise −1 with probability 0.4 × (1 − care). A well-kept mother improves about +0.5 per trait per generation; a neglected one degrades.
- Cap: +15 over the strain's base per trait through cloning alone.
- The clone's generation number = mother's + 1.

### How the player sees it
- Plant panel: "Blue Haze · G4", four trait bars with a ghost tick at the base strain's value.
- **Harvest report card** after each harvest: grams and quality with the multiplier breakdown ("60 g base × 0.93 health × 1.12 mastery × 1.0 timing = 62.5 g") and a comparison to the mother ("+3.1 g, +1 quality vs. mother").
- **Grower's journal** (phone): bar chart of the last 20 harvests' yield and quality, XP bar, perks list.
- Level-up toast listing the new perk.

## A11. System 8 — Genetics and breeding (late game)

**Decision: breeding is the prestige layer on top of the license, not part of the win condition, and ships in Milestone 11 (after v1).**

Reasons:
1. Stabilizing a strain takes 4–5 plant generations (25–40 game days). Putting that on the critical path would double the run length for every player.
2. It is the hardest system to balance; a mistake in it should not be able to break the win condition.
3. It gives the game a reason to continue after the license (Legacy mode), which the license alone does not.
4. It reuses the clone genome code, so deferring it costs no rework.

It unlocks at Grower L6, so a dedicated player can start before the license, but its full payoff needs the license.

### Mechanics
- **Males:** bred seeds are 50% male (shop seeds never are). Males show pollen sacs at 55% progress (loupe: 40%). An unculled flowering male pollinates every flowering female within 6 tiles: those plants give yield ×0.5 and quality ×0.6 (a real mistake to avoid). Buy a pollen kit ($150) to collect pollen from a flowering male (item carrying his genome; 4 uses).
- **Crossing:** apply pollen to a flowering female. She gives bud at yield ×0.3 plus `6 + floor(health/20)` seeds (6–11).
- **Inheritance, per trait:** `child = lerp(mother, father, u) + noise`, u uniform 0–1, noise uniform in ±8 × (1 − stability). Clamped 0–100.
- **Stability** (0–1) belongs to a line. A cross between two different lines makes a new line at stability 0.2 (F1). Crossing two plants of the same line raises it by 0.2 per generation (F2 0.4 … F5 1.0).
- **Inbreeding cost:** each same-line generation subtracts 2 from Resilience. Outcrossing resets stability to 0.2 but does not restore lost Resilience (you breed it back in).
- **Naming:** at stability 0.8+ you may register the line with a name (16 characters). Named strains show under that name everywhere.
- **Selling the custom strain:**
  - Buyers at trust 3+ pay +15% for a named strain.
  - **Hype** 0–100: +1 per 100 g of the named strain sold. Price bonus up to +30% at hype 100.
  - With the license: sell seed packs to the dispensary counter at town hall, $50 × (Y+P+R+S)/200 each, 10 per day.
- **Legacy mode goal (post-license):** win the yearly Harvest Cup (every 28 days) by entering a named strain with trait sum 320+ at stability 1.0. This is optional and has its own end screen.

## A12. System 9 — Addiction

Three addictive substances in v1, each tempting for a different reason, plus smoking your own product.

| Substance | Price | Buff | Duration | Dependence per use |
|---|---|---|---|---|
| **Crank** (stimulant) | $30 | Tending time ×0.6, move +25%, immune to Tired | 8 gh, then 4 gh crash (tending ×1.3, move −20%) | +8 |
| **Blues** (painkillers) | $20 | Heal 20 hp, damage taken −30% | 6 gh | +6 |
| **Booze** | $5 at the bar | Friendship gains ×1.5; aim spread ×1.3 | 3 gh | +2 |
| Own weed (1 g) | product | Withdrawal penalties −25%; tending time ×1.1 | 4 gh | none |

Cut: a fourth hard drug. Three already cover the work, combat and social temptations.

### Escalation (per substance)
- Dependence **D** 0–100. Each use: `D += gain × (1 + D/100)` (the more hooked, the faster it climbs).
- Tolerance: buff duration × (1 − D/200). At D 100 a dose lasts half as long.
- Dealer pricing: +10% per 20 D (up to +50%). He knows you need it.

| Stage | D | Rule |
|---|---|---|
| Casual | 0–29 | No penalty. D falls 2 per day without use |
| Hooked | 30–59 | Needs a dose every 24 gh or withdrawal starts. D no longer falls on its own while you keep using |
| Addicted | 60–100 | Needs a dose every 12 gh. Baseline penalties even when dosed |

### Damage

| | Hooked in withdrawal | Addicted in withdrawal | Addicted, dosed (baseline) |
|---|---|---|---|
| Tending time | ×1.5 | ×2.0 | ×1.0 |
| Fumble chance per tend action | 10% | 25% | 5% |
| Max stamina | −25% | −50% | −20% |
| Max HP | — | −20 (Blues −30) | −20 (Blues −30) |
| Aim spread | ×2 | ×2 | ×1 |

- **Fumble** = the action goes wrong: a double pour (+70 moisture), a double nutrient dose, or a pH dose in the wrong direction. This is how addiction directly lowers yield and quality.
- **Money:** an Addicted crank habit is 2+ doses a day at up to $45 = $90+/day, more than a runner's wage.
- **Compulsion (Addicted only):** after 6 gh of withdrawal, a dose in your inventory is used automatically. In withdrawal within 10 tiles of Moss with enough cash: 50% you buy and use one (2 s loss of control). So getting clean means not carrying and not walking the alley at night.
- **Health:** each day spent Addicted: permanent max HP −1 (floor 60). Regained +1 per day after 5 clean days.
- **Social:** crew loyalty −10/day while they see you Addicted or in withdrawal; allies −3 friendship each time they witness hard-drug use; buyers at trust 2 or less pay −10%.
- **Overdose:** a third dose of any hard drug within 6 gh = 25% chance (each further dose +25%). Collapse → clinic, $400, +5 heat, permanent max HP −5. **Third overdose is fatal** (lose condition).

### Recovery

| Route | Cost | What it takes |
|---|---|---|
| Cold turkey | Free | Stay in withdrawal; D falls 8 per day. From 60 that is about 4 days to Casual, 7.5 to zero, with full penalties throughout |
| Taper kit (clinic) | $100/day | D falls 12 per day; only penalty is max stamina −15%. Missing a day cancels it |
| Clinic detox | $1,500 | 3 days away (time skip; plants need cover). D set to 15 |

### Relapse
- Dropping below 30 from Hooked or Addicted starts **In Recovery** for 14 days.
- One craving per day at a random hour, plus one after every stress event (raid, break-in, crew busted, ally hurt). A craving lasts 2 gh: tending ×1.25, and the compulsion check near Moss applies at 30%.
- Any use during recovery snaps D straight to 75% of your all-time peak for that substance.
- Booze during recovery from anything adds one extra craving that day.
- A **sponsor** (ally at 3+ hearts; Rosa is best) halves compulsion chances and removes the stress-event cravings.
- After 14 clean days: Clean. Compulsion ends. History stays: a later use snaps D to 50% of peak.

## A13. System 10 — Friends and allies

Four possible allies in v1. Friendship = 0–100 points, shown as 0–5 hearts (20 points each).

| Ally | Who | Combat | Non-combat benefit | Loves / likes / dislikes |
|---|---|---|---|---|
| **Walt** | Retired veteran, lives on the road | hp 90, rifle 40 dmg, accuracy 80%, slow (70 px/s) | Sells you the dog; at 3 hearts warns of patrol cars | Whiskey / firewood (wood tiles ×10) / hard drugs |
| **Benny** | Mechanic, Skeet's cousin | hp 130, bat 18 dmg (KO only), fast (120 px/s) | At 5 hearts drives 4 pots away on a raid warning | Beer / bicycle parts ($30 hardware item) / being owed money |
| **June** | Hardware store owner | hp 70, shotgun, accuracy 60% | 15% discount at 3 hearts | Quality 60+ bud / coffee / gunfire in town |
| **Rosa** | Clinic nurse | hp 60, does not fight; revives a downed person in 5 s, heals 5 hp/s within 3 tiles | Taper kit half price at 3 hearts; best sponsor | Flowers (park pickup) / coffee / Blues use |

### How friendship forms

| Source | Points |
|---|---|
| **Favor** (one offered per ally every 3 days: fetch an item, deliver a package across town, walk them home at night, fix a fence with 6 wood tiles) | +12, and −1 heat |
| **Gift** (one per ally per day) | Loved +8, liked +5, neutral +1, disliked −3 |
| **Drink together** at the bar | +3 (costs a Booze use — an addiction hook) |
| **Shared history:** fought beside you | +10 |
| **Shared history:** you paid their hospital bill or bail | +15 |
| No contact for 5 days | −2 per day after |
| Witnessed your hard-drug use | −3 |
| Hurt while helping you and you did not pay the bill | −20 |

### Calling for defense
- Phone → Allies → Call (2+ hearts). Arrival time = (6 − hearts) × 20 s, +20 s at night. **Max 2 allies on the lot at once.**
- After a fight an ally has a 2-day cooldown.
- At 4+ hearts an ally comes on their own when a camera or dog alert fires and you are away or asleep, and waters your plants while you are in jail or detox (plants held at `care` cap 0.7).
- In a fight they stay within 10 tiles of you, target the nearest hostile, and retreat at 25% hp.
- **Allies never fight police.** They leave when a raid van arrives.

### When things go wrong
- **Hurt:** at 0 hp an ally is downed. Revived by Rosa or by you (hold E 5 s) within 60 s, they get up at 30 hp. Otherwise: hospital 3 days. Pay the $400 bill (+15) or don't (−20).
- **Killed:** a downed ally hit again by gunfire has a 10% chance to die. Permanent. All other allies −10; you get "Grief" for 3 days (tending ×1.1).
- **Arrested:** if a patrol responds to a gunfight (§A9) and an armed ally is still there, 50% they are arrested. Bail $600 (+15). Leave them in: −40 and unavailable 6 days.
- **Betrayal:** an ally who once had 60+ points and falls below 20 becomes **Estranged**. Each then does one hostile thing, once: Walt reports you (+15 heat); Benny sells your layout to thieves (break-in +15% for 5 days, thieves find the hatch 100% next time); June bans you from the store for 5 days and +20% prices for 10; Rosa refuses clinic service for 10 days. An estranged ally can be won back from 0 with favors only (gifts refused).
- **Benny's loan (scripted, once, after day 15):** he asks for $1,000. Lend it: +15, repaid in 10 days 70% of the time. Refuse: −15.

## A14. Progression curve to the license

### License requirements (town hall clerk)
1. **$50,000 from Bank** (clean money).
2. Own the **farm-stand front** ($3,000 permit).
3. **Grower L5** and a submitted sample of quality 70+ (28 g).
4. **Heat ≤ 20** on the day you apply, and it must stay ≤ 20 through a 3-day review.
5. No arrest in the last 10 days, no unpaid fines.
6. On review day 3 at 12:00 an inspector walks your lot for 60 s. Nothing happens unless a raid would have triggered; it is a tension beat, not a new mechanic.

Granted → win screen with run stats → option to continue in Legacy mode (no heat from growing or selling; thieves and Dale remain; breeding and the Cup become the goal).

### Expected curve (to be verified by the balance bot)

| Phase | Days | Plants | Strain | Income in phase | What the player is learning | New pressure |
|---|---|---|---|---|---|---|
| 1 Backyard | 1–7 | 4–8 outdoor | Ditch Weed | ~$900 | Moisture, pH, harvest timing, Skeet | Thieves from day 4 |
| 2 Basement | 8–18 | 12–20 | Blue Haze | ~$6,000 | Digging a hidden room, lamps, Marla and Doc, first runner | Raids from day 6, Dale from day 8 |
| 3 Operation | 19–30 | 24–40 | Blue Haze → Widow | ~$25,000 | Crew, security, allies, bribes, the front | Armed thieves, goon squads, heat climbing ~3/day |
| 4 Cash-out | 31–45 | 40 → wind down | Widow Kush | ~$60,000 | Laundering $50k, then going quiet to drop heat ≤ 20 | Everything, then deliberate silence |

The endgame shape is intended: the player must stop doing the profitable thing (selling) for the last several days to cool off, while holding off thieves and Dale with no income.

## A15. Lose conditions

1. **Prison:** third arrest.
2. **Fugitive:** an officer is killed. Triggers at the next 06:00 after a final SWAT raid.
3. **Overdose:** third overdose.
4. **Washed out:** cash + bank under $20 with no plants, product or seeds for 2 full days. The first time, Skeet fronts you 2 Ditch Weed seeds instead (one-time rescue). The second time is game over.

Every game over offers "Load last autosave" (autosaves are kept for the last 3 dawns).

---

## A16. MY ADDITIONS

Each is marked, justified, and assigned a milestone.

**MY ADDITION 1 — Dirty cash vs. clean bank, and the farm-stand front.** (Milestone 10)
The farm stand ($3,000 permit, built on your lot's road edge) launders up to $2,500 of cash per day into Bank at a 15% fee; a $4,000 upgrade raises it to $5,000/day. Why: without it the license is just a price tag. With it, the license needs about 2–3 weeks of deliberate laundering, "flashy spending" heat means something, and raids (which seize cash, not bank) create a real choice about where money sits.

**MY ADDITION 2 — Building as stealth: underground rooms, hidden hatches, buried stashes.** (Milestone 4)
Why: it gives the Terraria-style digging a purpose inside this game. Plants underground are invisible to the road; a hidden hatch can beat a raid search; a buried box beats thieves. Without this the sandbox layer would be decoration.

**MY ADDITION 3 — Event director.** (Milestone 5; rules in §A3)
Why: ten interlocking threat systems on a 12-minute day can stack into unfair nights. Grace days, one hostile event per night, and a guaranteed quiet night after make difficulty legible and also cap active entities for the perf budget.

**MY ADDITION 4 — Non-lethal incentives and blood feud.** (Milestone 5; §A9)
Why: makes "guns are a tool with costs" a mechanical truth: the bat and the dog are often the better answer.

**MY ADDITION 5 — Harvest report card, ledger and grower's journal.** (Milestone 2 for the card, Milestone 7 for journal)
Why: mastery only feels good if the player can see the multiplier breakdown and the trend. The ledger is also how skimming is detected.

**MY ADDITION 6 — Alt-overlay and "needs attention" markers.** (Milestone 2)
Holding Alt shows moisture/pH/nutrient bars over every plant; a small icon appears over any plant with an active stressor. Why: with 20+ plants, hover-inspecting each one is tedium, not gameplay.

**MY ADDITION 7 — Sleep fast-forward with interrupts.** (Milestone 2, alerts wired in Milestone 5)
Why: nights with no event should take 15 seconds, and security purchases gain a second job (they are what wakes you).

**MY ADDITION 8 — Leverage footage.** (Milestone 6; §A6)
Why: gives cameras a strategic payoff against the one sabotage type that has no on-site counter.

**MY ADDITION 9 — Weather.** (Milestone 4; §A3)
Why: cheap (one roll per day, up to 80 rain particles inside the particle budget) and it makes outdoor growing a gamble instead of strictly worse/better.

**MY ADDITION 10 — Bicycle.** (Milestone 3)
Why: the town trip is 37 s each way on foot; by mid-game that is dead time.

**MY ADDITION 11 — Headless balance bot.** (Milestone 3, extended each milestone)
`tools/balance.js` runs the pure simulation in Node with a scripted policy (water at 40, feed at 40, sell everything to available buyers, expand when affordable) for 45 days in under a second and prints cash, bank, heat, plants and grower level per day. Why: it is the only affordable way to tune ~200 numbers; see Risk 1.

**MY ADDITION 12 — Perf overlay and automatic quality step-down.** (Milestone 0 overlay, Milestone 10 step-down)
If average frame time exceeds 18 ms for 2 s: halve the particle cap, then disable the darkness layer's soft lights (flat night tint), then drop pedestrians to 4. Why: the hardware has no headroom; degrade visibly-harmless things before dropping frames.

**MY ADDITION 13 — Difficulty presets.** (Milestone 10)
Relaxed / Standard / Harsh multiply threat chances and heat gains by 0.7 / 1.0 / 1.3. Why: one multiplier in config, large accessibility gain.

## A17. Conflicts found in the request, and the fix applied

| Conflict / bloat | Fix |
|---|---|
| "Terraria-like sandbox" vs. a management sim: a full sandbox (worldgen, mining, crafting, fluids) is a second game and the biggest perf risk | Sandbox limited to digging and building on your own lot; items are bought, not crafted; one authored world |
| Clone improvement (System 7) and breeding (System 8) are two genetics systems | One genome model and one module. Cloning = small capped drift; breeding = recombination. Breeding deferred to Milestone 11 at zero rework cost |
| Guns vs. police vs. the license win | Fighting police cannot be a viable strategy: shooting one makes the license unreachable (with an explicit warning), killing one is a loss |
| Addiction "auto-use" vs. player agency | Compulsion only fires at the Addicted stage, only after 6 gh of withdrawal, and is fully avoidable by not carrying and avoiding the alley; the game explains the rule when you first become Hooked |
| Jail and detox time skips vs. plants that need watering every few hours | Drip kit, gardener, and 4-heart allies each cover absence, at different costs |
| Ten systems on one short day | Event director; staged unlocks by day; every menu pauses |
| Allies + crew + guards + dog could trivialize threats and blow the entity cap | Max 4 crew, max 2 allies on site, 1 dog; nobody fights police |
| Tending tedium at 40 plants | Drip kit, gardener, Alt overlay, mastery tending-time reduction |

---

# DELIVERABLE 2 — TECHNICAL ARCHITECTURE

## B1. Engine choice

**Raw Canvas 2D, vanilla JavaScript (ES modules), no framework, no bundler, no npm packages.**

| Option | Verdict | Reason |
|---|---|---|
| Godot web export | Rejected | 30–40 MB WebAssembly payload, WebGL2 renderer on Haswell GT1 via Mesa, slow startup on a 1.4 GHz 2-core; heavy for a tile game |
| Phaser 3 | Rejected | About 1 MB of framework and a general scene graph we would mostly bypass; its tilemap and physics don't fit editable tiles + custom sim without fighting it; adds a dependency for little gain |
| PixiJS | Rejected | Good WebGL batcher, but our draw count is small enough (≤ 400 `drawImage` per frame at 800×450) that Canvas 2D is sufficient, and Canvas 2D has no shader-compile or context-loss issues on old Mesa |
| **Raw Canvas 2D** | **Chosen** | Smallest CPU overhead, full control over what is drawn, Chrome GPU-accelerates it, trivial for a code model to write and debug |

Served with `python3 -m http.server 8000` from the project root (ES modules do not load from `file://`). Tests run with Node's built-in runner: `node --test tests/`. Node is a dev tool only.

## B2. Performance budget (hard limits, enforced in code)

| Item | Limit |
|---|---|
| Frame rate | 60 fps; frame budget 16.6 ms |
| JS time per frame (update + draw calls) | ≤ 6 ms average, ≤ 10 ms worst |
| Internal canvas | 800×450 (never resized; CSS scales it) |
| Active entities (player, NPCs, dog — simulated with physics and drawn) | **40** |
| Plants | **60** (static sprites; sim only at 2 Hz) |
| Bullets | **32** (pooled) |
| Particles | **150** (pooled; includes rain) |
| Soft lights on screen | **12** |
| `drawImage` calls per frame | ≤ 400 |
| Physics / movement step | **60 Hz** fixed |
| Simulation tick (plants, heat, economy, addiction, crew, allies) | **2 Hz** fixed (every 0.5 s = 1/60 gh) |
| AI decision rate | **5 Hz** per NPC, staggered by entity id |
| Pathfinding | max 1 search per frame, each ≤ 4,000 nodes |
| HUD DOM updates | 4 Hz, only changed fields |
| Allocation in the frame loop | none (pools, reused vectors); goal is zero GC pauses over 2 ms |
| Save size | under 200 KB |

Entities farther than 1,200 px from the camera are **abstract**: no physics, no drawing, only a schedule position updated at 2 Hz. Enforcing: `spawnEntity()` refuses beyond the cap (ambient pedestrians are removed first to make room for event NPCs).

**Perf gate (every milestone):** press F4 to spawn the stress scene (40 entities, 60 plants, 150 particles, 12 lights, raining, at night). On the target machine in Chrome the F3 overlay must show average frame time ≤ 12 ms and no frame over 20 ms across 60 s. A milestone is not done until this passes.

## B3. Main loop and tick design

```js
// main.js (shape, not final code)
const PHYS_DT = 1/60, SIM_DT = 0.5;
let physAcc = 0, simAcc = 0, last = performance.now();
function frame(now) {
  let dt = Math.min((now - last) / 1000, 0.1); last = now;   // clamp: tab was hidden
  if (!state.paused) {
    const speed = state.sleeping ? 20 : 1;
    physAcc += dt;
    while (physAcc >= PHYS_DT) { if (!state.sleeping) stepPhysics(state, PHYS_DT); physAcc -= PHYS_DT; }
    simAcc += dt * speed;
    while (simAcc >= SIM_DT) { stepSim(state, SIM_DT); simAcc -= SIM_DT; }
  }
  render(state, physAcc / PHYS_DT);
  requestAnimationFrame(frame);
}
```

- `stepPhysics`: input → player, active NPC movement, bullets, particles, camera. It does not run while sleeping. **Sleep ends the instant any alert fires or any police entity spawns**, so physics never needs fast-forward. A break-in with no alert while you sleep is resolved abstractly by `threats.js` (losses computed from the same formulas, no entities spawned).
- `stepSim` calls, in order: `time`, `weather`, `plants`, `heat`, `economy`, `crew`, `threats` (director + rolls), `addiction`, `allies`, `license`. Each is `fn(state, dt)` and may push to `state.events`.
- `state.events` is a queue of plain objects (`{type:'harvest', ...}`); UI, audio and particles read it once per frame, then it is cleared. Sim code never calls UI or audio directly.
- All randomness comes from one seeded PRNG (`mulberry32`) whose state is in the save, so tests and the balance bot are deterministic.

**Rule that keeps this testable:** nothing under `src/sim/` or `src/world/` may reference `window`, `document`, canvas or audio. They run unmodified in Node.

## B4. Game state and save system

One plain JSON-serializable object:

```js
state = {
  version: 1, seed, rngState,
  time: { day, hour, weather },
  player: { x, y, vx, vy, hp, maxHp, stamina, cash, bank, debt, inventory[], hotbar[], equipped,
            xp, level, arrests, overdoses, buffs[], dependence:{crank,blues,booze}, peak:{...},
            recovery:{...}|null, awakeHours },
  tiles: Uint8Array(400*60),            // saved as RLE → base64 string
  objects: [ {id, kind, x, y, ...} ],   // pots, lamps, doors, locks, cameras, racks, safe, stash…
  plants:  [ {id, potId, genome:{Y,P,R,S}, strainName, lineId, generation, sex,
              progress, moisture, ph, nutrients, health, healthSum, careTicks, ticks,
              stage, infested, poisonedHours} ],
  product: [ {strainName, quality, grams, wet, dryHoursLeft} ],
  heat: { value, floor, todayLog[], bribeCount, bribeCooldown, lawyer },
  buyers:  [ {id, known, trustPts, order:{grams, deadline}|null, nextOrderDay, dormantUntil, misses[]} ],
  crew:    [ {id, name, role, stats, loyalty, daysWorked, status, task} ],
  candidates: [...],
  rival: { aggression, frozenUntil, squadsBeaten, leverage },
  allies:  [ {id, pts, peakPts, status, cooldownUntil, favor, estranged} ],
  security: { breakInBonus:[{until, amount}] },
  director: { lastHostileNight, feuds[] },
  license: { frontOwned, launderCap, applied:{day}|null, granted },
  entities: [ ... active NPCs ... ],
  stats: { ... run totals ... },
  events: []   // not saved
}
```

- Storage: `localStorage`, keys `backforty.slot1..3` and `backforty.auto1..3` (rolling dawn autosaves).
- Save triggers: every 06:00, on sleep, manual from the pause menu.
- `save()` = `JSON.stringify` with tiles RLE+base64. `load()` checks `version` and runs `migrate(old)` (a chain of functions, one per version bump).
- Pause menu has Export (downloads the JSON) and Import (file input) so a cleared browser profile does not destroy a run.
- A failed `localStorage.setItem` (quota) shows a visible error and offers Export; it is never swallowed.

## B5. World, tiles, physics

- Tile grid: `Uint8Array(24000)`, index = `y*400 + x`. Tile ids: 0 air, 1 dirt, 2 grass, 3 stone, 4 bedrock, 5 wood wall, 6 wood platform, 7 concrete, 8 ladder, 9 road, 10 town-solid (not editable), 11 background wall (non-colliding, marks "indoors").
- `worldgen.js` builds the one world deterministically: flat-ish surface at row 20 with ±1 seeded variation in the woods and lot, stone from row 34 down, bedrock row 58–59, then stamps the shack and town buildings from small tile templates. Editable only where `40 ≤ x < 140`.
- Dig times: dirt 0.4 s (shovel), stone 1.5 s (pickaxe required). Digging returns nothing except dirt tiles (stack to refill holes).
- Physics: axis-aligned boxes vs. tiles, gravity 900 px/s², jump velocity 300 px/s (clears 3 tiles), step-up of 1 tile is automatic for NPCs. Player box 12×22 px. No slopes. No tile physics (dirt does not fall).
- **Rooms:** when a tile on the lot changes, a debounced (1 s) flood fill over the lot's air cells (≤ 4,000) labels enclosed regions. Each room gets `{cells, underground, openToSky, entrances[], hiddenOnly}`. Used for: plant visibility, raid search list, thief routing. Plants outside any room and above ground are "visible".

## B6. Entities and AI

No ECS library. Entities are plain objects in `state.entities` with a `kind` and a `state` string; `npc.js` has one `think(e, state)` per kind (a `switch` on `e.state`) run at 5 Hz, and one shared `move(e, dt)` run at 60 Hz that walks toward `e.targetX/targetY` along the current path.

**Navigation:** town and road are flat: NPCs just walk in x. On the lot, `nav.js` runs a breadth-first search over standable cells (walk, step up 1, drop any height, climb ladders, pass doors) within the lot region; result cached per entity and invalidated when tiles change. One search per frame maximum; others wait in a queue.

| Kind | States |
|---|---|
| Pedestrian | Schedule (home/shop/bar by hour) → WalkTo → Idle |
| Buyer | Schedule → AtMeetSpot → (Dormant) |
| Runner | Idle → Pickup → Travel → Deliver → Return (abstract timer when off-screen) |
| Guard | PatrolA ↔ PatrolB → Engage → Downed |
| Gardener | Idle → WalkToPlant → Tend |
| Dog | Idle/Follow → Bark → Attack → Hurt |
| Thief | Approach → PickLock → Search → Grab → Flee; any → Fight or Flee when attacked (by Nerve roll) |
| Saboteur | Approach → Sabotage → Flee |
| Goon | Approach → SmashPots / Attack → Retreat (hp < 30%) |
| Cop (raid) | Arrive → SearchRoom (6 s per room) → Seize → Leave; any → Combat if fired on |
| Cop (patrol) | WalkLoop → StopAndSearch |
| Ally | Travel → Defend → Retreat (hp < 25%) → Leave; Downed |

Combat AI for all armed kinds: if target in range and line of sight (tile raycast, max once per think) → fire with the kind's accuracy as a hit-cone; else move toward the target.

## B7. Rendering

Draw order each frame, on the single 800×450 canvas:

1. **Sky:** one 2-stop vertical gradient, re-created only when the game clock crosses a 10-minute boundary (cached canvas).
2. **Parallax hills:** one pre-rendered 1600×200 canvas, scrolled at 0.3×.
3. **Tile chunks:** the world is pre-rendered into 100 offscreen canvases of 16×16 tiles (256×256 px). A tile edit marks its chunk dirty; dirty chunks re-render at most 2 per frame. At most 8 chunks are visible.
4. **Objects and plants** in view (sprite `drawImage` from the atlas).
5. **Entities** in view (interpolated position, 2-frame walk flip via `scale(-1,1)` avoided: both facings are pre-rendered in the atlas).
6. **Bullets, particles** (1–2 px `fillRect`).
7. **Darkness layer:** a 200×113 canvas filled with black at the current night alpha (0 at day, 0.75 at midnight, 0.9 underground); lights are punched out with `destination-out` using 3 pre-rendered radial sprites (small, medium, large); then drawn scaled ×4 over the scene. Underground areas are dark in daytime too (darkness alpha is the max of night alpha and a per-column "under roof" flag sampled at the camera).
8. **World-space UI** (plant bars on Alt, interaction prompt, alert arrows) drawn in canvas.

Screen HUD and all menus are DOM elements in `#ui`, absolutely positioned over the canvas, updated at 4 Hz with dirty checks.

Camera: follows the player with a 0.15 s lag, clamped to world bounds, positions rounded to whole pixels (no shimmer, no sub-pixel filtering). `ctx.imageSmoothingEnabled = false` everywhere.

## B8. Audio

Web Audio API, fully synthesized, zero files. `audio.js` exposes `sfx(name)` and `setMusic(mode)`.

- **SFX:** each is a parameter object (wave type, start/end frequency, attack/decay, noise amount) rendered once at startup into an `AudioBuffer` (about 24 sounds, under 0.5 s each). Playback is a `BufferSource` through a gain node. Max 6 voices at once; extra calls are dropped.
- **Music:** two generative ambient beds (day, night), each two detuned oscillators through a low-pass filter playing a slow 8-note pentatonic sequence scheduled with `AudioContext.currentTime`. A third "tension" layer (pulse bass) fades in during raids and fights.
- Positional falloff: volume scales with distance to the camera centre (no panning node per sound; one stereo panner on the SFX bus).
- Audio starts on the first user click (browser autoplay policy). Volume sliders and mute in settings.

## B9. File layout

```
index.html              canvas + #ui root, loads src/main.js as a module
style.css               HUD and menu styles
README.md               how to run, test, and tune
src/
  main.js               boot, loop, perf overlay
  config.js             EVERY tunable number in this document, grouped by system
  rng.js                seeded PRNG + helpers (chance, range, pick)
  state.js              newGame(), save(), load(), migrate(), RLE helpers
  sim/
    time.js             clock, day rollover, weather roll
    plants.js           growth, moisture, pH, nutrients, light, stress, harvest, drying
    genetics.js         genome ops: seed variance, clone drift (M7), crossing + stability (M11)
    mastery.js          XP, levels, perks
    heat.js             sources, decay, tiers, raid roll and resolution
    economy.js          buyers, orders, trust, pricing, discovery, street sales, shops
    crew.js             candidates, wages, loyalty, delivery rolls
    threats.js          event director, thief roll, rival aggression + sabotage rolls
    addiction.js        use, dependence, withdrawal, compulsion, overdose, recovery
    allies.js           friendship, favors, gifts, calls, betrayal
    license.js          front, laundering, requirements, review, win/lose checks
  world/
    tiles.js            tile table, grid access, dig/place rules
    worldgen.js         builds the one world from templates
    physics.js          AABB vs tiles, raycast
    rooms.js            flood-fill room detection, visibility
    nav.js              BFS pathing on the lot
  entities/
    player.js           movement, tools, tending actions, interaction
    npc.js              all NPC state machines + movement
    combat.js           weapons table use, bullets pool, damage, noise
    spawn.js            entity cap, active/abstract switching
  render/
    renderer.js         camera, layers, chunk cache
    spritedata.js       pixel art as string arrays + palettes
    sprites.js          builds the atlas canvas at boot
    lighting.js         darkness layer
    particles.js        pool + emitters
  ui/
    input.js            keyboard/mouse state
    hud.js              heat meter, clock, cash, hp/stamina, hotbar, toasts
    menus.js            phone tabs, inventory, shops, dialogs, pause, title
  audio/
    audio.js            synth, sfx table, music
tests/
  plants.test.js  heat.test.js  economy.test.js  crew.test.js  threats.test.js
  addiction.test.js  allies.test.js  genetics.test.js  license.test.js  save.test.js
tools/
  balance.js            headless 45-day bot run, prints per-day table
```

Target size: about 6,000–7,000 lines total; no file over 600 lines.

---

# DELIVERABLE 3 — ASSET PLAN

**Everything is procedural and lives in source code. There are no binary asset files.** Reason: the build model writes text; text-defined art is reproducible, diffable and loads instantly.

## C1. Sprites
- **Format:** each sprite in `spritedata.js` is an array of strings, one character per pixel, plus a palette map (`{'.': null, 'g': '#3a7d2c', ...}`). `sprites.js` paints them into one **512×512 atlas canvas** at boot (under 50 ms) and records `{name: [x, y, w, h]}`.
- **Palette:** one shared 24-color palette. Variants (strains, NPC outfits) are palette swaps of the same pixel data, generated at boot.
- **Left-facing versions** are generated by mirroring at boot.

| Group | Size (px) | Count |
|---|---|---|
| Tiles (dirt, grass, stone, bedrock, wood, platform, concrete, ladder, road, town wall, background wall + 4 edge variants) | 16×16 | 16 |
| Player (idle, walk ×4, jump, tend, aim) | 16×24 | 8 frames |
| Human NPC base bodies ×3 (idle, walk ×4, aim, downed) × palette swaps for 5 buyers, 4 allies, 6 crew, thief, saboteur, goon, cop, clerk, Moss, pedestrians | 16×24 | 21 frames drawn, ~25 swaps generated |
| Dog (idle, run ×2, bite) | 16×12 | 4 frames |
| Plants: seedling, veg small, veg large, flowering, ripe, overripe, dead, male-flowering × 3 strain palettes (+1 generic palette for bred strains, tinted by potency) | 16×32 | 8 frames, 4 palettes |
| Objects: pot, 3 lamps, door, 3 locks, hatch, rack, safe, stash box, camera, floodlight, tripwire, tap, barrel, generator, filter, drip line, bed, shelf, cart, bicycle, farm stand, signs | 16×16 to 32×32 | 30 |
| Town building facades (stamped from tiles + 8 unique sign/window pieces) | 16×16 pieces | 8 |
| Item and status icons | 16×16 | 48 |
| Light sprites (radial gradients, generated with canvas gradients, not pixel data) | 32, 64, 128 px | 3 |
| Parallax hills (generated: 3 sine layers filled) | 1600×200 | 1 |

Particles are 1–2 px rectangles; no sprites.

**Optional later art pass (not part of this plan's scope):** because every draw call goes through `atlas[name]`, a hand-made or image-generated `atlas.png` with the same names can replace the procedural atlas without touching game code.

## C2. Sounds
Synthesized at boot (see §B8). Count: 24 SFX — footstep, jump, dig, place, pour, feed, snip, harvest, cash, door, lock pick, alarm, bark, bite, bat swing, bat hit, 3 gunshots, reload, hurt, phone buzz, siren, level-up. Music: 2 beds + 1 tension layer.

## C3. Text
All dialogue is short (1–2 lines) and data-driven from tables in `config.js` (`lines.buyer.orderPlaced`, etc.). About 150 lines total. No dialogue trees: interactions are menus with 2–4 choices.

---

# DELIVERABLE 4 — BUILD ORDER

Rules for the builder:
- Do milestones in order. Each ends in a playable build and passing tests.
- Put numbers in `config.js`, never inline.
- Every milestone ends with: `node --test tests/` green, and the F4 perf gate (§B2) passing on the target machine.
- v1 is complete at **Milestone 10**. Milestone 11 is breeding/Legacy.

### M0 — Skeleton and perf harness
**Files:** `index.html`, `style.css`, `README.md`, `src/main.js`, `src/config.js`, `src/rng.js`, `src/ui/input.js`, `src/render/renderer.js` (clear + test pattern), `tests/` (one trivial rng test).
**Done when:** the page shows an 800×450 canvas scaled to 1600×900 with crisp pixels; F3 shows fps and frame ms; 2,000 moving test rectangles hold 60 fps on the target machine; `node --test` runs; fixed-step loop with clamped dt is in place.

### M1 — World, movement, digging
**Files:** `src/world/tiles.js`, `worldgen.js`, `physics.js`; `src/entities/player.js`; `src/render/spritedata.js`, `sprites.js`, `renderer.js` (chunks, camera, sky, hills); `src/state.js` (newGame only).
**Done when:** you can walk, sprint and jump across the whole 400-tile world; dig and place dirt/wood/ladders inside the lot only; town and shack are visible; chunk redraw on edit works; F3 ≤ 8 ms average.

### M2 — Smallest playable loop: grow → harvest → sell → rebuy
**Files:** `src/sim/time.js`, `plants.js`, `genetics.js` (seed variance only), `economy.js` (Skeet with fixed price, hardware shop with seeds/pots/soil/nutrients/pH kit/meters/rack only); `src/ui/hud.js`, `menus.js` (shop, inventory, plant panel, harvest report card); `src/state.js` (save/load/autosave); `player.js` (tending actions, sleep); `renderer.js` (plants, objects, Alt overlay); `lighting.js` (flat night tint only); `tests/plants.test.js`, `tests/save.test.js`.
**Done when:** starting from $300 and 4 seeds you can grow Ditch Weed with moisture, pH and nutrients all mattering, harvest in the ripe window, dry it, sell to Skeet in the park, and buy more seeds; neglect measurably lowers the report card; sleeping skips the night; reload restores everything. Tests assert: an ideally tended Ditch Weed plant yields 38–41 g at quality 38–42 in 5 days; an unwatered one dies.

### M3 — Economy: buyers, orders, trust, town
**Files:** `economy.js` (all 5 buyers, orders, deadlines, trust, discovery, street sales, undercover, all shops' stock), `src/entities/npc.js` (pedestrians, buyers, schedules), `spawn.js`, `menus.js` (phone: orders, contacts, ledger), `hud.js` (order timers), `player.js` (bicycle, carry limits), `tools/balance.js` (first version), `tests/economy.test.js`.
**Done when:** orders arrive on schedule with countdowns; filling, partial, late and missed each change trust as specified; referrals and "ask around" reveal buyers; street sales work; shops keep hours; the balance bot prints a 45-day table and reaches at least $15,000 gross with no threats active.

### M4 — Heat, raids, hiding, lamps, weather
**Files:** `src/sim/heat.js`, `src/world/rooms.js`, `nav.js`, `npc.js` (cops: raid and patrol), `plants.js` (lamps, indoor light), `lighting.js` (darkness layer + lights), `time.js` (weather), `particles.js` (rain), `menus.js` (scanner view, bribe, lawyer, bail, arrest flow), `hud.js` (heat meter), `license.js` (arrest counter + Prison lose condition only), `tests/heat.test.js`.
**Done when:** every heat source in §A5 moves the meter (verified by the scanner's daily log); world tells appear by tier; raids roll at 05:00, cops path through the lot, find or miss hidden rooms by the stated odds, seize and fine correctly; underground lamp-lit growing works and is invisible; third arrest ends the game; rain waters outdoor plants.

### M5 — Combat, weapons, thieves, security, event director
**Files:** `src/entities/combat.js`, `npc.js` (thief, dog), `src/sim/threats.js` (director + thief roll), `player.js` (hp, stamina, weapons, crouch, downed), `particles.js` (muzzle, hit), `menus.js` (pawn shop, security items), `hud.js` (hp, ammo, alerts), `heat.js` (noise, bodies, shooting police, Fugitive), `tests/threats.test.js`.
**Done when:** thieves break in by the formula, pick locks for the stated times, steal and flee; dog, tripwire, camera and floodlight each work and wake a sleeping player; all six weapons work with ammo, reload, noise heat and body heat; KO vs. kill consequences (word-of-mouth bonus, blood feud) fire; shooting a cop shows the warning and applies the floor; killing one triggers Fugitive; director rules hold over a 30-night bot run (test).

### M6 — Crew and rival
**Files:** `src/sim/crew.js`, `threats.js` (rival aggression, three sabotage types, goon squads, leverage), `npc.js` (runner, guard, gardener, saboteur, goon), `menus.js` (hiring board, phone crew tab, ledger expected-vs-received, tribute/truce), `tests/crew.test.js`, `tests/threats.test.js` (extended).
**Done when:** you can hire up to 4; runners deliver orders and can be busted, late, robbed, skim and quit by the stated formulas; guard fights intruders; gardener tends with the 0.85 care cap; Dale's aggression moves as specified and each sabotage type works and has a working counter; goon squads appear at 70+.

### M7 — Mastery, clones, strains, audio
**Files:** `src/sim/mastery.js`, `genetics.js` (clone drift, generations), `plants.js` (apply level and perk effects), `menus.js` (journal, trait bars, level-up toast), `economy.js` (strain unlocks), `src/audio/audio.js`, `main.js` (event → sfx wiring), `tests/genetics.test.js`.
**Done when:** XP and levels follow the table and each perk works; clones copy and drift as specified, capped at +15; the journal shows the last 20 harvests; Blue Haze and Widow Kush unlock at the stated points; all 24 SFX and the music beds play, with volume controls.

### M8 — Addiction
**Files:** `src/sim/addiction.js`, `player.js` (buffs, fumbles, compulsion), `npc.js` (Moss), `menus.js` (dealer, clinic detox/taper, status panel), `hud.js` (buff/withdrawal icons, screen desaturation via a CSS filter on the canvas, toggled not animated), `crew.js` and `economy.js` (loyalty and price penalties), `tests/addiction.test.js`.
**Done when:** each substance gives its buff; dependence escalates through Casual/Hooked/Addicted with the stated timers; withdrawal slows tending and causes fumbles that visibly damage plants; compulsion and overdose work; all three recovery routes work; recovery cravings and relapse snapback work; third overdose ends the game.

### M9 — Friends and allies
**Files:** `src/sim/allies.js`, `npc.js` (ally combat, Rosa revive/heal), `menus.js` (gifts, favors, phone allies tab, hospital/bail choices, Benny's loan), `addiction.js` (sponsor), `tests/allies.test.js`.
**Done when:** favors and gifts raise friendship by the table; allies can be called and arrive in the stated time; each fights or heals per their stats; hurt, killed, arrested and estranged outcomes all occur and resolve as written; 4-heart allies auto-respond and cover absences.

### M10 — License, laundering, end states, polish = **v1 complete**
**Files:** `src/sim/license.js` (front, laundering, requirements, review, win, Washed-out lose), `economy.js` (dirty/clean balances everywhere), `menus.js` (town hall, title screen, 3 save slots, export/import, settings, difficulty, end screens, first-time tips), `main.js` (auto quality step-down), `tools/balance.js` (full policy incl. threats), `config.js` (tuning pass), `tests/license.test.js`.
**Done when:** the full run is playable from title screen to license win; all four lose conditions reachable; Legacy mode continues after the win; the balance bot's standard policy reaches the license between day 30 and day 50 in at least 6 of 10 seeds on Standard, and a "careless" policy (sells on the street, never hides) is raided before day 20; perf gate passes; a 30-minute soak shows no frame over 25 ms.

### M11 — Breeding and Legacy (post-v1 prestige)
**Files:** `genetics.js` (sex, pollen, crossing, stability, inbreeding), `plants.js` (males, accidental pollination, seed harvest), `economy.js` (named-strain bonus, hype, seed packs), `license.js` (Harvest Cup), `menus.js` (lineage view, naming, Cup entry), `spritedata.js` (male plant frame, bred palette), `tests/genetics.test.js` (extended).
**Done when:** a player at L6 can collect pollen, cross two strains, grow out seeds with correct variance, stabilize over generations, name the line, sell it at the bonus, and win the Cup with a 320+ stabilized strain.

---

# DELIVERABLE 5 — RISKS

### Risk 1 — Balance: ten interlocking systems, about 200 untested numbers
*Most likely failure:* the economy outruns heat (trivial win) or heat outruns the economy (unwinnable), or addiction/thieves snowball a mid-game loss.
*How the plan avoids it:*
- Every number is in `config.js`; nothing is inline.
- The simulation is pure and deterministic, so `tools/balance.js` can run hundreds of 45-day runs per minute; M10's "done" is defined as bot outcomes, not opinion.
- The event director bounds bad luck. Anti-softlock rules exist (Skeet never leaves, seed rescue, rolling autosaves).
- Difficulty is one multiplier, so a wrong default can be corrected without retuning.
- The bot cannot judge fun; M10 still needs a human playthrough, and the plan says so.

### Risk 2 — Scope: ten systems plus a sandbox is a lot for a cheaper build model
*Most likely failure:* a half-built system blocks the loop, or systems are tangled so a late one breaks an early one.
*How the plan avoids it:*
- The playable loop exists at M2; everything after is additive, one system per milestone, each with its own test file.
- Systems talk only through `state` and the event queue; no system calls another's internals.
- The cut list is explicit (§0, §A17). Breeding is outside v1. Each sim file is capped at about 600 lines.
- If time runs out, the order of sacrifice is: M9 allies → M8 addiction → rival goon squads. The game still wins and loses without them, because license logic (M10) depends only on M2–M5.

### Risk 3 — Performance on a 1.4 GHz 2-core with Haswell GT1
*Most likely failure:* full-screen compositing (the darkness layer), GC pauses from per-frame allocation, or DOM HUD thrash cause dropped frames.
*How the plan avoids it:*
- 800×450 internal resolution; cached tile chunks; a quarter-resolution darkness layer; hard caps on entities, bullets, particles and lights enforced at spawn.
- Object pools and no per-frame allocation; HUD updated at 4 Hz with dirty checks.
- The perf overlay exists from M0 and the F4 stress gate must pass at every milestone, so a regression is caught in the milestone that caused it.
- Automatic quality step-down (My Addition 12) as the last line of defense.
- Unverified until M0 runs on the machine: whether Chrome's Canvas 2D is GPU-accelerated on this Mesa driver. If `chrome://gpu` shows Canvas software-only, the fallback is the same design with the darkness layer replaced by a flat tint (already the step-down path) — no architectural change.

---

---

# DELIVERABLE 6 — MILESTONE 12: EDIBLES (post-license)

Added after v1. Decisions made with the owner: kitchen + cook timer, three products, sold at the dispensary AND to buyers, named strains carry a small bonus. Every number below goes in `config.js` under `edibles`.

### Unlock
Edibles unlock when the player holds the license (`state.license` granted — normal win or Legacy). Before that the kitchen is not sold and recipes are refused.

### Kitchen
- **Kitchen stove**, hardware store, **$1,500**, license required. Placeable object (inside the lot, indoors or out), one per lot. E opens the kitchen panel.
- One batch cooks at a time. The cook runs on game time (keeps cooking while asleep or away) and the finished batch waits in the stove until collected (E).

### Recipes (per batch)
| Product | Dry bud | Ingredients (paid at start) | Cook time | Units out | Base price / unit |
|---|---|---|---|---|---|
| Brownies | 7 g | $20 | 4 gh | 10 | $12 |
| Gummies | 5 g | $15 | 6 gh | 20 | $5 |
| Chocolate bars | 10 g | $30 | 3 gh | 8 | $18 |

- The player picks the recipe and which dry batch to use (dry bud only; wet is refused). Ingredients are paid cash-first then Bank, like other purchases.
- Edible **quality** = the bud batch's quality. Edibles are stored as batches: product, quality, units, strain name/lineId — batches of the same product + strain + quality merge.
- **Unit price** = base × (0.5 + quality / 100) × channel multiplier × named bonus.

### Selling
- **Dispensary (town hall, 9–17):** legal. Channel ×1.0, pays into the **Bank** (clean), **no heat**. Cap **40 units a day** across all products.
- **Buyers:** any revealed buyer at their spot, trust 2+, buys up to **10 units a day** each. Channel **×1.25**, paid in **cash (dirty)**, **+1 heat per sale** (heat source `edibleSale`, logged like the others). Undercover risk applies only to street pedestrians, and pedestrians do not buy edibles.
- **Named strain bonus:** edibles made from a named line carry the line name; +15% at the dispensary always, at buyers only at trust 3+ (same rule as named bud).

### Legal status
Edibles in the stove, inventory or stash are licensed stock: raids do not seize them and they add no visible/smell heat. Only buyer sales generate heat.

### UI
- Kitchen panel: recipe list with costs, dry-batch picker, Start, progress (time left), Collect.
- Inventory and the phone ledger show edible batches and edible sales. Town-hall dispensary rows gain "Sell edibles" (1 / 10). Buyer interaction gains "Sell edibles".
- Procedural sprites: stove (idle / cooking with a glow), one small icon per product for the hotbar/inventory.

### M12 — Edibles
**Files:** `src/sim/edibles.js` (new), `config.js` (`edibles`), `economy.js` (dispensary + buyer edible sales, named bonus), `heat.js` (`edibleSale` source), `player.js` (place stove, E on stove), `state.js` (save/load, migration for old saves), `menus.js` (kitchen panel, dispensary/buyer rows, inventory, ledger), `spritedata.js` (stove + icons), `tests/edibles.test.js`.
**Done when:** without a license the stove and recipes are refused; with one, each recipe consumes the stated bud + ingredients, cooks for the stated game hours (including while asleep), and yields the stated units at the bud's quality; prices follow the formula on both channels; the dispensary pays the Bank with no heat and respects the 40/day cap; buyers pay dirty cash, add +1 heat per sale, respect trust 2+ and 10/day; named-line edibles get the bonus; raids leave edibles alone; save/load round-trips a cook in progress; all v1/M11 tests still pass and the balance gate is unchanged.

---

*End of plan. v1 = Milestones 0–10. Prestige = Milestone 11. Edibles = Milestone 12.*
