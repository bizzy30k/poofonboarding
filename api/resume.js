// GET /api/resume?t=<token> → the saved state behind a /r/<token> link,
// re-hydrated against the AGCO index so stale ids are dropped.
const config = require('../lib/config');
const stores = require('../lib/stores');

module.exports = async (req, res) => {
  const st = config.decodeResume((req.query || {}).t);
  if (!st) return res.status(400).json({ error: 'That link has expired.' });
  if (Date.now() - (st.t || 0) > 30 * 86400e3) return res.status(400).json({ error: 'That link has expired.' });
  const chain = stores.chain(st.c);
  if (!chain) return res.status(404).json({ error: 'Store not found.' });
  const extra = (st.x || []).map(stores.chain).filter(Boolean);
  const valid = new Set([...chain.stores, ...extra.flatMap(c => c.stores)].map(s => s.id));
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).json({
    chain, extra, entryStoreId: st.e || null,
    selected: (st.s || []).filter(id => valid.has(id)),
    groups: (st.g || []).map(g => ({ name: g.name, ids: (g.ids || []).filter(id => valid.has(id)) })).filter(g => g.ids.length),
    systems: st.y || null, owner: st.o || null, referral: st.r || null,
  });
};
