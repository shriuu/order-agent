// Real Swiggy shopping agent: ChatGPT (OpenAI) drives Swiggy's official MCP tools to find dishes
// and build a real cart with real prices. It can NOT place orders or pay: those tools are never
// given to the model. Placing happens only after the user approves, in our own code.
import OpenAI from 'openai';

export const openaiEnabled = () => !!process.env.OPENAI_API_KEY;
const MODEL = () => process.env.OPENAI_MODEL || 'gpt-5.4-mini';
let client;

// Read and cart tools only. place_food_order, confirm_order, check_payment_status, create_address,
// delete_address and report_error are deliberately left out.
const ALLOWED = new Set([
  'get_addresses', 'search_restaurants', 'search_menu', 'get_restaurant_menu',
  'get_food_cart', 'update_food_cart', 'flush_food_cart', 'fetch_food_coupons', 'apply_food_coupon',
  'get_payment_options', 'get_food_orders', 'get_food_order_details', 'track_food_order',
]);
const MAX_RESULT = 15000; // characters of each Swiggy reply passed to the model
const MAX_ROUNDS = 12;

// Our own tool: the model calls it once the real cart is built and checked.
const READY = {
  type: 'function',
  function: {
    name: 'ready_for_approval',
    description: 'Call this once the cart is complete, right after get_food_cart and get_payment_options. Copy every number exactly from the get_food_cart result. The app then shows the cart to the user for approval. You cannot place the order yourself.',
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['addressId', 'addressLabel', 'restaurantId', 'restaurantName', 'items', 'itemTotal', 'fees', 'total', 'codAvailable'],
      properties: {
        addressId: { type: 'string' },
        addressLabel: { type: 'string', description: 'Short label like "Home" or "Work, Indiranagar"' },
        restaurantId: { type: 'string' },
        restaurantName: { type: 'string' },
        items: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false, required: ['name', 'quantity', 'price'],
            properties: { name: { type: 'string' }, quantity: { type: 'integer' }, price: { type: 'number', description: 'Line total in rupees for this item' } },
          },
        },
        itemTotal: { type: 'number' },
        fees: { type: 'number', description: 'Delivery fee + taxes + other charges, minus discounts' },
        total: { type: 'number', description: 'The final amount to pay, exactly as in get_food_cart' },
        codAvailable: { type: 'boolean', description: 'true only if get_payment_options lists Cash / Cash on Delivery' },
      },
    },
  },
};

const system = (ctx) => `You order food on Swiggy for the user through Swiggy's tools. This app is cash on delivery (COD) only, with a limit of ₹${ctx.codCap}.

How to work:
1. Delivery address: call get_addresses first. If the user hasn't chosen an address yet, suggest the first (most recent) one by its label and area and ask them to confirm, or name a different one. Use that addressId in every later call. Never ask for coordinates.
2. Find food: use search_menu for dishes, search_restaurants for restaurant names, get_restaurant_menu to browse. If several good matches differ a lot (restaurant or price), offer the top 2 or 3 with prices and let the user pick. Otherwise pick the best match yourself.
3. Build the cart: when starting a new order, call flush_food_cart first so nothing old is mixed in. Then update_food_cart with the right restaurantId, item IDs, variants and quantities. Follow the tool's rules on variants/variantsV2 and addons exactly.
4. Check: call get_food_cart (with addressId and restaurantName) and get_payment_options (with addressId).
5. Call ready_for_approval with numbers copied exactly from get_food_cart. Then tell the user the items and the total, and say "Say yes to send it for approval." If the total is over ₹${ctx.codCap}, say it will be blocked by their COD limit.

Rules:
- You cannot place, pay for or confirm orders. Never say an order is placed.
- Never mention IDs (address, restaurant or item IDs) to the user. Use names and labels.
- Prices: give the price of the dish itself when you know it, not the "cost for two".
- Only suggest coupons valid for cash on delivery.
- Reply in the language the user used (English, Hindi or Hinglish). Replies are spoken aloud: one to three short sentences, no lists, no markdown, use ₹.
- If a tool fails, say what went wrong in plain words and suggest what to try.
- For questions about past or active orders, use get_food_orders or track_food_order.`;

// OpenAI rejects top-level oneOf/anyOf/allOf/enum/const/not in a function schema. Swiggy uses them for
// "addressId OR latitude+longitude"; the tool description already explains that, so we drop them.
export function cleanSchema(schema) {
  const { oneOf, anyOf, allOf, enum: _e, const: _c, not, ...rest } = schema || {};
  return { ...rest, type: 'object', properties: rest.properties || {} };
}

const textOf = (result) => {
  const parts = (result.content || []).map(c => c.type === 'text' ? c.text : '').filter(Boolean);
  const text = parts.join('\n') || JSON.stringify(result.structuredContent || {});
  return text.length > MAX_RESULT ? text.slice(0, MAX_RESULT) + '\n…[truncated]' : text;
};

/**
 * One user turn. `session` keeps the conversation across turns ({ messages }); it is mutated.
 * `mcp` is a connected Swiggy MCP client. Returns { reply, proposal?, toolsUsed }.
 */
export async function shopTurn({ text, session, mcp, ctx }) {
  client ||= new OpenAI();
  const { tools: swiggyTools } = await mcp.listTools();
  const tools = swiggyTools.filter(t => ALLOWED.has(t.name)).map(t => ({
    type: 'function',
    function: { name: t.name, description: (t.description || '').slice(0, 1024), parameters: cleanSchema(t.inputSchema) },
  }));
  tools.push(READY);

  session.messages ||= [];
  session.messages.push({ role: 'user', content: text });
  const toolsUsed = [];
  let proposal = null;
  // Raw Swiggy replies from this turn, used to check the model's numbers against.
  const seen = { cart: null, payment: null };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await client.chat.completions.create({
      model: MODEL(),
      messages: [{ role: 'system', content: system(ctx) }, ...session.messages],
      tools,
    });
    const msg = res.choices[0].message;
    session.messages.push(msg);
    if (!msg.tool_calls?.length) return { reply: msg.content || '', proposal, toolsUsed };

    for (const call of msg.tool_calls) {
      const name = call.function.name;
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* answered as an error below */ }
      toolsUsed.push(name);
      let out;
      if (name === 'ready_for_approval') {
        const check = verify(args, seen);
        if (check) out = `Not accepted: ${check}`;
        else { proposal = args; out = 'Shown to the user for approval.'; }
      } else if (!ALLOWED.has(name)) {
        out = `Tool ${name} is not available in this app.`;
      } else {
        try {
          const r = await mcp.callTool({ name, arguments: args });
          out = (r.isError ? 'Error from Swiggy: ' : '') + textOf(r);
          if (name === 'get_food_cart' || name === 'apply_food_coupon') seen.cart = out;
          if (name === 'get_payment_options') seen.payment = out;
          if (name === 'update_food_cart' || name === 'flush_food_cart') seen.cart = null;
        } catch (e) {
          out = `Error calling Swiggy: ${e.message}`;
        }
      }
      session.messages.push({ role: 'tool', tool_call_id: call.id, content: out });
    }
  }
  return { reply: 'That took too many steps. Please try again with the restaurant and dish name.', proposal, toolsUsed };
}

/** Cheap checks that the proposal matches what Swiggy actually returned. Returns a problem or null. */
export function verify(p, seen) {
  if (!seen.cart) return 'call get_food_cart (after your last cart change) before ready_for_approval.';
  if (!seen.payment) return 'call get_payment_options before ready_for_approval.';
  if (!p.items?.length) return 'the cart has no items.';
  const amounts = (seen.cart.match(/\d[\d,]*(?:\.\d+)?/g) || []).map(s => Number(s.replace(/,/g, '')));
  if (!amounts.some(a => Math.abs(a - p.total) < 0.5)) return `the total ₹${p.total} does not appear in the get_food_cart result. Copy it exactly.`;
  // Only trust "COD available" if Swiggy's payment options actually mention cash.
  if (p.codAvailable && !/\bcash\b|\bcod\b|pay on delivery/i.test(seen.payment)) p.codAvailable = false;
  return null;
}
