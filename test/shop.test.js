import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verify } from '../shop.js';

const proposal = (over = {}) => ({ items: [{ name: 'Chicken biryani', quantity: 2, price: 598 }], total: 642.5, codAvailable: true, ...over });
const cart = 'Item total: ₹598\nDelivery fee: ₹29\nTaxes: ₹15.50\nTo pay: ₹642.50';

test('rejects a proposal before the cart and payment options were read', () => {
  assert.match(verify(proposal(), { cart: null, payment: 'Cash' }), /get_food_cart/);
  assert.match(verify(proposal(), { cart, payment: null }), /get_payment_options/);
});

test('rejects a total that is not in Swiggy\'s cart', () => {
  assert.match(verify(proposal({ total: 600 }), { cart, payment: 'Cash' }), /does not appear/);
});

test('accepts a total copied from the cart, including 1,234 style numbers', () => {
  assert.equal(verify(proposal(), { cart, payment: 'Cash on Delivery' }), null);
  assert.equal(verify(proposal({ total: 1234 }), { cart: 'To pay ₹1,234', payment: 'COD' }), null);
});

test('only trusts COD when Swiggy lists cash', () => {
  const p = proposal();
  assert.equal(verify(p, { cart, payment: 'UPI apps: GPay, PhonePe' }), null);
  assert.equal(p.codAvailable, false);
});
