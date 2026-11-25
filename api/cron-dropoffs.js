// Runs once a day (see vercel.json). Stores still at "Started signup" after the email sequence has
// had its chance get a follow-up task for a person and move to "Stalled".
// Safe for anyone to call: it only ever does what the schedule would do, and never twice for a row.
const sec = require('../lib/security');
const notion = require('../lib/notion');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!sec.rateLimit(`cron:dropoffs:${sec.clientIp(req)}`, 4, 60e3)) return sec.tooMany(res);
  try {
    const out = await notion.sweepDropoffs();
    if (out.errors && out.errors.length) console.error('cron-dropoffs: errors', out.errors.slice(0, 5));
    // Same daily run: locations follow their account's column on the pipeline board.
    let stages = {};
    try { stages = await notion.syncStages(); if (stages.errors && stages.errors.length) console.error('cron-dropoffs: stage sync errors', stages.errors.slice(0, 5)); }
    catch (e) { console.error('cron-dropoffs: stage sync failed', e.message); }
    return res.status(200).json({ ok: true, due: out.due || 0, tasks: out.tasks || 0, skipped: out.skipped, stageSync: { accounts: stages.accounts || 0, stores: stages.stores || 0 } });
  } catch (e) {
    console.error('cron-dropoffs failed', e.message);
    return res.status(200).json({ ok: false });
  }
};
