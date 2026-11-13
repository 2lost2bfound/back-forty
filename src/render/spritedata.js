// spritedata.js — pixel art as string arrays + palettes (plan §C1).
// Every sprite is an array of strings, one character per pixel; '.' is
// transparent. All colors come from the one shared 24-ish color palette.
// Pure data module: no DOM, runs unmodified in Node (used by tests too).
//
// M1 scope: the 11 terrain tiles and the player (8 frames, 16x24; both
// facings are pre-rendered into the atlas by mirroring — plan §B7 avoids
// scale(-1,1) at draw time). M2 adds plants (16x32, 7 growth frames) and
// objects (pot, rack, tap, barrel, bed, Skeet's marker).

import { CONFIG } from '../config.js';

export const PALETTE = {
  '.': null,
  // terrain
  d: '#6b4a2f', D: '#553a22', e: '#7f5c3c',   // dirt
  g: '#3f8a2f', G: '#2e6a23', h: '#57a83d',   // grass / plant leaves
  s: '#7c828c', S: '#5f6570', t: '#98a0ab',   // stone
  k: '#26262c', K: '#141417', j: '#3a3a42',   // bedrock
  w: '#8a5a2b', W: '#6a4520', v: '#a8773f',   // wood
  c: '#9aa0a6', C: '#7c8288',                 // concrete
  r: '#3a3d42', R: '#2b2e32', q: '#4a4e55',   // road
  n: '#8a4f3d', N: '#6d3c2e', m: '#a5684f',   // town brick / terracotta
  b: '#4a3a2a', B: '#382b1e',                 // background wall (interior)
  // humanoids
  f: '#e0b088', F: '#c89868',                 // skin
  u: '#4a8a3c', U: '#356829',                 // shirt
  p: '#3a5a8c', P: '#2c4468',                 // pants
  o: '#5a3a22',                               // hair/boots
  x: '#11131a',                               // outline/eye
  // plants and objects (M2)
  i: '#c9a23f',                               // buds (ripe gold)
  z: '#6a5230',                               // dead/wilted stem
  a: '#8fd0e8', A: '#5aa8c8',                 // water (barrel/tap)
};

// ------------------------------------------------------------- tiles ------

export const TILES = {
  dirt: [
    'dddddddddddddddd',
    'ddDdddddddeedddd',
    'ddddddDddddddddd',
    'dedddddddddddDdd',
    'ddddddeedddddddd',
    'dddddddddddDdddd',
    'dDdddddedddddddd',
    'ddddDddddddddddd',
    'ddddddddddeedddd',
    'deedddddddddddDd',
    'ddddddDddddddddd',
    'dddddDddddddeedd',
    'dDeedddddddddddd',
    'dddddddddDdddddd',
    'ddddDdddddddddde',
    'dddddddddddddddd',
  ],
  grass: [
    'hghghghghghghghg',
    'GgghGggghggGghgg',
    'gghggghgGghggghg',
    'GggghggghgggGggg',
    'dddddddddddddddd',
    'ddDdddddddeedddd',
    'ddddddDddddddddd',
    'dedddddddddddDdd',
    'ddddddeedddddddd',
    'dddddddddddDdddd',
    'dDdddddedddddddd',
    'ddddDddddddddddd',
    'ddddddddddeedddd',
    'deedddddddddddDd',
    'ddddddDddddddddd',
    'dddddDddddddeedd',
  ],
  stone: [
    'ssssssssssssssss',
    'sSssssssstssssss',
    'sssssssssssssSss',
    'tsssssssssssssss',
    'ssssssSsssssssss',
    'ssssssssssstssss',
    'sSssssssssssssss',
    'sssssstssssssSss',
    'ssssssssssssssss',
    'ssSsssssssssssss',
    'ssssssssSssssstt',
    'ssssssssssssssss',
    'ssssssSsssssssss',
    'stssssssssssssss',
    'ssssssssssSsssss',
    'ssssssssssssssss',
  ],
  bedrock: [
    'kkkkkkkkkkkkkkkk',
    'kkjkkkkKkkkkkkjk',
    'kkkkkkkkkkkKkkkk',
    'kKkkkkjkkkkkkkkk',
    'kkkkKkkkkkkkkkkj',
    'kkjkkkkkkkKkkkkk',
    'kkkkkkkkkkkkkkkk',
    'kkKkkkkjkkkkkKkk',
    'kkkkkkkkkkkkkkkk',
    'kjkkkkKkkkkkkkkk',
    'kkkkkkkkkkjkkkkk',
    'kkkkKkkkkkkkkKkk',
    'kkkkkkkkjkkkkkkk',
    'kkjkkkkkkkkkkkjk',
    'kkkkkkKkkkkkkkkk',
    'kkkkkkkkkkkkkkkk',
  ],
  wood: [
    'wwwwwwwwwwwwwwww',
    'wvwwwwwwvwwwwwww',
    'WWWWWWWWWWWWWWWW',
    'wwwwwwwwwwwwwwww',
    'wwwwwwwwwwwwwwww',
    'wvwwwwwwvwwwwwww',
    'WWWWWWWWWWWWWWWW',
    'wwwwwwwwwwwwwwww',
    'wwwwwwwwwwwwwwww',
    'wvwwwwwwvwwwwwww',
    'WWWWWWWWWWWWWWWW',
    'wwwwwwwwwwwwwwww',
    'wwwwwwwwwwwwwwww',
    'wvwwwwwwvwwwwwww',
    'WWWWWWWWWWWWWWWW',
    'wwwwwwwwwwwwwwww',
  ],
  platform: [
    'wwwwwwwwwwwwwwww',
    'wvwwwwwwwwvwwwww',
    'WWWWWWWWWWWWWWWW',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
  ],
  concrete: [
    'cccccccccccccccc',
    'cCcccccccccccccc',
    'cccccccccccCcccc',
    'cccccccccccccccc',
    'cccccccCcccccccc',
    'ccCccccccccccccc',
    'cccccccccccccccc',
    'cccccccccccCcccc',
    'cccccCcccccccccc',
    'cccccccccccccccc',
    'ccCccccccccccccc',
    'cccccccccccCcccc',
    'cccccccccccccccc',
    'cccccccCcccccccc',
    'ccCccccccccccccc',
    'cccccccccccccccc',
  ],
  ladder: [
    '.w............w.',
    '.w............w.',
    '.w............w.',
    '.wwwwwwwwwwwwww.',
    '.w............w.',
    '.w............w.',
    '.w............w.',
    '.wwwwwwwwwwwwww.',
    '.w............w.',
    '.w............w.',
    '.w............w.',
    '.wwwwwwwwwwwwww.',
    '.w............w.',
    '.w............w.',
    '.w............w.',
    '.wwwwwwwwwwwwww.',
  ],
  road: [
    'rrrrrrrrrrrrrrrr',
    'rrqrrrrrrRrrrrrr',
    'rrrrrrrrrrrrqrrr',
    'rRrrrrrrrrrrrrrr',
    'rrrrrrqrrrrrrrrr',
    'rrrrrrrrrrrrrRrr',
    'rqrrrrrrrrrrrrrr',
    'rrrrrrrrrrqrrrrr',
    'rrrrRrrrrrrrrrrr',
    'rrrrrrrrrrrrrrqR',
    'rqrrrrrrrrrrrrrr',
    'rrrrrrrRrrrrrrrr',
    'rrrrrrrrrrrrrrrr',
    'rRrrqrrrrrrrrrrr',
    'rrrrrrrrrrRrrrrr',
    'rrrrrrrrrrrrrrrr',
  ],
  town: [
    'nnnnnnnnNnnnnnnn',
    'nnnnnnnnnnnnnnnn',
    'NnnnnnnnnnnnnnnN',
    'nnnnnnnnnnnnnnnn',
    'nnnnNnnnnnnnnnnn',
    'nnnnnnnnnnnnnnnn',
    'nnnnnnnnnnnnNnnn',
    'NNNNNNNNNNNNNNNN',
    'nnnNnnnnnnnnnnnn',
    'nnnnnnnnnnnnnnnn',
    'NnnnnnnnnNnnnnnn',
    'nnnnnnnnnnnnnnnn',
    'nnnnnnnnnnnnnnnn',
    'nnnnNnnnnnnnnnnn',
    'nnnnnnnnnnnnnnnn',
    'NNNNNNNNNNNNNNNN',
  ],
  bgwall: [
    'bbbbbbbbbbbbbbbb',
    'bBbbbbbbbbbbbbbb',
    'bbbbbbbbbbbBbbbb',
    'bbbbbbbbbbbbbbbb',
    'bbbbbBbbbbbbbbbb',
    'bbbbbbbbbbbbbbbb',
    'bbbbbbbbbbBbbbbb',
    'bbbbbbbbbbbbbbbb',
    'bBbbbbbbbbbbbbbb',
    'bbbbbbbbBbbbbbbb',
    'bbbbbbbbbbbbbbbb',
    'bbbbbbBbbbbbbbbb',
    'bbbbbbbbbbbbbbbb',
    'bbbbbbbbbbbBbbbb',
    'bbbbBbbbbbbbbbbb',
    'bbbbbbbbbbbbbbbb',
  ],
};

// ------------------------------------------------------------ player ------
// 16x24, composed: 4 empty rows, 4 head rows, 6 torso rows, 10 leg rows.
// Feet sit on the last row so the sprite bottom aligns with the hitbox.

const E = '................';

const HEAD = [
  '.....oooooo.....',
  '....offffffo....',
  '....offxfffo....',
  '....offffffo....',
];

const TORSO = [
  '.....uuuuuu.....',
  '....uuuuuuuu....',
  '...fuuuuuuuuf...',
  '...fuuuuuuuuf...',
  '...fuuuuuuuuf...',
  '....uuuuuuuu....',
];

// Tend/aim: right arm extends, with a tool handle (w/v pixels) for digging.
const TORSO_TEND = [
  '.....uuuuuu.....',
  '....uuuuuuuu....',
  '...fuuuuuuuuf...',
  '...fuuuuuuuuwv..',
  '...fuuuuuuuuff..',
  '....uuuuuuuu....',
];

const TORSO_AIM = [
  '.....uuuuuu.....',
  '....uuuuuuuu....',
  '...fuuuuuuuuff..',
  '...fuuuuuuuuff..',
  '...fuuuuuuuuf...',
  '....uuuuuuuu....',
];

const LEGS_IDLE = [
  '....pppppppp....',
  '....pppppppp....',
  '....ppp..ppp....',
  '....ppp..ppp....',
  '....ppp..ppp....',
  '....ppp..ppp....',
  '....ppp..ppp....',
  '....ppp..ppp....',
  '....oo....oo....',
  '...ooo....ooo...',
];

const LEGS_WALK1 = [
  '....pppppppp....',
  '...ppppppppp....',
  '...ppp...ppp....',
  '..ppp.....ppp...',
  '..ppp.....ppp...',
  '.ppp.......ppp..',
  '.ppp.......ppp..',
  '.ppp.......ppp..',
  '.oo.........oo..',
  'ooo.........ooo.',
];

const LEGS_PASS = [
  '....pppppppp....',
  '....pppppppp....',
  '....ppppppp.....',
  '....ppp.ppp.....',
  '....ppp.ppp.....',
  '....ppp.ppp.....',
  '....ppp.ppp.....',
  '....ppp.ppp.....',
  '....oo..oo......',
  '...ooo..ooo.....',
];

const LEGS_WALK3 = [
  '....pppppppp....',
  '....ppppppppp...',
  '...ppp...ppp....',
  '...ppp....ppp...',
  '..ppp.....ppp...',
  '..ppp......ppp..',
  '..ppp......ppp..',
  '.ppp.......ppp..',
  '..oo........oo..',
  '.ooo........ooo.',
];

const LEGS_JUMP = [
  '....pppppppp....',
  '...ppppppppp....',
  '...ppp...pppp...',
  '..ppp.....ppp...',
  '..ooo.....ooo...',
  '..ooo.....ooo...',
  '................',
  '................',
  '................',
  '................',
];

const LEGS_TEND = [
  '....pppppppp....',
  '...pppppppppp...',
  '...ppp....ppp...',
  '...ppp....ppp...',
  '...ppp....ppp...',
  '...ppp....ppp...',
  '...ppp....ppp...',
  '...ppp....ppp...',
  '...oo......oo...',
  '..ooo......ooo..',
];

const TOP = [E, E, E, E, ...HEAD, ...TORSO];
const TOP_TEND = [E, E, E, E, ...HEAD, ...TORSO_TEND];
const TOP_AIM = [E, E, E, E, ...HEAD, ...TORSO_AIM];

export const PLAYER_W = 16;
export const PLAYER_H = 24;

export const PLAYER_FRAMES = {
  idle: [...TOP, ...LEGS_IDLE],
  walk0: [...TOP, ...LEGS_WALK1],
  walk1: [...TOP, ...LEGS_PASS],
  walk2: [...TOP, ...LEGS_WALK3],
  walk3: [...TOP, ...LEGS_PASS],
  jump: [...TOP, ...LEGS_JUMP],
  tend: [...TOP_TEND, ...LEGS_TEND],
  aim: [...TOP_AIM, ...LEGS_IDLE],
};

// ------------------------------------------------------------- plants -----
// 16x32, bottom-anchored (the bottom rows overlap the pot rim). M2 carries
// the Ditch Weed palette; strain palette swaps arrive with more strains (M7).

const P32 = '................';

/** Bottom-pad rows into a 32-tall frame. */
function frame32(rows) {
  const pad = Array(32 - rows.length).fill(P32);
  return pad.concat(rows);
}

const PLANT_SEEDLING = frame32([
  '................',
  '.......hh.......',
  '......ghhg......',
  '.......gg.......',
  '.......gg.......',
  '......GggG......',
  '.......gg.......',
  '.......gg.......',
]);

const PLANT_VEG1 = frame32([
  '................',
  '....hh..hh......',
  '...gghhgghg.....',
  '....gggggg......',
  '..ghgGggGghg....',
  '...gggggggg.....',
  '....GggggG......',
  '.....GggG.......',
  '......gg........',
  '......gg........',
  '.......g........',
]);

const PLANT_VEG2 = frame32([
  '..hh..hh..hh....',
  '.gghhgghhgghg...',
  '..gggggggggg....',
  '.ghGgggGGgghg...',
  '.gggggggggggg...',
  '..gGggggggGg....',
  '...gggggggg.....',
  '....GggggG......',
  '.....GggG.......',
  '.....GggG.......',
  '......gg........',
  '......gg........',
  '......gg........',
  '.......g........',
]);

const PLANT_FLOWER = frame32([
  '..hh.iiii.hh....',
  '.gghiiGGiihgg...',
  '..ggiiGGiigg....',
  '.ghGggiiigggh...',
  '.gggggGGgggggg..',
  '..gGgggiggGg....',
  '...gggiggigg....',
  '...gGggggGg.....',
  '....GggggG......',
  '.....GggG.......',
  '.....GggG.......',
  '......gg........',
  '......gg........',
  '......gg........',
  '.......g........',
]);

const PLANT_RIPE = frame32([
  '.iiii.ii.iiii...',
  '.iGgiii.iiiGgi..',
  '.iiiGGi.iGGiii..',
  '.giiiiiiiiiiig..',
  '.ggiiGGGgiiggg..',
  '..giiggggiigg...',
  '..ggiiiiiiiigg..',
  '...gGgiiigGg....',
  '....GggggG......',
  '.....GggG.......',
  '.....GggG.......',
  '......gg........',
  '......gg........',
  '......gg........',
  '.......g........',
]);

const PLANT_OVER = frame32([
  'zzzz..zz..zzz...',
  '.zNzNNz.zNzNzz..',
  '.zzNNzz.zzNNzz..',
  '.zNzzzzzzzzNzz..',
  '.zzzzNNNzzzzz...',
  '..zNzzzzzzNz....',
  '..zzzz...zzz....',
  '...zNz...zNz....',
  '....zz....z.....',
  '.....GzzG.......',
  '......zz........',
  '......zz........',
  '......zz........',
  '.......z........',
]);

const PLANT_DEAD = frame32([
  '................',
  '..zz.......z....',
  '...zzz...zz.....',
  '.....zzzzz......',
  '.......zz.......',
  '.......z........',
  '.......z........',
  '.......z........',
]);

export const PLANT_W = 16;
export const PLANT_H = 32;

export const PLANT_FRAMES = {
  seedling: PLANT_SEEDLING,
  veg1: PLANT_VEG1,
  veg2: PLANT_VEG2,
  flowering: PLANT_FLOWER,
  ripe: PLANT_RIPE,
  over: PLANT_OVER,
  dead: PLANT_DEAD,
};

/** Frame name for a plant's growth state (renderer). */
export function plantFrameName(plant) {
  if (plant.dead) return 'dead';
  const P = CONFIG.plants;
  if (plant.progress >= 1) {
    if (plant.overHours < P.ripeWindowGh) return 'ripe';
    return 'over';
  }
  if (plant.progress >= P.stageProgress.flower) return 'flowering';
  if (plant.progress >= P.stageProgress.veg) {
    return plant.progress < (P.stageProgress.veg + P.stageProgress.flower) / 2 ? 'veg1' : 'veg2';
  }
  return 'seedling';
}

// ------------------------------------------------------------ objects -----

export const OBJECT_W = 16;
export const OBJECT_H = 16;

export const OBJECTS = {
  pot: [
    '................',
    '..nnnnnnnnnnnn..',
    '.ndddddddddddn..',
    '.nNnnnnnnnnnNn..',
    '..nnnnnnnnnnnn..',
    '..nNnnnnnnnNn...',
    '..nNnnnnnnnNn...',
    '...nNnnnnnNn....',
    '...nNnnnnnNn....',
    '...nnnnnnnnn....',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
  ],
  rack: [
    '................',
    'wwwwwwwwwwwwwwww',
    'w..............w',
    'w..vvvvvvvvvv..w',
    'w..............w',
    'w..............w',
    'w..vvvvvvvvvv..w',
    'w..............w',
    'w..............w',
    'w..vvvvvvvvvv..w',
    'w..............w',
    'wwwwwwwwwwwwwwww',
    '................',
    '................',
    '................',
    '................',
  ],
  tap: [
    '................',
    '.....ssss.......',
    '.....s..ss......',
    'SSSSSs...s......',
    'S...S....ssss...',
    'S...S...........',
    'SSSSS...........',
    '..s.............',
    '..s.............',
    '..ss............',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
  ],
  barrel: [
    '................',
    '..wwwwwwwwwwww..',
    '.wAWAAAAAAAWAw..',
    '.wWWWWWWWWWWWw..',
    '.wAWAAAAAAAWAw..',
    '.wAWAAAAAAAWAw..',
    '.wWWWWWWWWWWWw..',
    '.wAWAAAAAAAWAw..',
    '.wAWAAAAAAAWAw..',
    '.wWWWWWWWWWWWw..',
    '.wAWAAAAAAAWAw..',
    '..wwwwwwwwwwww..',
    '................',
    '................',
    '................',
    '................',
  ],
  bed: [
    '................',
    '.WWWWWWWWWWWWW..',
    '.Wuuuuuuuuuuuw..',
    '.Wuuuuffuuuuuw..',
    '.Wuuuuffuuuuuw..',
    '.Wuuuuuuuuuuuw..',
    '.Wuuuuuuuuuuuw..',
    '.WWWWWWWWWWWWW..',
    '.w....w..w...w..',
    '.w....w..w...w..',
    '.w....w..w...w..',
    '.WWWWWWWWWWWWW..',
    '................',
    '................',
    '................',
    '................',
  ],
  skeet: [
    '................',
    '..wwwwwwwwwwww..',
    '.wvvvvvvvvvvvw..',
    '.wvxxvvxxvvvvw..',
    '.wvvvvvvvvvvvw..',
    '.wvvvxxxxvvvvw..',
    '.wvvvvvvvvvvvw..',
    '.wvvvvvvvvvvvw..',
    '..wwwwwwwwwwww..',
    '......wW........',
    '......wW........',
    '......wW........',
    '......wW........',
    '......WW........',
    '................',
    '................',
  ],
};
