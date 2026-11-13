// audio.js — fully synthesized Web Audio (plan §B8/§C2): no files.
// Safe to import in Node: nothing touches AudioContext until start() runs
// (first user click, browser autoplay policy). renderSfx() is pure so tests
// can check every sound without a sound card.

import { CONFIG } from '../config.js';

const A = CONFIG.audio;
export const SFX_NAMES = Object.keys(A.sfx);
export const MUSIC_BEDS = ['day', 'night'];

/** Render one SFX parameter object to samples (deterministic noise). */
export function renderSfx(def, sampleRate = A.sampleRate) {
  const n = Math.floor(def.len * sampleRate);
  const out = new Float32Array(n);
  let phase = 0;
  let seed = 12345;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const k = i / n;
    phase += 2 * Math.PI * (def.f0 + (def.f1 - def.f0) * k) / sampleRate;
    const w = def.wave === 'square' ? (Math.sin(phase) >= 0 ? 1 : -1)
      : def.wave === 'saw' ? 2 * ((phase / (2 * Math.PI)) % 1) - 1
      : def.wave === 'tri' ? 2 * Math.abs(2 * ((phase / (2 * Math.PI)) % 1) - 1) - 1
      : Math.sin(phase);
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const noise = seed / 2147483648 - 1;
    let env = Math.min(1, t / Math.max(def.attack, 1e-4)) * (1 - k) * (1 - k);
    if (def.mod) env *= 0.6 + 0.4 * Math.sin(2 * Math.PI * def.mod * t);
    out[i] = (w * (1 - def.noise) + noise * def.noise) * env * def.vol;
  }
  return out;
}

// ------------------------------------------------------------ runtime ----

const rt = { ctx: null, buffers: null, voices: 0, muted: false, vol: { master: A.master, sfx: A.sfxVol, music: A.musicVol },
  bed: 'off', tension: false, timer: null, nextBeat: 0 };

try {
  const saved = JSON.parse(globalThis.localStorage?.getItem(A.storageKey) || 'null');
  if (saved) { Object.assign(rt.vol, saved.vol); rt.muted = !!saved.muted; }
} catch { /* no storage: defaults */ }

const save = () => {
  try { globalThis.localStorage?.setItem(A.storageKey, JSON.stringify({ vol: rt.vol, muted: rt.muted })); } catch { /* ignore */ }
};

function applyVolumes() {
  if (!rt.ctx) return;
  const m = rt.muted ? 0 : rt.vol.master;
  rt.master.gain.value = m;
  rt.sfxBus.gain.value = rt.vol.sfx;
  rt.musicBus.gain.value = rt.vol.music;
}

/** Create the context and render every SFX buffer. Call from a user gesture. */
export function start() {
  if (rt.ctx || typeof AudioContext === 'undefined') { if (rt.ctx && rt.ctx.state === 'suspended') rt.ctx.resume(); return !!rt.ctx; }
  const ctx = rt.ctx = new AudioContext();
  rt.master = ctx.createGain(); rt.master.connect(ctx.destination);
  rt.pan = ctx.createStereoPanner(); rt.pan.connect(rt.master);
  rt.sfxBus = ctx.createGain(); rt.sfxBus.connect(rt.pan);
  rt.musicBus = ctx.createGain(); rt.musicBus.connect(rt.master);
  rt.buffers = {};
  for (const name of SFX_NAMES) {
    const data = renderSfx(A.sfx[name], ctx.sampleRate);
    const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
    buf.copyToChannel(data, 0);
    rt.buffers[name] = buf;
  }
  applyVolumes();
  for (const k of ['day', 'night', 'tension']) {
    rt['g_' + k] = ctx.createGain(); rt['g_' + k].gain.value = 0; rt['g_' + k].connect(rt.musicBus);
  }
  rt.timer = setInterval(schedule, A.music.tickMs);
  schedule();
  const bed = rt.bed;
  rt.bedSet = null;
  setMusic(bed);
  if (rt.tension) { rt.tension = false; setTension(true); }
  return true;
}

/** Play an SFX. `dx` = source x minus camera centre, px (volume and pan). Max voices; extras dropped. */
export function sfx(name, dx = 0) {
  if (!rt.ctx || rt.voices >= A.maxVoices || !rt.buffers[name]) return false;
  const fall = 1 - Math.min(1, Math.abs(dx) / A.falloffPx);
  if (fall <= 0) return false;
  const src = rt.ctx.createBufferSource();
  src.buffer = rt.buffers[name];
  const g = rt.ctx.createGain();
  g.gain.value = fall;
  rt.pan.pan.value = Math.max(-1, Math.min(1, dx / A.falloffPx));
  src.connect(g); g.connect(rt.sfxBus);
  rt.voices++;
  src.onended = () => { rt.voices--; };
  src.start();
  return true;
}

function fade(key, to) {
  if (!rt.ctx) return;
  rt['g_' + key].gain.setTargetAtTime(to, rt.ctx.currentTime, A.music.fadeSec / 3);
}

/** 'day' | 'night' | 'off': which ambient bed plays. */
export function setMusic(mode) {
  if (mode === rt.bedSet) return;
  rt.bed = rt.bedSet = mode;
  fade('day', mode === 'day' ? 1 : 0);
  fade('night', mode === 'night' ? 1 : 0);
}

/** Pulse-bass tension layer for raids and fights. */
export function setTension(on) {
  if (!!on === rt.tension) return;
  rt.tension = !!on;
  fade('tension', on ? 1 : 0);
}

export function setVolume(kind, v) { rt.vol[kind] = Math.max(0, Math.min(1, v)); applyVolumes(); save(); }
export function setMuted(m) { rt.muted = !!m; applyVolumes(); save(); }
export const getVolumes = () => ({ ...rt.vol, muted: rt.muted });

function note(bed, freq, when, dur, out) {
  const M = bed === 'tension' ? { ...A.music.tension, detuneCents: 0 } : A.music[bed];
  const f = rt.ctx.createBiquadFilter();
  f.type = 'lowpass'; f.frequency.value = M.cutoff;
  const env = rt.ctx.createGain();
  env.gain.setValueAtTime(0, when);
  env.gain.linearRampToValueAtTime(M.vol, when + dur * 0.3);
  env.gain.linearRampToValueAtTime(0, when + dur);
  f.connect(env); env.connect(out);
  for (const c of [-M.detuneCents, M.detuneCents]) {
    const o = rt.ctx.createOscillator();
    o.type = A.oscTypes[M.wave]; o.frequency.value = freq; o.detune.value = c;
    o.connect(f); o.start(when); o.stop(when + dur + 0.05);
  }
}

/** Look-ahead scheduler: queue notes and pulses on AudioContext time. */
function schedule() {
  if (!rt.ctx) return;
  const now = rt.ctx.currentTime;
  const until = now + A.music.lookaheadSec;
  for (const bed of MUSIC_BEDS) {
    // Both beds keep stepping (silent at gain 0) so a crossfade is in phase.
    const M = A.music[bed];
    for (let t = rt['n_' + bed] || now; t < until; t += M.noteSec) {
      if (t >= now) {
        const i = Math.round(t / M.noteSec) % M.notes.length;
        note(bed, M.root * 2 ** (M.notes[i] / 12), t, M.noteSec * 1.2, rt['g_' + bed]);
      }
      rt['n_' + bed] = t + M.noteSec;
    }
  }
  const T = A.music.tension;
  if (rt.tension || rt.g_tension.gain.value > 0.01) {
    for (let t = Math.max(rt.nextBeat, now); t < until; t += T.beatSec) {
      note('tension', T.freq, t, T.beatSec * 0.9, rt.g_tension);
      rt.nextBeat = t + T.beatSec;
    }
  }
}
