// hud.js — DOM HUD over the canvas (plan §B7): clock, cash, stamina, hotbar,
// toasts and the interaction prompt. Updated at CONFIG.ui.updateHz with dirty
// checks; the frame loop never touches the DOM directly. Browser-only module.

import { CONFIG } from '../config.js';
import { formatClock, weatherNow } from '../sim/time.js';
import { heatTier } from '../sim/heat.js';
import { nowGh } from '../sim/economy.js';
import { tileInfo, itemKeyFor } from '../world/tiles.js';
import { status as addStatus } from '../sim/addiction.js';
import { isGun, isWeapon, ammoOf } from '../entities/combat.js';

const U = CONFIG.ui;
const HEAT_NAMES = ['COLD', 'WARM', 'HOT', 'BURNING'];

function el(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

export function initHud() {
  const root = document.getElementById('ui');

  const top = el('div', 'hud-top', root);
  const clockEl = el('span', 'hud-clock', top);
  const weatherEl = el('span', 'hud-weather', top);
  const cashEl = el('span', 'hud-cash', top);

  const ordersEl = el('div', 'hud-orders', root);

  const barWrap = el('div', 'hud-bars', root);
  const stamOuter = el('div', 'hud-bar-outer', barWrap);
  const stamFill = el('div', 'hud-bar-fill stam', stamOuter);
  const stamLabel = el('span', 'hud-bar-label', stamOuter);
  stamLabel.textContent = 'STAMINA';

  const hpOuter = el('div', 'hud-bar-outer', barWrap);
  const hpFill = el('div', 'hud-bar-fill hp', hpOuter);
  const hpLabel = el('span', 'hud-bar-label', hpOuter);

  const hotbar = el('div', 'hud-hotbar', root);
  const slots = [];
  for (let i = 0; i < 8; i++) {
    const slot = el('div', 'hud-slot', hotbar);
    const num = el('span', 'hud-slot-num', slot);
    num.textContent = String(i + 1);
    const name = el('span', 'hud-slot-name', slot);
    const count = el('span', 'hud-slot-count', slot);
    slots.push({ slot, name, count });
  }

  // Heat meter (plan §A5): tier colour always; the exact number needs a scanner.
  const heatOuter = el('div', 'hud-bar-outer hud-heat', barWrap);
  const heatFill = el('div', 'hud-bar-fill heat', heatOuter);
  const heatLabel = el('span', 'hud-bar-label', heatOuter);

  const addictEl = el('div', 'hud-addict', root);
  const canvas = document.getElementById('game');
  const promptEl = el('div', 'hud-prompt', root);

  const toasts = el('div', 'hud-toasts', root);

  let lastTop = '';
  let lastHotbar = '';
  let lastPrompt = '';
  let lastOrders = '';

  function slotText(state, i) {
    const e = state.player.hotbar[i];
    if (!e) return { name: '?', count: '' };    if (e.kind === 'tile') {
      return { name: tileInfo(e.id).name, count: state.player.inv[itemKeyFor(e.id)] || 0 };
    }
    const key = e.key;
    const inv = state.player.inv;
    if (isGun(key)) {
      const a = ammoOf(state.player, key);
      return { name: CONFIG.itemNames[key], count: inv[key] ? `${a.mag}/${a.bag}${state.player.reload && state.player.tool === key ? ' ...' : ''}` : 'none' };
    }
    if (isWeapon(key)) return { name: CONFIG.itemNames[key], count: key === 'fists' || inv[key] ? '' : 'none' };
    const tools = ['can', 'pickaxe', 'moisture_meter', 'ph_meter', 'loupe'];
    const count = key === 'nutrients' || key === 'phkit'
      ? `${inv[key] || 0} doses`
      : tools.includes(key) ? (inv[key] ? '' : 'none')
      : (inv[key] || 0);
    return { name: CONFIG.itemNames[key] || key, count };
  }

  return {
    /** Called at ui.updateHz from the frame loop. */
    update(state, hint) {
      const w0 = weatherNow(state);
      const weather = w0[0].toUpperCase() + w0.slice(1);
      const topStr = formatClock(state.time);
      if (topStr !== lastTop) { lastTop = topStr; clockEl.textContent = topStr; }
      const cashStr = `$${Math.round(state.player.cash)}${state.sleeping ? '  (sleeping)' : ''}`;
      if (cashStr !== cashEl.textContent) cashEl.textContent = cashStr;
      const wStr = weather === 'Clear' ? '' : weather;
      if (wStr !== weatherEl.textContent) weatherEl.textContent = wStr;

      const stamPct = Math.round(state.player.stamina);
      if (stamPct !== stamFill.dataset.v) {
        stamFill.dataset.v = stamPct;
        stamFill.style.width = `${stamPct}%`;
      }

      const hp = Math.round(state.player.hp);
      if (hp !== hpFill.dataset.v) {
        hpFill.dataset.v = hp;
        hpFill.style.width = `${hp}%`;
        hpLabel.textContent = `HP ${hp}`;
      }

      const tier = heatTier(state.heat);
      const heatStr = `${tier}|${Math.round(state.heat)}|${state.player.inv.scanner > 0}`;
      if (heatStr !== heatFill.dataset.v) {
        heatFill.dataset.v = heatStr;
        heatFill.style.width = `${Math.round(state.heat)}%`;
        heatFill.className = `hud-bar-fill heat tier${tier}`;
        heatLabel.textContent = `HEAT ${HEAT_NAMES[tier]}${state.player.inv.scanner > 0 ? ` ${state.heat.toFixed(1)}` : ''}`;
      }

      let hb = `${state.player.hotbarIndex}|`;
      const texts = [];
      for (let i = 0; i < slots.length; i++) {
        const t = slotText(state, i);
        texts.push(t);
        hb += `${t.name}#${t.count};`;
      }
      if (hb !== lastHotbar) {
        lastHotbar = hb;
        for (let i = 0; i < slots.length; i++) {
          slots[i].slot.classList.toggle('sel', i === state.player.hotbarIndex);
          slots[i].name.textContent = texts[i].name;
          slots[i].count.textContent = texts[i].count === '' ? '' : String(texts[i].count);
        }
      }

      // Order timers: buyer, grams, hours left (red when late).
      const now = nowGh(state);
      const ordStr = state.economy.orders.map((o) => {
        const left = o.deadline - now;
        return `${CONFIG.economy.buyers[o.buyer].name} ${o.grams}g ${left >= 0 ? `${Math.ceil(left)}h` : 'LATE'}`;
      }).join('\n');
      if (ordStr !== lastOrders) { lastOrders = ordStr; ordersEl.textContent = ordStr; }

      // Buff / withdrawal icons and the screen desaturation: toggled, not animated.
      const as = addStatus(state);
      const tags = [];
      for (const x of as.subs) {
        if (x.buffLeft > 0) tags.push(`${x.key.toUpperCase()} ${Math.ceil(x.buffLeft)}h`);
        else if (x.crashLeft > 0) tags.push(`${x.key.toUpperCase()} CRASH`);
      }
      if (as.weedLeft > 0) tags.push('HIGH');
      if (as.withdrawal) tags.push('WITHDRAWAL');
      if (as.craving) tags.push('CRAVING');
      if (as.taper) tags.push('TAPER');
      const addStr = tags.join('  ');
      if (addStr !== addictEl.textContent) addictEl.textContent = addStr;
      const filter = as.withdrawal ? CONFIG.addiction.desaturate : '';
      if (canvas && canvas.style.filter !== filter) canvas.style.filter = filter;

      if (hint !== lastPrompt) {
        lastPrompt = hint;
        promptEl.textContent = hint || '';
        promptEl.style.display = hint ? 'block' : 'none';
      }
    },

    /** Show a toast (sim events -> main -> here). */
    toast(msg) {
      const t = el('div', 'hud-toast', toasts);
      t.textContent = msg;
      while (toasts.children.length > U.toastMax) toasts.removeChild(toasts.firstChild);
      setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, U.toastSeconds * 1000);
    },
  };
}
