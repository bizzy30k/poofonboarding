// Writes data/core-stores.json — every AGCO "Authorized to Open" store as a Poof HQ
// core store document (shape of GET api.poof.ca/v1/admin/store/:id), ready to upsert
// on license.licenseNumber. Same mapper as the signup webhook (lib/core.js) so
// imported stores and onboarded stores look identical in core.
//
//   node scripts/export-core-stores.js
const fs = require('fs');
const path = require('path');
const stores = require('../lib/stores');
const core = require('../lib/core');

const db = stores.load ? stores.load() : null;
const chains = db ? db.chains : JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'stores.json'), 'utf8')).chains;

const out = [];
for (const c of chains) {
  for (const s of c.stores) {
    // Minimal record: chain only, no owner/systems — this is the AGCO import, not a signup
    const rec = { store: { chain: c.slug, chainName: c.name, overrides: {} }, locations: [s], groups: [], systems: {}, owner: {}, acceptance: null };
    const doc = core.toCoreStore(rec, s, { stage: 'unclaimed' });
    doc.source = 'imported';
    doc.contactName = null; doc.contactEmail = null; doc.contactNumber = null;
    doc.deliveryInformation = { hasDelivery: false, note: null };
    doc.breadStackIntegration = {};
    doc.poof = { stage: 'unclaimed', chainSlug: c.slug, onboardingUrl: doc.poof.onboardingUrl, agcoStatus: 'Authorized to Open', agcoRegisterDate: db ? db.built : null };
    out.push(doc);
  }
}
out.sort((a, b) => a.license.licenseNumber.localeCompare(b.license.licenseNumber));
const file = path.join(__dirname, '..', 'data', 'core-stores.json');
fs.writeFileSync(file, JSON.stringify({ generated: new Date().toISOString().slice(0, 10), agcoRegister: db ? db.built : null, status: 'Authorized to Open', count: out.length, stores: out }));
console.log(`core-stores.json: ${out.length} stores, ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
