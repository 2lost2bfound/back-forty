// screens.js — title screen, pause menu with 3 save slots, export/import,
// settings, the win screen and the save-failed export offer (plan M10, §B4).
// Browser-only. It owns its own panels; main.js asks anyOpen() so these pause
// the sim like every menu (plan §A2) and reacts to the window events below:
//   backforty:newgame {difficulty}  backforty:save {slot}  backforty:load {key}
//   backforty:import {json}  backforty:title  backforty:legacy
// Settings (tips on/off) persist in localStorage; audio keeps its own keys.

import { CONFIG } from '../config.js';
import { browserStorage, slotKey, autoKey, serializeState } from '../state.js';
import * as audio from '../audio/audio.js';
import { setQualityMode } from '../quality.js';

const fire = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));

function el(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

export function loadSettings() {
  try { return { tips: true, ...JSON.parse(browserStorage.getItem(CONFIG.save.settingsKey) || '{}') }; } catch { return { tips: true }; }
}
function saveSettings(s) {
  try { browserStorage.setItem(CONFIG.save.settingsKey, JSON.stringify(s)); } catch { /* settings are a convenience */ }
}

/** One-line summary of a saved slot straight from its JSON, or null when empty. */
export function slotSummary(key) {
  let raw = null;
  try { raw = browserStorage.getItem(key); } catch { /* storage blocked */ }
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    return `Day ${o.time.day} · $${Math.round(o.player.cash)} cash · $${Math.round(o.player.bank || 0)} bank · L${o.player.level}${o.legacy ? ' · Legacy' : ''}`;
  } catch { return 'unreadable save'; }
}

export function download(name, text) {
  const a = el('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function initScreens() {
  const root = document.getElementById('menus');
  let open = null;
  let difficulty = 'standard';
  const settings = loadSettings();
  setQualityMode(settings.effects);

  const panels = {};
  for (const k of ['title', 'pause', 'settings', 'win', 'cup', 'export']) {
    const panel = el('div', `menu-panel screen-${k}`, root);
    panel.style.display = 'none';
    panels[k] = { panel, title: el('div', 'menu-title', panel), body: el('div', 'menu-body', panel) };
  }
  function show(kind, title) {
    closeAll();
    panels[kind].title.textContent = title;
    panels[kind].panel.style.display = 'flex';
    open = kind;
  }
  function closeAll() {
    for (const p of Object.values(panels)) p.panel.style.display = 'none';
    open = null;
  }
  const clear = (kind) => { panels[kind].body.textContent = ''; return panels[kind].body; };
  const button = (parent, text, fn) => { const b = el('button', 'menu-btn', parent, text); b.onclick = fn; return b; };

  /** Three slots (save/load) plus the rolling autosaves (load only). */
  function slotRows(body, state, withSave) {
    for (let n = 1; n <= CONFIG.save.slots; n++) {
      const row = el('div', 'menu-row', body);
      const info = slotSummary(slotKey(n));
      el('span', 'menu-item-name', row, `Slot ${n}: ${info || 'empty'}`);
      if (withSave && state) button(row, 'Save', () => { fire('backforty:save', { slot: n }); open === 'pause' && openPause(state); });
      button(row, 'Load', () => fire('backforty:load', { key: slotKey(n) })).disabled = !info;
    }
    for (let n = 1; n <= 3; n++) {
      const info = slotSummary(autoKey(n));
      if (!info) continue;
      const row = el('div', 'menu-row', body);
      el('span', 'menu-item-name', row, `Autosave ${n}: ${info}`);
      button(row, 'Load', () => fire('backforty:load', { key: autoKey(n) }));
    }
  }

  function importButton(parent) {
    const input = el('input', '', parent);
    input.type = 'file'; input.accept = 'application/json,.json'; input.style.display = 'none';
    input.onchange = () => {
      const f = input.files && input.files[0];
      if (f) f.text().then((json) => fire('backforty:import', { json }));
      input.value = '';
    };
    button(parent, 'Import save', () => input.click());
  }

  function openTitle() {
    const body = clear('title');
    el('div', 'menu-report-line', body, 'A grower\'s story in one town. Win the license, or lose it all.');
    el('div', 'menu-hint', body, `Legacy goal: after the license, win the Harvest Cup (every ${CONFIG.cup.everyDays} days) with a named strain.`);
    const row = el('div', 'menu-row', body, 'Difficulty ');
    for (const [key, d] of Object.entries(CONFIG.difficulty)) {
      const b = button(row, key === difficulty ? `[${d.label}]` : d.label, () => { difficulty = key; openTitle(); });
      b.title = `Threat chances and heat gains x${d.mult}`;
    }
    button(el('div', 'menu-row', body), 'New game', () => fire('backforty:newgame', { difficulty }));
    slotRows(body, null, false);
    importButton(el('div', 'menu-row', body));
    button(el('div', 'menu-row', body), 'Settings', () => openSettings(openTitle));
    show('title', 'BACK FORTY');
  }

  function openPause(state) {
    const body = clear('pause');
    slotRows(body, state, true);
    const row = el('div', 'menu-row', body);
    button(row, 'Export save', () => download(`backforty-day${state.time.day}.json`, serializeState(state)));
    importButton(row);
    const row2 = el('div', 'menu-row', body);
    button(row2, 'Settings', () => openSettings(() => openPause(state)));
    button(row2, 'Title screen', () => fire('backforty:title'));
    button(row2, 'Resume', closeAll);
    show('pause', state.legacy ? 'Paused (Legacy)' : 'Paused');
  }

  function openSettings(back) {
    const body = clear('settings');
    const vols = audio.getVolumes();
    for (const [kind, label] of [['master', 'Master'], ['sfx', 'Effects'], ['music', 'Music']]) {
      const r = el('div', 'menu-row', body, `${label} `);
      const sl = el('input', '', r);
      sl.type = 'range'; sl.min = 0; sl.max = 1; sl.step = 0.05; sl.value = vols[kind];
      sl.oninput = () => audio.setVolume(kind, +sl.value);
    }
    const mr = el('div', 'menu-row', body, 'Mute ');
    const mute = el('input', '', mr);
    mute.type = 'checkbox'; mute.checked = vols.muted;
    mute.onchange = () => audio.setMuted(mute.checked);
    const mo = el('div', 'menu-row', body, 'Mute music ');
    const musicOff = el('input', '', mo);
    musicOff.type = 'checkbox'; musicOff.checked = vols.musicOff;
    musicOff.onchange = () => audio.setMusicOff(musicOff.checked);
    const er = el('div', 'menu-row', body, 'Effects ');
    const fx = el('select', '', er);
    for (const [v, label] of [['auto', 'Auto'], ['high', 'High'], ['low', 'Low']]) {
      const o = el('option', '', fx, label); o.value = v;
    }
    fx.value = settings.effects || 'auto';
    fx.onchange = () => { settings.effects = fx.value; saveSettings(settings); setQualityMode(fx.value); };
    const tr = el('div', 'menu-row', body, 'First-time tips ');
    const tips = el('input', '', tr);
    tips.type = 'checkbox'; tips.checked = settings.tips;
    tips.onchange = () => { settings.tips = tips.checked; saveSettings(settings); };
    button(el('div', 'menu-row', body), 'Back', back);
    show('settings', 'Settings');
  }

  /** The win screen: run stats, then Legacy mode or the title screen. */
  function openWin(state) {
    const w = state.won;
    const body = clear('win');
    el('div', 'menu-report-strain', body, 'LICENSED. You are a legitimate grower.');
    for (const line of [
      `Day ${w.day} · Grower level ${w.level} · Heat ${w.heat}`,
      `Gross sales $${w.gross} · Bank $${w.bank}`,
      `Laundered $${w.laundered} (fees $${w.fees})`,
      `Arrests ${w.arrests} · Overdoses ${w.overdoses}`,
    ]) el('div', 'menu-report-line', body, line);
    const row = el('div', 'menu-row', body);
    button(row, 'Continue in Legacy mode', () => { fire('backforty:legacy'); closeAll(); });
    button(row, 'Title screen', () => fire('backforty:title'));
    show('win', 'YOU WIN');
  }

  /** The Harvest Cup end screen (Legacy mode, plan §A11): its own win, then back to the farm. */
  function openCup(c) {
    const body = clear('cup');
    el('div', 'menu-report-strain', body, `${c.name} wins the Harvest Cup!`);
    for (const line of [
      `Day ${c.day} · trait sum ${c.sum} at full stability · quality ${Math.round(c.quality)}`,
      `Cups won: ${c.wins}. The next Cup is in 28 days.`,
    ]) el('div', 'menu-report-line', body, line);
    const row = el('div', 'menu-row', body);
    button(row, 'Back to the farm', closeAll);
    button(row, 'Title screen', () => fire('backforty:title'));
    show('cup', 'HARVEST CUP');
  }

  /** A failed save is never swallowed (plan §B4): say so and offer the file. */
  function openExportOffer(error, json) {
    const body = clear('export');
    el('div', 'menu-report-line', body, `The browser refused the save (${error}). Your run is not lost: export it to a file.`);
    const row = el('div', 'menu-row', body);
    button(row, 'Download save file', () => download('backforty-save.json', json));
    button(row, 'Close', closeAll);
    show('export', 'Save failed');
  }

  return {
    openTitle, openPause, openWin, openCup, openSettings, openExportOffer, closeAll,
    anyOpen: () => open !== null,
    isOpen: (kind) => open === kind,
    tipsOn: () => settings.tips,
  };
}
