'use strict';

/* ---------- Constants and helpers ---------- */

const STATUSES = ['Not started', 'In Progress', 'Shipped', 'Complete'];
const CONFIG_KEY = 'print-tracker-config';
const LOCAL_DATA_KEY = 'print-tracker-local-data';
const SHEETJS_URL = 'vendor/xlsx.full.min.js'; // SheetJS 0.18.5, Apache-2.0

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r2 = (n) => Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;
const sum = (arr) => arr.reduce((a, b) => a + (Number(b) || 0), 0);
const cents = (n) => Math.round((Number(n) || 0) * 100);
const fmt = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });
const money = (n) => fmt.format(r2(n)).replace('CA$', '$');
const today = () => new Date().toLocaleDateString('en-CA');
const uid = (p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const statusClass = (s) => 'st-' + String(s).toLowerCase().replace(/\s+/g, '-');
const statusChip = (s) => `<span class="status ${statusClass(s)}">${esc(s)}</span>`;
const num = (v) => (v === '' || v == null ? 0 : Number(v));

function readConfig() {
  try { return JSON.parse(localStorage.getItem(CONFIG_KEY)) || null; } catch { return null; }
}
function writeConfig(cfg) {
  try {
    if (cfg) localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
    else localStorage.removeItem(CONFIG_KEY);
  } catch { /* storage unavailable */ }
}

/* Split an amount into n parts that add up exactly to the cent. */
function splitEven(amount, n) {
  if (n <= 0) return [];
  const total = cents(amount);
  const base = Math.trunc(total / n);
  let rem = total - base * n;
  return Array.from({ length: n }, () => {
    let c = base;
    if (rem > 0) { c++; rem--; } else if (rem < 0) { c--; rem++; }
    return c / 100;
  });
}

/* ---------- Storage: GitHub repo (synced) or this browser only ---------- */

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

class ConflictError extends Error {}

class GitHubStore {
  constructor({ owner, repo, token, path }) {
    Object.assign(this, { owner, repo, token, path: path || 'data.json' });
    this.sha = null;
    this.label = `${owner}/${repo}`;
  }
  api(p) { return `https://api.github.com/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}${p}`; }
  headers(extra = {}) {
    return { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...extra };
  }
  async errorText(res) {
    let msg = `${res.status} ${res.statusText}`;
    try { const j = await res.json(); if (j.message) msg += `: ${j.message}`; } catch { /* not json */ }
    return msg;
  }
  async load() {
    const repoRes = await fetch(this.api(''), { headers: this.headers(), cache: 'no-store' });
    if (repoRes.status === 401) throw new Error('GitHub rejected the token. It may have expired; create a new one in Settings.');
    if (repoRes.status === 404) throw new Error(`Can't see ${this.label}. Check the owner and repo name, and that the token has access to this repository.`);
    if (!repoRes.ok) throw new Error(await this.errorText(repoRes));
    const res = await fetch(this.api(`/contents/${this.path}`), { headers: this.headers(), cache: 'no-store' });
    if (res.status === 404) { this.sha = null; return null; }
    if (!res.ok) throw new Error(await this.errorText(res));
    const j = await res.json();
    this.sha = j.sha;
    let content = j.content;
    if (!content) { // files over 1 MB come back without content
      const blob = await fetch(this.api(`/git/blobs/${j.sha}`), { headers: this.headers(), cache: 'no-store' });
      if (!blob.ok) throw new Error(await this.errorText(blob));
      content = (await blob.json()).content;
    }
    return JSON.parse(b64decode(content));
  }
  async save(data, message) {
    const body = { message, content: b64encode(JSON.stringify(data, null, 1) + '\n') };
    if (this.sha) body.sha = this.sha;
    const res = await fetch(this.api(`/contents/${this.path}`), {
      method: 'PUT', headers: this.headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(body),
    });
    if (res.status === 409 || (res.status === 422 && !this.sha)) throw new ConflictError('The data was changed on another device.');
    if (!res.ok) throw new Error(await this.errorText(res));
    this.sha = (await res.json()).content.sha;
  }
}

class LocalStore {
  constructor() { this.label = 'this browser only'; }
  async load() {
    try { const raw = localStorage.getItem(LOCAL_DATA_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
  }
  async save(data) {
    try { localStorage.setItem(LOCAL_DATA_KEY, JSON.stringify(data)); } catch (e) { throw new Error('Could not save in this browser: ' + e.message); }
  }
}

function emptyData() {
  return {
    version: 1,
    nextIds: { order: 1, shipment: 1, payment: 1 },
    settings: {
      defaultCustomerId: 'c-dbc',
      labourRates: [{ from: '2000-01-01', rate: 30 }],
      currency: 'CAD',
    },
    customers: [{ id: 'c-dbc', name: 'Dutch Boys Chocolate', contact: '', email: '', notes: '' }],
    filaments: [],
    orders: [],
    shipments: [],
    payments: [],
  };
}

/* ---------- Calculations ---------- */

function rateOn(data, date) {
  const rates = [...data.settings.labourRates].sort((a, b) => a.from.localeCompare(b.from));
  const d = date || today();
  let rate = rates.length ? rates[0].rate : 0;
  for (const r of rates) if (r.from <= d) rate = r.rate;
  return Number(rate) || 0;
}

const perGram = (f) => (f && Number(f.spoolGrams) ? Number(f.spoolCost) / Number(f.spoolGrams) : 0);

function lineCost(data, line) {
  const f = data.filaments.find((x) => x.id === line.filamentId);
  return num(line.grams) * (num(line.qty) || 1) * perGram(f);
}

/* Builds every derived number the screens need in one pass. */
function ledger(data) {
  const shipOf = new Map();
  const shipShare = new Map();
  for (const s of data.shipments) {
    const ids = s.orderIds.filter((id) => data.orders.some((o) => o.id === id));
    const parts = splitEven(s.cost, ids.length);
    ids.forEach((id, i) => { shipOf.set(id, s); shipShare.set(id, parts[i]); });
  }

  const orders = new Map();
  for (const o of data.orders) {
    const computed = {
      labour: r2(num(o.hours) * rateOn(data, o.received)),
      materials: r2(sum((o.filaments || []).map((l) => lineCost(data, l)))),
      shipping: shipShare.get(o.id) || 0,
    };
    const labour = o.labourOverride ?? computed.labour;
    const materials = o.materialsOverride ?? computed.materials;
    const shipping = o.shippingOverride ?? computed.shipping;
    orders.set(o.id, {
      computed, labour, materials, shipping,
      total: r2(labour + materials + shipping),
      shipment: shipOf.get(o.id) || null,
      paid: 0, overage: 0, payments: [],
    });
  }

  // Apply payments in the order they were entered. Each payment first covers
  // what its orders still owe; anything extra is overage, split evenly across
  // that payment's orders. A short payment is shared in proportion to what
  // each order owes.
  const payments = new Map();
  for (const p of [...data.payments].sort((a, b) => a.number - b.number)) {
    const ids = p.orderIds.filter((id) => orders.has(id));
    const remaining = ids.map((id) => Math.max(0, r2(orders.get(id).total - orders.get(id).paid)));
    const owed = r2(sum(remaining));
    const amount = num(p.amount);
    const alloc = [];
    if (amount >= owed) {
      const extra = splitEven(amount - owed, ids.length);
      ids.forEach((id, i) => alloc.push({ orderId: id, applied: remaining[i], overage: extra[i] || 0 }));
    } else {
      ids.forEach((id, i) => alloc.push({ orderId: id, applied: owed ? r2(amount * remaining[i] / owed) : 0, overage: 0 }));
    }
    for (const a of alloc) {
      const o = orders.get(a.orderId);
      o.paid = r2(o.paid + a.applied);
      o.overage = r2(o.overage + a.overage);
      o.payments.push(p);
    }
    payments.set(p.id, { owed, overage: r2(amount - owed), alloc });
  }
  for (const o of orders.values()) o.balance = r2(o.total - o.paid);
  return { orders, payments };
}

/* ---------- App state ---------- */

let store = null;
let db = null;
let busy = false;

function toast(msg, ms = 2500) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

function setBusy(on, label) {
  busy = on;
  $$('button').forEach((b) => { b.disabled = on; });
  $('#sync').textContent = on ? (label || 'Saving…') : (store ? `Data: ${store.label}` : '');
}

/* Apply a change to a copy of the data, save it, then keep it. */
async function commit(message, mutate) {
  if (busy) return false;
  const next = structuredClone(db);
  mutate(next);
  setBusy(true);
  try {
    await store.save(next, message);
    db = next;
    toast('Saved');
    return true;
  } catch (e) {
    if (e instanceof ConflictError) {
      alert('Your data was changed on another device since this page loaded. The latest version will now load; please make your change again.');
      await loadData();
      route();
    } else {
      alert('Save failed: ' + e.message);
    }
    return false;
  } finally {
    setBusy(false);
  }
}

async function loadData() {
  setBusy(true, 'Loading…');
  try {
    db = await store.load();
    if (!db) {
      db = emptyData();
      await store.save(db, 'Create tracker data file');
    }
  } finally {
    setBusy(false);
  }
}

const customerName = (id) => db.customers.find((c) => c.id === id)?.name || '—';
const filamentName = (id) => db.filaments.find((f) => f.id === id)?.name || '?';
const orderById = (id) => db.orders.find((o) => o.id === id);
const sortOrders = (list) => [...list].sort((a, b) => (b.received || '').localeCompare(a.received || '') || String(b.number).localeCompare(String(a.number), undefined, { numeric: true }));

/* ---------- Router ---------- */

function parseHash() {
  const [path, query] = (location.hash.slice(1) || '/orders').split('?');
  const parts = path.split('/').filter(Boolean);
  return { parts, params: new URLSearchParams(query || '') };
}

function route() {
  const app = $('#app');
  if (!store || !db) { $('#nav').hidden = true; renderSetup(app); return; }
  $('#nav').hidden = false;
  const { parts, params } = parseHash();
  const [view, id] = parts;
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.tab === view || (view === 'order' && a.dataset.tab === 'orders') || (view === 'shipment' && a.dataset.tab === 'shipments') || (view === 'payment' && a.dataset.tab === 'payments')));
  const views = {
    orders: () => renderOrders(app, params),
    order: () => renderOrderForm(app, id),
    shipments: () => renderShipments(app),
    shipment: () => renderShipmentForm(app, id),
    payments: () => renderPayments(app),
    payment: () => renderPaymentForm(app, id),
    statement: () => renderStatement(app, params),
    customers: () => renderCustomers(app),
    filaments: () => renderFilaments(app),
    settings: () => renderSettings(app),
  };
  (views[view] || views.orders)();
  window.scrollTo(0, 0);
}

/* ---------- Setup / sign in ---------- */

function renderSetup(app, error) {
  const cfg = readConfig() || {};
  app.innerHTML = `
    <h1>Connect your data</h1>
    ${error ? `<p class="error">${esc(error)}</p>` : ''}
    <div class="panel">
      <p>Your orders live in your private GitHub repository. Enter its name and a GitHub access token once on each device you use.</p>
      <form id="setup">
        <div class="row">
          <label>GitHub owner<input name="owner" required value="${esc(cfg.owner || 'Drewdrew32')}" autocomplete="username"></label>
          <label>Data repository<input name="repo" required value="${esc(cfg.repo || 'print-tracker-data')}"></label>
        </div>
        <div class="row" style="margin-top:.75rem">
          <label class="wide">Access token<input name="token" type="password" required placeholder="github_pat_…" value="${esc(cfg.token || '')}" autocomplete="current-password"></label>
        </div>
        <p class="small muted">Create a fine-grained token at GitHub → Settings → Developer settings → Fine-grained tokens. Give it access to <b>only</b> the data repository, with <b>Contents: Read and write</b>. The token is stored only in this browser.</p>
        <div class="toolbar"><button class="primary" type="submit">Connect</button><span class="spacer"></span><button type="button" class="link" id="local">Try it without GitHub (this browser only)</button></div>
      </form>
    </div>`;
  $('#setup').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const cfg2 = { mode: 'github', owner: f.get('owner').trim(), repo: f.get('repo').trim(), token: f.get('token').trim() };
    await connect(cfg2);
  };
  $('#local').onclick = () => connect({ mode: 'local' });
}

async function connect(cfg) {
  store = cfg.mode === 'local' ? new LocalStore() : new GitHubStore(cfg);
  try {
    await loadData();
    writeConfig(cfg);
    route();
  } catch (e) {
    store = null; db = null;
    renderSetup($('#app'), e.message);
  }
}

/* ---------- Orders ---------- */

function renderOrders(app, params) {
  const L = ledger(db);
  const filter = params.get('status') || 'Open';
  const q = (params.get('q') || '').toLowerCase();
  const year = new Date().getFullYear().toString();
  const multiCustomer = new Set(db.orders.map((o) => o.customerId)).size > 1;

  const matches = (o) => {
    const c = L.orders.get(o.id);
    if (filter === 'Open' && o.status === 'Complete') return false;
    if (filter === 'Unpaid' && !(c.balance > 0.004)) return false;
    if (STATUSES.includes(filter) && o.status !== filter) return false;
    if (q && !`${o.number} ${o.description} ${o.comments} ${customerName(o.customerId)}`.toLowerCase().includes(q)) return false;
    return true;
  };
  const list = sortOrders(db.orders.filter(matches));
  const all = [...L.orders.values()];
  const outstanding = sum(all.map((c) => Math.max(0, c.balance)));
  const receivedThisYear = sum(db.payments.filter((p) => (p.date || '').startsWith(year)).map((p) => p.amount));
  const openCount = db.orders.filter((o) => o.status !== 'Complete').length;
  const overage = sum(all.map((c) => c.overage));

  const counts = Object.fromEntries(STATUSES.map((s) => [s, db.orders.filter((o) => o.status === s).length]));
  const chip = (key, text) => `<button class="chip ${filter === key ? 'on' : ''}" data-filter="${esc(key)}">${esc(text)}</button>`;

  const rows = list.map((o) => {
    const c = L.orders.get(o.id);
    const fil = (o.filaments || []).map((l) => filamentName(l.filamentId)).join(', ');
    return `<tr class="click" data-id="${esc(o.id)}">
      <td>${esc(o.number)}</td>
      <td class="hide-sm">${esc(o.received || '')}</td>
      ${multiCustomer ? `<td>${esc(customerName(o.customerId))}</td>` : ''}
      <td>${esc(o.description)}</td>
      <td class="hide-sm">${esc(fil)}</td>
      <td class="num hide-sm">${o.hours || ''}</td>
      <td class="num">${money(c.total)}</td>
      <td class="num ${c.balance > 0.004 ? 'neg' : ''}">${c.balance > 0.004 ? money(c.balance) : '—'}</td>
      <td>${statusChip(o.status)}</td>
    </tr>`;
  }).join('');

  app.innerHTML = `
    <div class="cards">
      <div class="card"><div class="label">Open orders</div><div class="value">${openCount}</div></div>
      <div class="card"><div class="label">Waiting on payment</div><div class="value">${money(outstanding)}</div></div>
      <div class="card"><div class="label">Received in ${year}</div><div class="value">${money(receivedThisYear)}</div></div>
      <div class="card"><div class="label">Overage received (all time)</div><div class="value">${money(overage)}</div></div>
    </div>
    <div class="toolbar">
      <h1 style="margin:0">Orders</h1><span class="spacer"></span>
      <a class="btn primary" href="#/order/new">New order</a>
    </div>
    <div class="toolbar">
      <div class="chips">
        ${chip('Open', 'Open')}
        ${STATUSES.map((s) => chip(s, `${s} (${counts[s]})`)).join('')}
        ${chip('Unpaid', 'Unpaid')}
        ${chip('All', 'All')}
      </div>
      <span class="spacer"></span>
      <input id="search" type="search" placeholder="Search orders" value="${esc(q)}" style="max-width:240px">
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>#</th><th class="hide-sm">Received</th>${multiCustomer ? '<th>Customer</th>' : ''}<th>Description</th><th class="hide-sm">Filament</th><th class="num hide-sm">Hrs</th><th class="num">Total</th><th class="num">Owing</th><th>Status</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="9" class="muted">No orders match.</td></tr>`}</tbody>
    </table></div>`;

  const go = (status, query) => {
    const p = new URLSearchParams();
    if (status && status !== 'Open') p.set('status', status);
    if (query) p.set('q', query);
    const qs = p.toString();
    history.replaceState(null, '', '#/orders' + (qs ? '?' + qs : ''));
    renderOrders(app, p);
  };
  $$('[data-filter]', app).forEach((b) => { b.onclick = () => go(b.dataset.filter, $('#search').value); });
  $('#search').oninput = (e) => {
    clearTimeout(renderOrders.t);
    renderOrders.t = setTimeout(() => { go(filter, e.target.value); const s = $('#search'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }, 250);
  };
  $$('tr[data-id]', app).forEach((tr) => { tr.onclick = () => { location.hash = `#/order/${tr.dataset.id}`; }; });
}

function nextOrderNumber() {
  let n = db.nextIds.order || 1;
  const used = new Set(db.orders.map((o) => String(o.number)));
  while (used.has(String(n))) n++;
  return String(n);
}

function customerOptions(selected) {
  return db.customers.map((c) => `<option value="${esc(c.id)}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}</option>`).join('')
    + '<option value="__new">+ Add new customer…</option>';
}

function filamentOptions(selected) {
  const opts = db.filaments.map((f) => `<option value="${esc(f.id)}" ${f.id === selected ? 'selected' : ''}>${esc(f.name)} (${money(perGram(f) * 1000)}/kg)</option>`).join('');
  return `<option value="">Choose filament…</option>${opts}`;
}

function lineHtml(line = {}) {
  return `<div class="line">
    <label>Filament<select name="filamentId">${filamentOptions(line.filamentId)}</select></label>
    <label class="narrow">Grams each<input name="grams" type="number" step="0.01" min="0" value="${esc(line.grams ?? '')}"></label>
    <label class="narrow">Quantity<input name="qty" type="number" step="1" min="1" value="${esc(line.qty ?? 1)}"></label>
    <button type="button" class="link danger remove-line" title="Remove">Remove</button>
  </div>`;
}

function renderOrderForm(app, id) {
  const isNew = !id || id === 'new';
  const o = isNew
    ? { id: uid('o'), number: nextOrderNumber(), customerId: db.settings.defaultCustomerId, received: today(), description: '', hours: '', filaments: [{ qty: 1 }], status: 'Not started', comments: '' }
    : orderById(id);
  if (!o) { app.innerHTML = '<p>Order not found. <a href="#/orders">Back to orders</a></p>'; return; }
  const L = ledger(db);
  const c = L.orders.get(o.id);
  const hasOverride = ['labourOverride', 'materialsOverride', 'shippingOverride'].some((k) => o[k] != null);

  app.innerHTML = `
    <div class="toolbar"><a href="#/orders">← Orders</a></div>
    <h1>${isNew ? 'New order' : `Order ${esc(o.number)}`}</h1>
    <form id="order" class="panel">
      <div class="row">
        <label class="narrow">Order #<input name="number" required value="${esc(o.number)}"></label>
        <label>Customer<select name="customerId">${customerOptions(o.customerId)}</select></label>
        <label class="narrow" style="flex-basis:150px">Received<input name="received" type="date" value="${esc(o.received || '')}"></label>
        <label class="narrow" style="flex-basis:150px">Status<select name="status">${STATUSES.map((s) => `<option ${s === o.status ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
      </div>
      <div class="row" id="new-customer" hidden style="margin-top:.75rem">
        <label>New customer name<input name="newCustomer" placeholder="Name"></label>
      </div>
      <div class="row" style="margin-top:.75rem">
        <label class="wide">Description<input name="description" required value="${esc(o.description)}"></label>
        <label class="narrow">Hours<input name="hours" type="number" step="0.25" min="0" value="${esc(o.hours)}"></label>
      </div>
      <h2>Filament</h2>
      <div class="lines" id="lines">${(o.filaments && o.filaments.length ? o.filaments : [{ qty: 1 }]).map(lineHtml).join('')}</div>
      <button type="button" id="add-line">+ Add another filament</button>
      <h2>Comments</h2>
      <textarea name="comments">${esc(o.comments)}</textarea>

      <h2>Cost</h2>
      ${hasOverride ? `<div class="note">This order was imported with the amounts you billed at the time, so they're locked. <label style="display:inline;color:inherit"><input type="checkbox" name="unlock"> Recalculate from hours, grams and shipping instead</label></div>` : ''}
      <div class="calc" id="calc"></div>
      ${c && c.shipment ? `<p class="small muted">Shipped in <a href="#/shipment/${esc(c.shipment.id)}">shipment ${esc(c.shipment.number)}</a> on ${esc(c.shipment.date)}${c.shipment.orderIds.length > 1 ? `, shared by ${c.shipment.orderIds.length} orders` : ''}.</p>` : ''}
      ${c && c.payments.length ? `<p class="small muted">Payments: ${c.payments.map((p) => `<a href="#/payment/${esc(p.id)}">#${esc(p.number)}</a>`).join(', ')}</p>` : ''}

      <div class="toolbar" style="margin-top:1rem">
        <button class="primary" type="submit">${isNew ? 'Save order' : 'Save changes'}</button>
        <a class="btn" href="#/statement?orders=${esc(o.id)}">Statement</a>
        <span class="spacer"></span>
        ${isNew ? '' : '<button type="button" class="danger" id="delete">Delete</button>'}
      </div>
    </form>`;

  const form = $('#order');
  const readLines = () => $$('#lines .line').map((el) => ({
    filamentId: $('[name=filamentId]', el).value,
    grams: num($('[name=grams]', el).value),
    qty: Math.max(1, Math.round(num($('[name=qty]', el).value) || 1)),
  })).filter((l) => l.filamentId || l.grams);

  const draft = () => {
    const f = new FormData(form);
    const d = { ...o, number: f.get('number').trim(), customerId: f.get('customerId'), received: f.get('received'), status: f.get('status'), description: f.get('description').trim(), hours: num(f.get('hours')), comments: f.get('comments'), filaments: readLines() };
    if (f.get('unlock')) { delete d.labourOverride; delete d.materialsOverride; delete d.shippingOverride; }
    return d;
  };

  const updateCalc = () => {
    const d = draft();
    const trial = { ...db, orders: [...db.orders.filter((x) => x.id !== d.id), d] };
    const k = ledger(trial).orders.get(d.id);
    const rate = rateOn(db, d.received);
    const locked = (key) => (d[key] != null ? ' <span class="muted small">(as billed)</span>' : '');
    $('#calc').innerHTML = `
      <span>Labour ${d.labourOverride == null ? `<span class="muted small">${d.hours || 0} h × ${money(rate)}</span>` : ''}${locked('labourOverride')}</span><span class="num">${money(k.labour)}</span>
      ${d.filaments.map((l) => `<span class="muted small">&nbsp;&nbsp;${esc(filamentName(l.filamentId))}: ${l.grams} g × ${l.qty}</span><span class="num muted small">${money(lineCost(db, l))}</span>`).join('')}
      <span>Materials${locked('materialsOverride')}</span><span class="num">${money(k.materials)}</span>
      <span>Shipping share${locked('shippingOverride')}</span><span class="num">${money(k.shipping)}</span>
      <span class="total">Total</span><span class="num total">${money(k.total)}</span>
      ${k.paid ? `<span>Paid</span><span class="num">${money(k.paid)}</span><span>Owing</span><span class="num ${k.balance > 0.004 ? 'neg' : ''}">${money(Math.max(0, k.balance))}</span>` : ''}
      ${k.overage ? `<span>Overage received</span><span class="num pos">${money(k.overage)}</span>` : ''}`;
  };

  form.addEventListener('input', updateCalc);
  form.addEventListener('change', updateCalc);
  $('[name=customerId]', form).onchange = (e) => { $('#new-customer').hidden = e.target.value !== '__new'; };
  $('#add-line').onclick = () => { $('#lines').insertAdjacentHTML('beforeend', lineHtml({ qty: 1 })); updateCalc(); };
  $('#lines').onclick = (e) => {
    if (e.target.classList.contains('remove-line')) { e.target.closest('.line').remove(); updateCalc(); }
  };
  updateCalc();

  form.onsubmit = async (e) => {
    e.preventDefault();
    const d = draft();
    if (db.orders.some((x) => x.id !== d.id && String(x.number) === d.number)) { alert(`Order #${d.number} already exists.`); return; }
    let newCustomer = null;
    if (d.customerId === '__new') {
      const name = new FormData(form).get('newCustomer').trim();
      if (!name) { alert('Enter the new customer\'s name.'); return; }
      newCustomer = { id: uid('c'), name, contact: '', email: '', notes: '' };
      d.customerId = newCustomer.id;
    }
    const ok = await commit(isNew ? `Add order ${d.number}` : `Update order ${d.number}`, (data) => {
      if (newCustomer) data.customers.push(newCustomer);
      const i = data.orders.findIndex((x) => x.id === d.id);
      if (i >= 0) data.orders[i] = d; else data.orders.push(d);
      if (/^\d+$/.test(d.number) && Number(d.number) >= (data.nextIds.order || 1)) data.nextIds.order = Number(d.number) + 1;
    });
    if (ok) location.hash = '#/orders';
  };

  if (!isNew) {
    $('#delete').onclick = async () => {
      if (!confirm(`Delete order ${o.number}? It will also be removed from any shipment or payment.`)) return;
      const ok = await commit(`Delete order ${o.number}`, (data) => {
        data.orders = data.orders.filter((x) => x.id !== o.id);
        data.shipments.forEach((s) => { s.orderIds = s.orderIds.filter((x) => x !== o.id); });
        data.payments.forEach((p) => { p.orderIds = p.orderIds.filter((x) => x !== o.id); });
      });
      if (ok) location.hash = '#/orders';
    };
  }
}

/* ---------- Shipments ---------- */

function orderLabel(o) {
  return `#${esc(o.number)} ${esc(o.description)} <span class="muted small">${esc(o.received || '')}</span>`;
}

function renderShipments(app) {
  const list = [...db.shipments].sort((a, b) => b.number - a.number);
  app.innerHTML = `
    <div class="toolbar"><h1 style="margin:0">Shipments</h1><span class="spacer"></span><a class="btn primary" href="#/shipment/new">New shipment</a></div>
    <div class="table-wrap"><table>
      <thead><tr><th>#</th><th>Date</th><th>Orders</th><th class="num">Cost</th><th class="num">Each</th><th class="hide-sm">Tracking</th></tr></thead>
      <tbody>${list.map((s) => {
        const orders = s.orderIds.map(orderById).filter(Boolean);
        return `<tr class="click" data-id="${esc(s.id)}"><td>${esc(s.number)}</td><td>${esc(s.date)}</td>
          <td>${orders.map((o) => esc(o.number)).join(', ')}</td><td class="num">${money(s.cost)}</td>
          <td class="num">${orders.length > 1 ? money(s.cost / orders.length) : '—'}</td><td class="hide-sm">${esc(s.tracking)}</td></tr>`;
      }).join('') || '<tr><td colspan="6" class="muted">No shipments yet.</td></tr>'}</tbody>
    </table></div>`;
  $$('tr[data-id]', app).forEach((tr) => { tr.onclick = () => { location.hash = `#/shipment/${tr.dataset.id}`; }; });
}

function renderShipmentForm(app, id) {
  const isNew = !id || id === 'new';
  const s = isNew
    ? { id: uid('s'), number: db.nextIds.shipment || db.shipments.length + 1, date: today(), cost: '', tracking: '', orderIds: [], notes: '' }
    : db.shipments.find((x) => x.id === id);
  if (!s) { app.innerHTML = '<p>Shipment not found. <a href="#/shipments">Back</a></p>'; return; }
  const inOther = new Set(db.shipments.filter((x) => x.id !== s.id).flatMap((x) => x.orderIds));
  const candidates = sortOrders(db.orders.filter((o) => s.orderIds.includes(o.id) || (!inOther.has(o.id) && o.status !== 'Complete')));

  app.innerHTML = `
    <div class="toolbar"><a href="#/shipments">← Shipments</a></div>
    <h1>${isNew ? 'New shipment' : `Shipment ${esc(s.number)}`}</h1>
    <form id="ship" class="panel">
      <div class="row">
        <label class="narrow">Shipment #<input name="number" type="number" required value="${esc(s.number)}"></label>
        <label class="narrow" style="flex-basis:160px">Ship date<input name="date" type="date" required value="${esc(s.date)}"></label>
        <label class="narrow">Cost<input name="cost" type="number" step="0.01" min="0" required value="${esc(s.cost)}"></label>
        <label>Tracking #<input name="tracking" value="${esc(s.tracking)}"></label>
      </div>
      <h2>Orders in this box</h2>
      <p class="small muted">Shows orders that aren't complete and aren't already in another shipment. The cost is split evenly across the orders you tick.</p>
      <div class="checklist">${candidates.map((o) => `<label><input type="checkbox" name="order" value="${esc(o.id)}" ${s.orderIds.includes(o.id) ? 'checked' : ''}> ${orderLabel(o)} ${statusChip(o.status)}</label>`).join('') || '<p class="muted">No orders waiting to ship.</p>'}</div>
      <p id="split" class="small"></p>
      <label style="color:var(--text)"><input type="checkbox" name="markShipped" checked> Mark these orders as Shipped</label>
      <label style="margin-top:.75rem">Notes<textarea name="notes">${esc(s.notes)}</textarea></label>
      <div class="toolbar" style="margin-top:1rem">
        <button class="primary" type="submit">Save shipment</button><span class="spacer"></span>
        ${isNew ? '' : '<button type="button" class="danger" id="delete">Delete</button>'}
      </div>
    </form>`;

  const form = $('#ship');
  const picked = () => $$('[name=order]:checked', form).map((x) => x.value);
  const update = () => {
    const ids = picked();
    const cost = num($('[name=cost]', form).value);
    $('#split').textContent = ids.length ? `${ids.length} order${ids.length > 1 ? 's' : ''}: ${splitEven(cost, ids.length).map(money).join(' + ')}` : 'No orders ticked yet.';
  };
  form.addEventListener('input', update);
  update();

  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const d = { ...s, number: Number(f.get('number')), date: f.get('date'), cost: r2(num(f.get('cost'))), tracking: f.get('tracking').trim(), notes: f.get('notes'), orderIds: picked() };
    if (!d.orderIds.length && !confirm('No orders are ticked. Save anyway?')) return;
    const ok = await commit(`${isNew ? 'Add' : 'Update'} shipment ${d.number}`, (data) => {
      const i = data.shipments.findIndex((x) => x.id === d.id);
      if (i >= 0) data.shipments[i] = d; else data.shipments.push(d);
      if (d.number >= (data.nextIds.shipment || 1)) data.nextIds.shipment = d.number + 1;
      if (f.get('markShipped')) data.orders.forEach((o) => { if (d.orderIds.includes(o.id) && o.status !== 'Complete') o.status = 'Shipped'; });
    });
    if (ok) location.hash = '#/shipments';
  };
  if (!isNew) {
    $('#delete').onclick = async () => {
      if (!confirm(`Delete shipment ${s.number}?`)) return;
      if (await commit(`Delete shipment ${s.number}`, (data) => { data.shipments = data.shipments.filter((x) => x.id !== s.id); })) location.hash = '#/shipments';
    };
  }
}

/* ---------- Payments ---------- */

function renderPayments(app) {
  const L = ledger(db);
  const list = [...db.payments].sort((a, b) => b.number - a.number);
  app.innerHTML = `
    <div class="toolbar"><h1 style="margin:0">Payments</h1><span class="spacer"></span><a class="btn primary" href="#/payment/new">Record payment</a></div>
    <div class="table-wrap"><table>
      <thead><tr><th>#</th><th>Date</th><th>Orders</th><th class="num">Amount</th><th class="num">Billed</th><th class="num">Overage</th></tr></thead>
      <tbody>${list.map((p) => {
        const k = L.payments.get(p.id);
        return `<tr class="click" data-id="${esc(p.id)}"><td>${esc(p.number)}</td><td>${esc(p.date)}</td>
          <td>${p.orderIds.map((id) => esc(orderById(id)?.number ?? '?')).join(', ')}</td>
          <td class="num">${money(p.amount)}</td><td class="num">${money(k.owed)}</td>
          <td class="num ${k.overage < 0 ? 'neg' : 'pos'}">${money(k.overage)}</td></tr>`;
      }).join('') || '<tr><td colspan="6" class="muted">No payments yet.</td></tr>'}</tbody>
      <tfoot><tr><td colspan="3">Total</td><td class="num">${money(sum(db.payments.map((p) => p.amount)))}</td><td></td><td class="num">${money(sum([...L.payments.values()].map((k) => k.overage)))}</td></tr></tfoot>
    </table></div>`;
  $$('tr[data-id]', app).forEach((tr) => { tr.onclick = () => { location.hash = `#/payment/${tr.dataset.id}`; }; });
}

function renderPaymentForm(app, id) {
  const isNew = !id || id === 'new';
  const p = isNew
    ? { id: uid('p'), number: db.nextIds.payment || db.payments.length + 1, date: today(), amount: '', customerId: db.settings.defaultCustomerId, orderIds: [], notes: '' }
    : db.payments.find((x) => x.id === id);
  if (!p) { app.innerHTML = '<p>Payment not found. <a href="#/payments">Back</a></p>'; return; }
  // Balances without this payment, so editing shows what it actually covers.
  const without = ledger({ ...db, payments: db.payments.filter((x) => x.id !== p.id) });
  const candidates = sortOrders(db.orders.filter((o) => p.orderIds.includes(o.id) || without.orders.get(o.id).balance > 0.004));

  app.innerHTML = `
    <div class="toolbar"><a href="#/payments">← Payments</a></div>
    <h1>${isNew ? 'Record payment' : `Payment ${esc(p.number)}`}</h1>
    <form id="pay" class="panel">
      <div class="row">
        <label class="narrow">Payment #<input name="number" type="number" required value="${esc(p.number)}"></label>
        <label class="narrow" style="flex-basis:160px">Date received<input name="date" type="date" required value="${esc(p.date)}"></label>
        <label class="narrow">Amount<input name="amount" type="number" step="0.01" min="0" required value="${esc(p.amount)}"></label>
        <label>From<select name="customerId">${db.customers.map((c) => `<option value="${esc(c.id)}" ${c.id === p.customerId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      </div>
      <h2>Orders this payment covers</h2>
      <p class="small muted">Shows orders that still owe money. Anything paid over the bill is recorded as overage and split evenly across the ticked orders.</p>
      <div class="checklist">${candidates.map((o) => `<label><input type="checkbox" name="order" value="${esc(o.id)}" ${p.orderIds.includes(o.id) ? 'checked' : ''}> ${orderLabel(o)} <span class="num">${money(Math.max(0, without.orders.get(o.id).balance))}</span></label>`).join('') || '<p class="muted">No orders owe money.</p>'}</div>
      <div id="alloc"></div>
      <label style="color:var(--text)"><input type="checkbox" name="markComplete" checked> Mark fully paid orders as Complete</label>
      <label style="margin-top:.75rem">Notes<textarea name="notes">${esc(p.notes)}</textarea></label>
      <div class="toolbar" style="margin-top:1rem">
        <button class="primary" type="submit">Save payment</button>
        ${isNew ? '' : `<a class="btn" href="#/statement?payment=${esc(p.id)}">Statement</a>`}
        <span class="spacer"></span>
        ${isNew ? '' : '<button type="button" class="danger" id="delete">Delete</button>'}
      </div>
    </form>`;

  const form = $('#pay');
  const draft = () => {
    const f = new FormData(form);
    return { ...p, number: Number(f.get('number')), date: f.get('date'), amount: r2(num(f.get('amount'))), customerId: f.get('customerId'), notes: f.get('notes'), orderIds: $$('[name=order]:checked', form).map((x) => x.value) };
  };
  const update = () => {
    const d = draft();
    const trial = ledger({ ...db, payments: [...db.payments.filter((x) => x.id !== d.id), d] });
    const k = trial.payments.get(d.id);
    if (!d.orderIds.length) { $('#alloc').innerHTML = '<p class="small muted">Tick the orders this payment is for.</p>'; return; }
    $('#alloc').innerHTML = `<div class="table-wrap" style="margin:.75rem 0"><table>
      <thead><tr><th>Order</th><th class="num">Applied</th><th class="num">Overage</th><th class="num">Still owing</th></tr></thead>
      <tbody>${k.alloc.map((a) => { const o = orderById(a.orderId); const t = trial.orders.get(a.orderId); return `<tr><td>#${esc(o.number)} ${esc(o.description)}</td><td class="num">${money(a.applied)}</td><td class="num pos">${a.overage ? money(a.overage) : '—'}</td><td class="num ${t.balance > 0.004 ? 'neg' : ''}">${t.balance > 0.004 ? money(t.balance) : '—'}</td></tr>`; }).join('')}</tbody>
      <tfoot><tr><td>Billed ${money(k.owed)} · Received ${money(d.amount)}</td><td></td><td class="num ${k.overage < 0 ? 'neg' : 'pos'}">${k.overage < 0 ? 'Short ' + money(-k.overage) : money(k.overage)}</td><td></td></tr></tfoot>
    </table></div>`;
  };
  form.addEventListener('input', update);
  form.addEventListener('change', update);
  update();

  form.onsubmit = async (e) => {
    e.preventDefault();
    const d = draft();
    if (!d.orderIds.length && !confirm('No orders are ticked, so this will all count as overage. Save anyway?')) return;
    const markComplete = new FormData(form).get('markComplete');
    const ok = await commit(`${isNew ? 'Record' : 'Update'} payment ${d.number}`, (data) => {
      const i = data.payments.findIndex((x) => x.id === d.id);
      if (i >= 0) data.payments[i] = d; else data.payments.push(d);
      if (d.number >= (data.nextIds.payment || 1)) data.nextIds.payment = d.number + 1;
      if (markComplete) {
        const k = ledger(data);
        data.orders.forEach((o) => { if (d.orderIds.includes(o.id) && k.orders.get(o.id).balance <= 0.004) o.status = 'Complete'; });
      }
    });
    if (ok) location.hash = '#/payments';
  };
  if (!isNew) {
    $('#delete').onclick = async () => {
      if (!confirm(`Delete payment ${p.number}?`)) return;
      if (await commit(`Delete payment ${p.number}`, (data) => { data.payments = data.payments.filter((x) => x.id !== p.id); })) location.hash = '#/payments';
    };
  }
}

/* ---------- Customer statement ---------- */

function renderStatement(app, params) {
  const L = ledger(db);
  const payment = params.get('payment') ? db.payments.find((p) => p.id === params.get('payment')) : null;
  let ids = params.get('orders') ? params.get('orders').split(',') : null;
  if (payment) ids = payment.orderIds;
  const customerId = params.get('customer') || (ids && orderById(ids[0])?.customerId) || db.settings.defaultCustomerId;
  if (!ids) ids = db.orders.filter((o) => o.customerId === customerId && L.orders.get(o.id).balance > 0.004).map((o) => o.id);
  const chosen = sortOrders(ids.map(orderById).filter(Boolean)).reverse();
  const pool = sortOrders(db.orders.filter((o) => o.customerId === customerId));
  const totals = { labour: 0, materials: 0, shipping: 0, total: 0, paid: 0 };
  chosen.forEach((o) => { const c = L.orders.get(o.id); for (const k in totals) totals[k] += c[k]; });
  const pk = payment ? L.payments.get(payment.id) : null;

  app.innerHTML = `
    <div class="no-print">
      <h1>Statement</h1>
      <div class="panel">
        <div class="row">
          <label>Customer<select id="st-customer">${db.customers.map((c) => `<option value="${esc(c.id)}" ${c.id === customerId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
          <div style="flex:0 0 auto"><button class="primary" id="print">Print or save as PDF</button></div>
        </div>
        <details style="margin-top:.75rem"><summary>Choose orders (${chosen.length} selected)</summary>
          <div class="checklist">${pool.map((o) => `<label><input type="checkbox" value="${esc(o.id)}" ${ids.includes(o.id) ? 'checked' : ''}> ${orderLabel(o)} ${statusChip(o.status)}</label>`).join('')}</div>
          <button id="apply">Update statement</button>
        </details>
      </div>
    </div>
    <div class="statement">
      <h1>Order statement</h1>
      <p><b>${esc(customerName(customerId))}</b><br><span class="muted">Prepared ${esc(today())}</span></p>
      <div class="table-wrap" style="border:0"><table>
        <thead><tr><th>Order</th><th>Description</th><th class="num">Labour</th><th class="num">Materials</th><th class="num">Shipping</th><th class="num">Total</th></tr></thead>
        <tbody>${chosen.map((o) => {
          const c = L.orders.get(o.id);
          const detail = [
            o.hours ? `${o.hours} h` : '',
            ...(o.filaments || []).map((l) => `${esc(filamentName(l.filamentId))} ${r2(l.grams * (l.qty || 1))} g`),
            c.shipment && c.shipment.orderIds.length > 1 ? `shipping shared with ${c.shipment.orderIds.length - 1} other order${c.shipment.orderIds.length > 2 ? 's' : ''}` : '',
          ].filter(Boolean).join(' · ');
          return `<tr><td>#${esc(o.number)}<br><span class="muted small">${esc(o.received || '')}</span></td><td>${esc(o.description)}<br><span class="muted small">${detail}</span></td>
            <td class="num">${money(c.labour)}</td><td class="num">${money(c.materials)}</td><td class="num">${money(c.shipping)}</td><td class="num">${money(c.total)}</td></tr>`;
        }).join('') || '<tr><td colspan="6" class="muted">No orders selected.</td></tr>'}</tbody>
        <tfoot>
          <tr><td colspan="2">Total</td><td class="num">${money(totals.labour)}</td><td class="num">${money(totals.materials)}</td><td class="num">${money(totals.shipping)}</td><td class="num">${money(totals.total)}</td></tr>
          ${payment ? `<tr><td colspan="5">Payment received ${esc(payment.date)}</td><td class="num">${money(payment.amount)}</td></tr>
            <tr><td colspan="5">${pk.overage >= 0 ? 'Paid over the bill' : 'Still owing'}</td><td class="num">${money(Math.abs(pk.overage))}</td></tr>`
          : `<tr><td colspan="5">Paid</td><td class="num">${money(totals.paid)}</td></tr>
            <tr><td colspan="5">Balance due</td><td class="num">${money(Math.max(0, totals.total - totals.paid))}</td></tr>`}
        </tfoot>
      </table></div>
      <p class="muted small">Labour at ${money(rateOn(db, today()))}/hour. Materials charged by filament weight. Shared shipments are split evenly across the orders in the box.</p>
    </div>`;

  $('#print').onclick = () => window.print();
  $('#st-customer').onchange = (e) => { location.hash = `#/statement?customer=${encodeURIComponent(e.target.value)}`; };
  $('#apply').onclick = () => {
    const sel = $$('.checklist input:checked', app).map((x) => x.value);
    location.hash = `#/statement?customer=${encodeURIComponent(customerId)}&orders=${encodeURIComponent(sel.join(','))}`;
  };
}

/* ---------- Customers ---------- */

function renderCustomers(app) {
  const L = ledger(db);
  app.innerHTML = `
    <h1>Customers</h1>
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th class="hide-sm">Contact</th><th class="hide-sm">Email</th><th class="num">Orders</th><th class="num">Owing</th><th></th></tr></thead>
      <tbody>${db.customers.map((c) => {
        const os = db.orders.filter((o) => o.customerId === c.id);
        const owing = sum(os.map((o) => Math.max(0, L.orders.get(o.id).balance)));
        return `<tr><td>${esc(c.name)}${c.id === db.settings.defaultCustomerId ? ' <span class="muted small">(default)</span>' : ''}</td><td class="hide-sm">${esc(c.contact)}</td><td class="hide-sm">${esc(c.email)}</td>
          <td class="num">${os.length}</td><td class="num">${owing ? money(owing) : '—'}</td><td><button class="link" data-edit="${esc(c.id)}">Edit</button></td></tr>`;
      }).join('')}</tbody>
    </table></div>
    <form id="cust" class="panel" style="margin-top:1rem">
      <h2 id="cust-title" style="margin-top:0">Add customer</h2>
      <input type="hidden" name="id">
      <div class="row">
        <label>Name<input name="name" required></label>
        <label>Contact person<input name="contact"></label>
        <label>Email<input name="email" type="email"></label>
      </div>
      <label style="margin-top:.75rem">Notes<textarea name="notes"></textarea></label>
      <label style="color:var(--text);margin-top:.5rem"><input type="checkbox" name="isDefault"> Default customer for new orders</label>
      <div class="toolbar" style="margin-top:.75rem"><button class="primary" type="submit">Save customer</button><button type="reset">Clear</button></div>
    </form>`;
  const form = $('#cust');
  $$('[data-edit]', app).forEach((b) => {
    b.onclick = () => {
      const c = db.customers.find((x) => x.id === b.dataset.edit);
      for (const k of ['id', 'name', 'contact', 'email', 'notes']) form.elements[k].value = c[k] || '';
      form.elements.isDefault.checked = c.id === db.settings.defaultCustomerId;
      $('#cust-title').textContent = `Edit ${c.name}`;
      form.scrollIntoView({ behavior: 'smooth' });
    };
  });
  form.onreset = () => { $('#cust-title').textContent = 'Add customer'; };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const c = { id: f.get('id') || uid('c'), name: f.get('name').trim(), contact: f.get('contact').trim(), email: f.get('email').trim(), notes: f.get('notes') };
    const ok = await commit(`Save customer ${c.name}`, (data) => {
      const i = data.customers.findIndex((x) => x.id === c.id);
      if (i >= 0) data.customers[i] = c; else data.customers.push(c);
      if (f.get('isDefault')) data.settings.defaultCustomerId = c.id;
    });
    if (ok) renderCustomers(app);
  };
}

/* ---------- Filaments ---------- */

function renderFilaments(app) {
  const used = new Set(db.orders.flatMap((o) => (o.filaments || []).map((l) => l.filamentId)));
  app.innerHTML = `
    <h1>Filaments</h1>
    <p class="muted small">Materials cost = grams used × (spool price ÷ spool weight). Changing a price affects every order that isn't locked to its billed amount.</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Filament</th><th class="num">Spool price</th><th class="num">Spool weight</th><th class="num">Per gram</th><th></th></tr></thead>
      <tbody>${db.filaments.map((f) => `<tr><td>${esc(f.name)}</td><td class="num">${money(f.spoolCost)}</td><td class="num">${esc(f.spoolGrams)} g</td><td class="num">$${perGram(f).toFixed(4)}</td>
        <td><button class="link" data-edit="${esc(f.id)}">Edit</button>${used.has(f.id) ? '' : ` <button class="link danger" data-del="${esc(f.id)}">Delete</button>`}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No filaments yet.</td></tr>'}</tbody>
    </table></div>
    <form id="fil" class="panel" style="margin-top:1rem">
      <h2 id="fil-title" style="margin-top:0">Add filament</h2>
      <input type="hidden" name="id">
      <div class="row">
        <label>Name<input name="name" required placeholder="e.g. Red PLA"></label>
        <label class="narrow">Spool price<input name="spoolCost" type="number" step="0.01" min="0" required></label>
        <label class="narrow">Spool weight (g)<input name="spoolGrams" type="number" step="1" min="1" value="1000" required></label>
      </div>
      <div class="toolbar" style="margin-top:.75rem"><button class="primary" type="submit">Save filament</button><button type="reset">Clear</button></div>
    </form>`;
  const form = $('#fil');
  $$('[data-edit]', app).forEach((b) => {
    b.onclick = () => {
      const f = db.filaments.find((x) => x.id === b.dataset.edit);
      for (const k of ['id', 'name', 'spoolCost', 'spoolGrams']) form.elements[k].value = f[k];
      $('#fil-title').textContent = `Edit ${f.name}`;
      form.scrollIntoView({ behavior: 'smooth' });
    };
  });
  $$('[data-del]', app).forEach((b) => {
    b.onclick = async () => {
      const f = db.filaments.find((x) => x.id === b.dataset.del);
      if (confirm(`Delete ${f.name}?`) && await commit(`Delete filament ${f.name}`, (data) => { data.filaments = data.filaments.filter((x) => x.id !== f.id); })) renderFilaments(app);
    };
  });
  form.onreset = () => { $('#fil-title').textContent = 'Add filament'; };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const f = { id: fd.get('id') || uid('f'), name: fd.get('name').trim(), spoolCost: r2(num(fd.get('spoolCost'))), spoolGrams: num(fd.get('spoolGrams')) };
    const ok = await commit(`Save filament ${f.name}`, (data) => {
      const i = data.filaments.findIndex((x) => x.id === f.id);
      if (i >= 0) data.filaments[i] = f; else data.filaments.push(f);
    });
    if (ok) renderFilaments(app);
  };
}

/* ---------- Settings ---------- */

function renderSettings(app) {
  const rates = [...db.settings.labourRates].sort((a, b) => a.from.localeCompare(b.from));
  app.innerHTML = `
    <h1>Settings</h1>
    <div class="panel">
      <h2 style="margin-top:0">Labour rate</h2>
      <p class="small muted">Each order uses the rate in effect on its received date.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>From</th><th class="num">Rate per hour</th><th></th></tr></thead>
        <tbody>${rates.map((r, i) => `<tr><td>${i === 0 ? 'Start' : esc(r.from)}</td><td class="num">${money(r.rate)}</td><td>${i === 0 ? '' : `<button class="link danger" data-del-rate="${esc(r.from)}">Remove</button>`}</td></tr>`).join('')}</tbody>
      </table></div>
      <form id="rate" class="row" style="margin-top:.75rem">
        <label class="narrow" style="flex-basis:160px">New rate from<input name="from" type="date" required value="${esc(today())}"></label>
        <label class="narrow">Rate per hour<input name="rate" type="number" step="0.5" min="0" required></label>
        <div style="flex:0 0 auto"><button type="submit">Add rate</button></div>
      </form>
    </div>
    <div class="panel">
      <h2 style="margin-top:0">Your data</h2>
      <p>Stored in <b>${esc(store.label)}</b>.${store instanceof GitHubStore ? ' Every change is saved as a commit there, so you can see the full history on GitHub.' : ' Nothing is synced to other devices in this mode.'}</p>
      <div class="toolbar">
        <button id="export">Export to Excel</button>
        <button id="backup">Download backup (JSON)</button>
        <label class="btn" style="color:var(--text)">Restore from backup<input id="restore" type="file" accept="application/json,.json" hidden></label>
        <span class="spacer"></span>
        <button id="signout" class="danger">Sign out on this device</button>
      </div>
    </div>`;

  $('#rate').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const r = { from: f.get('from'), rate: num(f.get('rate')) };
    if (await commit(`Set labour rate ${r.rate} from ${r.from}`, (data) => {
      data.settings.labourRates = data.settings.labourRates.filter((x) => x.from !== r.from).concat(r);
    })) renderSettings(app);
  };
  $$('[data-del-rate]', app).forEach((b) => {
    b.onclick = async () => {
      if (await commit(`Remove labour rate from ${b.dataset.delRate}`, (data) => {
        data.settings.labourRates = data.settings.labourRates.filter((x) => x.from !== b.dataset.delRate);
      })) renderSettings(app);
    };
  });
  $('#export').onclick = exportExcel;
  $('#backup').onclick = () => {
    const blob = new Blob([JSON.stringify(db, null, 1)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `print-tracker-backup-${today()}.json` });
    a.click();
    URL.revokeObjectURL(a.href);
  };
  $('#restore').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    let data;
    try { data = JSON.parse(await file.text()); } catch { alert('That file is not a valid backup.'); return; }
    if (!Array.isArray(data.orders) || !data.settings) { alert('That file is not a Print Tracker backup.'); return; }
    if (!confirm(`Replace all current data with this backup (${data.orders.length} orders)?`)) return;
    if (await commit('Restore from backup', (d) => { Object.keys(d).forEach((k) => delete d[k]); Object.assign(d, data); })) route();
  };
  $('#signout').onclick = () => {
    if (!confirm('Forget the access token on this device?')) return;
    writeConfig(null);
    store = null; db = null;
    location.hash = '#/orders';
    route();
  };
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = Object.assign(document.createElement('script'), { src, onload: resolve, onerror: () => reject(new Error('Could not load ' + src)) });
    document.head.appendChild(s);
  });
}

async function exportExcel() {
  try {
    if (!window.XLSX) await loadScript(SHEETJS_URL);
  } catch (e) { alert(e.message); return; }
  const L = ledger(db);
  const orders = sortOrders(db.orders).reverse().map((o) => {
    const c = L.orders.get(o.id);
    return {
      'Order #': o.number, Customer: customerName(o.customerId), Received: o.received, Description: o.description,
      Hours: o.hours, Filament: (o.filaments || []).map((l) => `${filamentName(l.filamentId)} ${l.grams}g${l.qty > 1 ? ' x' + l.qty : ''}`).join('; '),
      'Grams total': r2(sum((o.filaments || []).map((l) => l.grams * (l.qty || 1)))),
      Labour: c.labour, Materials: c.materials, Shipping: c.shipping, Total: c.total, Paid: c.paid, Overage: c.overage, Owing: Math.max(0, c.balance),
      'Shipment #': c.shipment?.number ?? '', 'Date shipped': c.shipment?.date ?? '', 'Payment #': c.payments.map((p) => p.number).join(', '),
      Status: o.status, Comments: o.comments,
    };
  });
  const shipments = db.shipments.map((s) => ({ 'Shipment #': s.number, Date: s.date, Cost: s.cost, Orders: s.orderIds.map((id) => orderById(id)?.number).join(', '), Tracking: s.tracking, Notes: s.notes }));
  const payments = db.payments.map((p) => { const k = L.payments.get(p.id); return { 'Payment #': p.number, Date: p.date, From: customerName(p.customerId), Amount: p.amount, Billed: k.owed, Overage: k.overage, Orders: p.orderIds.map((id) => orderById(id)?.number).join(', '), Notes: p.notes }; });
  const filaments = db.filaments.map((f) => ({ Filament: f.name, 'Spool price': f.spoolCost, 'Spool weight (g)': f.spoolGrams, 'Per gram': perGram(f) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(orders), 'Orders');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(shipments), 'Shipping');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(payments), 'Payments');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(filaments), 'Materials');
  XLSX.writeFile(wb, `print-tracker-${today()}.xlsx`);
}

/* ---------- Start ---------- */

window.addEventListener('hashchange', route);
(async () => {
  const cfg = readConfig();
  if (cfg) await connect(cfg);
  else route();
})();
