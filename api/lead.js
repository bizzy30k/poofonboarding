// POST /api/lead
// Fired as soon as we have an email (right after the store is confirmed), and
// again at key steps. Builds a signed resume link, notifies you, and sends a
// Klaviyo event so an abandonment flow can chase anyone who doesn't finish.
//
// Body: { email, name?, stage, storeName, chain, entryStoreId, state }
//   stage: started | locations | systems | review | agreement | completed | waitlist
//   state: the page's in-progress state (used only to build the resume link)
const config = require('../lib/config');
const sec = require('../lib/security');
const stores = require('../lib/stores');
const { internalEmail } = require('../lib/mail');
const { track: klaviyo } = require('../lib/klaviyo');

const STAGES = ['started', 'locations', 'systems', 'review', 'agreement', 'completed', 'waitlist'];

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!sec.sameOrigin(req)) return res.status(403).json({ error: 'Forbidden' });
  const ip = sec.clientIp(req);
  try {
    const b = sec.body(req);
    if (!b) return res.status(400).json({ error: 'Bad request.' });
    // Honeypot: the page never sends `website`; bots filling every field do.
    if (b.website) return res.status(200).json({ ok: true });
    const email = sec.v.email(b.email);
    if (!email) return res.status(400).json({ error: 'Email required.' });
    const stage = STAGES.includes(b.stage) ? b.stage : 'started';
    // Abuse brakes: per IP and per email. 'agreement'/'completed' additionally need the session token,
    // so nobody can fire a fake "completed" to pull a real lead out of the retargeting flow.
    if (!sec.rateLimit(`lead:ip:${ip}`, 8, 60e3) || !sec.rateLimit(`lead:em:${email}`, 12, 3600e3)) return sec.tooMany(res);
    if (stage === 'completed' && !sec.checkSession(b.customerId, b.session)) return res.status(403).json({ error: 'Session expired.' });
    if (stage === 'started') {
      // Arriving from a claim: the owner's edit token proves they are the claimant (and that email) — no Turnstile needed.
      let viaClaim = false;
      if (b.claimToken && b.entryStoreId) {
        const claims = require('../lib/claims');
        const rec = await claims.getRecord(String(b.entryStoreId).toUpperCase().replace(/[^A-Z0-9]/g, '')).catch(() => null);
        viaClaim = !!(rec && claims.checkEditToken(rec, b.claimToken) && rec.contact.email.toLowerCase() === email.toLowerCase());
      }
      if (!viaClaim) { const ts = await sec.verifyTurnstile(b.turnstile, ip); if (!ts.ok) return res.status(403).json({ error: 'Verification failed. Please reload and try again.' }); }
      b.fromClaim = viaClaim;
    }

    const chain = sec.v.slug(b.chain) ? stores.chain(b.chain) : null;
    const storeName = sec.v.optStr(b.storeName, 120) || (chain ? chain.name : '');
    const entryStoreId = /^CRSA\d{6,8}$/.test(b.entryStoreId || '') ? b.entryStoreId : '';
    const name = sec.v.optStr(b.name, 120) || '';
    const st = b.state && typeof b.state === 'object' ? b.state : null;

    // Resume link — the whole state travels in the URL, signed, so nothing is stored.
    // Only ids are carried; everything is re-validated against the AGCO index on resume.
    let resumeUrl = null;
    if (st && chain && stage !== 'completed' && stage !== 'waitlist') {
      const slim = {
        c: chain.slug, e: entryStoreId || null,
        x: (Array.isArray(st.extra) ? st.extra : []).filter(sec.v.slug).slice(0, 10),
        s: sec.v.crsaList(st.selected) || [],
        g: (Array.isArray(st.groups) ? st.groups : []).slice(0, 20).map(g => ({ name: sec.v.optStr(g && g.name, 60) || '', ids: sec.v.crsaList(g && g.ids) || [] })),
        y: st.systems && typeof st.systems === 'object' ? { pos: sec.v.optStr(st.systems.pos, 60) || '', processor: sec.v.optStr(st.systems.processor, 60) || '', ecommerce: sec.v.optStr(st.systems.ecommerce, 60) || '', delivery: st.systems.delivery == null ? null : !!st.systems.delivery, deliverySoftware: sec.v.optStr(st.systems.deliverySoftware, 60) || '' } : null,
        o: st.owner && typeof st.owner === 'object' ? { name: sec.v.optStr(st.owner.name, 120) || '', email, mobile: sec.v.optStr(st.owner.mobile, 30) || '' } : null,
        r: st.referral && sec.v.str(st.referral.code, 32) ? { code: st.referral.code } : null,
        t: Date.now(),
      };
      resumeUrl = `${config.SITE_URL}/r/${config.encodeResume(slim)}`;
    }

    // signup.poof.ca is one page, so its resume link is just the page with the store and code filled in.
    // No personal data travels in the link.
    const fromSignup = b.source === 'signup.poof.ca';
    if (fromSignup && stage !== 'completed' && stage !== 'waitlist') {
      const q = [];
      if (entryStoreId) q.push('store=' + entryStoreId);
      const code = st && st.referral && /^[A-Za-z0-9_-]{2,32}$/.test(st.referral.code || '') ? String(st.referral.code).toUpperCase() : '';
      if (code) q.push('code=' + code);
      resumeUrl = 'https://signup.poof.ca/' + (q.length ? '?' + q.join('&') : '');
    }

    const first = name.split(' ')[0] || '';
    const props = { stage, store: storeName, chain: chain ? chain.slug : '', entry_store: entryStoreId, locations: (st && Array.isArray(st.selected) ? st.selected.length : 0), resume_url: resumeUrl, first_name: first, source: fromSignup ? 'signup.poof.ca' : 'onboarding.poof.ca' };
    const out = {};
    const profileProps = stage === 'completed' ? { pos_connected: true, pos_completed_at: new Date().toISOString() }
      : stage === 'waitlist' ? { waitlisted: true }
      : { pos_started: true, pos_stage: stage, ...(b.fromClaim ? { pos_from_claim: true } : {}) };
    out.klaviyo = await klaviyo(stage === 'completed' ? 'Onboarding Completed' : stage === 'waitlist' ? 'Onboarding Waitlist' : 'Onboarding Started', email, props, profileProps).catch(e => ({ error: e.message }));

    // Internal ping on first capture and waitlist only (not every step — that's noise)
    if (stage === 'started' || stage === 'waitlist') {
      out.internal = await internalEmail(stage === 'waitlist' ? `Waitlist — ${storeName || 'unknown store'} (not on AGCO authorized list)` : `Onboarding started — ${storeName}`, {
        Email: email, Name: name, Store: storeName, Chain: chain ? chain.slug : '', 'Entry store': entryStoreId, Note: sec.v.optStr(b.note, 500) || '', 'Resume link': resumeUrl || '',
      }).catch(e => ({ error: e.message }));
    }
    // A finished signup goes into the Notion data room: store rows updated, first tasks queued for approval.
    // The retailer is already on the "You're in" screen, so this never slows them down.
    if (stage === 'completed') {
      try {
        const { stripeClient } = require('../lib/stripe');
        const record = require('../lib/record');
        const customer = await stripeClient().customers.retrieve(b.customerId);
        const rec = record.unpack(customer.metadata || {});
        if (rec && rec.acceptance) {
          out.notion = await require('../lib/notion').syncSignup(rec, b.customerId);
          if (out.notion.errors && out.notion.errors.length) console.error('lead: notion sync had errors', { customerId: b.customerId, errors: out.notion.errors.slice(0, 5) });
        }
      } catch (e) { console.error('lead: notion sync failed', { customerId: b.customerId, err: e.message }); }
    }
    if (out.klaviyo && out.klaviyo.error) console.error('lead: klaviyo failed', { stage, err: out.klaviyo.error });
    if (out.internal && out.internal.error) console.error('lead: internal email failed', { stage, err: out.internal.error });
    return res.status(200).json({ ok: true, resumeUrl });
  } catch (e) {
    console.error('lead failed:', { ip, err: e.message });
    return res.status(200).json({ ok: false }); // never block the flow on this
  }
};
