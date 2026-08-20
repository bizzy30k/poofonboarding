# Poof Retail Network — retailer onboarding

A conversational signup flow for dispensaries joining the Poof Retail Network. The retailer
types one thing (their store name); everything else is pulled, shown with its source, and
confirmed. Ends at Stripe, then a welcome email.

Static front end + Vercel serverless functions. No build step, no framework.

```
public/index.html        the whole chat UI — open it directly in a browser to walk the flow
api/lookup.js            typeahead + profile enrichment
api/checkout.js          Stripe Checkout in setup mode — vaults a card, charges nothing
api/webhook.js           card vaulted → agreement PDF → welcome email → tracker → HubSpot
api/activate.js          ops-only: go-live, creates the subscription, starts billing
lib/enrich.js            matching, Google Places, POS fingerprinting, hours prose
lib/vendors.js           POS / processor / delivery options — one list, three surfaces
lib/agreement.js         service agreement PDF (pdf-lib)
lib/tracker.js           appends onboarded stores to a Google Sheet
lib/email.js             welcome + go-live emails (Resend)
lib/store.js             submission store (Vercel KV, memory fallback)
scripts/build-index.mjs  AGCO CSV → searchable retailer index
scripts/build-tracker.py builds the tracker workbook
data/                    AGCO export + built index
```

---

## The flow

| # | Step | What the retailer does |
|---|------|------------------------|
| 1 | Open | Presses **Get started** |
| 2 | Name | Types the store name; typeahead matches 2,611 AGCO records grouped into 1,024 banners |
| 3 | Enrich | Waits ~2s while we hit the AGCO index, Google Places, and their own site |
| 4 | Readback | Hears it back conversationally — locations, AGCO status, hours, phone, POS |
| 5 | Location | Confirms which store(s) this is for; a chain can start with one |
| 6 | Systems | POS (Cova / Greenline / Other), processor (Merrco / Moneris / BlazePay / CovaPay / Other), Breadstack yes-no |
| 7 | Delivery | "Do you offer delivery?" → if yes, Breadstack / Canfleet / other, answerable in their own words |
| 8 | Goal | Marketplace / e-commerce / ad network |
| 9 | Referral | Optional brand code → three months of credit |
| 10 | Owner | Name, work email, mobile |
| 11 | Summary | "Excellent — here's a summary of what we have for your store" |
| 12 | Card | Stripe **setup** mode: card vaulted, nothing charged |
| 13 | Done | "Awesome — you're all set." + agreement PDF + welcome email |

Later, off this flow: ops calls `/api/activate`, the subscription is created, billing
starts, and the go-live email goes out.

The **store record** panel builds itself alongside the conversation. Each field carries a
source tag (Poof index / AGCO / Public listing / You), and POS chips are green only when
there's a live integration. That panel is doing double duty: it's the confirmation UI *and*
a demo of what Poof knows about their business.

---

## Deploy

```bash
npm install
cp .env.example .env          # fill in
vercel --prod
```

Point `business.poof.ca/join/` at the deployment, and set `PUBLIC_BASE_URL` to match so Stripe's
return URLs land in the right place.

### Stripe webhook

```bash
stripe listen --forward-to localhost:3000/api/webhook     # local
```

In production add an endpoint at `https://business.poof.ca/api/webhook` subscribed to
`checkout.session.completed` and `customer.subscription.deleted`, then put its signing
secret in `STRIPE_WEBHOOK_SECRET`.

### Brand referral codes — three months of credit

One coupon, then one promotion code per referring brand. Per-brand codes mean attribution
is queryable in Stripe directly, without a separate table.

```bash
stripe coupons create \
  --percent-off=100 --duration=repeating --duration-in-months=3 \
  --name="Brand referral — 3 months"
# → coupon id, e.g. AbC123xy

stripe promotion_codes create \
  --coupon=AbC123xy --code=BUZZD --metadata[brand]="Buzz'd"

stripe promotion_codes create \
  --coupon=AbC123xy --code=SENSE --metadata[brand]="Sense & Purpose"
```

Checkout runs in `subscription` mode with `payment_method_collection: 'always'`, so the
card is still vaulted when the first three invoices total $0. When the credit runs out
billing just starts — no second signup, no dunning surprise.

To see referrals by brand later: filter subscriptions on the `referral_brand` metadata key.

### Pricing per surface

`STRIPE_PRICE_MARKETPLACE`, `STRIPE_PRICE_ECOMMERCE`, `STRIPE_PRICE_ADNETWORK`.

**A goal with no price ID is free and skips the paywall entirely.** If a retailer picks only
free surfaces, `/api/checkout` returns `no_payment_required`, sends the welcome email
immediately, and the chat goes straight to the confirmation. This is deliberate — see
*Decisions* below.

---

## The retailer index

Built from the AGCO **Cannabis Store Applications** export. Drop a fresh CSV into `data/`
and rebuild:

```bash
npm run build:index
# or, explicitly:
node scripts/build-index.mjs \
  --agco data/Cannabis-Store-Applications-20260814-EN.csv \
  --pos  data/poof-pos-index.json \
  --out  data/retailers.json
```

Current export (Aug 14, 2026):

```
  AGCO rows read        2637
  exact duplicates        26 (dropped)
  missing licence         89
  stores written        2611

  authorized            1856
  cancelled              667
  in progress             79
  public notice            9

  banners               1024  (343 multi-location)
  with a website        1297 of 1856 authorized
```

### What the ingest has to clean

The export is authoritative but not tidy, and all of this is fixed once at build time
rather than on every keystroke in the typeahead:

| Problem | Example | Handling |
|---|---|---|
| Three casings of one name | `FIKA CANNABIS` / `FIKA Cannabis` / `Fika Cannabis` | Title-cased, preserving deliberate caps like `THC` |
| Curly vs straight apostrophes | `POP'S` / `POP'S` | Normalized, then dropped from search keys |
| City baked into store name | `Pop's Cannabis Co. Courtice` | Trailing city token stripped when it matches the row's city |
| Same banner, different names | 5 spellings of Hunny Pot | Grouped to one banner of 45 by stripped-token key |
| Exact duplicate rows | 26 rows sharing a licence and address | Deduped on licence + address + city |
| Blank licence numbers | 89 rows | Kept, with a synthetic id; the retailer confirms by hand |
| Chains named after their towns | `Highlife Ancaster`, `Highlife Delhi` … | City stripped before voting on the banner label → `Highlife` |

The result is that `pops` returns **one** row reading *Pop's Cannabis Co. · 33 cities · 44
locations*, not 44 rows.

### Merging your POS index

`--pos` takes your own integration list, keyed by AGCO licence number:

```json
[{ "licenceNumber": "CRSA1188757", "pos": "greenline", "integrated": true }]
```

Licence number is the join key because it's the only identifier both systems agree on —
store names don't survive the round trip. Matches get a green POS badge in the flow.

### Cancelled and pending stores

Cancelled licences stay searchable but rank last and are flagged in the typeahead, so
someone whose licence lapsed gets told that rather than silently finding nothing.

Stores at *In Progress* or *Public Notice* can sign up — the flow says so explicitly:
*"The AGCO has you as in progress rather than authorized yet. That's fine — we can set
everything up now and flip you live the day your authorization lands."* Catching a
retailer during their licensing wait is a better acquisition moment than catching them
after they've already picked a menu vendor.

---

## Hours, and the conversational readback

Google Places is called **once per signup**, anchored on the AGCO street address. That
anchoring is what makes it reliable — `Canna Cabana` alone is 97 possible stores, but
`Canna Cabana, 38 Mill St E, Acton, ON L7J 1H2` resolves to exactly one.

`hoursToProse()` collapses the week into something speakable, because reading a
seven-row table back to someone is not a conversation:

| Google returns | Poof says |
|---|---|
| Same hours all week | *9 AM to 11 PM every day* |
| Weekend variation | *9 AM to 11 PM Monday through Saturday, and 10 AM to 9 PM Sunday* |
| Closed Sundays | *10 AM to 8 PM Monday through Saturday, closed Sunday* |
| Three distinct blocks | *9 AM to 9 PM Monday through Wednesday, 9 AM to 11 PM Thursday and Friday, 10 AM to 11 PM Saturday, and 11 AM to 7:30 PM Sunday* |
| Noon to midnight | *noon to midnight every day* |

For a multi-location banner the flow names the store it actually looked up rather than
implying it speaks for all of them: *"Google has your Ajax store open 9 AM to 11 PM…
We'll pull the rest per location once you're in."*

The readback runs as separate messages with pauses between — identity, then licence
status, then hours, then phone and site, then POS — and closes with the editability
promise before asking for confirmation:

> Everything above lives in your admin panel once you're in, so nothing here is
> permanent — change hours, addresses, contact details, any of it, any time.

That line also appears at the foot of the store record panel.

---

## POS and payment detection

Three tiers, in order:

1. **Verified** — the store is in the Poof index with a live integration. Green chip.
2. **Detected** — we fetched their homepage and found a known vendor signature. Grey chip,
   and the UI says so: *"Detected from your site — we'll confirm during setup."*
3. **Unknown** — nothing shown; setup asks.

Signatures currently cover Greenline, Cova/iQmetrix, BLAZE, TechPOS, Flowhub, Treez,
IndicaOnline (POS); Dutchie, Buddi, Jane, Tymber, Meadow, Leafly, Weedmaps, Shopify, Poof
(menu); Stripe, Moneris, Square, Clover, Helcim, Global Payments, Chase Paymentech
(payments). Add to the arrays in `lib/enrich.js` as you find more.

The fetch is read-only, capped at 4 seconds and 400KB, and fails silently.

---

## Billing: why setup mode

The flow promises *"you won't be charged until the store is live"*, and Checkout in
`mode: 'setup'` is the only way to keep that promise honestly. It vaults a payment method
against a Customer and creates nothing billable.

Subscription mode with a trial looks the same to the retailer but fixes the trial end at
signup — so a store that takes six weeks to integrate gets billed before it has ever
received an order. That is precisely the surprise this flow says it won't spring.

Billing starts when ops calls activation:

```bash
curl -X POST https://business.poof.ca/api/activate \
  -H "x-poof-admin-key: $ADMIN_API_KEY" \
  -H "content-type: application/json" \
  -d '{"submissionId":"onb_mf2k91xq","goLiveDate":"2026-08-20"}'
```

That endpoint creates the subscription, applies the referral coupon **from that date**,
sends the go-live email, and updates the tracker row. Keep `ADMIN_API_KEY` off the front
end; move the endpoint behind the admin panel's own auth once it exists.

Referral credit therefore starts on go-live, not signup — otherwise a three-month credit
burns down during integration, before the store has earned a dollar.

---

## Credentials are never collected here

Cova, Greenline, Breadstack and Canfleet all need API access eventually. **None of it is
asked for in this flow.** The chat records *which* vendors are in play and flags the
account; credentials get collected later in the authenticated admin panel.

This is deliberate. A signup form is the wrong place for a live API key: the value would
pass through the browser, the serverless function, the submission store, the agreement PDF,
and the tracker spreadsheet — five places it does not belong, one of which is a Google Sheet
your whole team can read.

Two safeguards back this up:

- `api/checkout.js` runs a tripwire over the free-text vendor fields and rejects anything
  resembling a key (`sk_live…`, bearer tokens, 40+ character opaque strings) with a message
  telling the retailer where those actually go.
- The service agreement states it in clause 5, so the expectation is set in writing:
  credentials come through the admin panel, never by email or chat.

---

## Service agreement

`lib/agreement.js` generates a two-page PDF at signup and the webhook attaches it to the
welcome email. It's built from the same submission object the flow produced, so the
agreement and the onboarding answers cannot drift apart.

It records the parties, the store record (locations, licences, AGCO status, hours), the
systems the retailer named, the commercial terms, and eight clauses covering scope,
responsibilities, fees, payment method, data and integrations, term, referral credit, and
governing law.

Bump `ORDER_FORM_VERSION` when the layout changes — the version is stored on each
submission, so you can always tell which form a given retailer received.

---

## Tracker

`Poof-Retailer-Onboarding-Tracker.xlsx` — three tabs:

- **Onboarded stores** — one row per store, 30 columns, written by the API. Dropdowns match
  the vendor options exactly; status is colour-coded; row 4 is a worked example showing the
  expected format for every column.
- **Dashboard** — live formulas: funnel by status, doors covered vs doors live, POS and
  processor split, integrations to build (Breadstack / Canfleet counts), referral totals,
  and a hygiene block that surfaces missing licences, missing cards, unsent agreements, and
  stores marked live with no subscription.
- **How this works** — what's automatic, what you edit by hand, and how to move it to Sheets.

Only two columns are yours to edit: **Go-live date** and **Notes** (both shaded). Everything
else is overwritten on the next update for that store.

Rows are keyed on Submission ID, and a repeat write updates in place — so a Stripe webhook
retry can't duplicate a store.

To run it as a Google Sheet: upload the workbook to Drive, open as a Sheet, set
`TRACKER_SHEET_ID`, and share it with your service account's `client_email` as an Editor.
`lib/tracker.js` signs its own JWT, so there's no `googleapis` dependency to carry. Without
those env vars it logs each row as CSV instead, so nothing is lost while you set it up.

**Column order is a contract.** `TRACKER_COLUMNS` in `lib/tracker.js` and the header row in
the workbook must match. Add new columns at the end, in both places.

---

## Decisions worth a second look

**Paywalling the marketplace contradicts the Fika pitch.** The open-market pitch is a *free*
Ontario network listing — free demand acquisition is the whole reason a retailer says yes.
Charging at signup for that surface undercuts it. The flow is built so you can set marketplace
to free and charge only for e-commerce and the ad network; that's the recommended
configuration, and it's why the no-payment path exists.

**The AGCO export is a file, not a feed.** There is no stable public JSON endpoint, so the
index is a build artifact. Re-download the CSV and run `npm run build:index` on a schedule —
monthly is fine; the register moves slowly. Commit `data/retailers.json` so Vercel has it at
runtime.

**The admin panel doesn't exist yet, and three things now depend on it.** The flow promises
it in the readback and in the record panel footer; the agreement names it as the only place
credentials are accepted; and activation currently sits behind a shared key instead of real
auth. It needs to be real before launch — at minimum: store details, per-location hours,
contact fields, a credential vault for POS / Breadstack / Canfleet, and a go-live button
that calls `/api/activate`.

**Bump `TERMS_VERSION` whenever the terms text changes.** It's recorded against every
acceptance, so it has to identify the exact wording the retailer saw.

**KV is required in production.** Without `KV_REST_API_URL`/`KV_REST_API_TOKEN`, submissions
live in process memory and will not survive a cold start between Checkout and the webhook —
meaning a paid signup with no welcome email and no record. Set it before taking real signups.

**Nothing is auto-asserted.** Every pulled field is editable and labelled with where it came
from. A licence number we found is a suggestion the retailer confirms, never a fact we
recorded on their behalf.

**Welcome email idempotency.** Stripe retries failed webhooks. `welcomeEmailSentAt` guards
against sending twice; the send happens before the status write so a crash mid-handler
retries the whole thing rather than silently skipping.
