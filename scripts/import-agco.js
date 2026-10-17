#!/usr/bin/env node
// Rebuilds data/agco.json from the AGCO register CSV (data/agco-register.csv).
// Keeps only "Authorized to Open". Coordinates: previous agco.json by CRSA →
// else city centroid from data/city-coords.json. Then run build-data.js.
//
// Refresh: download the CSV from agco.ca (Cannabis Retail Store Applications),
// save as data/agco-register.csv, run `npm run build:data`.
const fs = require('fs'); const path = require('path');
const D = (f) => path.join(__dirname, '..', 'data', f);
function parseCSV(t) { const rows = []; let row = [], cell = '', q = false; for (let i = 0; i < t.length; i++) { const c = t[i]; if (q) { if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; } else if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; } else cell += c; } if (cell || row.length) { row.push(cell); rows.push(row); } return rows; }
const text = fs.readFileSync(D('agco-register.csv'), 'utf8').replace(/^﻿/, '');
const [head, ...rows] = parseCSV(text);
const col = (n) => head.findIndex(h => h.trim().toLowerCase() === n);
const iLic = col('license number'), iCity = col('city or town'), iName = col('store name'), iAddr = col('address'), iPostal = col('postal code'), iStatus = col('store application status'), iWeb = col('website url');
let prev = {}; try { const p = JSON.parse(fs.readFileSync(D('agco.json'), 'utf8')); p.s.forEach(r => prev[r[0]] = [r[5], r[6]]); } catch (e) {}
const cities = JSON.parse(fs.readFileSync(D('city-coords.json'), 'utf8'));
const titleCity = (s) => s.toLowerCase().replace(/(^|[\s\-'.])([a-z])/g, (m, p, c) => p + c.toUpperCase());
const out = []; let fromPrev = 0, fromCity = 0, missing = 0;
for (const r of rows) {
  if (!r[iLic] || !/^authorized to open$/i.test((r[iStatus] || '').trim())) continue;
  const id = r[iLic].trim(), city = titleCity(r[iCity].trim()), postal = (r[iPostal] || '').trim().replace(/^(\w{3})(\w{3})$/, '$1 $2');
  let ll = prev[id]; if (ll) fromPrev++; else { const c = cities[r[iCity].trim().toLowerCase()] || cities[r[iCity].trim().toLowerCase().replace(/\./g, '')]; if (c) { ll = c; fromCity++; } else { missing++; continue; } }
  out.push([id, r[iName].trim(), r[iAddr].trim(), city, postal, ll[0], ll[1], 0, (r[iWeb] || '').trim()]);
}
fs.writeFileSync(D('agco.json'), JSON.stringify({ b: [], s: out, source: 'AGCO register CSV', built: new Date().toISOString().slice(0, 10) }));
console.log(`agco.json: ${out.length} authorized stores (${fromPrev} with prior coords, ${fromCity} city-centroid, ${missing} skipped — no coords)`);
