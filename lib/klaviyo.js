// Klaviyo Events API. One implementation shared by /api/lead and /api/claim so every
// metric lands under the same API-key source (the live flows are wired to those metrics).
//
//   track('Listing Claimed', email, { store, ... })
//
// Metric names in use (do not rename — flows trigger and exit on them):
//   Onboarding Started | Onboarding Progress | Onboarding Completed | Onboarding Waitlist
//   Listing Claimed    | Listing Published
const config = require('./config');
const sec = require('./security');

/**
 * @param {string} event   metric name
 * @param {string} email
 * @param {object} props   event properties (templates read these as {{ event.x }})
 * @param {object} profile extra PROFILE properties (segments read these) — e.g. claimed_at, store_count, pos_connected
 */
async function track(event, email, props = {}, profile = {}) {
  if (!config.KLAVIYO_API_KEY) return { skipped: true };
  const r = await sec.fetchT('https://a.klaviyo.com/api/events', {
    method: 'POST',
    headers: { Authorization: `Klaviyo-API-Key ${config.KLAVIYO_API_KEY}`, 'Content-Type': 'application/vnd.api+json', accept: 'application/vnd.api+json', revision: '2025-01-15' },
    body: JSON.stringify({ data: { type: 'event', attributes: {
      metric: { data: { type: 'metric', attributes: { name: event } } },
      profile: { data: { type: 'profile', attributes: { email, first_name: props.first_name || undefined, properties: { retailer: true, store: props.store, ...profile } } } },
      properties: props,
    } } }),
  });
  return { ok: r.ok, status: r.status };
}

module.exports = { track };
