// menus.js — DOM menus over the canvas (plan §B7): hardware shop, sell-to-
// Skeet dialog, inventory, pause (save/load), harvest report card and the
// hover plant panel. All full-screen menus pause the simulation (plan §A2);
// main.js derives state.paused from anyOpen(). Browser-only module.

import { CONFIG } from '../config.js';
import { stageOf, stressorsOf, avgHealthOf, careOf, litHoursToRipe } from '../sim/plants.js';
import { hardwareStock, shopOpen, buyItem, invBatches, sellBatch } from '../sim/economy.js';

function el(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

export function initMenus(hud) {
  const root = document.getElementById('menus');
  let open = null;          // 'shop' | 'sell' | 'inventory' | 'pause' | 'report'
  let stateRef = null;      // the state the menu operates on
  const reportQueue = [];   // queued harvest report cards (My Addition 5)

  // A full-screen panel: title, body, close hint.
  function makePanel(cls) {
    const panel = el('div', `menu-panel ${cls}`, root);
    panel.style.display = 'none';
    const title = el('div', 'menu-title', panel);
    const body = el('div', 'menu-body', panel);
    const hint = el('div', 'menu-hint', panel, 'Esc / E to close');
    return { panel, title, body, hint };
  }

  const shopPanel = makePanel('shop');
  const sellPanel = makePanel('sell');
  const invPanel = makePanel('inventory');
  const pausePanel = makePanel('pause');
  const reportPanel = makePanel('report');

  function closeAll() {
    open = null;
    for (const p of [shopPanel, sellPanel, invPanel, pausePanel, reportPanel]) {
      p.panel.style.display = 'none';
    }
  }

  function show(panel, title, openKind) {
    closeAll();
    panel.title.textContent = title;
    panel.panel.style.display = 'flex';
    open = openKind;
  }

  // ------------------------------------------------------------- shop ----

  function openShop(state) {
    stateRef = state;
    renderShop();
    show(shopPanel, `Hardware store — $${Math.round(state.player.cash)}`, 'shop');
  }

  function renderShop() {
    const state = stateRef;
    shopPanel.body.textContent = '';
    if (!shopOpen(state.time, 'hardware')) {
      el('div', 'menu-note', shopPanel.body, 'Closed. Open 8:00-18:00.');
    }
    for (const item of hardwareStock()) {
      const row = el('div', 'menu-row', shopPanel.body);
      el('span', 'menu-item-name', row, item.name);
      el('span', 'menu-item-price', row, `$${item.price}`);
      const btn = el('button', 'menu-btn', row, 'Buy');
      btn.disabled = state.player.cash < item.price;
      btn.onclick = () => {
        const r = buyItem(state, item.key);
        if (!r.ok) hud.toast(r.msg);
        renderShop();
        shopPanel.title.textContent = `Hardware store — $${Math.round(state.player.cash)}`;
      };
    }
  }

  // ------------------------------------------------------------- sell ----

  function openSell(state) {
    stateRef = state;
    renderSell();
    show(sellPanel, 'Skeet — "What have you got?"', 'sell');
  }

  function priceText(batch) {
    const per = (CONFIG.economy.priceBase + CONFIG.economy.pricePerQuality * batch.quality) *
      (batch.wet ? CONFIG.plants.wetPriceMult : 1);
    return `$${per.toFixed(2)}/g — $${(per * batch.grams).toFixed(0)} total`;
  }

  function renderSell() {
    const state = stateRef;
    sellPanel.body.textContent = '';
    const batches = invBatches(state);
    if (batches.length === 0) {
      el('div', 'menu-note', sellPanel.body, 'Nothing to sell.');
      return;
    }
    for (const b of batches) {
      const row = el('div', 'menu-row', sellPanel.body);
      el('span', 'menu-item-name', row,
        `${b.strainName} · ${b.grams.toFixed(1)} g · q${b.quality}${b.wet ? ' (wet, half price)' : ''}`);
      el('span', 'menu-item-price', row, priceText(b));
      const btn = el('button', 'menu-btn', row, 'Sell');
      btn.onclick = () => {
        const value = sellBatch(state, b);
        hud.toast(`Sold ${b.strainName} — +$${Math.round(value)}`);
        renderSell();
      };
    }
  }

  // -------------------------------------------------------- inventory ----

  function openInventory(state) {
    stateRef = state;
    renderInventory();
    show(invPanel, 'Inventory — click an item to put it in the selected hotbar slot', 'inventory');
  }

  function renderInventory() {
    const state = stateRef;
    invPanel.body.textContent = '';
    const inv = state.player.inv;
    const tools = ['can', 'pickaxe', 'moisture_meter', 'ph_meter', 'loupe'];
    const keys = Object.keys(inv).filter((k) => inv[k] > 0);
    if (keys.length === 0) el('div', 'menu-note', invPanel.body, 'Empty.');
    for (const key of keys) {
      const row = el('div', 'menu-row', invPanel.body);
      const count = key === 'nutrients' || key === 'phkit' ? `${inv[key]} doses` : inv[key];
      el('span', 'menu-item-name', row,
        `${CONFIG.itemNames[key] || key}${tools.includes(key) ? '' : ` x${count}`}`);
      const btn = el('button', 'menu-btn', row, '-> hotbar');
      btn.onclick = () => {
        hud.toast(`${CONFIG.itemNames[key] || key} -> hotbar slot ${state.player.hotbarIndex + 1}`);
        window.dispatchEvent(new CustomEvent('backforty:assign', { detail: { key } }));
        closeAll();
      };
    }
  }

  // ------------------------------------------------------------ pause ----

  function openPause(state) {
    stateRef = state;
    pausePanel.body.textContent = '';
    const row = el('div', 'menu-row', pausePanel.body);
    const save = el('button', 'menu-btn', row, 'Save (slot 1)');
    const load = el('button', 'menu-btn', row, 'Load (slot 1)');
    const resume = el('button', 'menu-btn', row, 'Resume');
    save.onclick = () => window.dispatchEvent(new CustomEvent('backforty:save'));
    load.onclick = () => window.dispatchEvent(new CustomEvent('backforty:load'));
    resume.onclick = () => closeAll();
    show(pausePanel, 'Paused', 'pause');
  }

  // ------------------------------------------------------ report card ----
  // Harvest report card (My Addition 5): the multiplier breakdown of the
  // last harvest. Multiple harvests queue; each pauses until dismissed.

  function queueReport(ev) {
    reportQueue.push(ev);
    if (open !== 'report') showNextReport();
  }

  function showNextReport() {
    const ev = reportQueue.shift();
    if (!ev) { closeAll(); return; }
    reportPanel.body.textContent = '';
    el('div', 'menu-report-strain', reportPanel.body, `${ev.strainName} — ${ev.grams.toFixed(1)} g wet, quality ${ev.quality.toFixed(1)}`);
    for (const line of ev.lines) {
      el('div', 'menu-report-line', reportPanel.body, line);
    }
    const row = el('div', 'menu-row', reportPanel.body);
    const ok = el('button', 'menu-btn', row, 'OK');
    ok.onclick = () => showNextReport();
    show(reportPanel, 'Harvest report card', 'report');
  }

  // ------------------------------------------------- hover plant panel ----

  const hoverPanel = el('div', 'plant-panel', root);
  hoverPanel.style.display = 'none';
  let lastHoverKey = '';

  /** Called at ui.updateHz: hover = pot under the aim point (or null). */
  function tick(state, hover) {
    if (open || !hover || !hover.plant) {
      if (hoverPanel.style.display !== 'none') { hoverPanel.style.display = 'none'; lastHoverKey = ''; }
      return;
    }
    const plant = hover.plant;
    const inv = state.player.inv;
    const stage = stageOf(plant);
    let key = `${plant.id}|${stage}|${Math.round(plant.moisture)}|${plant.ph.toFixed(2)}|${Math.round(plant.nutrients)}`;
    if (key === lastHoverKey) return;
    lastHoverKey = key;

    hoverPanel.textContent = '';
    el('div', 'plant-panel-title', hoverPanel, `${plant.strainName}`);
    const rows = [
      `Stage: ${stage}${stage === 'ripe' ? ' — harvest now (E)' : ''}`,
      `Health: ${Math.round(plant.health)} (avg ${Math.round(avgHealthOf(plant))}, care ${(careOf(plant) * 100) | 0}%)`,
    ];
    // Without tools you see bands only; tools give exact numbers (plan §A4).
    rows.push(inv.moisture_meter
      ? `Moisture: ${plant.moisture.toFixed(0)}`
      : `Moisture: ${moistureBand(plant.moisture)}`);
    rows.push(inv.ph_meter
      ? `pH: ${plant.ph.toFixed(2)}`
      : `pH: ${phBand(plant.ph)}`);
    rows.push(`Nutrients: ${nutrientBand(plant.nutrients)}`);
    if (inv.loupe) {
      const h = litHoursToRipe(state, plant, hover.pot);
      rows.push(h === null ? 'To ripe: — (no light)'
        : h === 0 ? (stage === 'ripe' ? 'Ripe window: NOW' : `Overripe: ${Math.round(plant.overHours)} gh`)
        : `To ripe: ~${h.toFixed(1)} lit hours`);
    }
    const stressors = stressorsOf(plant);
    if (stressors.length > 0) rows.push(`Stress: ${stressors.join(', ')}`);
    for (const r of rows) el('div', 'plant-panel-row', hoverPanel, r);
    hoverPanel.style.display = 'block';
  }

  return {
    openShop, openSell, openInventory, openPause,
    queueReport,
    closeAll,
    anyOpen: () => open !== null,
    isOpen: (kind) => open === kind,
    tick,
  };
}

function moistureBand(m) {
  const P = CONFIG.plants; // bands derive from the ideal/stress ranges
  if (m > P.moistureStress.hi) return 'Soaked';
  if (m > P.moistureIdeal.hi) return 'Wet';
  if (m >= P.moistureIdeal.lo) return 'Good';
  if (m >= P.moistureStress.lo) return 'Slightly dry';
  return 'Dry';
}

function phBand(ph) {
  const P = CONFIG.plants;
  if (ph > P.phMild.hi) return 'High (yellow tips)';
  if (ph > P.phIdeal.hi) return 'Slightly high (yellow tips)';
  if (ph < P.phMild.lo) return 'Low (dark spots)';
  if (ph < P.phIdeal.lo) return 'Slightly low (dark spots)';
  return 'Good';
}

function nutrientBand(n) {
  const P = CONFIG.plants;
  if (n < P.nutrientStress.lo) return 'Deficient';
  if (n < P.nutrientIdeal.lo) return 'Low';
  if (n <= P.nutrientIdeal.hi) return 'Good';
  if (n <= P.nutrientStress.hi) return 'High';
  return 'Burn';
}
