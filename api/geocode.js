import { loadIndex, fetchPlace } from '../lib/enrich.js';

/**
 * POST /api/geocode  { ids: [locationId, ...] }
 *
 * Street-level coordinates for the retailer's own stores.
 *
 * The index carries city centroids (see lib/geo.js), which is fine for a
 * province-wide dot cloud but visibly wrong on a street map — the pin lands in
 * the middle of town rather than on the storefront. So the coverage map asks
 * for real coordinates, and only for the handful of stores the retailer
 * actually selected, not all 2,611.
 *
 * Falls back to the index coordinate when Places has no answer or no key is
 * configured, and says which it used so the UI can be honest about precision.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 40) : [];
  if (!ids.length) return res.status(400).json({ error: 'No location ids supplied.' });

  try {
    const index = loadIndex();
    const wanted = index.filter(r => ids.includes(r.id));

    const results = await Promise.all(wanted.map(async r => {
      const fallback = {
        id: r.id,
        name: r.address.city,
        address: [r.address.street, r.address.city, r.address.postal].filter(Boolean).join(', '),
        licenceNumber: r.licenceNumber,
        lat: r.lat,
        lng: r.lng,
        precision: r.geo || 'city'
      };

      try {
        const place = await fetchPlace({
          name: r.banner,
          street: r.address.street,
          city: r.address.city,
          postal: r.address.postal
        });
        if (place?.lat && place?.lng) {
          return { ...fallback, lat: place.lat, lng: place.lng, precision: 'exact' };
        }
      } catch { /* fall through to the city centroid */ }

      return fallback;
    }));

    return res.status(200).json({ locations: results });
  } catch (err) {
    console.error('[geocode]', err);
    return res.status(500).json({ error: 'Geocoding unavailable.' });
  }
}
