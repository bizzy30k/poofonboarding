import { searchIndex, buildProfile, relatedBanners } from '../lib/enrich.js';

/**
 * GET /api/lookup?q=fire            → typeahead candidates
 * GET /api/lookup?bannerId=...&name=... → full confirmable profile
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { q, bannerId, bannerIds, name, locationIds, exclude, related } = req.query;

  try {
    // Sibling banners — same business trading under near-identical names.
    if (related) {
      res.setHeader('Cache-Control', 'private, max-age=300');
      return res.status(200).json({ related: relatedBanners(String(related)) });
    }

    if (bannerId || bannerIds || (name && !q)) {
      const profile = await buildProfile({
        bannerId: bannerId || null,
        bannerIds: bannerIds ? String(bannerIds).split(',').filter(Boolean) : [],
        storeName: name || '',
        locationIds: locationIds ? String(locationIds).split(',').filter(Boolean) : []
      });
      res.setHeader('Cache-Control', 'private, max-age=60');
      return res.status(200).json({ profile });
    }

    if (!q || q.trim().length < 2) {
      return res.status(200).json({ candidates: [] });
    }

    const excludeIds = exclude
      ? new Set(String(exclude).split(',').filter(Boolean))
      : null;
    const candidates = searchIndex(q, { excludeIds });
    res.setHeader('Cache-Control', 'private, max-age=120');
    return res.status(200).json({ candidates });
  } catch (err) {
    console.error('[lookup]', err);
    return res.status(500).json({ error: 'Lookup unavailable. Enter details manually.' });
  }
}
