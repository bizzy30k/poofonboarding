// The signup record lives on the Stripe customer as metadata, so there is no
// database to set up. Stripe metadata is 50 keys × 500 chars; the full JSON
// record is chunked across poof_record_N keys and a few human-readable keys
// are written alongside for the Stripe dashboard.
const CHUNK = 490;
const MAX_CHUNKS = 26; // + 24 named keys (pack + accept + activate) = 50, Stripe's cap

// Strip anything regenerable from the AGCO index before storing.
function slim(record) {
  const r = { ...record, locations: (record.locations || []).map(l => (typeof l === 'string' ? l : l.id)) };
  if (r.acceptance && r.acceptance.locationIds) { r.acceptance = { ...r.acceptance }; delete r.acceptance.locationIds; }
  // Conflicts: keep ids + counts only, never other customers' contact details
  if (Array.isArray(r.conflicts)) r.conflicts = r.conflicts.map(c => ({ customerId: c.customerId, stage: c.stage, overlapCount: c.overlapCount || (c.overlap || []).length, overlap: (c.overlap || []).slice(0, 10) }));
  return r;
}

function pack(record, prevChunks = 0) {
  const json = JSON.stringify(slim(record));
  const meta = {};
  const chunks = Math.ceil(json.length / CHUNK);
  if (chunks > MAX_CHUNKS) throw new Error(`Record too large for Stripe metadata (${json.length} chars)`);
  for (let i = 0; i < chunks; i++) meta[`poof_record_${i + 1}`] = json.slice(i * CHUNK, (i + 1) * CHUNK);
  meta.poof_record_chunks = String(chunks);
  // Clear stale chunks from a previous, longer record (empty string deletes the key)
  for (let i = chunks + 1; i <= Math.min(prevChunks, MAX_CHUNKS); i++) meta[`poof_record_${i}`] = '';

  const a = record.acceptance || {};
  meta.poof_store_name = record.store?.chainName || '';
  meta.locations = String((record.locations || []).length);
  meta.location_ids = (record.locations || []).map(l => l.id).join(',').slice(0, 500);
  meta.groups = (record.groups || []).map(g => `${g.name}:${g.ids.length}`).join('; ').slice(0, 500);
  meta.pos = record.systems?.pos || '';
  meta.payment_processor = record.systems?.processor || '';
  meta.ecommerce = record.systems?.ecommerce || '';
  meta.delivery = record.systems?.delivery ? (record.systems.deliverySoftware || 'yes') : 'no';
  meta.contact_name = record.owner?.name || '';
  meta.contact_mobile = record.owner?.mobile || '';
  meta.referral_code = record.referral?.code || '';
  meta.accepted_by = a.name ? `${a.name}${a.title ? ', ' + a.title : ''}` : '';
  meta.accepted_at = a.at || '';
  meta.accepted_ip = a.ip || '';
  meta.terms_version = a.termsVersion || '';
  meta.terms_hash = a.termsHash || '';
  meta.onboarding_stage = a.at ? 'Agreement + Card' : 'In progress';
  meta.entry_store = record.entryStoreId || '';
  meta.source = 'onboarding.poof.ca';
  return meta;
}

function unpack(metadata) {
  const n = parseInt(metadata.poof_record_chunks || '0', 10);
  if (!n) return null;
  let json = '';
  for (let i = 1; i <= n; i++) json += metadata[`poof_record_${i}`] || '';
  try {
    const rec = JSON.parse(json);
    // Re-hydrate locations from the AGCO index (only ids are stored)
    const stores = require('./stores');
    rec.locations = (rec.locations || []).map(l => {
      const id = typeof l === 'string' ? l : l.id;
      const s = stores.store(id);
      return s ? { id: s.id, name: s.name, addr: s.addr, city: s.city, postal: s.postal, lat: s.lat, lng: s.lng } : (typeof l === 'string' ? { id, name: id, addr: '', city: '', postal: '' } : l);
    });
    return rec;
  } catch (e) { return null; }
}

function chunksIn(metadata) { return parseInt((metadata || {}).poof_record_chunks || '0', 10) || 0; }

module.exports = { pack, unpack, chunksIn };
