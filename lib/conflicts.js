// Franchise guard. Before a second owner signs up doors that are already on
// another customer's record, find the overlap so it's flagged (at acceptance)
// or refused (at activation) instead of silently double-billed.
const record = require('./record');

async function findConflicts(stripe, chainName, locationIds, excludeCustomerId) {
  const out = [];
  try {
    const q = `metadata['poof_store_name']:'${String(chainName).replace(/'/g, "\\'")}'`;
    let page = await stripe.customers.search({ query: q, limit: 100 });
    const seen = new Set(locationIds);
    for (;;) {
      for (const c of page.data) {
        if (c.id === excludeCustomerId) continue;
        const theirs = String(c.metadata.location_ids || '').split(',').filter(Boolean);
        const overlap = theirs.filter(id => seen.has(id));
        if (overlap.length) out.push({ customerId: c.id, email: c.email, name: c.metadata.contact_name || c.name, stage: c.metadata.onboarding_stage || '', overlap });
      }
      if (!page.has_more) break;
      page = await stripe.customers.search({ query: q, limit: 100, page: page.next_page });
    }
  } catch (e) { /* search unavailable → no guard, never block */ }
  return out;
}

module.exports = { findConflicts };
