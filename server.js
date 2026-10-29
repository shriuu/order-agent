// Order Agent demo server. Plain Node, no dependencies.
// Ordering itself happens in the AI assistant through Swiggy's and Zomato's official connectors;
// this server is the control layer: who is set up, the COD cap, approvals, and a log of every test run.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import { understand, missing, emptyDraft, hasCredentials, YES_RE, NO_RE } from './agent.js';
import { shopTurn, openaiEnabled } from './shop.js';
import { placeCashOrder } from './place.js';
import { sarvamEnabled, transcribe, speak } from './sarvam.js';
import { activityFor } from './activity.js';
import { swiggy } from './swiggy.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'data', 'db.json');
const PORT = Number(process.env.PORT) || 3000;
// Where Swiggy sends the user back after login. Swiggy allows http://localhost while developing.
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

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
  'GET /api/meta': () => ({ platforms: PLATFORMS, flows: FLOWS, failures: FAILURES, settings: db.settings, agentEngine: openaiEnabled() ? 'openai' : hasCredentials() ? 'claude' : 'rules', speech: sarvamEnabled() ? 'sarvam' : 'browser', adminLocked: adminLocked() }),

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
    // Never send Swiggy tokens to the browser.
    const pub = (l) => l ? { platform: l.platform, status: l.status, linkedAt: l.linkedAt, disconnectedAt: l.disconnectedAt, real: !!l.tokens } : null;
    return { user: u, links: PLATFORMS.map(p => pub(linkFor(u.id, p)) || { platform: p, status: 'not_linked' }) };
  },

  // Talks to Swiggy with the user's token and lists the tools it offers: proof the link is real.
  'GET /api/swiggy/check': async (_, q) => {
    const u = getUser(q.get('userId'));
    const l = linkFor(u.id, 'swiggy');
    need(l?.status === 'linked' && l.tokens, 'Log in with Swiggy first');
    const client = await sw.connect(l).catch(e => { throw new HttpError(502, e.message); });
    try { return { ok: true, tools: (await client.listTools()).tools.map(t => t.name) }; }
    finally { await client.close().catch(() => {}); }
  },

  // Manual confirmation, only for platforms without a real login yet. Swiggy uses /oauth/swiggy/start.
  'POST /api/link': (b) => {
    const u = getUser(b.userId);
    need(PLATFORMS.includes(b.platform), 'Unknown platform');
    need(b.platform !== 'swiggy', 'Use "Log in with Swiggy"');
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
    delete l.tokens; // forget the Swiggy login entirely
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

    // Real Swiggy: ChatGPT builds an actual cart with Swiggy's tools.
    const swLink = linkFor(u.id, 'swiggy');
    if (openaiEnabled() && swLink?.status === 'linked' && swLink.tokens) {
      const reset = () => sessions.delete(u.id);
      if (draft.real && YES_RE.test(text)) {
        const order = createOrder(u, {
          platform: 'swiggy', flow: 'search', total: draft.total, items: describeItems(draft), lineItems: draft.items,
          restaurant: draft.restaurant, source: 'voice', codAvailable: draft.codAvailable,
          swiggy: { addressId: draft.addressId, addressLabel: draft.addressLabel, restaurantId: draft.restaurantId, itemTotal: draft.itemTotal, fees: draft.fees },
        });
        reset();
        logEvent(u.id, 'voice', { intent: 'confirm' });
        return {
          intent: 'confirm', order, draft: emptyDraft(), engine: 'swiggy',
          reply: order.status !== 'blocked' ? 'Sent. Tap approve on the Order tab when you are ready.'
            : order.blockReason === 'cod_not_offered' ? 'Blocked: Swiggy is not offering cash on delivery for this order. I have logged it.'
            : `Blocked: ₹${order.total} is over your ₹${order.cap} limit. I have logged it.`,
        };
      }
      if (NO_RE.test(text)) { reset(); return { intent: 'cancel', draft: emptyDraft(), engine: 'swiggy', reply: 'Okay, cleared. What would you like?' }; }

      let session = sessions.get(u.id);
      if (!session || Date.now() - session.at > 30 * 60 * 1000) session = { messages: [] };
      session.at = Date.now();
      sessions.set(u.id, session);
      let mcp;
      try {
        mcp = await sw.connect(swLink);
        const out = await shopTurn({ text, session, mcp, ctx: { codCap: db.settings.codCap } });
        logEvent(u.id, 'voice', { intent: 'swiggy', tools: out.toolsUsed });
        const p = out.proposal;
        return {
          intent: 'order', engine: 'swiggy', reply: out.reply, toolsUsed: out.toolsUsed,
          draft: p ? {
            platform: 'swiggy', flow: 'search', real: true, restaurant: p.restaurantName, restaurantId: p.restaurantId,
            items: p.items, itemTotal: p.itemTotal, fees: p.fees, total: p.total, codAvailable: p.codAvailable,
            addressId: p.addressId, addressLabel: p.addressLabel,
          } : draft,
        };
      } catch (e) {
        console.error('Swiggy agent:', e);
        const why = e instanceof OpenAI.APIError ? `ChatGPT error ${e.status}: ${e.message}` : e.message;
        return { intent: 'unclear', engine: 'swiggy', draft, reply: `Sorry, something went wrong talking to Swiggy. ${why}` };
      } finally {
        await mcp?.close().catch(() => {});
      }
    }
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
      return await transcribe(b.audio, b.mimeType, { understandsIndic: hasCredentials() || openaiEnabled(), keyterms });
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

  'POST /api/orders/decide': async (b) => {
    const o = db.orders.find(x => x.id === b.orderId && x.userId === b.userId);
    need(o, 'Order not found', 404);
    need(o.status === 'pending_approval', 'Order is not waiting for approval');
    need(['approve', 'reject'].includes(b.decision), 'Decision must be approve or reject');
    o.decidedAt = now();
    logEvent(o.userId, b.decision === 'approve' ? 'order_approved' : 'order_rejected', { platform: o.platform, orderId: o.id });
    if (b.decision === 'reject') { o.status = 'rejected'; return o; }
    if (!o.swiggy) { o.status = 'approved'; return o; } // demo orders: result is recorded by hand
    return placeOnSwiggy(o);
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

  const overCap = b.flow === 'table_booking' ? null : capCheck(total, db.settings.codCap);
  const blocked = overCap || (b.codAvailable === false ? 'cod_not_offered' : null);
  const o = {
    id: id(), userId: u.id, platform: b.platform, flow: b.flow, items, total: total || 0,
    lineItems: Array.isArray(b.lineItems) ? b.lineItems : null, restaurant: b.restaurant || null,
    source: b.source === 'voice' ? 'voice' : 'form',
    swiggy: b.swiggy || null, // a real Swiggy cart: address, restaurant and price breakdown
    cap: db.settings.codCap, status: blocked ? 'blocked' : 'pending_approval', blockReason: blocked, createdAt: now(),
  };
  db.orders.push(o);
  logEvent(u.id, 'order_request', { platform: o.platform, orderId: o.id });
  if (blocked) addRun({
    userId: u.id, orderId: o.id, platform: o.platform, flow: o.flow, outcome: 'failed', failure: blocked, total: o.total,
    codOffered: blocked === 'cod_not_offered' ? false : null,
    notes: blocked === 'cod_not_offered' ? 'Swiggy did not offer cash on delivery for this cart' : `Total ₹${o.total} is over the ₹${o.cap} COD cap`,
  });
  return o;
}

// Places an approved real Swiggy order. Status goes placing -> placed | failed | blocked | unknown.
async function placeOnSwiggy(o) {
  const link = linkFor(o.userId, 'swiggy');
  need(link?.status === 'linked' && link.tokens, 'Log in with Swiggy again first');
  o.status = 'placing'; // set before any await, so a second Approve tap is refused
  save();
  let r, mcp;
  try {
    mcp = await sw.connect(link);
    r = await placeCashOrder(mcp, o, db.settings.codCap);
  } catch (e) {
    // Failed before place_food_order was reached (login, network, reading the cart).
    r = { ok: false, failure: /login|token|401/i.test(e.message) ? 'login_failed' : 'other', message: e.message };
  } finally {
    await mcp?.close().catch(() => {});
  }
  const run = { userId: o.userId, orderId: o.id, platform: 'swiggy', flow: o.flow, total: o.total };
  if (r.ok) {
    Object.assign(o, { status: 'placed', placedAt: now(), swiggyOrderId: r.swiggyOrderId, swiggyReply: r.raw });
    addRun({ ...run, outcome: 'success', codOffered: true, notes: `Placed on Swiggy${r.swiggyOrderId ? `, order ${r.swiggyOrderId}` : ''}` });
    logEvent(o.userId, 'order_placed', { platform: 'swiggy', orderId: o.id, items: o.items });
  } else {
    o.status = r.placed === 'unknown' ? 'unknown' : ['cod_over_cap', 'cod_not_offered'].includes(r.failure) ? 'blocked' : 'failed';
    Object.assign(o, { failReason: r.message, blockReason: r.failure, swiggyReply: r.raw || null });
    addRun({ ...run, outcome: 'failed', failure: r.failure, codOffered: r.failure === 'cod_not_offered' ? false : null, notes: r.message });
  }
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

// Browser redirects for Swiggy's login. Not JSON: the user's browser is sent to Swiggy and back.
async function swiggyOAuth(url, res) {
  const back = (params) => { res.writeHead(302, { Location: `/#setup?${new URLSearchParams(params)}` }); res.end(); };
  try {
    if (url.pathname === '/oauth/swiggy/start') {
      const u = getUser(url.searchParams.get('userId'));
      res.writeHead(302, { Location: await sw.loginUrl(u.id) });
      return res.end();
    }
    if (url.pathname === '/oauth/swiggy/callback') {
      const err = url.searchParams.get('error');
      if (err) return back({ swiggy_error: url.searchParams.get('error_description') || err });
      const { userId, tokens } = await sw.finishLogin(url.searchParams.get('code'), url.searchParams.get('state'));
      let l = linkFor(userId, 'swiggy');
      if (!l) { l = { userId, platform: 'swiggy' }; db.links.push(l); }
      Object.assign(l, { status: 'linked', linkedAt: now(), disconnectedAt: null, tokens });
      logEvent(userId, 'link', { platform: 'swiggy' });
      save();
      return back({ linked: 'swiggy' });
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error('Swiggy login:', e.message);
    back({ swiggy_error: e.message });
  }
}

let sw;
const sessions = new Map(); // userId -> ChatGPT conversation with Swiggy, kept in memory for 30 min
export function createServer() {
  load();
  sw = swiggy(db, save, PUBLIC_URL);
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/oauth/')) return swiggyOAuth(url, res);
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
