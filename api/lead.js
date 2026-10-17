// POST /api/lead
// Fired as soon as we have an email (right after the store is confirmed), and
// again at key steps. Builds a signed resume link, notifies you, and sends a
// Klaviyo event so an abandonment flow can chase anyone who doesn't finish.
//
// Body: { email, name?, stage, storeName, chain, entryStoreId, state }
//   stage: started | locations | systems | review | agreement | completed | waitlist
//   state: the page's in-progress state (used only to build the resume link)
const config = require('../lib/config');

async function klaviyo(event, email, props) {
  if (!config.KLAVIYO_API_KEY) return { skipped: true };
  const r = await fetch('https://a.klaviyo.com/api/events', {
    method: 'POST',
    headers: { Authorization: `Klaviyo-API-Key ${config.KLAVIYO_API_KEY}`, 'Content-Type': 'application/vnd.api+json', accept: 'application/vnd.api+json', revision: '2025-01-15' },
    body: JSON.stringify({ data: { type: 'event', attributes: {
      metric: { data: { type: 'metric', attributes: { name: event } } },
      profile: { data: { type: 'profile', attributes: { email, first_name: props.first_name || undefined, properties: { retailer: true, store: props.store } } } },
      properties: props,
    } } }),
  });
  return { ok: r.ok, status: r.status };
}

async function web3forms(fields) {
  if (!config.WEB3FORMS_KEY) return { skipped: true };
  const r = await fetch('https://api.web3forms.com/submit', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ access_key: config.WEB3FORMS_KEY, ...fields }) });
  return r.json().catch(() => ({}));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const email = String(b.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Email required.' });
    const stage = String(b.stage || 'started').slice(0, 20);
    const storeName = String(b.storeName || '').slice(0, 120);

    // Resume link — the whole state travels in the URL, signed, so nothing is stored.
    let resumeUrl = null;
    if (b.state && stage !== 'completed' && stage !== 'waitlist') {
      const slim = { c: b.chain, e: b.entryStoreId, x: b.state.extra || [], s: b.state.selected || [], g: b.state.groups || [], y: b.state.systems || null, o: b.state.owner || null, r: b.state.referral || null, t: Date.now() };
      resumeUrl = `${config.SITE_URL}/r/${config.encodeResume(slim)}`;
    }

    const first = String(b.name || '').split(' ')[0] || '';
    const props = { stage, store: storeName, chain: b.chain || '', entry_store: b.entryStoreId || '', locations: (b.state && b.state.selected || []).length, resume_url: resumeUrl, first_name: first };
    const out = {};
    out.klaviyo = await klaviyo(stage === 'completed' ? 'Onboarding Completed' : stage === 'waitlist' ? 'Onboarding Waitlist' : 'Onboarding Started', email, props).catch(e => ({ error: e.message }));

    // Internal ping on first capture and waitlist only (not every step — that's noise)
    if (stage === 'started' || stage === 'waitlist') {
      out.internal = await web3forms({
        subject: stage === 'waitlist' ? `Waitlist — ${storeName || 'unknown store'} (not on AGCO authorized list)` : `Onboarding started — ${storeName}`,
        from_name: 'onboarding.poof.ca', Email: email, Name: b.name || '', Store: storeName, Chain: b.chain || '', 'Entry store': b.entryStoreId || '', Note: b.note || '', 'Resume link': resumeUrl || '',
      }).catch(e => ({ error: e.message }));
    }
    return res.status(200).json({ ok: true, resumeUrl });
  } catch (e) {
    return res.status(200).json({ ok: false }); // never block the flow on this
  }
};
