// GET /api/lookup?q=sessions         → { chains, stores, all } matching the query (results = chains, for older clients)
// GET /api/lookup?chain=sessions-cannabis → one chain with every authorized store
// GET /api/lookup?chain=…&places=1   → same, plus Google Places details for the chain's first store (optional)
const stores = require('../lib/stores');
const config = require('../lib/config');

const sec = require('../lib/security');

// Google Places costs money per call. Cache results per store for the life of the
// instance and cap Places lookups globally per minute, independent of IP.
const placesCache = new Map(); // storeId → { at, data }
const PLACES_TTL = 6 * 3600e3;

async function places(store) {
  if (!config.GOOGLE_PLACES_KEY) return null;
  const hit = placesCache.get(store.id);
  if (hit && Date.now() - hit.at < PLACES_TTL) return hit.data;
  if (!sec.rateLimit('places:global', 30, 60e3)) return null; // soft cap: 30 Places lookups / min / instance
  try {
    const q = encodeURIComponent(`${store.name} ${store.addr} ${store.city} Ontario`);
    const f = await sec.fetchT(`https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${q}&inputtype=textquery&fields=place_id&key=${config.GOOGLE_PLACES_KEY}`);
    const j = await f.json();
    const id = j.candidates && j.candidates[0] && j.candidates[0].place_id;
    if (!id) return null;
    const d = await sec.fetchT(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${id}&fields=rating,user_ratings_total,formatted_phone_number,website,opening_hours&key=${config.GOOGLE_PLACES_KEY}`);
    const r = (await d.json()).result || {};
    const data = {
      rating: r.rating || null,
      ratings: r.user_ratings_total || null,
      phone: r.formatted_phone_number || null,
      website: /^https?:\/\//i.test(r.website || '') ? r.website : null,
      hours: r.opening_hours && r.opening_hours.weekday_text ? r.opening_hours.weekday_text : null,
    };
    placesCache.set(store.id, { at: Date.now(), data });
    return data;
  } catch (e) { return null; }
}

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
