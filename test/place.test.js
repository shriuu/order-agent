import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCashMethod, cartProblem, orderIdOf, needsPayment, placeCashOrder } from '../place.js';

const tool = (text, structuredContent, isError = false) => ({ content: [{ type: 'text', text }], structuredContent, isError });

test('finds the cash method in Swiggy\'s payment list', () => {
  assert.equal(findCashMethod(tool('', { allMethods: [] })), null); // what Swiggy returns for an empty cart
  assert.equal(findCashMethod(tool('', { allMethods: [{ name: 'GPay', type: 'UPI' }] })), null);
  assert.equal(findCashMethod(tool('', { allMethods: [{ type: 'UPI' }, { paymentMethod: 'Cash', displayName: 'Cash on Delivery' }] })), 'Cash');
  assert.equal(findCashMethod(tool('', { allMethods: ['UPI', 'COD'] })), 'COD');
});

test('spots an empty or changed cart', () => {
  assert.match(cartProblem(tool('Cart is empty.', { data: null }), 500), /empty/);
  assert.match(cartProblem(tool('To pay: ₹612', { data: {} }), 642), /no longer/);
  assert.equal(cartProblem(tool('To pay: ₹642', { data: {} }), 642), null);
  assert.match(cartProblem(tool('addressId is required', {}, true), 642), /could not read/);
});

test('reads the order ID and spots online-payment answers', () => {
  assert.equal(orderIdOf(tool('', { orderId: 1234567890 })), '1234567890');
  assert.equal(orderIdOf(tool('Order placed! Order ID: 98765432', {})), '98765432');
  assert.equal(needsPayment(tool('', { status: 'PENDING_PAYMENT', paasId: 'x' })), true);
  assert.equal(needsPayment(tool('Order placed, pay cash on delivery', { orderId: 1 })), false);
  assert.equal(needsPayment(tool('Order placed. Tip: next time you can pay by UPI.', { orderId: 1 })), false);
});

// A fake Swiggy that records what was called.
const fakeSwiggy = (replies) => {
  const calls = [];
  return { calls, callTool: async ({ name, arguments: args }) => { calls.push({ name, args }); return replies[name]; } };
};
const order = { total: 642, restaurant: 'Biryani Blues', swiggy: { addressId: 'a1' } };

test('places a cash order only after the cart and cash checks pass', async () => {
  const mcp = fakeSwiggy({
    get_food_cart: tool('To pay ₹642', { data: {} }),
    get_payment_options: tool('', { allMethods: [{ paymentMethod: 'Cash' }] }),
    place_food_order: tool('Order placed', { orderId: 555001 }),
  });
  const r = await placeCashOrder(mcp, order, 1500);
  assert.deepEqual(r.ok, true);
  assert.equal(r.swiggyOrderId, '555001');
  assert.deepEqual(mcp.calls.at(-1), { name: 'place_food_order', args: { addressId: 'a1', paymentMethod: 'Cash' } });
});

test('never calls place_food_order when a check fails', async () => {
  for (const [replies, cap, failure] of [
    [{ get_food_cart: tool('To pay ₹642', { data: {} }), get_payment_options: tool('', { allMethods: [{ type: 'UPI' }] }) }, 1500, 'cod_not_offered'],
    [{ get_food_cart: tool('Cart is empty.', { data: null }) }, 1500, 'other'],
    [{}, 500, 'cod_over_cap'],
  ]) {
    const mcp = fakeSwiggy(replies);
    const r = await placeCashOrder(mcp, order, cap);
    assert.equal(r.ok, false);
    assert.equal(r.failure, failure);
    assert.ok(!mcp.calls.some(c => c.name === 'place_food_order'));
  }
});

test('does not retry when Swiggy gives no clear answer', async () => {
  let placeCalls = 0;
  const mcp = {
    callTool: async ({ name }) => {
      if (name === 'get_food_cart') return tool('To pay ₹642', { data: {} });
      if (name === 'get_payment_options') return tool('', { allMethods: ['Cash'] });
      placeCalls++; throw new Error('socket hang up');
    },
  };
  const r = await placeCashOrder(mcp, order, 1500);
  assert.equal(r.placed, 'unknown');
  assert.equal(placeCalls, 1);
});
