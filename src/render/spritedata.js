// spritedata.js — pixel art as string arrays + palettes (plan §C1).
// Every sprite is an array of strings, one character per pixel; '.' is
// transparent. All colors come from the one shared 24-ish color palette.
// Pure data module: no DOM, runs unmodified in Node (used by tests too).
//
// M1 scope: the 11 terrain tiles and the player (8 frames, 16x24; both
// facings are pre-rendered into the atlas by mirroring — plan §B7 avoids
// scale(-1,1) at draw time).

export const PALETTE = {
  '.': null,
  // terrain
  d: '#6b4a2f', D: '#553a22', e: '#7f5c3c',   // dirt
  g: '#3f8a2f', G: '#2e6a23', h: '#57a83d',   // grass
  s: '#7c828c', S: '#5f6570', t: '#98a0ab',   // stone
  k: '#26262c', K: '#141417', j: '#3a3a42',   // bedrock
  w: '#8a5a2b', W: '#6a4520', v: '#a8773f',   // wood
  c: '#9aa0a6', C: '#7c8288',                 // concrete
  r: '#3a3d42', R: '#2b2e32', q: '#4a4e55',   // road
  n: '#8a4f3d', N: '#6d3c2e', m: '#a5684f',   // town brick
  b: '#4a3a2a', B: '#382b1e',                 // background wall (interior)
  // humanoids
  f: '#e0b088', F: '#c89868',                 // skin
  u: '#4a8a3c', U: '#356829',                 // shirt
  p: '#3a5a8c', P: '#2c4468',                 // pants
  o: '#5a3a22',                               // hair/boots
  x: '#11131a',                               // outline/eye
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
