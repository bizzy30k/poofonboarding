#!/usr/bin/env node
// Writes data/store-links.csv — one personal onboarding link per authorized store.
const fs = require('fs'); const path = require('path');
const db = require('../lib/stores').load();
const SITE = process.env.SITE_URL || 'https://onboarding.poof.ca';
const rows = [['chain', 'store_name', 'crsa', 'address', 'city', 'postal', 'chain_doors', 'link']];
for (const c of db.chains) for (const s of c.stores) rows.push([c.name, s.name, s.id, s.addr, s.city, s.postal, c.count, `${SITE}/s/${s.id}`]);
const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
fs.writeFileSync(path.join(__dirname, '..', 'data', 'store-links.csv'), csv);
console.log(`store-links.csv: ${rows.length - 1} links`);
