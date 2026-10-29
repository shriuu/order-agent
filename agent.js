// Voice agent: turns what the user said into either an order draft or an answer.
// With Anthropic credentials set it uses Claude; without them it falls back to a rule-based parser,
// so the demo still works offline. Either way it only ever builds a DRAFT: sending for approval is
// a separate confirm step, and approving stays a tap on the Order tab.
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5-5';
export const hasCredentials = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);
let client;

/** @typedef {{platform: string|null, flow: string, restaurant: string|null, items: {name: string, quantity: number}[], total: number|null}} Draft */
export const emptyDraft = () => ({ platform: null, flow: 'search', restaurant: null, items: [], total: null });

/** What's still missing before the draft can be sent for approval, in the order we ask for it. */
export function missing(d, linked) {
  if (!d.platform) return linked.length === 1 ? null : 'platform';
  if (d.flow === 'table_booking') return d.restaurant ? null : 'restaurant';
  if (!d.items.length) return 'items';
  if (!d.total) return 'total';
  return null;
}

const ASK = {
  platform: 'Swiggy or Zomato?',
  restaurant: 'Which restaurant?',
  items: 'What would you like, and how many?',
  total: 'What is the cart total in the app? I need it to check the COD limit.',
};

export const describe = (d) => {
  if (d.flow === 'table_booking') return `a table at ${d.restaurant} on ${cap(d.platform)}`;
  const items = d.items.map(i => `${i.quantity} ${i.name}`).join(', ');
  return `${items}${d.restaurant ? ` from ${d.restaurant}` : ''} on ${cap(d.platform)}${d.total ? `, ₹${d.total} cash on delivery` : ''}`;
};
const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;

// ---------- entry point ----------

/**
 * @param {string} text what the user said
 * @param {Draft} draft the order being built so far
 * @param {object} ctx app state the agent may answer questions about
 * @param {{role: 'user'|'agent', text: string}[]} history recent turns, oldest first
 */
export async function understand(text, draft, ctx, history = []) {
  let out;
  if (hasCredentials()) {
    try { out = await withClaude(text, draft, ctx, history); out.engine = 'claude'; }
    catch (e) { console.error('Claude call failed, using rules:', e.message); }
  }
  if (!out) { out = withRules(text, draft, ctx); out.engine = 'rules'; }

  // Platform defaults to the only linked one; an unlinked platform can't be used.
  if (!out.draft.platform && ctx.linked.length === 1) out.draft.platform = ctx.linked[0];
  if (out.draft.platform && !ctx.linked.includes(out.draft.platform)) {
    const p = out.draft.platform; out.draft.platform = null;
    return { ...out, intent: 'order', reply: `${cap(p)} isn't linked. Link it on the Setup tab first${ctx.linked.length ? `, or use ${ctx.linked.map(cap).join(' or ')}` : ''}.` };
  }

  if (out.intent === 'order') {
    const gap = missing(out.draft, ctx.linked);
    if (gap) out.reply = (out.reply ? out.reply + ' ' : '') + ASK[gap];
    else {
      const over = out.draft.flow !== 'table_booking' && out.draft.total > ctx.codCap;
      out.ready = true;
      out.reply = over
        ? `That's ${describe(out.draft)}. It's over your ₹${ctx.codCap} COD limit, so it will be blocked. Say yes to log it anyway, or change the order.`
        : `Got it: ${describe(out.draft)}. Say yes to send it for approval.`;
    }
  }
  return out;
}

// ---------- Claude ----------

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'reply', 'draft'],
  properties: {
    intent: { type: 'string', enum: ['order', 'question', 'confirm', 'cancel', 'unclear'] },
    reply: { type: 'string', description: 'What to say back, one or two short spoken sentences. Empty for order turns that only fill fields.' },
    draft: {
      type: 'object',
      additionalProperties: false,
      required: ['platform', 'flow', 'restaurant', 'items', 'total'],
      properties: {
        platform: { type: ['string', 'null'], enum: ['swiggy', 'zomato', null] },
        flow: { type: 'string', enum: ['reorder', 'search', 'address_change', 'table_booking'] },
        restaurant: { type: ['string', 'null'] },
        items: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false, required: ['name', 'quantity'],
            properties: { name: { type: 'string' }, quantity: { type: 'integer' } },
          },
        },
        total: { type: ['integer', 'null'] },
      },
    },
  },
};

const SYSTEM = `You are the voice assistant inside Order Agent, an app that places Swiggy and Zomato food orders and table bookings, cash on delivery only.
Each turn you get the user's words (from speech recognition, so expect mishearings like "swiggi" or "zometo"), the order draft so far, and the app state.

Return:
- intent "order" when they are describing or changing an order. Update the draft: keep what's already there unless they change it, merge new items, set quantity (default 1), restaurant if named, total in rupees only if they say it. "Book a table" means flow "table_booking". "Same as last time" or "reorder" means flow "reorder" and copy items from the last order in the app state. "My usual" means flow "reorder" and copy platform, restaurant, items and total from activity.usual.
- intent "confirm" when they say yes / go ahead / send it to a draft that is complete; "cancel" when they want to start over.
- intent "question" for anything else they ask. Answer from the app state only; if the answer isn't there, say so. Never invent prices, menus or delivery times.
- intent "unclear" if you can't tell.

The user may speak English, Hindi, Hinglish or another Indian language. Reply in the language they used. Always write item names in the draft in plain English letters (e.g. "paneer tikka", not Devanagari).

Rules: you never approve or pay for orders. If asked to approve, say approvals are a tap on the Order tab for safety. Orders above the COD cap are blocked. Keep replies short and spoken, no lists or markdown, and use ₹ amounts.`;

async function withClaude(text, draft, ctx, history) {
  client ||= new Anthropic();
  const context = `App state:\n${JSON.stringify(ctx)}\n\nOrder draft so far:\n${JSON.stringify(draft)}\n\nRecent conversation:\n${history.slice(-6).map(h => `${h.role}: ${h.text}`).join('\n') || '(none)'}`;
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 2000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'text', text: context }, { type: 'text', text: `User said: ${text}` }] }],
  });
  if (response.stop_reason === 'refusal') throw new Error('Claude declined this request');
  const block = response.content.find(b => b.type === 'text');
  const parsed = JSON.parse(block.text);
  parsed.draft.items = parsed.draft.items.filter(i => i.name && i.quantity > 0);
  return parsed;
}

// ---------- rules (no API key) ----------

const NUMBERS = { one: 1, a: 1, an: 1, ek: 1, two: 2, do: 2, three: 3, teen: 3, four: 4, char: 4, five: 5, paanch: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const PLATFORM_RE = /\b(swigg?y|swiggi|zomato|zometo|zomatto)\b/i;
const YES_RE = /^(yes|yeah|yep|haan|ha|ok(ay)?|sure|go ahead|send( it)?|confirm|do it|place it)\b/i;
const NO_RE = /^(no|nope|cancel|stop|start over|nahi|clear)\b/i;
const QUESTION_RE = /^(what|whats|what's|how|when|which|who|why|is|are|do|does|can|did|tell me|show me)\b|\?$/i;

export function withRules(text, draft, ctx) {
  const t = text.trim().replace(/\s+/g, ' ');
  const d = structuredClone(draft);

  if (YES_RE.test(t) && missing(d, ctx.linked) === null) return { intent: 'confirm', reply: '', draft: d };
  if (NO_RE.test(t)) return { intent: 'cancel', reply: 'Okay, cleared. What would you like?', draft: { ...emptyDraft() } };
  if (QUESTION_RE.test(t) && !/\b(order|get|book|want)\b.*\b(swiggy|zomato|from)\b/i.test(t)) {
    return { intent: 'question', reply: answer(t.toLowerCase(), ctx), draft: d };
  }
  if (/\bapprove\b/i.test(t)) return { intent: 'question', reply: 'For safety, approvals are a tap on the Order tab.', draft: d };

  let rest = ' ' + t + ' ';
  const pm = rest.match(PLATFORM_RE);
  if (pm) { d.platform = pm[1].toLowerCase().startsWith('s') ? 'swiggy' : 'zomato'; rest = rest.replace(new RegExp(`\\b(on|from|via|using|through)?\\s*${pm[1]}\\b`, 'i'), ' '); }

  // Total: "total 600", "₹600", "600 rupees", "rs 600".
  const tm = rest.match(/(?:total(?: is| of)?|₹|rs\.?|inr)\s*(\d{2,5})|(\d{2,5})\s*(?:rupees|rs\b|bucks)/i);
  if (tm) { d.total = Number(tm[1] || tm[2]); rest = rest.replace(tm[0], ' ').replace(/\b(rupees?|rs|bucks|only)\b/gi, ' '); }

  if (/\b(book|reserve)\b.*\btable\b|\btable for\b/i.test(rest)) {
    d.flow = 'table_booking';
    const r = rest.match(/\b(?:at|in)\s+([a-z][\w' &]+?)(?=\s+(?:for|tonight|today|tomorrow|at \d)|\s*$)/i);
    if (r) d.restaurant = r[1].trim();
    return { intent: 'order', reply: '', draft: d };
  }
  if (/\b(my usual|the usual|usual order|my regular)\b/i.test(rest)) {
    const u = ctx.activity?.usual;
    d.flow = 'reorder';
    if (u) { d.platform = u.platform; d.items = u.items; d.restaurant = u.restaurant; d.total = u.total; }
    return { intent: 'order', reply: u ? '' : "You don't have a usual order yet.", draft: d };
  }
  if (/\b(reorder|same as last time|repeat (my )?(last )?order|order again)\b/i.test(rest)) {
    d.flow = 'reorder';
    if (ctx.lastOrder) { d.platform ||= ctx.lastOrder.platform; d.items = ctx.lastOrder.items; d.restaurant = ctx.lastOrder.restaurant; d.total ||= ctx.lastOrder.total; }
    return { intent: 'order', reply: ctx.lastOrder ? '' : "I don't see a past order yet.", draft: d };
  }

  // "from <restaurant>" after the platform has been removed.
  const rm = rest.match(/\bfrom\s+([a-z][\w' &]+?)\s*(?=$|,|\band\b|\btotal\b)/i);
  if (rm) { d.restaurant = rm[1].trim(); rest = rest.replace(rm[0], ' '); }

  rest = rest.replace(/\b(i(?:'d| would)? (?:like|want)(?: to order)?|please|order|get me|can i get|i want|add|to|for me)\b/gi, ' ');
  for (const part of rest.split(/,|\band\b|\bplus\b|\balso\b/i)) {
    const m = part.trim().match(/^(?:(\d+|[a-z]+)\s+)?(?:x\s*)?(.+)$/i);
    if (!m || !m[2]) continue;
    let qty = 1, name = m[2].trim();
    if (m[1]) {
      const n = /^\d+$/.test(m[1]) ? Number(m[1]) : NUMBERS[m[1].toLowerCase()];
      if (n) qty = n; else name = `${m[1]} ${name}`.trim();
    }
    name = name.replace(/\s+(x\s*)?(\d+)$/i, (_, __, n) => { qty = Number(n); return ''; }).trim();
    if (name.length < 2 || /^(the|a|an|some)$/i.test(name)) continue;
    const existing = d.items.find(i => i.name.toLowerCase() === name.toLowerCase());
    if (existing) existing.quantity = qty; else d.items.push({ name, quantity: qty });
  }
  if (d.flow === 'search' && !d.items.length && !pm && !tm && !rm) {
    return { intent: 'unclear', reply: 'Sorry, I didn\'t catch that. Try "2 chicken biryani from Meghana on Swiggy, total 600".', draft: draft };
  }
  return { intent: 'order', reply: '', draft: d };
}

function answer(q, ctx) {
  if (/\b(limit|cap|maximum|max)\b/.test(q)) return `Your cash on delivery limit is ₹${ctx.codCap}. Orders above it are blocked.`;
  if (/\b(link|linked|connected|connect)\b/.test(q)) return ctx.linked.length ? `${ctx.linked.map(cap).join(' and ')} ${ctx.linked.length > 1 ? 'are' : 'is'} linked.` : 'Nothing is linked yet. Use the Setup tab.';
  const a = ctx.activity;
  if (a && /\b(usual|most|favou?rite|often order)\b/.test(q)) {
    if (!a.topItems.length) return 'You have not ordered enough yet for me to know your favourites.';
    return `You order ${a.topItems.map(i => `${i.name} (${i.times} time${i.times > 1 ? 's' : ''})`).join(', ')} most.` +
      (a.usual?.times > 1 ? ` Your usual is ${describe({ ...a.usual, flow: 'reorder' })}. Say "order my usual" to get it.` : '');
  }
  if (a && /\bwhen\b.*\b(last|previous)\b.*\border/.test(q)) {
    return a.daysSinceLastOrder === null ? 'You have no orders yet.' : `Your last order was ${a.daysSinceLastOrder === 0 ? 'today' : a.daysSinceLastOrder === 1 ? 'yesterday' : a.daysSinceLastOrder + ' days ago'}.`;
  }
  if (a && /\bhow (often|many|much)\b|\bthis month\b/.test(q)) {
    return `In the last 30 days you made ${a.ordersLast30Days} order${a.ordersLast30Days === 1 ? '' : 's'} and used the app on ${a.activeDaysLast30} day${a.activeDaysLast30 === 1 ? '' : 's'}.`;
  }
  if (/\b(pending|waiting|approval)\b/.test(q)) return ctx.pending ? `${ctx.pending} order${ctx.pending > 1 ? 's are' : ' is'} waiting for your approval on the Order tab.` : 'Nothing is waiting for approval.';
  if (/\b(last|previous|recent)\b.*\border\b|\bstatus\b/.test(q)) return ctx.lastOrder ? `Your last order was ${describe({ ...ctx.lastOrder, flow: ctx.lastOrder.flow })}, and it is ${ctx.lastOrder.status.replace('_', ' ')}.` : 'You have no orders yet.';
  if (/\b(success|working|rate|fail|break)\b/.test(q)) return ctx.stats.map(s => `${cap(s.platform)}: ${s.runs ? `${s.ok} of ${s.runs} runs worked` : 'no runs yet'}`).join('. ') + '.';
  if (/\b(cod|cash|pay|payment|upi)\b/.test(q)) return `Every order is cash on delivery, up to ₹${ctx.codCap}. There's no online payment in this app.`;
  if (/\bhow\b.*\border\b|\bhelp\b|\bwhat can you\b/.test(q)) return 'Tell me the platform, what you want and how many, and the cart total. For example: 2 chicken biryani from Meghana on Swiggy, total 600.';
  return 'I can answer about your COD limit, linked platforms, orders and success rates. Open questions need an Anthropic API key on the server.';
}
