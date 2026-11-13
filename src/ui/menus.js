// menus.js — DOM menus over the canvas (plan §B7): shops, buyer order dialog,
// phone (orders, contacts, ledger), inventory, pause (save/load), harvest report card and the
// hover plant panel. All full-screen menus pause the simulation (plan §A2);
// main.js derives state.paused from anyOpen(). Browser-only module.

import { CONFIG } from '../config.js';
import { stageOf, stressorsOf, avgHealthOf, careOf, litHoursToRipe } from '../sim/plants.js';
import { scannerView, heatTier, hs, payDebt } from '../sim/heat.js';
import {
  shopStock, shopOpen, buyItem, orderOf, fillQuote, fillOrder, nowGh, payFee,
  buyerLevel, buyerMult, BUYER_KEYS, carriedGrams, carryCap,
} from '../sim/economy.js';
import { journalView, hasLevel } from '../sim/mastery.js';
import { status as addStatus, useSubstance } from '../sim/addiction.js';
import { baseGenome } from '../sim/genetics.js';
import * as audio from '../audio/audio.js';
import { refuseFee, payTribute, rv } from '../sim/threats.js';
import {
  boardCandidates, describe, hire, fire, giveBonus, bailOut, dockPay, threaten, toggleOutgoing, placeMarker, crewOf,
} from '../sim/crew.js';

import {
  ALLY_KEYS, allyOf, alOf, hearts, giftOptions, giveGift, drinkTogether, acceptFavor, completeFavor, describeFavor,
  canCall, callAlly, arrivalSeconds, payBill, bailAlly, leaveInJail, answerLoan,
} from '../sim/allies.js';

const hearts5 = (n) => '\u2665'.repeat(n) + '\u2661'.repeat(5 - n);

function el(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

export function initMenus(hud) {
  const root = document.getElementById('menus');
  let open = null;          // 'shop' | 'sell' | 'phone' | 'inventory' | 'pause' | 'report'
  let shopKey = 'hardware';
  let buyerKey = 'skeet';
  let phoneTab = 'orders';
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
  const phonePanel = makePanel('phone');
  const noticePanel = makePanel('notice');
  const allyPanel = makePanel('ally');

  function closeAll() {
    open = null;
    for (const p of [shopPanel, sellPanel, invPanel, pausePanel, reportPanel, phonePanel, noticePanel, allyPanel]) {
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

  function openShop(state, key = 'hardware') {
    stateRef = state;
    shopKey = key;
    renderShop();
    show(shopPanel, `${CONFIG.economy[key].label} — $${Math.round(state.player.cash)}`, 'shop');
  }

  const hrs = (h) => `${h % 24}:00`;

  function renderShop() {
    const state = stateRef;
    const sh = CONFIG.economy[shopKey];
    shopPanel.body.textContent = '';
    if (!shopOpen(state.time, shopKey)) {
      el('div', 'menu-note', shopPanel.body, `Closed. Open ${hrs(sh.open)}-${hrs(sh.close)}.`);
    }
    if (shopKey === 'bar') { renderBoard(state); renderDrinks(state); }
    for (const item of shopStock(shopKey, state)) {
      const row = el('div', 'menu-row', shopPanel.body);
      el('span', 'menu-item-name', row, item.name + (item.unreg ? ' (unregistered)' : ''));
      el('span', 'menu-item-price', row, `$${item.price}`);
      const btn = el('button', 'menu-btn', row, 'Buy');
      btn.disabled = state.player.cash < item.price;
      btn.onclick = () => {
        const r = buyItem(state, item.key, shopKey);
        hud.toast(r.msg);
        renderShop();
        shopPanel.title.textContent = `${sh.label} — $${Math.round(state.player.cash)}`;
      };
    }
  }

  /** Drink together (plan A13): +3 friendship, costs a Booze use. */
  function renderDrinks(state) {
    for (const id of ALLY_KEYS) {
      const a = allyOf(state, id);
      if (a.status !== 'ok' || a.estranged) continue;
      const row = el('div', 'menu-row', shopPanel.body);
      el('span', 'menu-item-name', row, `Drink with ${CONFIG.allies.defs[id].name} ${hearts5(hearts(state, id))}`);
      el('span', 'menu-item-price', row, `$${CONFIG.allies.drinkPrice}`);
      el('button', 'menu-btn', row, 'Drink').onclick = () => { hud.toast(drinkTogether(state, id).msg); renderShop(); };
    }
  }

  /** The bar's hiring board (plan A8): two candidates, one adjective per stat. */
  function renderBoard(state) {
    el('div', 'menu-note', shopPanel.body, `Hiring board (crew ${crewOf(state).members.length}/${CONFIG.crew.max})`);
    for (const c of boardCandidates(state)) {
      const d = describe(state, c);
      const row = el('div', 'menu-row', shopPanel.body);
      el('span', 'menu-item-name', row, `${c.name}: ${d.rel}, ${d.disc}, ${d.greed}, ${d.nerve}`);
      for (const role of Object.keys(CONFIG.crew.wage)) {
        const b = el('button', 'menu-btn', row, `${role} $${CONFIG.crew.wage[role]}/day`);
        b.onclick = () => { hud.toast(hire(state, c.id, role).msg); renderShop(); };
      }
    }
  }

  // ------------------------------------------------------------- sell ----

  function openSell(state, key = 'skeet') {
    stateRef = state;
    buyerKey = key;
    renderSell();
    show(sellPanel, `${CONFIG.economy.buyers[key].name} — "What have you got?"`, 'sell');
  }

  function renderSell() {
    const state = stateRef;
    const def = CONFIG.economy.buyers[buyerKey];
    sellPanel.body.textContent = '';
    const order = orderOf(state, buyerKey);
    if (!order) {
      el('div', 'menu-note', sellPanel.body, `${def.name} doesn't need anything right now.`);
      return;
    }
    const q = fillQuote(state, order);
    const left = order.deadline - nowGh(state);
    el('div', 'menu-note', sellPanel.body,
      `Wants ${order.grams} g of dry, quality ${order.minQ}+ — ${left >= 0 ? `${left.toFixed(0)} gh left` : 'LATE'}`);
    el('div', 'menu-note', sellPanel.body,
      `You can deliver ${q.grams.toFixed(0)} g for $${q.value.toFixed(0)} (x${buyerMult(state, buyerKey).toFixed(2)}). Half the order is the minimum.`);
    const row = el('div', 'menu-row', sellPanel.body);
    const btn = el('button', 'menu-btn', row, q.grams < order.grams ? 'Deliver what I have' : 'Deliver order');
    btn.onclick = () => {
      const r = fillOrder(state, order.id);
      hud.toast(r.ok ? `${r.outcome}: +$${Math.round(r.value)}` : r.msg);
      renderSell();
    };
  }

  // ------------------------------------------------------------ phone ----
  // Tab: orders (with countdowns), contacts (trust), ledger (My Addition 5).

  function openPhone(state) {
    stateRef = state;
    renderPhone();
    show(phonePanel, 'Phone', 'phone');
  }

  function renderPhone() {
    const state = stateRef;
    const eco = state.economy;
    phonePanel.body.textContent = '';
    const tabs = el('div', 'menu-row', phonePanel.body);
    for (const t of ['orders', 'contacts', 'ledger', 'heat', 'crew', 'allies', 'journal', 'status']) {
      const b = el('button', 'menu-btn', tabs, t === phoneTab ? `[${t}]` : t);
      b.onclick = () => { phoneTab = t; renderPhone(); };
    }
    el('div', 'menu-note', phonePanel.body,
      `Cash $${Math.round(state.player.cash)} · Carrying ${carriedGrams(state).toFixed(0)}/${carryCap(state)} g · Heat ${TIER_NAMES[heatTier(state.heat)]} · Gross $${Math.round(eco.gross)}`);
    if (phoneTab === 'orders') {
      if (eco.orders.length === 0) el('div', 'menu-note', phonePanel.body, 'No open orders.');
      for (const o of eco.orders) {
        const left = o.deadline - nowGh(state);
        el('div', 'menu-row', phonePanel.body,
          `${CONFIG.economy.buyers[o.buyer].name}: ${o.grams} g, q${o.minQ}+, ` +
          `${left >= 0 ? `${left.toFixed(0)} gh left` : `LATE (${(CONFIG.economy.lateGraceGh + left).toFixed(0)} gh grace)`}`);
      }
      for (const f of eco.fees) {
        const row = el('div', 'menu-row', phonePanel.body, `A biker wants $${f.amount}.`);
        const b = el('button', 'menu-btn', row, 'Pay');
        b.onclick = () => { hud.toast(payFee(state).msg); renderPhone(); };
        const r = el('button', 'menu-btn', row, 'Refuse (he will come for you)');
        r.onclick = () => { hud.toast(refuseFee(state).msg); renderPhone(); };
      }
    } else if (phoneTab === 'heat') {
      const v = scannerView(state);
      if (!v) {
        el('div', 'menu-note', phonePanel.body, `Heat: ${TIER_NAMES[heatTier(state.heat)]}. Buy a police scanner ($250, pawn shop) for the exact number.`);
      } else {
        el('div', 'menu-note', phonePanel.body, `Heat ${v.value.toFixed(1)} (${TIER_NAMES[v.tier]}) · raid chance tonight ${(v.raidChance * 100).toFixed(0)}%`);
        if (v.log.length === 0) el('div', 'menu-note', phonePanel.body, 'No changes yet today.');
        for (const e of v.log) {
          el('div', 'menu-row', phonePanel.body, `${e.amount > 0 ? '+' : ''}${e.amount}  ${e.label}`);
        }
      }
      const hst = hs(state);
      el('div', 'menu-note', phonePanel.body,
        `Debt $${Math.round(state.player.debt || 0)} · Arrests ${state.player.arrests || 0}/${CONFIG.heat.raid.maxArrests}` +
        `${nowGh(state) < hst.lawyerUntil ? ' · Lawyer retained' : ''}`);
      if (state.player.debt > 0) {
        const b = el('button', 'menu-btn', phonePanel.body, 'Pay debt');
        b.onclick = () => { hud.toast(`Paid $${Math.round(payDebt(state))} of your debt.`); renderPhone(); };
      }
    } else if (phoneTab === 'crew') {
      renderCrewTab(state);
    } else if (phoneTab === 'allies') {
      renderAlliesTab(state);
    } else if (phoneTab === 'journal') {
      renderJournal(state);
    } else if (phoneTab === 'status') {
      renderStatus(state);
    } else if (phoneTab === 'contacts') {
      for (const key of BUYER_KEYS) {
        const b = eco.buyers[key];
        const def = CONFIG.economy.buyers[key];
        if (!b.known) { el('div', 'menu-row', phonePanel.body, '???'); continue; }
        const dorm = b.dormantUntil ? ` — gone ${Math.ceil((b.dormantUntil - nowGh(state)) / 24)} d` : '';
        el('div', 'menu-row', phonePanel.body,
          `${def.name} (${def.where} ${hrs(def.open)}-${hrs(def.close)}) trust ${buyerLevel(state, key)}/5, ${b.pts} pts${dorm}`);
      }
    } else {
      if (eco.ledger.length === 0) el('div', 'menu-note', phonePanel.body, 'Nothing yet.');
      for (const e of eco.ledger.slice().reverse()) {
        el('div', 'menu-row', phonePanel.body,
          `Day ${e.day} ${e.hour}:00  ${e.text}${e.amount ? `  ${e.amount > 0 ? '+' : '-'}$${Math.abs(Math.round(e.amount))}` : ''}` +
          // Skimming shows only once you have sold to that buyer yourself (plan A8).
          `${e.expected !== undefined && eco.buyers[e.buyer].personal ? ` (expected $${Math.round(e.expected)})` : ''}`);
      }
    }
  }

  /** Grower's journal (plan §A10): XP bar, perks, last 20 harvests as bars. */
  function renderJournal(state) {
    const body = phonePanel.body;
    const v = journalView(state);
    const span = v.nextXp === null ? 1 : v.nextXp - v.levelStart;
    const pct = v.nextXp === null ? 100 : Math.round(100 * (v.xp - v.levelStart) / span);
    el('div', 'menu-note', body, `Grower level ${v.level} · ${Math.round(v.xp)} XP` + (v.nextXp === null ? ' (max)' : ` / ${v.nextXp}`));
    const bar = el('div', 'xp-bar', body);
    el('div', 'xp-fill', bar).style.width = `${pct}%`;
    for (const p of v.perks) el('div', 'menu-row', body, `${p.got ? '[x]' : '[ ]'} L${p.level}: ${p.text}`);
    el('div', 'menu-note', body, `Last ${v.harvests.length} harvests (green = grams, gold = quality; older to the left)`);
    const chart = el('div', 'journal-chart', body);
    const maxG = Math.max(1, ...v.harvests.map((h) => h.grams));
    for (const h of v.harvests) {
      const col = el('div', 'journal-col', chart);
      col.title = `Day ${h.day} ${h.strainName}${h.generation ? ' G' + h.generation : ''}: ${h.grams.toFixed(1)} g, quality ${h.quality}`;
      el('div', 'journal-yield', col).style.height = `${Math.round(60 * h.grams / maxG)}px`;
      el('div', 'journal-quality', col).style.height = `${Math.round(60 * h.quality / 100)}px`;
    }
  }

  /** Addiction status (plan §A12): dependence, buffs, withdrawal, recovery, and the doses you carry. */
  function renderStatus(state) {
    const body = phonePanel.body;
    const s = addStatus(state);
    el('div', 'menu-note', body,
      `${s.stage.toUpperCase()}${s.withdrawal ? ' · WITHDRAWAL' : ''}${s.craving ? ' · CRAVING' : ''}${s.taper ? ' · taper kit' : ''}` +
      `${s.recovery !== null ? ` · in recovery (${Math.ceil(s.recovery)} days left)` : s.clean ? ' · clean' : ''}` +
      ` · max HP ${s.maxHp} · overdoses ${s.overdoses}/${CONFIG.addiction.overdose.fatal}`);
    for (const x of s.subs) {
      const row = el('div', 'menu-row', body,
        `${CONFIG.itemNames[x.key]}: dependence ${x.d} (${x.stage})${x.buffLeft > 0 ? ` · active ${x.buffLeft.toFixed(1)} gh` : ''}` +
        `${x.crashLeft > 0 ? ` · crash ${x.crashLeft.toFixed(1)} gh` : ''}${x.withdrawing ? ' · needs a dose' : ''}`);
      const held = state.player.inv[x.key] || 0;
      if (held > 0) el('button', 'menu-btn', row, `Take (${held})`).onclick = () => { hud.toast(useSubstance(state, x.key).msg); renderPhone(); };
    }
    const w = el('div', 'menu-row', body, `Own weed${s.weedLeft > 0 ? ` · active ${s.weedLeft.toFixed(1)} gh` : ''}`);
    el('button', 'menu-btn', w, 'Smoke 1 g').onclick = () => { hud.toast(useSubstance(state, 'weed').msg); renderPhone(); };
    el('div', 'menu-note', body, 'Keys: Z crank, X blues, V smoke your own. Clinic: taper kit and detox.');
  }

  /** Phone > Allies (plan A13): hearts, Call, hospital bill, bail, Benny's loan. */
  function renderAlliesTab(state) {
    const body = phonePanel.body;
    const al = alOf(state);
    const act = (label, row, fn) => {
      el('button', 'menu-btn', row, label).onclick = () => { hud.toast(fn().msg || ''); renderPhone(); };
    };
    if (al.loan && al.loan.status === 'asked') {
      const row = el('div', 'menu-row', body, `Benny asks for a $${CONFIG.allies.loan.amount} loan.`);
      act('Lend', row, () => answerLoan(state, true));
      act('Refuse', row, () => answerLoan(state, false));
    }
    for (const id of ALLY_KEYS) {
      const a = allyOf(state, id);
      const d = CONFIG.allies.defs[id];
      const status = a.status === 'dead' ? 'dead' : a.estranged ? 'estranged' : a.status === 'ok' ? '' : a.status;
      const row = el('div', 'menu-row', body, `${d.name} ${hearts5(hearts(state, id))} (${Math.round(a.pts)} pts)${status ? ` - ${status}` : ''}`);
      if (a.status === 'ok' && !a.estranged) {
        const c = canCall(state, id);
        const b = el('button', 'menu-btn', row, c.ok ? `Call (${arrivalSeconds(state, id)} s)` : `Call: ${c.msg}`);
        b.disabled = !c.ok;
        b.onclick = () => { hud.toast(callAlly(state, id).msg); renderPhone(); };
      }
      if (a.status === 'hospital' && a.bill) act(`Pay bill $${CONFIG.allies.downed.bill}`, row, () => payBill(state, id));
      if (a.status === 'jailed' && !a.bailed && !a.decided) {
        act(`Bail $${CONFIG.allies.arrest.bail}`, row, () => bailAlly(state, id));
        act('Leave them in', row, () => leaveInJail(state, id));
      }
    }
  }

  /** Talk to an ally at their spot: gifts and the day's favor. */
  function openAlly(state, id) {
    stateRef = state;
    renderAlly(id);
    show(allyPanel, CONFIG.allies.defs[id].name, 'ally');
  }

  function renderAlly(id) {
    const state = stateRef;
    const a = allyOf(state, id);
    allyPanel.body.textContent = '';
    el('div', 'menu-note', allyPanel.body, `${hearts5(hearts(state, id))}  ${Math.round(a.pts)} pts${a.estranged ? ' - estranged: favors only' : ''}`);
    const f = a.favor;
    if (f) {
      const row = el('div', 'menu-row', allyPanel.body, `Favor: ${describeFavor(id, f)}`);
      if (!f.accepted) el('button', 'menu-btn', row, 'Accept').onclick = () => { hud.toast(acceptFavor(state, id).msg); renderAlly(id); };
      else el('button', 'menu-btn', row, 'Done').onclick = () => { hud.toast(completeFavor(state, id).msg); renderAlly(id); };
    } else el('div', 'menu-note', allyPanel.body, 'No favor to ask right now.');
    if (!a.estranged) {
      el('div', 'menu-note', allyPanel.body, 'Give a gift (one a day):');
      for (const g of giftOptions(state, id)) {
        const row = el('div', 'menu-row', allyPanel.body);
        el('span', 'menu-item-name', row, g.label);
        el('button', 'menu-btn', row, 'Give').onclick = () => { hud.toast(giveGift(state, id, g.key).msg); renderAlly(id); };
      }
    }
  }

  function renderCrewTab(state) {
    const body = phonePanel.body;
    const c = crewOf(state);
    const act = (label, row, fn) => {
      el('button', 'menu-btn', row, label).onclick = () => { hud.toast(fn().msg || ''); renderPhone(); };
    };
    if (c.members.length === 0) el('div', 'menu-note', body, 'No crew. Check the hiring board at the bar.');
    for (const m of c.members) {
      const d = describe(state, m);
      const row = el('div', 'menu-row', body,
        `${m.name} (${m.role}, ${m.status}) loyalty ${m.loyalty}` +
        (d.known ? ` · Rel ${d.rel} Disc ${d.disc} Greed ${d.greed} Nerve ${d.nerve}` : ` · ${d.rel}, ${d.disc}, ${d.greed}, ${d.nerve}`));
      act('Bonus $100', row, () => giveBonus(state, m.id));
      if (m.status === 'jailed' && !m.bailed) act('Bail $800', row, () => bailOut(state, m.id));
      act('Dock pay', row, () => dockPay(state, m.id));
      act('Threaten', row, () => threaten(state, m.id));
      act('Fire', row, () => fire(state, m.id));
    }
    for (const o of state.objects.filter((x) => x.kind === 'rack')) {
      const row = el('div', 'menu-row', body, `Rack at x${o.x}: ${o.outgoing ? 'OUTGOING (runners take from it)' : 'normal'}`);
      act('Toggle outgoing', row, () => ({ msg: toggleOutgoing(state, o.id) ? 'Marked outgoing.' : 'Unmarked.' }));
    }
    const mk = el('div', 'menu-row', body, `Guard patrol markers: x${c.markers[0]} and x${c.markers[1]}`);
    const here = () => (state.player.x + state.player.w / 2) / CONFIG.world.tile;
    act('Marker A here', mk, () => { placeMarker(state, 0, here()); return { msg: 'Marker A set.' }; });
    act('Marker B here', mk, () => { placeMarker(state, 1, here()); return { msg: 'Marker B set.' }; });
    const dale = rv(state).aggression;
    const row = el('div', 'menu-row', body, `Dale: ${dale >= 70 ? 'furious' : dale >= 40 ? 'angry' : 'restless'}`);
    act(`Pay tribute $${CONFIG.threats.rival.tribute.cost}`, row, () => payTribute(state));
  }

  // ----------------------------------------------- notices, game over -----
  // Raid/patrol/arrest reports and the Prison game over. Notices pause the
  // sim until dismissed; game over offers "Load last autosave" (plan §A15).

  const noticeQueue = [];
  function openNotice(title, lines) {
    noticeQueue.push({ title, lines });
    if (open !== 'notice') showNextNotice();
  }
  function showNextNotice() {
    const n = noticeQueue.shift();
    if (!n) { closeAll(); return; }
    noticePanel.body.textContent = '';
    for (const l of n.lines) el('div', 'menu-report-line', noticePanel.body, l);
    const row = el('div', 'menu-row', noticePanel.body);
    el('button', 'menu-btn', row, 'OK').onclick = () => showNextNotice();
    show(noticePanel, n.title, 'notice');
  }
  function openGameOver(reason) {
    noticePanel.body.textContent = '';
    el('div', 'menu-report-line', noticePanel.body,
      reason === 'prison' ? 'Third arrest. The judge is not feeling generous.'
        : reason === 'overdose' ? 'A third overdose. This time nobody gets you to the clinic in time.'
        : reason === 'fugitive' ? 'You killed an officer. Fugitive: the SWAT team came at dawn.' : 'Game over.');
    const row = el('div', 'menu-row', noticePanel.body);
    el('button', 'menu-btn', row, 'Load last autosave').onclick = () =>
      window.dispatchEvent(new CustomEvent('backforty:loadauto'));
    show(noticePanel, 'GAME OVER', 'gameover');
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
    const cuts = state.player.cuttings || [];
    if (cuts.length > 0) el('div', 'menu-note', invPanel.body, `Cuttings x${cuts.length} (C cuts one from a vegetative plant; E plants it first)`);
    if (keys.length === 0 && cuts.length === 0) el('div', 'menu-note', invPanel.body, 'Empty.');
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
    // Sound: master / effects / music sliders and mute (plan §B8).
    const vols = audio.getVolumes();
    for (const [kind, label] of [['master', 'Master'], ['sfx', 'Effects'], ['music', 'Music']]) {
      const r = el('div', 'menu-row', pausePanel.body, `${label} `);
      const sl = el('input', '', r);
      sl.type = 'range'; sl.min = 0; sl.max = 1; sl.step = 0.05; sl.value = vols[kind];
      sl.oninput = () => audio.setVolume(kind, +sl.value);
    }
    const mr = el('div', 'menu-row', pausePanel.body, 'Mute ');
    const mute = el('input', '', mr);
    mute.type = 'checkbox'; mute.checked = vols.muted;
    mute.onchange = () => audio.setMuted(mute.checked);
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
    el('div', 'plant-panel-title', hoverPanel, `${plant.strainName}${plant.generation ? ` · G${plant.generation}` : ''}`);
    const base = baseGenome(plant.strainKey);
    for (const k of ['Y', 'P', 'R', 'S']) {
      const r = el('div', 'trait-row', hoverPanel, k);
      const bar = el('div', 'trait-bar', r);
      el('div', 'trait-fill', bar).style.width = `${plant.genome[k]}%`;
      el('div', 'trait-ghost', bar).style.left = `${base[k]}%`;
      el('span', '', r, ` ${plant.genome[k]}`);
    }
    const rows = [
      `Stage: ${stage}${stage === 'ripe' ? ' — harvest now (E)' : ''}`,
      `Health: ${Math.round(plant.health)} (avg ${Math.round(avgHealthOf(plant))}, care ${(careOf(plant) * 100) | 0}%)`,
    ];
    // Without tools you see bands only; tools give exact numbers (plan §A4).
    rows.push(inv.moisture_meter || hasLevel(state, CONFIG.mastery.exactMoistureLevel)
      ? `Moisture: ${plant.moisture.toFixed(0)}`
      : `Moisture: ${moistureBand(plant.moisture)}`);
    rows.push(inv.ph_meter
      ? `pH: ${plant.ph.toFixed(2)}`
      : `pH: ${phBand(plant.ph)}`);
    rows.push(`Nutrients: ${nutrientBand(plant.nutrients)}`);
    if (inv.loupe || hasLevel(state, CONFIG.mastery.exactRipeLevel)) {
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
    openShop, openSell, openAlly, openInventory, openPause, openPhone, openNotice, openGameOver,
    queueReport,
    closeAll,
    anyOpen: () => open !== null,
    isOpen: (kind) => open === kind,
    tick,
  };
}

const TIER_NAMES = ['Cold', 'Warm', 'Hot', 'Burning'];

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
