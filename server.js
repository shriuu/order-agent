// Order Agent demo server. Plain Node, no dependencies.
// Ordering itself happens in the AI assistant through Swiggy's and Zomato's official connectors;
// this server is the control layer: who is set up, the COD cap, approvals, and a log of every test run.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { understand, missing, emptyDraft, hasCredentials } from './agent.js';
import { sarvamEnabled, transcribe, speak } from './sarvam.js';
import { activityFor } from './activity.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'data', 'db.json');
const PORT = Number(process.env.PORT) || 3000;

export const PLATFORMS = ['swiggy', 'zomato'];
export const FLOWS = ['reorder', 'search', 'address_change', 'table_booking'];
export const FAILURES = {
  cod_over_cap: 'COD blocked: order above limit',
  cod_unavailable: 'COD unavailable for this order',
  cod_not_offered: 'COD not offered by the connector',
  login_failed: 'Login / link expired',
  item_not_found: 'Item not found',
  wrong_item: 'Agent picked the wrong item',
  address_issue: 'Address problem',
  store_closed: 'Restaurant closed or not delivering',
  table_unavailable: 'Table not available',
  timeout: 'Agent timed out or got stuck',
  other: 'Other',
};

// ---------- storage ----------

const empty = () => ({ settings: { codCap: 1500 }, users: [], links: [], orders: [], runs: [], events: [] });

let db;
function load() {
  try { db = { ...empty(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch { db = empty(); }
}
function save() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE); // write-then-rename so a crash never leaves half a file
}

const id = () => crypto.randomUUID().slice(0, 8);
const now = () => new Date().toISOString();

function logEvent(userId, type, extra = {}) {
  db.events.push({ userId, type, at: now(), ...extra });
}

// ---------- rules ----------

/** The COD cap check. Returns null if the order may go to approval, or the failure code. */
export function capCheck(total, cap) {
  return total > cap ? 'cod_over_cap' : null;
}

function linkFor(userId, platform) {
  return db.links.find(l => l.userId === userId && l.platform === platform);
}

// ---------- API ----------

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const need = (cond, msg, status = 400) => { if (!cond) throw new HttpError(status, msg); };

function getUser(userId) {
  const u = db.users.find(x => x.id === userId);
  need(u, 'Unknown user, sign up again', 404);
  return u;
}

const routes = {
  'GET /api/meta': () => ({ platforms: PLATFORMS, flows: FLOWS, failures: FAILURES, settings: db.settings, agentEngine: hasCredentials() ? 'claude' : 'rules', speech: sarvamEnabled() ? 'sarvam' : 'browser', adminLocked: adminLocked() }),

  'GET /api/admin/check': () => ({ ok: true }),

  'PUT /api/settings': (b) => {
    const cap = Number(b.codCap);
    need(Number.isFinite(cap) && cap > 0, 'COD cap must be a positive number');
    db.settings.codCap = Math.round(cap);
    return db.settings;
  },

  // Demo sign-up: phone number only, no OTP. Signing up again with the same number returns the same user.
  'POST /api/signup': (b) => {
    const phone = String(b.phone || '').replace(/\D/g, '').slice(-10);
    need(/^[6-9]\d{9}$/.test(phone), 'Enter a 10-digit Indian mobile number');
    let u = db.users.find(x => x.phone === phone);
    if (!u) { u = { id: id(), phone, createdAt: now() }; db.users.push(u); logEvent(u.id, 'signup'); }
    return u;
  },

  'GET /api/me': (_, q) => {
    const u = getUser(q.get('userId'));
    return { user: u, links: PLATFORMS.map(p => linkFor(u.id, p) || { platform: p, status: 'not_linked' }) };
  },

  // Records that the user approved the official connector login in the assistant.
  'POST /api/link': (b) => {
    const u = getUser(b.userId);
    need(PLATFORMS.includes(b.platform), 'Unknown platform');
    let l = linkFor(u.id, b.platform);
    if (!l) { l = { userId: u.id, platform: b.platform }; db.links.push(l); }
    Object.assign(l, { status: 'linked', linkedAt: now(), disconnectedAt: null });
    logEvent(u.id, 'link', { platform: b.platform });
    return l;
  },

  'POST /api/disconnect': (b) => {
    const u = getUser(b.userId);
    const l = linkFor(u.id, b.platform);
    need(l && l.status === 'linked', 'Platform is not linked');
    Object.assign(l, { status: 'disconnected', disconnectedAt: now() });
    logEvent(u.id, 'disconnect', { platform: b.platform });
    return l;
  },

  // The page calls this when it opens. Opens within 30 minutes of the last one count as the same session.
  'POST /api/open': (b) => {
    const u = getUser(b.userId);
    const last = db.events.findLast(e => e.userId === u.id && e.type === 'app_open');
    if (!last || Date.now() - Date.parse(last.at) > 30 * 60 * 1000) logEvent(u.id, 'app_open');
    return { ok: true };
  },

  // An order the agent has built in the assistant. Over the cap: blocked and logged. Otherwise: waits for approval.
  'POST /api/orders': (b) => createOrder(getUser(b.userId), b),

  // Voice / typed agent. Builds a draft over several turns; "yes" on a complete draft creates the order
  // through the same path as the form, so the cap check and approval step still apply.
  'POST /api/agent': async (b) => {
    const u = getUser(b.userId);
    const text = String(b.text || '').trim().slice(0, 500);
    need(text, 'Say or type something');
    const draft = b.draft && typeof b.draft === 'object' ? { ...emptyDraft(), ...b.draft } : emptyDraft();
    const ctx = agentContext(u.id);
    const out = await understand(text, draft, ctx, Array.isArray(b.history) ? b.history : []);
    logEvent(u.id, 'voice', { intent: out.intent });

    if (out.intent === 'confirm' && missing(out.draft, ctx.linked) === null) {
      const d = out.draft;
      const order = createOrder(u, {
        platform: d.platform, flow: d.flow, total: d.total,
        items: d.flow === 'table_booking' ? `Table at ${d.restaurant}` : describeItems(d),
        lineItems: d.items, restaurant: d.restaurant, source: 'voice',
      });
      return {
        ...out, order, draft: emptyDraft(),
        reply: order.status === 'blocked'
          ? `Blocked: ₹${order.total} is over your ₹${order.cap} limit. I've logged it.`
          : 'Sent. Tap approve on the Order tab when you are ready.',
      };
    }
    if (out.intent === 'confirm') out.reply ||= 'The order is not complete yet.';
    return out;
  },

  // Sarvam speech-to-text. Body is the recorded audio; ?userId= identifies the user.
  'POST /api/voice/transcribe': async (b, q) => {
    const u = getUser(q.get('userId'));
    need(sarvamEnabled(), 'Sarvam is not configured', 503);
    need(b.audio?.length, 'No audio received');
    const mine = db.orders.filter(o => o.userId === u.id);
    const keyterms = [...mine.map(o => o.restaurant), ...mine.flatMap(o => (o.lineItems || []).map(i => i.name))];
    try {
      return await transcribe(b.audio, b.mimeType, { understandsIndic: hasCredentials(), keyterms });
    } catch (e) { throw new HttpError(502, e.message); }
  },

  // Sarvam text-to-speech for the agent's reply.
  'POST /api/voice/speak': async (b) => {
    need(sarvamEnabled(), 'Sarvam is not configured', 503);
    const text = String(b.text || '').trim();
    need(text, 'Nothing to say');
    try { return { audio: await speak(text) }; } catch (e) { throw new HttpError(502, e.message); }
  },

  // The customer only gets their usual order and top dishes; segments and counts are admin-only.
  'GET /api/usual': (_, q) => {
    const { usual, topItems } = activityOf(getUser(q.get('userId')));
    return { usual, topItems };
  },

  // Every user's recency/frequency, for the dashboard. Sample users only when asked for.
  'GET /api/activity/all': (_, q) => {
    const sample = q.get('sample') === '1';
    return db.users.filter(u => sample || !u.sample).map(u => ({
      id: u.id, phone: u.phone.slice(0, 2) + '••••••' + u.phone.slice(-2), sample: !!u.sample, ...activityOf(u),
    })).sort((a, b) => (a.daysSinceActive ?? 1e9) - (b.daysSinceActive ?? 1e9));
  },

  'POST /api/sample': () => { clearSample(); loadSample(); return { ok: true }; },
  'POST /api/sample/clear': () => { clearSample(); return { ok: true }; },

  'GET /api/orders': (_, q) => {
    const u = getUser(q.get('userId'));
    return db.orders.filter(o => o.userId === u.id).reverse();
  },

  'POST /api/orders/decide': (b) => {
    const o = db.orders.find(x => x.id === b.orderId && x.userId === b.userId);
    need(o, 'Order not found', 404);
    need(o.status === 'pending_approval', 'Order is not waiting for approval');
    need(['approve', 'reject'].includes(b.decision), 'Decision must be approve or reject');
    o.status = b.decision === 'approve' ? 'approved' : 'rejected';
    o.decidedAt = now();
    logEvent(o.userId, b.decision === 'approve' ? 'order_approved' : 'order_rejected', { platform: o.platform, orderId: o.id });
    return o;
  },

  // What happened after the assistant tried to place it.
  'POST /api/orders/result': (b) => {
    const o = db.orders.find(x => x.id === b.orderId && x.userId === b.userId);
    need(o, 'Order not found', 404);
    need(o.status === 'approved', 'Approve the order before recording its result');
    const run = addRun({ userId: o.userId, orderId: o.id, platform: o.platform, flow: o.flow, outcome: b.outcome, failure: b.failure, total: o.total, codOffered: b.codOffered, notes: b.notes });
    o.status = run.outcome === 'success' ? 'placed' : 'failed';
    if (run.outcome === 'success') logEvent(o.userId, 'order_placed', { platform: o.platform, orderId: o.id, items: o.items });
    return o;
  },

  // A test flow run directly in the assistant, logged by hand by the admin.
  'POST /api/runs': (b) => addRun({ ...b, userId: null }),

  'GET /api/runs': (_, q) => {
    const sample = q.get('sample') === '1';
    return db.runs.filter(r => sample || !r.sample).reverse();
  },
};

function createOrder(u, b) {
  need(PLATFORMS.includes(b.platform), 'Unknown platform');
  need(linkFor(u.id, b.platform)?.status === 'linked', `Link ${b.platform} first`);
  need(FLOWS.includes(b.flow), 'Unknown flow');
  const total = Number(b.total);
  need(b.flow === 'table_booking' || (Number.isFinite(total) && total > 0), 'Enter the cart total');
  const items = String(b.items || '').trim();
  need(items, 'Describe the order (items or restaurant)');

  const blocked = b.flow === 'table_booking' ? null : capCheck(total, db.settings.codCap);
  const o = {
    id: id(), userId: u.id, platform: b.platform, flow: b.flow, items, total: total || 0,
    lineItems: Array.isArray(b.lineItems) ? b.lineItems : null, restaurant: b.restaurant || null,
    source: b.source === 'voice' ? 'voice' : 'form',
    cap: db.settings.codCap, status: blocked ? 'blocked' : 'pending_approval', createdAt: now(),
  };
  db.orders.push(o);
  logEvent(u.id, 'order_request', { platform: o.platform, orderId: o.id });
  if (blocked) addRun({ userId: u.id, orderId: o.id, platform: o.platform, flow: o.flow, outcome: 'failed', failure: blocked, total: o.total, codOffered: null, notes: `Total ₹${o.total} is over the ₹${o.cap} COD cap` });
  return o;
}

const describeItems = (d) => d.items.map(i => `${i.name} x${i.quantity}`).join(', ') + (d.restaurant ? ` from ${d.restaurant}` : '');

function activityOf(u) {
  return activityFor(u, db.events.filter(e => e.userId === u.id), db.orders.filter(o => o.userId === u.id));
}

// ---------- sample data (clearly flagged, never mixed into real numbers unless asked) ----------

function clearSample() {
  const ids = new Set(db.users.filter(u => u.sample).map(u => u.id));
  db.users = db.users.filter(u => !u.sample);
  for (const k of ['links', 'orders', 'events']) db[k] = db[k].filter(x => !ids.has(x.userId));
  db.runs = db.runs.filter(r => !r.sample);
}

function loadSample() {
  const day = 864e5, at = (d, h = 13) => new Date(Date.now() - d * day - h * 36e5 + 13 * 36e5).toISOString();
  const menus = {
    swiggy: [{ restaurant: 'Meghana Foods', items: [{ name: 'Chicken biryani', quantity: 2 }, { name: 'Raita', quantity: 1 }], total: 640 },
             { restaurant: 'Empire', items: [{ name: 'Ghee rice', quantity: 1 }, { name: 'Kabab', quantity: 1 }], total: 420 }],
    zomato: [{ restaurant: 'Truffles', items: [{ name: 'All American burger', quantity: 2 }], total: 560 },
             { restaurant: 'MTR', items: [{ name: 'Masala dosa', quantity: 3 }], total: 390 }],
  };
  // [phone, signed up days ago, days active in the last 30 (spread out), days since last active, orders]
  const people = [
    ['9000000001', 120, 16, 0, 9], ['9000000002', 90, 6, 4, 4], ['9000000003', 60, 3, 9, 2],
    ['9000000004', 80, 1, 21, 1], ['9000000005', 150, 0, 46, 3], ['9000000006', 2, 2, 0, 1],
  ];
  people.forEach(([phone, signup, activeDays, lastDays, nOrders], idx) => {
    const u = { id: id(), phone, createdAt: at(signup), sample: true };
    db.users.push(u);
    db.links.push(...PLATFORMS.map(p => ({ userId: u.id, platform: p, status: 'linked', linkedAt: at(signup), disconnectedAt: null })));
    const days = activeDays ? Array.from({ length: activeDays }, (_, i) => lastDays + Math.round(i * Math.min(29 - lastDays, signup - 1 - lastDays) / Math.max(activeDays - 1, 1))) : [lastDays];
    for (const d of days) {
      db.events.push({ userId: u.id, type: 'app_open', at: at(d, 19 + (d % 3)) });
      if (d === lastDays || d % 4 === 0) db.events.push({ userId: u.id, type: 'app_open', at: at(d, 13) });
    }
    const fav = idx % 2 ? 'zomato' : 'swiggy';
    for (let i = 0; i < nOrders; i++) {
      const p = i % 3 === 2 ? (fav === 'swiggy' ? 'zomato' : 'swiggy') : fav;
      const m = menus[p][i % 3 === 1 ? 1 : 0], d = days[Math.min(i * 2, days.length - 1)] + (lastDays > 30 ? i * 5 : 0);
      db.orders.push({ id: id(), userId: u.id, platform: p, flow: 'search', items: describeItems(m), lineItems: m.items,
        restaurant: m.restaurant, total: m.total, source: i % 2 ? 'voice' : 'form', cap: db.settings.codCap, status: 'placed', createdAt: at(d, 20) });
      db.events.push({ userId: u.id, type: 'order_placed', platform: p, at: at(d, 20) });
    }
  });
  const runs = [['swiggy', 'reorder', 'success'], ['swiggy', 'search', 'success'], ['swiggy', 'address_change', 'failed', 'address_issue'],
    ['zomato', 'search', 'failed', 'cod_not_offered'], ['zomato', 'table_booking', 'success'], ['zomato', 'reorder', 'failed', 'cod_unavailable'],
    ['swiggy', 'search', 'failed', 'item_not_found'], ['zomato', 'search', 'success']];
  runs.forEach(([platform, flow, outcome, failure], i) => addRun({ userId: null, platform, flow, outcome, failure, total: 300 + i * 90,
    codOffered: failure?.startsWith('cod') ? false : flow === 'table_booking' ? null : true, notes: 'Sample data', sample: true, at: at(i) }));
}

/** The app state the voice agent can see and answer questions about. */
function agentContext(userId) {
  const orders = db.orders.filter(o => o.userId === userId);
  const last = orders.at(-1);
  const a = activityOf(db.users.find(u => u.id === userId));
  return {
    activity: {
      daysSinceLastOrder: a.lastOrderAt ? Math.floor((Date.now() - Date.parse(a.lastOrderAt)) / 864e5) : null,
      ordersLast30Days: a.orders30d, activeDaysLast30: a.activeDays30d, favouritePlatform: a.favouritePlatform,
      topItems: a.topItems.map(i => ({ name: i.name, times: i.times })), usual: a.usual,
    },
    codCap: db.settings.codCap,
    linked: db.links.filter(l => l.userId === userId && l.status === 'linked').map(l => l.platform),
    pending: orders.filter(o => o.status === 'pending_approval').length,
    lastOrder: last && {
      platform: last.platform, flow: last.flow, total: last.total, status: last.status, restaurant: last.restaurant,
      items: last.lineItems || [{ name: last.items, quantity: 1 }],
    },
    stats: PLATFORMS.map(p => {
      const rs = db.runs.filter(r => r.platform === p && !r.sample);
      return { platform: p, runs: rs.length, ok: rs.filter(r => r.outcome === 'success').length };
    }),
  };
}

function addRun(b) {
  need(PLATFORMS.includes(b.platform), 'Unknown platform');
  need(FLOWS.includes(b.flow), 'Unknown flow');
  need(['success', 'failed'].includes(b.outcome), 'Outcome must be success or failed');
  need(b.outcome === 'success' || FAILURES[b.failure], 'Pick a failure type');
  const run = {
    id: id(), userId: b.userId, orderId: b.orderId || null, platform: b.platform, flow: b.flow,
    outcome: b.outcome, failure: b.outcome === 'failed' ? b.failure : null,
    total: Number(b.total) || 0,
    codOffered: b.codOffered === true || b.codOffered === false ? b.codOffered : null,
    notes: String(b.notes || '').slice(0, 500), sample: !!b.sample, at: b.at || now(),
  };
  db.runs.push(run);
  return run;
}

// ---------- admin ----------

// Test results, user analytics, sample data and the COD cap are for the admin only.
const ADMIN_ROUTES = new Set([
  'GET /api/admin/check', 'PUT /api/settings', 'GET /api/runs', 'POST /api/runs',
  'GET /api/activity/all', 'POST /api/sample', 'POST /api/sample/clear',
]);
// Without ADMIN_KEY in .env the admin area is open (fine on your own laptop, not once deployed).
const adminLocked = () => !!process.env.ADMIN_KEY;
function isAdmin(req) {
  if (!adminLocked()) return true;
  const given = Buffer.from(String(req.headers['x-admin-key'] || ''));
  const want = Buffer.from(process.env.ADMIN_KEY);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

// ---------- HTTP ----------

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function serveStatic(req, res) {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(ROOT, 'public', rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(path.join(ROOT, 'public'))) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

export function createServer() {
  load();
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res);
    const key = `${req.method} ${url.pathname}`;
    const handler = routes[key];
    if (!handler) return send(res, 404, { error: 'No such endpoint' });
    if (ADMIN_ROUTES.has(key) && !isAdmin(req)) return send(res, 403, { error: 'Admin key required' });
    try {
      let body = {};
      if (req.method !== 'GET') {
        // Audio uploads are raw bytes (up to ~30 s of speech); everything else is JSON.
        const isAudio = (req.headers['content-type'] || '').startsWith('audio/');
        const limit = isAudio ? 3e6 : 1e5, chunks = [];
        let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > limit) throw new HttpError(413, 'Too large'); chunks.push(chunk); }
        const raw = Buffer.concat(chunks);
        body = isAudio ? { audio: raw, mimeType: req.headers['content-type'] } : raw.length ? JSON.parse(raw) : {};
      }
      const out = await handler(body, url.searchParams);
      if (req.method !== 'GET') save();
      send(res, 200, out);
    } catch (e) {
      send(res, e.status || (e instanceof SyntaxError ? 400 : 500), { error: e.status || e instanceof SyntaxError ? e.message : 'Server error' });
      if (!e.status && !(e instanceof SyntaxError)) console.error(e);
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer().listen(PORT, () => console.log(`Order Agent on http://localhost:${PORT}`));
}
