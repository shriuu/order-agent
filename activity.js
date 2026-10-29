// Recency and frequency: how recently and how often each user uses the app and orders.
// Pure functions over the stored events and orders, so they're easy to test.

const DAY = 24 * 60 * 60 * 1000;
// Days are counted in India time, so a 11:30 pm order and a 12:30 am open are different days.
const dayKey = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

/**
 * Segments, checked in order. Recency = days since last active; frequency = active days in the last 30.
 *   New        signed up in the last 7 days
 *   Power user active in the last 3 days, and on 10+ of the last 30 days
 *   Regular    active in the last 7 days, and on 4+ of the last 30 days
 *   Occasional active in the last 14 days
 *   At risk    last active 15-30 days ago
 *   Lapsed     last active over 30 days ago
 */
export function segment({ daysSinceActive, activeDays30d, daysSinceSignup }) {
  if (daysSinceSignup !== null && daysSinceSignup < 7) return 'New';
  if (daysSinceActive === null) return 'Lapsed';
  if (daysSinceActive <= 3 && activeDays30d >= 10) return 'Power user';
  if (daysSinceActive <= 7 && activeDays30d >= 4) return 'Regular';
  if (daysSinceActive <= 14) return 'Occasional';
  if (daysSinceActive <= 30) return 'At risk';
  return 'Lapsed';
}

/** One user's recency/frequency summary. `events` and `orders` are that user's only. */
export function activityFor(user, events, orders, now = Date.now()) {
  const t = (iso) => Date.parse(iso);
  const within = (iso, days) => now - t(iso) <= days * DAY;
  const daysAgo = (iso) => iso ? Math.floor((now - t(iso)) / DAY) : null;

  const opens = events.filter(e => e.type === 'app_open');
  const lastActive = events.reduce((m, e) => (!m || t(e.at) > t(m) ? e.at : m), null);
  const activeDays = new Set(events.filter(e => within(e.at, 30)).map(e => dayKey(t(e.at))));

  // Daily activity for the last 30 days, oldest first, for the strip on the dashboard.
  const perDay = {};
  for (const e of events) if (within(e.at, 30)) perDay[dayKey(t(e.at))] = (perDay[dayKey(t(e.at))] || 0) + 1;
  const strip = Array.from({ length: 30 }, (_, i) => {
    const k = dayKey(now - (29 - i) * DAY);
    return { day: k, count: perDay[k] || 0 };
  });

  const placed = orders.filter(o => o.status === 'placed');
  const lastOrderByPlatform = {};
  for (const o of orders) {
    const prev = lastOrderByPlatform[o.platform];
    if (!prev || t(o.createdAt) > t(prev)) lastOrderByPlatform[o.platform] = o.createdAt;
  }
  const platformCounts = orders.reduce((m, o) => (m[o.platform] = (m[o.platform] || 0) + 1, m), {});
  const favouritePlatform = Object.entries(platformCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  // Items ordered most often in the last 90 days (blocked and rejected orders don't count).
  const counted = orders.filter(o => within(o.createdAt, 90) && !['blocked', 'rejected'].includes(o.status));
  const items = {};
  for (const o of counted) {
    for (const i of o.lineItems || [{ name: o.items, quantity: 1 }]) {
      const k = i.name.toLowerCase();
      items[k] ||= { name: i.name, times: 0, lastAt: o.createdAt };
      items[k].times += 1;
      if (t(o.createdAt) > t(items[k].lastAt)) items[k].lastAt = o.createdAt;
    }
  }
  const topItems = Object.values(items).sort((a, b) => b.times - a.times || t(b.lastAt) - t(a.lastAt)).slice(0, 3);

  // "Your usual": the same platform + items ordered most often; ties go to the most recent.
  const combos = {};
  for (const o of counted) {
    if (o.flow === 'table_booking') continue;
    const k = o.platform + '|' + (o.lineItems ? o.lineItems.map(i => `${i.name.toLowerCase()}x${i.quantity}`).sort().join(',') : o.items.toLowerCase());
    combos[k] ||= { times: 0, order: o };
    combos[k].times += 1;
    if (t(o.createdAt) > t(combos[k].order.createdAt)) combos[k].order = o;
  }
  const best = Object.values(combos).sort((a, b) => b.times - a.times || t(b.order.createdAt) - t(a.order.createdAt))[0];
  const usual = best && {
    times: best.times, platform: best.order.platform, restaurant: best.order.restaurant, total: best.order.total,
    items: best.order.lineItems || [{ name: best.order.items, quantity: 1 }], lastAt: best.order.createdAt,
  };

  const summary = {
    lastActiveAt: lastActive,
    daysSinceActive: daysAgo(lastActive),
    daysSinceSignup: daysAgo(user.createdAt),
    sessions7d: opens.filter(e => within(e.at, 7)).length,
    sessions30d: opens.filter(e => within(e.at, 30)).length,
    activeDays30d: activeDays.size,
    orders30d: orders.filter(o => within(o.createdAt, 30)).length,
    placed30d: placed.filter(o => within(o.createdAt, 30)).length,
    lastOrderAt: orders.reduce((m, o) => (!m || t(o.createdAt) > t(m) ? o.createdAt : m), null),
    lastOrderByPlatform, favouritePlatform, topItems, usual, strip,
  };
  summary.segment = segment(summary);
  return summary;
}
