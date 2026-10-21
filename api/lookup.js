// GET /api/lookup?q=sessions         → { chains, stores, all } matching the query (results = chains, for older clients)
// GET /api/lookup?chain=sessions-cannabis → one chain with every authorized store
// GET /api/lookup?chain=…&places=1   → same, plus Google Places details for the chain's first store (optional)
const stores = require('../lib/stores');
const sec = require('../lib/security');

const { places } = require('../lib/places');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!sec.rateLimit(`lookup:${sec.clientIp(req)}`, 60, 60e3)) return sec.tooMany(res);

  const { q, chain, store: storeId, places: wantPlaces } = req.query || {};
  if (storeId) {
    // Per-store deep link: /s/CRSA1234567 → the store plus its whole chain
    const s = stores.store(String(storeId).toUpperCase().replace(/[^A-Z0-9]/g, ''));
    if (!s) return res.status(404).json({ error: 'No such store.' });
    const c = stores.chain(s.chain);
    const out = { ...c, entry: { id: s.id, name: s.name, addr: s.addr, city: s.city, postal: s.postal, lat: s.lat, lng: s.lng } };
    if (wantPlaces) out.places = await places(s);
    return res.status(200).json(out);
  }
  if (chain) {
    const c = stores.chain(String(chain));
    if (!c) return res.status(404).json({ error: 'No such store.' });
    const out = { ...c };
    if (wantPlaces) out.places = await places(c.stores[0]);
    return res.status(200).json(out);
  }
  if (q) { const r = stores.search(String(q).slice(0, 80)); return res.status(200).json({ results: r.chains, ...r }); }
  return res.status(400).json({ error: 'Pass ?q= or ?chain=' });
};
