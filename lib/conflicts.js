// Franchise guard. Before a second owner signs up doors that are already on
// another customer's record, find the overlap so it's flagged (at acceptance)
// or refused (at activation) instead of silently double-billed.
//
// Compares against the FULL unpacked record of every onboarding customer, not the
// truncated `location_ids` dashboard key (which only holds ~41 ids) and not just
// customers with the same chain name (a franchisee may have typed a different name).
// Returns { ok, conflicts }: ok=false means Stripe search failed and the caller must
// decide whether to fail closed (activation does).
const record = require('./record');

async function findConflicts(stripe, locationIds, excludeCustomerId, ownerEmail) {
  const own = String(ownerEmail || '').toLowerCase();
  const mine = new Set(locationIds);
  const conflicts = [];
  try {
    const q = "metadata['source']:'onboarding.poof.ca'";
    let page = await stripe.customers.search({ query: q, limit: 100 });
    for (;;) {
      for (const c of page.data) {
        if (c.id === excludeCustomerId || c.deleted) continue;
        if (own && String(c.email || '').toLowerCase() === own) continue; // the same retailer's earlier attempt, not a rival
        const rec = record.unpack(c.metadata || {});
        const theirs = rec ? rec.locations.map(l => l.id) : String(c.metadata.location_ids || '').split(',').filter(Boolean);
        const overlap = theirs.filter(id => mine.has(id));
        if (overlap.length) conflicts.push({ customerId: c.id, name: c.metadata.contact_name || c.name, stage: c.metadata.onboarding_stage || '', overlap: overlap.slice(0, 20), overlapCount: overlap.length });
      }
      if (!page.has_more) break;
      page = await stripe.customers.search({ query: q, limit: 100, page: page.next_page });
    }
    return { ok: true, conflicts };
  } catch (e) {
    console.error('conflicts: search failed', e.message);
    return { ok: false, conflicts: [] };
  }
}

module.exports = { findConflicts };
