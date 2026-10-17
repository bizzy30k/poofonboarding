// GET /api/lookup?q=sessions         → { chains, stores, all } matching the query (results = chains, for older clients)
// GET /api/lookup?chain=sessions-cannabis → one chain with every authorized store
// GET /api/lookup?chain=…&places=1   → same, plus Google Places details for the chain's first store (optional)
const stores = require('../lib/stores');
const config = require('../lib/config');

const bucket = new Map(); // very light rate limit per instance: 60 req / min / ip
function limited(ip) {
  const now = Date.now();
  const b = bucket.get(ip) || { n: 0, t: now };
  if (now - b.t > 60000) { b.n = 0; b.t = now; }
  b.n++; bucket.set(ip, b);
  return b.n > 60;
}

async function places(store) {
  if (!config.GOOGLE_PLACES_KEY) return null;
  try {
    const q = encodeURIComponent(`${store.name} ${store.addr} ${store.city} Ontario`);
    const f = await fetch(`https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${q}&inputtype=textquery&fields=place_id&key=${config.GOOGLE_PLACES_KEY}`);
    const j = await f.json();
    const id = j.candidates && j.candidates[0] && j.candidates[0].place_id;
    if (!id) return null;
    const d = await fetch(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${id}&fields=rating,user_ratings_total,formatted_phone_number,website,opening_hours&key=${config.GOOGLE_PLACES_KEY}`);
    const r = (await d.json()).result || {};
    return {
      rating: r.rating || null,
      ratings: r.user_ratings_total || null,
      phone: r.formatted_phone_number || null,
      website: r.website || null,
      hours: r.opening_hours && r.opening_hours.weekday_text ? r.opening_hours.weekday_text : null,
    };
  } catch (e) { return null; }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress;
  if (limited(ip)) return res.status(429).json({ error: 'Slow down.' });

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
  if (q) { const r = stores.search(String(q)); return res.status(200).json({ results: r.chains, ...r }); }
  return res.status(400).json({ error: 'Pass ?q= or ?chain=' });
};
