import { loadIndex } from '../lib/enrich.js';

/**
 * GET /api/map — every authorized store as a plottable point.
 *
 * Deliberately minimal: coordinate, city and banner id only. No licence
 * numbers, no addresses, no contact details. This payload is public the moment
 * it renders in a browser, so it carries nothing that isn't already on a map
 * of storefronts.
 *
 * Coordinates are city centroids with a deterministic spread, not geocoded
 * street addresses — see lib/geo.js.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const points = loadIndex()
      .filter(r => r.status === 'authorized' && r.lat && r.lng)
      .map(r => [
        Number(r.lat.toFixed(3)),
        Number(r.lng.toFixed(3)),
        r.bannerId,
        r.address.city
      ]);

    // Static for a given index build, so let the CDN hold it.
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800');
    return res.status(200).json({
      points,
      total: points.length,
      cities: new Set(points.map(p => p[3])).size
    });
  } catch (err) {
    console.error('[map]', err);
    return res.status(500).json({ error: 'Map data unavailable.' });
  }
}
