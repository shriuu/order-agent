import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityFor, segment } from '../activity.js';

const NOW = Date.parse('2026-10-29T12:00:00+05:30');
const ago = (days, hours = 0) => new Date(NOW - days * 864e5 - hours * 36e5).toISOString();

test('segments follow recency then frequency', () => {
  assert.equal(segment({ daysSinceSignup: 2, daysSinceActive: 0, activeDays30d: 1 }), 'New');
  assert.equal(segment({ daysSinceSignup: 60, daysSinceActive: 1, activeDays30d: 12 }), 'Power user');
  assert.equal(segment({ daysSinceSignup: 60, daysSinceActive: 5, activeDays30d: 12 }), 'Regular');
  assert.equal(segment({ daysSinceSignup: 60, daysSinceActive: 2, activeDays30d: 4 }), 'Regular');
  assert.equal(segment({ daysSinceSignup: 60, daysSinceActive: 2, activeDays30d: 3 }), 'Occasional');
  assert.equal(segment({ daysSinceSignup: 60, daysSinceActive: 20, activeDays30d: 1 }), 'At risk');
  assert.equal(segment({ daysSinceSignup: 60, daysSinceActive: 45, activeDays30d: 0 }), 'Lapsed');
});

test('counts sessions, active days and orders in their windows', () => {
  const user = { createdAt: ago(60) };
  const events = [
    { type: 'app_open', at: ago(0, 1) }, { type: 'app_open', at: ago(0, 3) }, // same day, two sessions
    { type: 'app_open', at: ago(3) }, { type: 'app_open', at: ago(10) }, { type: 'app_open', at: ago(40) },
    { type: 'order_request', at: ago(3) },
  ];
  const a = activityFor(user, events, [], NOW);
  assert.equal(a.daysSinceActive, 0);
  assert.equal(a.sessions7d, 3);
  assert.equal(a.sessions30d, 4);
  assert.equal(a.activeDays30d, 3); // today, 3 days ago, 10 days ago
  assert.equal(a.strip.length, 30);
  assert.equal(a.strip.at(-1).count, 2);
  assert.equal(a.segment, 'Occasional');
});

test('finds the usual order and top items, ignoring blocked ones', () => {
  const biryani = [{ name: 'Chicken biryani', quantity: 2 }];
  const o = (days, extra) => ({ platform: 'swiggy', flow: 'search', status: 'placed', total: 600, items: 'x', lineItems: biryani, restaurant: 'Meghana', createdAt: ago(days), ...extra });
  const orders = [
    o(20), o(9), o(2),
    o(1, { platform: 'zomato', lineItems: [{ name: 'Burger', quantity: 1 }], restaurant: 'Truffles', total: 300 }),
    o(0, { lineItems: [{ name: 'Party pack', quantity: 4 }], status: 'blocked', total: 2200 }),
  ];
  const a = activityFor({ createdAt: ago(60) }, [], orders, NOW);
  assert.equal(a.usual.times, 3);
  assert.equal(a.usual.restaurant, 'Meghana');
  assert.equal(a.topItems[0].name, 'Chicken biryani');
  assert.ok(!a.topItems.some(i => i.name === 'Party pack'));
  assert.equal(a.favouritePlatform, 'swiggy');
  assert.equal(a.orders30d, 5);
  assert.equal(a.lastOrderByPlatform.zomato, ago(1));
});
