// Placing a real Swiggy order, cash on delivery only. Every step re-checks against Swiggy itself
// right before placing, because the cart may have changed since the user approved what they saw.

const text = (r) => (r?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
const json = (r) => JSON.stringify(r?.structuredContent ?? {});

/** The cash / COD entry from get_payment_options, or null. Returns the value to pass as paymentMethod. */
export function findCashMethod(result) {
  const methods = result?.structuredContent?.allMethods;
  const isCash = (s) => /\bcash\b|\bcod\b|pay on delivery/i.test(s);
  if (Array.isArray(methods)) {
    for (const m of methods) {
      if (typeof m === 'string') { if (isCash(m)) return m; continue; }
      if (!isCash(JSON.stringify(m))) continue;
      // Prefer the field Swiggy uses as the method's identifier.
      for (const k of ['paymentMethod', 'method', 'code', 'type', 'name', 'id', 'displayName']) {
        if (typeof m[k] === 'string' && m[k]) return m[k];
      }
      return 'Cash';
    }
    return null;
  }
  // No structured list: fall back to the text, using Swiggy's documented name.
  return isCash(text(result)) ? 'Cash' : null;
}

/** Is the live cart non-empty and showing the total the user approved? Returns a problem or null. */
export function cartProblem(result, approvedTotal) {
  if (!result || result.isError) return `Swiggy could not read the cart: ${text(result).split('\n')[0] || 'unknown error'}`;
  const t = text(result) + '\n' + json(result);
  if (/cart is empty/i.test(t) || result.structuredContent?.data === null) return 'Your Swiggy cart is empty now. Build the order again.';
  const amounts = (t.match(/\d[\d,]*(?:\.\d+)?/g) || []).map(s => Number(s.replace(/,/g, '')));
  if (!amounts.some(a => Math.abs(a - approvedTotal) < 0.5)) return `Your Swiggy cart no longer comes to ₹${approvedTotal}. It may have changed. Build the order again.`;
  return null;
}

/** Swiggy's order ID from the place_food_order result, if there is one. */
export function orderIdOf(result) {
  const s = result?.structuredContent;
  const direct = s?.orderId ?? s?.order_id ?? s?.data?.orderId ?? s?.data?.order_id;
  if (direct) return String(direct);
  const m = (json(result) + ' ' + text(result)).match(/order[ _-]?id["\s:=#]*["']?([A-Za-z0-9-]{5,})/i);
  return m ? m[1] : null;
}

/** Did Swiggy ask for online payment instead of cash? Then the order is not complete. */
export const needsPayment = (result) => /PENDING_PAYMENT|"paasId":\s*"[^"]+"/.test(json(result) + text(result));

/**
 * Re-checks and places the order. `mcp` is a connected Swiggy client; `o` is our approved order.
 * Returns { ok: true, swiggyOrderId, raw } or { ok: false, failure, message, placed?: 'unknown' }.
 */
export async function placeCashOrder(mcp, o, cap) {
  const { addressId, restaurantName } = { ...o.swiggy, restaurantName: o.restaurant };
  if (o.total > cap) return { ok: false, failure: 'cod_over_cap', message: `₹${o.total} is over your ₹${cap} COD limit.` };

  const cart = await mcp.callTool({ name: 'get_food_cart', arguments: { addressId, restaurantName } });
  const problem = cartProblem(cart, o.total);
  if (problem) return { ok: false, failure: 'other', message: problem };

  const options = await mcp.callTool({ name: 'get_payment_options', arguments: { addressId } });
  const cash = findCashMethod(options);
  if (!cash) return { ok: false, failure: 'cod_not_offered', message: 'Swiggy is not offering cash on delivery for this order.' };

  let res;
  try {
    res = await mcp.callTool({ name: 'place_food_order', arguments: { addressId, paymentMethod: cash } });
  } catch (e) {
    // We don't know whether Swiggy placed it. Never retry automatically.
    return { ok: false, failure: 'timeout', placed: 'unknown', message: `No clear answer from Swiggy (${e.message}). Check the Swiggy app before trying again.` };
  }
  const raw = text(res).slice(0, 2000);
  if (res.isError) return { ok: false, failure: 'other', message: `Swiggy refused the order: ${raw.split('\n')[0]}`, raw };
  if (needsPayment(res)) return { ok: false, failure: 'cod_not_offered', placed: 'unknown', message: 'Swiggy asked for online payment instead of cash. Check the Swiggy app.', raw };
  return { ok: true, swiggyOrderId: orderIdOf(res), raw };
}
