// threats.js — event director, thieves, security alerts, blood feud, the dog's
// AI and the Fugitive end state (plan §A3, §A6, §A9; My Additions 3, 4, 7).
// Pure module: no window/document, runs unmodified in Node. M6 adds the rival
// (sabotage, goons) on top of the same director: Dale's aggression, the nightly
// 23:00 roll, the saboteur and goon entities, tribute and truce.
//
// Thieves are plain entities in state.entities (runtime only). They are
// stepped here at 2 Hz (with the sim), so the same code runs in the browser,
// the tests and the balance bot, and also during the 20x sleep: any alert
// (dog, tripwire, camera, floodlight) wakes the player the moment it fires;
// with no alert the theft happens and you read about it in the morning.
// Threats use their own PRNG stream (state.threats.rngState) so adding them
// did not reshuffle the draws of the older systems.

import { CONFIG } from '../config.js';
import { createRng } from '../rng.js';
import { stageOf } from './plants.js';
import { hs, wakeUp, heatEvent } from './heat.js';
import { pricePerGram, BUYER_KEYS, buyerLevel, nowGh as nowGhEco } from './economy.js';
import { nightKey } from './time.js';
import { roomOf, isBuried } from '../world/rooms.js';
import { raycastSolid } from '../world/physics.js';
import { damageEntity, enemyShoot, hurtPlayer, stepCops, groundY, HOSTILE_KINDS } from '../entities/combat.js';
import { dogHomeX } from '../entities/dog.js';

const TH = CONFIG.threats;
const BI = TH.breakIn;
const T = TH.thief;
const DG = TH.dog;
const RV = TH.rival;
const TS = CONFIG.world.tile;
const nowGh = (s) => s.time.day * 24 + s.time.hour;
export const crossed = (prev, cur, at) => (prev - cur > 12 ? at > prev || at <= cur : prev < at && at <= cur);

export function initThreats(seed = 1) {
  return {
    rngState: ((seed ^ 0x7f4a7c15) >>> 0),
    hostile: {},            // night key -> kind of the hostile event that night
    history: [],            // [{night, kind}] (for tests and the journal)
    feud: [],               // [{night, kind: 'feud' | 'biker'}]
    wordUntil: 0,           // night key until which "the word is out"
    selloutUntil: 0,        // night key until which a quitter's tip-off raises break-ins (M6)
    lock: null,             // 'padlock' | 'deadbolt' | 'steeldoor' on the shack door
    dog: null,              // see entities/dog.js
    footage: 0,             // recorded intruders (leverage, M6)
    rival: initRival(seed), // Dale Pruitt (M6)
    news: [],               // morning-after lines
    downed: false,
    lastHour: null,
    incident: { shots: 0, heat: 0, loud: 0, lastGh: -99, dispatched: false },
    dispatch: null,
    stats: { breakIns: 0, kos: 0, kills: 0, stolenGrams: 0, uprooted: 0 },
  };
}

export function initRival(seed = 1) {
  return {
    aggression: RV.start, rngState: ((seed ^ 0x5bd1e995) >>> 0), // its own stream: thieves keep their draws
    trust3: [], absorbed: 0, frozenUntil: 0, backOffUntil: 0, squadsBeaten: 0,
    leverage: false, tributeAt: -1e9, poison: null,
  };
}

export const tt = (state) => {
  const t = state.threats || (state.threats = initThreats(state.seed));
  if (!t.rival) t.rival = initRival(state.seed); // saves from before M6
  return t;
};
export const rv = (state) => tt(state).rival;

function rivalRng(state, fn) {
  const r = rv(state);
  const rng = createRng(r.rngState);
  const out = fn(rng);
  r.rngState = rng.state;
  return out;
}

function rngOf(state, fn) {
  const t = tt(state);
  const rng = createRng(t.rngState);
  const out = fn(rng);
  t.rngState = rng.state;
  return out;
}

// ------------------------------------------------------------ director ---

/** May a hostile night event of this kind happen tonight? (plan §A3) */
export function directorAllows(state, kind, { ignoreQuiet = false } = {}) {
  const k = nightKey(state.time);
  const t = tt(state);
  const min = TH.director.minNight[kind === 'feud' || kind === 'biker' ? 'thief' : kind];
  if (min !== undefined && k < min) return false;
  if (t.hostile[k]) return false;                       // one per night
  if (!ignoreQuiet && t.hostile[k - 1]) return false;   // the night after is quiet
  return true;
}

/** Record tonight's hostile event. */
export function directorClaim(state, kind) {
  const t = tt(state);
  const k = nightKey(state.time);
  t.hostile[k] = kind;
  t.history.push({ night: k, kind });
  for (const key of Object.keys(t.hostile)) if (Number(key) < k - TH.director.keep) delete t.hostile[key];
}

// ----------------------------------------------------------- break-in ----

const shackDoorX = () => {
  const b = CONFIG.world.buildings.find((x) => x.key === 'shack');
  return (b.x + b.w - 1 + T.doorOffsetTiles) * TS + TS / 2;
};

const securityOf = (state) => {
  const objs = state.objects;
  const c = BI.cut;
  const t = tt(state);
  const lights = Math.min(c.floodlightMax, objs.filter((o) => o.kind === 'floodlight').length);
  const parts = {
    lock: t.lock ? c.lock : 0,
    floodlight: lights * c.floodlight,
    camera: objs.some((o) => o.kind === 'camera') ? c.camera : 0,
    dog: t.dog ? c.dog : 0,
    guard: state.crew && state.crew.guard ? c.guard : 0, // M6 sets state.crew.guard
  };
  return { ...parts, total: parts.lock + parts.floodlight + parts.camera + parts.dog + parts.guard };
};

/** The break-in roll's chance in percent, itemized (plan §A6). */
export function breakInChance(state) {
  const value = state.product.reduce((n, b) => n + pricePerGram(b) * b.grams, 0);
  const ripe = state.plants.filter((p) => ['flowering', 'ripe'].includes(stageOf(p))).length;
  const now = nowGh(state);
  const street = state.economy.streetSales.filter((g) => now - g <= BI.streetSaleDays * 24).length;
  const gen = state.objects.some((o) => o.kind === 'generator');
  const sec = securityOf(state);
  const word = nightKey(state.time) <= tt(state).wordUntil ? CONFIG.threats.wordOfMouth.cut : 0;
  const sellout = nightKey(state.time) <= tt(state).selloutUntil ? CONFIG.crew.quit.breakIn : 0;
  const parts = {
    product: value / BI.valuePerPct, ripe: ripe * BI.perRipePlant, street: street * BI.perStreetSale,
    generator: gen ? BI.generator : 0, security: sec.total, word, sellout,
  };
  const raw = parts.product + parts.ripe + parts.street + parts.generator + parts.sellout - parts.security - parts.word;
  return { ...parts, raw, total: Math.max(BI.min, Math.min(BI.max, raw)) };
}

/** 01:00 each night: feud first, then the ordinary break-in roll. */
export function rollNight(state) {
  const t = tt(state);
  const k = nightKey(state.time);
  const due = t.feud.find((f) => f.night <= k);
  if (due && directorAllows(state, due.kind, { ignoreQuiet: true })) {
    t.feud.splice(t.feud.indexOf(due), 1);
    directorClaim(state, due.kind);
    spawnThieves(state, due.kind === 'biker'
      ? { count: 1, armed: true, biker: true }
      : { count: TH.feud.thieves, armed: true, feud: true });
    state.events.push({ type: 'hostile', kind: due.kind, night: k });
    return due.kind;
  }
  if (!directorAllows(state, 'thief')) return null;
  const chance = breakInChance(state).total;
  if (!rngOf(state, (rng) => rng.next() * 100 < chance)) return null;
  directorClaim(state, 'thief');
  spawnThieves(state, {});
  state.events.push({ type: 'hostile', kind: 'thief', night: k });
  return 'thief';
}

/** Put thieves in the woods. opts: count, armed, feud, biker. */
export function spawnThieves(state, opts = {}) {
  const t = tt(state);
  const day = state.time.day;
  const E = state.entities || (state.entities = []);
  const count = opts.count || (day >= T.twoDay && rngOf(state, (r) => r.chance(T.twoChance)) ? 2 : 1);
  t.stats.breakIns++;
  const out = [];
  for (let i = 0; i < count; i++) {
    const armed = opts.armed || (day >= T.pistolDay && rngOf(state, (r) => r.chance(T.pistolChance)));
    const x = rngOf(state, (r) => r.range(T.spawnX0, T.spawnX1)) * TS;
    const e = {
      id: state.nextId++, kind: 'thief', x, y: groundY(state, x), hp: opts.biker ? TH.biker.hp : T.hp,
      state: 'approach', armed, feud: !!opts.feud, biker: !!opts.biker, dir: 1,
      cd: 0, alerts: {}, loot: null, haulMult: 1, lockLeft: null, grabLeft: 0, wasBitten: false,
    };
    E.push(e);
    out.push(e);
  }
  return out;
}

/** What a thief can find: open rooms always, hidden rooms 25%, buried stashes never. */
export function thiefTargets(state) {
  return rngOf(state, (rng) => {
    const cache = new Map();
    const found = (x, y) => {
      const r = roomOf(state, x, y);
      if (r.open) return true;
      if (!cache.has(r.id)) cache.set(r.id, rng.chance(T.hatchFind));
      return cache.get(r.id);
    };
    const batches = [];
    for (const o of state.objects) {
      if (o.kind === 'rack' || (o.kind === 'stash' && !isBuried(state, o.x, o.y))) {
        const mine = state.product.filter((b) => b.where === o.id && b.grams > 0);
        if (mine.length && found(o.x, o.y)) batches.push(...mine);
      }
    }
    const plants = [];
    for (const p of state.plants) {
      const pot = state.objects.find((o) => o.id === p.potId);
      if (!p.dead && pot && found(pot.x, pot.y)) plants.push(p);
    }
    plants.sort((a, b) => b.progress - a.progress); // the ripest first
    return { batches, plants };
  });
}

// ------------------------------------------------------------- alerts ----

function alert(state, e, kind, id, msg) {
  const key = `${kind}${id}`;
  if (e.alerts[key]) return;
  e.alerts[key] = true;
  state.events.push({ type: 'alert', kind, msg, x: e.x, y: e.y });
  wakeUp(state);
}

/** Dog, tripwire, camera and floodlight react to one intruder (plan §A6, My Addition 7). */
function checkSecurity(state, e, prevX) {
  const tx = e.x / TS;
  const ptx = prevX / TS;
  const t = tt(state);
  for (const o of state.objects) {
    if (o.kind === 'tripwire') {
      const cx = o.x + 0.5;
      if ((ptx - cx) * (tx - cx) <= 0 && Math.abs(tx - cx) < 2) alert(state, e, 'tripwire', o.id, 'The tripwire alarm rings!');
    } else if (o.kind === 'floodlight') {
      if (Math.abs(tx - o.x) <= TH.floodlight.radiusTiles) { e.lit = true; alert(state, e, 'floodlight', o.id, 'A floodlight snaps on outside.'); }
    } else if (o.kind === 'camera') {
      const dx = (tx - o.x) * (o.dir || -1);
      if (dx >= -0.5 && dx <= TH.camera.coneTiles) {
        o.footage = (o.footage || 0) + (e.alerts[`camera${o.id}`] ? 0 : 1);
        if (!e.alerts[`camera${o.id}`]) t.footage++;
        if (e.kind === 'saboteur' || e.kind === 'goon') t.rival.leverage = true; // Dale's men on tape
        alert(state, e, 'camera', o.id, `Camera alert: someone is at x ${Math.round(tx)}.`);
      }
    }
  }
  const dog = t.dog;
  if (dog && dog.hp > 0 && Math.abs(dog.x / TS - tx) <= DG.barkTiles) alert(state, e, 'dog', '', 'Your dog is barking!');
}

// ------------------------------------------------------------ thieves ----

const stepToward = (e, tx, dt, speed) => {
  const d = tx - e.x;
  const step = Math.min(Math.abs(d), speed * dt);
  e.x += Math.sign(d) * step;
  if (d) e.dir = Math.sign(d);
  return Math.abs(tx - e.x) < 0.5;
};

const lockSeconds = (state) => T.lockSeconds[tt(state).lock || 'none'];

function steal(state, e) {
  const found = {
    batches: e.plan.batches.filter((b) => state.product.includes(b)),
    plants: e.plan.plants.filter((p) => state.plants.includes(p)),
  };
  const loot = { batches: [], plants: [] };
  const cap = T.haulGrams * e.haulMult;
  if (found.batches.length) {
    let left = cap;
    for (const b of found.batches.sort((a, c) => c.quality - a.quality)) {
      if (left <= 0) break;
      const take = Math.min(left, b.grams);
      left -= take;
      b.grams -= take;
      loot.batches.push({ ...b, id: state.nextId++, grams: take });
      if (b.grams <= 0) state.product.splice(state.product.indexOf(b), 1);
    }
  } else {
    for (const plant of found.plants.slice(0, T.uprootCount * e.haulMult)) {
      const pot = state.objects.find((o) => o.id === plant.potId);
      if (pot) pot.plantId = null;
      state.plants.splice(state.plants.indexOf(plant), 1);
      loot.plants.push({ plant, potId: plant.potId });
    }
  }
  e.loot = loot;
}

const lootGrams = (l) => (l ? l.batches.reduce((n, b) => n + b.grams, 0) : 0);

function think(state, e, dt) {
  const p = state.player;
  const prevX = e.x;
  e.cd -= dt;
  e.y = groundY(state, e.x);
  if (e.state === 'ko') { e.koT -= dt; if (e.koT <= 0) e.gone = true; return; }
  // Reactions to being attacked: flee below half hp or when a shot landed
  // nearby; otherwise stand and fight (a stand-in for the Nerve roll).
  if (e.state !== 'flee' && (e.scared || e.hp < T.hp * T.fleeHpFrac)) { e.state = 'flee'; e.scared = false; }
  if (e.attacked && e.state !== 'flee' && e.state !== 'fight' && !p.downed) { e.back = e.state; e.state = 'fight'; }
  e.attacked = false;
  if (e.biker && e.state === 'approach') e.state = 'fight';
  switch (e.state) {
    case 'approach': {
      if (stepToward(e, shackDoorX(), dt, T.speed)) {
        e.lockLeft = lockSeconds(state);
        e.state = e.lockLeft > 0 ? 'pickLock' : 'search';
      }
      break;
    }
    case 'pickLock': {
      e.lockLeft -= dt;
      if (e.lockLeft <= 0) { e.state = 'search'; }
      break;
    }
    case 'search': {
      e.plan = thiefTargets(state);
      const n = Math.min(e.plan.plants.length, T.uprootCount * e.haulMult);
      e.grabLeft = e.plan.batches.length ? T.grabSeconds : n * T.uprootSeconds;
      e.state = e.grabLeft > 0 ? 'grab' : 'flee';
      break;
    }
    case 'grab': {
      e.grabLeft -= dt;
      if (e.grabLeft <= 0) { steal(state, e); e.state = 'flee'; }
      break;
    }
    case 'flee': {
      if (stepToward(e, T.escapeX * TS, dt, T.speed)) finishEscape(state, e);
      break;
    }
    case 'fight': {
      if (p.downed) { e.state = e.back || 'flee'; break; }
      const px = p.x + p.w / 2;
      const d = Math.abs(px - e.x);
      if (e.armed && d <= T.pistolRangeTiles * TS && hasLos(state, e, p)) {
        if (e.cd <= 0) { e.cd = 1 / T.pistolRate; enemyShoot(state, { x: e.x, y: e.y }, T.pistolDmg, T.pistolAcc, 'thief'); }
      } else if (d > T.knifeReach) {
        stepToward(e, px, dt, T.speed);
      } else if (e.cd <= 0) {
        e.cd = 1 / T.knifeRate;
        hurtPlayer(state, T.knife, 'thief');
      }
      break;
    }
    default: break;
  }
  e.y = groundY(state, e.x);
  if (e.x !== prevX && e.state !== 'ko') checkSecurity(state, e, prevX);
  else if (e.state === 'pickLock') checkSecurity(state, e, e.x);
}

function hasLos(state, e, p) {
  return !raycastSolid(state.tiles, e.x, e.y - 12, p.x + p.w / 2, p.y + 6, 2000);
}

function finishEscape(state, e) {
  e.gone = true;
  const t = tt(state);
  const g = lootGrams(e.loot);
  const n = e.loot ? e.loot.plants.length : 0;
  if (!e.loot) return;
  t.stats.stolenGrams += g;
  t.stats.uprooted += n;
  const line = n ? `A thief uprooted ${n} plant(s) and got away.` : `A thief got away with ${Math.round(g)} g of product.`;
  state.events.push({ type: 'theft', grams: g, plants: n });
  if (state.sleeping) t.news.push(line);
  else state.events.push({ type: 'notice', title: 'Break-in', lines: [line] });
}

// ----------------------------------------------------------------- dog ----

function stepDog(state, dt) {
  const t = tt(state);
  const dog = t.dog;
  if (!dog) return;
  const E = state.entities || [];
  if (dog.hp <= 0) { dog.state = 'hurt'; return; }
  const prey = E.filter((e) => HOSTILE_KINDS.includes(e.kind) && e.state !== 'ko' && e.state !== 'dead')
    .sort((a, b) => Math.abs(a.x - dog.x) - Math.abs(b.x - dog.x))[0];
  if (prey && Math.abs(prey.x - dog.x) <= DG.barkTiles * TS) {
    dog.state = 'attack';
    const d = prey.x - dog.x;
    if (Math.abs(d) > DG.biteReach) dog.x += Math.sign(d) * Math.min(Math.abs(d), DG.speed * dt);
    else {
      damageEntity(state, prey, DG.bite * dt, 'dog');
      if (!prey.wasBitten) {
        prey.wasBitten = true;
        if (rngOf(state, (r) => r.chance(T.fleeBitten))) prey.scared = true;
      }
      if (prey.armed || prey.state === 'fight') { dog.hp -= T.knife * dt; if (dog.hp <= 0) { dog.hp = 0; state.events.push({ type: 'toast', msg: 'Your dog is hurt. The vet can fix him.' }); } }
    }
  } else {
    const home = dogHomeX();
    dog.state = 'idle';
    dog.x += Math.sign(home - dog.x) * Math.min(Math.abs(home - dog.x), DG.speed * dt);
  }
}

/** Dawn: dog food ($10/day); unfed for 2 days it runs away. */
function dogDaily(state) {
  const dog = tt(state).dog;
  if (!dog) return;
  if (state.player.cash >= DG.food) { state.player.cash -= DG.food; dog.hungry = 0; }
  else dog.hungry++;
  if (dog.hungry >= DG.hungryDays) {
    tt(state).dog = null;
    state.events.push({ type: 'toast', msg: 'Your dog ran away. Nobody fed him.' });
  }
}

// ---------------------------------------------------------------- misc ---

/** Install the best lock in the inventory on the shack door (plan §A6). */
export function installLock(state) {
  const t = tt(state);
  const inv = state.player.inv;
  const have = TH.locks.filter((k) => inv[k] > 0);
  if (!have.length) return { ok: false, msg: 'You have no lock to fit.' };
  const best = have[have.length - 1];
  if (t.lock && TH.locks.indexOf(t.lock) >= TH.locks.indexOf(best)) return { ok: false, msg: 'The door already has a better lock.' };
  inv[best]--;
  t.lock = best;
  return { ok: true, msg: `Fitted a ${CONFIG.itemNames[best].toLowerCase()}.` };
}

/** Cameras (max 4) must be within 10 tiles of the shack or a generator. */
export function canPlaceCamera(state, cx, cy) {
  if (state.objects.filter((o) => o.kind === 'camera').length >= TH.camera.max) return false;
  const b = CONFIG.world.buildings.find((x) => x.key === 'shack');
  const near = (x, y) => Math.hypot(cx - x, cy - y) <= TH.camera.shackTiles;
  return near(b.x + b.w / 2, cy) || state.objects.some((o) => o.kind === 'generator' && near(o.x, o.y));
}

/** Refuse Big Tone's collection fee: a biker comes for you after dark (plan §A7 / M5). */
export function refuseFee(state) {
  const eco = state.economy;
  if (!eco.fees.length) return { ok: false, msg: 'Nobody is collecting.' };
  eco.fees.shift();
  tt(state).feud.push({ night: nightKey(state.time) + TH.biker.nights, kind: 'biker' });
  return { ok: true, msg: 'You told the biker where to go. He will be back.' };
}

function stepDispatch(state) {
  const t = tt(state);
  if (t.dispatch && nowGh(state) >= t.dispatch.at) {
    const D = CONFIG.combat.dispatch;
    const x = (CONFIG.world.zones.lotX1 - D.offsetTiles) * TS;
    for (let i = 0; i < D.cops; i++) {
      state.cops.push({ x: x + i * 12, dir: 0, coolUntil: 0, responder: true, until: nowGh(state) + D.stayGh });
    }
    t.dispatch = null;
    state.events.push({ type: 'toast', msg: 'A patrol car pulls up at the road.' });
  }
  state.cops = state.cops.filter((c) => !c.responder || nowGh(state) < c.until);
}

// =========================================================== M6: rival ====
// Dale Pruitt (plan §A6): an aggression value, one 23:00 roll a night, three
// sabotage types, goon squads from 70, tribute and truce. All of it goes
// through the director, and Dale himself is never on screen.

const pctOf = (state) => Math.min(RV.maxChance, rv(state).aggression * RV.chancePerPoint) / 100;
export const rivalChance = pctOf;

/** Move Dale's aggression. Gains are ignored while a truce holds. */
export function rivalBump(state, n) {
  const r = rv(state);
  if (n > 0 && nowGhEco(state) < r.frozenUntil) return;
  r.aggression = Math.max(0, Math.min(RV.max, r.aggression + n));
}

/** Weekly tribute ($300 by phone): aggression -10. */
export function payTribute(state) {
  const r = rv(state);
  const now = nowGhEco(state);
  if (now < r.tributeAt + RV.tribute.everyDays * 24) return { ok: false, msg: 'Dale was paid this week already.' };
  if (state.player.cash < RV.tribute.cost) return { ok: false, msg: 'Not enough cash.' };
  state.player.cash -= RV.tribute.cost;
  r.tributeAt = now;
  rivalBump(state, -RV.tribute.drop);
  return { ok: true, msg: `Sent Dale $${RV.tribute.cost}. He will keep his dogs on a leash for a while.` };
}

/** Truce at the bar (aggression 60+, $2,000): aggression 10, frozen 10 days. */
export function buyTruce(state) {
  const r = rv(state);
  const X = RV.truce;
  if (r.aggression < X.minAggression) return { ok: false, msg: 'Nobody is offering a truce. Dale is not angry enough to deal.' };
  if (state.player.cash < X.cost) return { ok: false, msg: 'Not enough cash.' };
  state.player.cash -= X.cost;
  r.aggression = X.setTo;
  r.frozenUntil = nowGhEco(state) + X.frozenDays * 24;
  return { ok: true, msg: 'The bartender carries your envelope up the ridge. Dale agrees to a truce.' };
}

/** Rival gains that other systems record: buyers at trust 3, taken buyers. */
function stepRival(state) {
  const r = rv(state);
  for (const key of BUYER_KEYS) {
    if (!r.trust3.includes(key) && buyerLevel(state, key) >= 3) { r.trust3.push(key); rivalBump(state, RV.trust3Bump); }
  }
  const d = state.economy.daleAggression - r.absorbed;
  r.absorbed = state.economy.daleAggression;
  if (d > 0) rivalBump(state, d);
}

/** Open-room pots Dale's men can find (hidden rooms 25% each, like thieves). */
function rivalPots(state, rng) {
  const cache = new Map();
  const found = (x, y) => {
    const room = roomOf(state, x, y);
    if (room.open) return true;
    if (!cache.has(room.id)) cache.set(room.id, rng.chance(T.hatchFind));
    return cache.get(room.id);
  };
  return state.objects.filter((o) => o.kind === 'pot' && found(o.x, o.y));
}

const spawnX = (rng) => rng.range(T.spawnX0, T.spawnX1) * TS;

/** Put Dale's saboteur in the woods. job: 'poison' | 'pest'. */
export function spawnSaboteur(state, job, { source = 'tap', plantId = null } = {}) {
  const x = rivalRng(state, (r) => spawnX(r));
  const e = {
    id: state.nextId++, kind: 'saboteur', x, y: groundY(state, x), hp: RV.saboteur.hp, state: 'approach',
    job, source, plantId, workLeft: 0, alerts: {}, dir: 1,
  };
  (state.entities || (state.entities = [])).push(e);
  return e;
}

/** A goon squad (hp 80, pistol) with the pots they will smash. */
export function spawnGoons(state) {
  const G = RV.goon;
  const { xs, pots } = rivalRng(state, (r) => {
    const found = rivalPots(state, r);
    return { xs: Array.from({ length: G.count }, () => spawnX(r)), pots: found };
  });
  const squad = { size: G.count, down: 0, smashed: 0, beaten: false, queue: pots.map((o) => o.id) };
  const out = xs.map((x) => ({
    id: state.nextId++, kind: 'goon', x, y: groundY(state, x), hp: G.hp, state: 'seek', armed: true,
    squad, cd: 0, alerts: {}, dir: 1, potId: null, workLeft: 0,
  }));
  (state.entities || (state.entities = [])).push(...out);
  return out;
}

/** 23:00: Dale's roll. Returns what he sent ('poison' | 'tip' | 'pest' | 'goons') or null. */
export function rollRival(state) {
  const r = rv(state);
  const d = rivalRng(state, (rng) => ({ roll: rng.next(), type: rng.next(), goon: rng.next(), src: rng.next(), pick: rng.next() }));
  const now = nowGhEco(state);
  if (now < r.frozenUntil || now < r.backOffUntil) return null;
  if (d.roll >= pctOf(state) || !directorAllows(state, 'rival')) return null;
  const k = nightKey(state.time);
  if (r.aggression >= RV.goon.from && d.goon < RV.goon.chance) {
    directorClaim(state, 'rival');
    spawnGoons(state);
    state.events.push({ type: 'hostile', kind: 'rival', night: k });
    return 'goons';
  }
  if (d.type < RV.mix.poison) {
    directorClaim(state, 'rival');
    spawnSaboteur(state, 'poison', { source: d.src < 0.5 ? 'tap' : 'barrel' });
    state.events.push({ type: 'hostile', kind: 'rival', night: k });
    return 'poison';
  }
  if (d.type < RV.mix.poison + RV.mix.tip) {
    if (r.leverage) {
      state.events.push({ type: 'toast', msg: 'The tip-off from Dale never came. He knows you have him on camera.' });
      return null;
    }
    directorClaim(state, 'rival');
    const hh = hs(state);
    const bribed = state.time.day <= hh.lastBribeDay + CONFIG.heat.raid.tipWindowDays;
    heatEvent(state, bribed ? 'rivalTipBribed' : 'rivalTip');
    return 'tip';
  }
  const plants = rivalRng(state, (rng) => {
    const pots = new Set(rivalPots(state, rng).map((o) => o.id));
    return state.plants.filter((p) => !p.dead && pots.has(p.potId));
  });
  if (!plants.length) return null;
  directorClaim(state, 'rival');
  spawnSaboteur(state, 'pest', { plantId: plants[Math.floor(d.pick * plants.length)].id });
  state.events.push({ type: 'hostile', kind: 'rival', night: k });
  return 'pest';
}

/** Is the rain barrel/tap water Dale poisoned? Looks cloudy; a pH meter flags it. */
export const waterPoisoned = (state, source) => !!(rv(state).poison && rv(state).poison.source === source);

/** Dump the poisoned water and refill (plan §A6 counter). */
export function purgeWater(state) {
  const r = rv(state);
  if (!r.poison) return false;
  if (r.poison.source === 'barrel') { const b = state.objects.find((o) => o.kind === 'barrel'); if (b) b.charges = 0; }
  r.poison = null;
  return true;
}

/** Fit a barrel lock ($40): the saboteur needs 20 s more at the water. */
export function installBarrelLock(state) {
  const barrel = state.objects.find((o) => o.kind === 'barrel');
  if (!barrel || barrel.locked) return { ok: false, msg: 'The barrel is already locked.' };
  if (!(state.player.inv.barrel_lock > 0)) return { ok: false, msg: 'You have no barrel lock.' };
  state.player.inv.barrel_lock--;
  barrel.locked = true;
  return { ok: true, msg: 'Locked the barrel and tap.' };
}

const activeGuard = (state) => state.crew && state.crew.members.find((m) => m.role === 'guard' && m.status === 'active');
const say = (state, line) => (state.sleeping ? tt(state).news.push(line) : state.events.push({ type: 'toast', msg: line }));

function thinkSaboteur(state, e, dt) {
  const S = RV.saboteur;
  const p = state.player;
  e.y = groundY(state, e.x);
  if (e.state === 'ko') { e.koT -= dt; if (e.koT <= 0) e.gone = true; return; }
  const prevX = e.x;
  const seen = e.scared || e.hp < S.hp ||
    (!state.sleeping && !p.downed && Math.abs(p.x + p.w / 2 - e.x) <= S.seenTiles * TS && hasLos(state, e, p));
  if (e.state !== 'flee' && seen) { e.state = 'flee'; e.scared = false; } // flees when seen: the job is off
  if (e.state === 'approach') {
    let goal = null;
    if (e.job === 'poison') {
      const o = state.objects.find((x) => x.kind === e.source);
      goal = o ? o.x * TS + TS / 2 : null;
    } else {
      const pl = state.plants.find((x) => x.id === e.plantId);
      const pot = pl && state.objects.find((o) => o.id === pl.potId);
      goal = pot ? pot.x * TS + TS / 2 : null;
    }
    if (goal === null) e.state = 'flee';
    else if (stepToward(e, goal, dt, S.speed)) {
      const barrel = state.objects.find((o) => o.kind === 'barrel');
      e.workLeft = e.job === 'poison' ? S.poisonSeconds + (barrel && barrel.locked ? S.barrelLockSeconds : 0) : S.pestSeconds;
      e.state = 'work';
    }
  } else if (e.state === 'work') {
    e.workLeft -= dt;
    if (e.workLeft <= 0) {
      if (e.job === 'poison') rv(state).poison = { source: e.source, pours: RV.poison.pours };
      else {
        const pl = state.plants.find((x) => x.id === e.plantId);
        if (pl && !pl.dead) { pl.infested = true; pl.infestGh = 0; }
      }
      e.state = 'flee';
    }
  } else if (e.state === 'flee') {
    if (stepToward(e, T.escapeX * TS, dt, S.speed)) e.gone = true;
  }
  if (e.state !== 'ko') {
    if (e.x !== prevX) checkSecurity(state, e, prevX);
    else if (e.state === 'work') checkSecurity(state, e, e.x);
  }
}

function thinkGoon(state, e, dt) {
  const G = RV.goon;
  const p = state.player;
  e.y = groundY(state, e.x);
  if (e.state === 'ko') { e.koT -= dt; if (e.koT <= 0) e.gone = true; return; }
  e.cd -= dt;
  e.attacked = false;
  const prevX = e.x;
  const px = p.x + p.w / 2;
  const guard = activeGuard(state);
  let tgt = null;
  if (!p.downed && Math.abs(px - e.x) <= G.rangeTiles * TS && hasLos(state, e, p)) tgt = 'player';
  if (guard && Math.abs(guard.x - e.x) <= G.rangeTiles * TS && (!tgt || Math.abs(guard.x - e.x) < Math.abs(px - e.x))) tgt = 'guard';
  if (tgt) { // stand and fight
    if (e.cd <= 0) {
      e.cd = 1 / G.rate;
      if (tgt === 'player') enemyShoot(state, { x: e.x, y: e.y }, G.dmg, G.acc, 'goon');
      else if (rivalRng(state, (r) => r.chance(G.acc))) guard.hp -= G.dmg;
    }
    e.dir = Math.sign((tgt === 'player' ? px : guard.x) - e.x) || e.dir;
  } else if (e.state === 'seek') {
    if (e.potId === null) {
      e.potId = e.squad.smashed >= G.maxPots ? 0 : (e.squad.queue.shift() || 0);
      if (!e.potId) e.state = 'flee';
    }
    if (e.state === 'seek') {
      const pot = state.objects.find((o) => o.id === e.potId);
      if (!pot) e.potId = null;
      else if (stepToward(e, pot.x * TS + TS / 2, dt, G.speed)) { e.state = 'smash'; e.workLeft = G.smashSeconds; }
    }
  } else if (e.state === 'smash') {
    e.workLeft -= dt;
    if (e.workLeft <= 0) {
      const i = state.objects.findIndex((o) => o.id === e.potId);
      if (i >= 0) {
        const pot = state.objects[i];
        const pl = state.plants.find((x) => x.id === pot.plantId);
        if (pl) state.plants.splice(state.plants.indexOf(pl), 1);
        state.objects.splice(i, 1);
        e.squad.smashed++;
        say(state, 'Dale\'s goons are smashing your pots!');
      }
      e.potId = null;
      e.state = 'seek';
    }
  } else if (e.state === 'flee') {
    if (stepToward(e, T.escapeX * TS, dt, G.speed)) e.gone = true;
  }
  if (e.state !== 'ko' && e.x !== prevX) checkSecurity(state, e, prevX);
}

/** Dale's men that went down count: -20 for a saboteur, -20 for a squad; 3 squads and he backs off. */
function countBeaten(state, e) {
  if (e.state !== 'ko' && e.state !== 'dead') return;
  if (e.kind === 'saboteur' && !e.counted) {
    e.counted = true;
    rivalBump(state, RV.beatSaboteur);
    say(state, 'You caught Dale\'s saboteur. He will think twice.');
  } else if (e.kind === 'goon' && !e.counted) {
    e.counted = true;
    const sq = e.squad;
    if (++sq.down >= sq.size && !sq.beaten) {
      sq.beaten = true;
      const r = rv(state);
      rivalBump(state, RV.beatGoons);
      if (++r.squadsBeaten >= RV.goon.backOffSquads) {
        r.squadsBeaten = 0;
        r.backOffUntil = nowGhEco(state) + RV.goon.backOffDays * 24;
        say(state, 'Three squads beaten. Dale backs off for a while.');
      } else say(state, 'Dale\'s goons are beaten.');
    }
  }
}

/** The 2 Hz threat step (plan §B3: after crew, before addiction). */
export function stepThreats(state, dt) {
  const t = tt(state);
  const cur = state.time.hour;
  const prev = t.lastHour === null ? cur : t.lastHour;
  t.lastHour = cur;
  if (crossed(prev, cur, BI.rollHour)) rollNight(state);
  if (crossed(prev, cur, RV.rollHour)) rollRival(state);
  if (crossed(prev, cur, CONFIG.clock.wakeHour)) {
    dogDaily(state);
    if (state.time.day > RV.dailyAfterDay) rivalBump(state, 1);
    const h = hs(state);
    if (h.officerKilled && !state.gameOver) {
      state.gameOver = { reason: 'fugitive' };
      state.events.push({ type: 'notice', title: 'SWAT raid', lines: ['At dawn the SWAT team hits the lot. You are a cop killer and there is nowhere left to run.'] });
      state.events.push({ type: 'gameOver', reason: 'fugitive' });
    }
  }
  const E = state.entities || (state.entities = []);
  stepRival(state);
  for (const e of E) {
    if (e.kind === 'thief') think(state, e, dt);
    else if (e.kind === 'saboteur') { thinkSaboteur(state, e, dt); countBeaten(state, e); }
    else if (e.kind === 'goon') { thinkGoon(state, e, dt); countBeaten(state, e); }
  }
  if (E.some((e) => e.gone || e.state === 'dead')) {
    state.entities = E.filter((e) => !e.gone && e.state !== 'dead');
  }
  stepDog(state, dt);
  stepCops(state, dt);
  stepDispatch(state);
  if (!state.sleeping && t.news.length) {
    state.events.push({ type: 'notice', title: 'While you were out', lines: t.news.splice(0) });
  }
}
