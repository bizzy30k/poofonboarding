# Poof retailer onboarding — onboarding.poof.ca

The conversational retailer onboarding flow. One Vercel project, no database:
every signup lives on its Stripe customer, the order form regenerates from
that record on demand, and the AGCO store index ships with the code.

**What a retailer does (5 steps):** opens their personal link (or searches —
AGCO authorized-to-open list only) → gives an email → sees their listing
before/after → tells us which of the chain's doors they own → systems →
owner + referral code + review → accepts the agreement (click-wrap) → adds a
card for 3 months free, or skips at standard pricing. Nothing is charged until
you activate them.

**Conversion features:** per-store links (`/s/CRSA…`), franchise prompt, email
captured first so abandons get a signed resume link (`/r/…`) and a Klaviyo
event, launch offer tied to the card, FAQ with Text Baz / Book 10 min exits,
waitlist capture for not-yet-authorized stores, GA4 event per step.

**What you get:** a Stripe customer with the full record and card attached, an
Order Form PDF (Schedule C + execution block) emailed to the retailer and
cc'd to you, and an internal notification. On go-live day you run one
`activate` call and billing starts.

## Files

| Path | What it is |
|---|---|
| `public/index.html` | The whole front end. Reads `/api/config`, no secrets inside. |
| `api/lookup.js` | AGCO search (name, address, postal, CRSA) and chain detail. Optional Google Places. |
| `api/setup-intent.js` | Creates the Stripe customer with the record as metadata + a SetupIntent (card vault). |
| `api/accept.js` | After the card is saved: writes the acceptance record, builds the PDF, sends emails. |
| `api/orderform.js` | Signed download link for the Order Form PDF, regenerated from Stripe. |
| `api/promo.js` | Validates a referral code against Stripe promotion codes. |
| `api/activate.js` | **Admin.** Creates the subscription (quantity = locations) on go-live. |
| `api/config.js` | Public config for the page. |
| `api/lead.js` | Email capture → signed resume link, Klaviyo event, internal ping. |
| `api/resume.js` | Decodes a `/r/<token>` link back into state. |
| `api/links.js` | **Admin.** CSV of every store's personal link. |
| `lib/conflicts.js` | Franchise guard — finds doors already on another customer. |
| `data/store-links.csv` | All 1,856 personal links, ready for outreach. |
| `lib/` | Store index, metadata packing, PDF builder, mail. |
| `data/stores.json` | 1,856 authorized stores in 636 chains. Built by `scripts/build-data.js`. |
| `scripts/dev-server.js` | `node scripts/dev-server.js` → http://localhost:3000 |

See **DEPLOY.md** for the step-by-step.

## Design decisions

- **Only "Authorized to Open" stores are searchable.** A store still in
  application can't onboard; the search tells them to email you.
- **Chains roll up.** "Sessions Cannabis - Kenora", "SESSIONS CANNABIS NORTH
  YORK" and "Sessions Cannabis-Waterloo" are one chain of 50. Hand aliases for
  AGCO drift live at the top of `scripts/build-data.js`.
- **Click-wrap is the signature.** The terms step records name, title,
  timestamp, IP, user agent, terms version and a hash of the terms page. That
  record prints on the Order Form execution block. No DocuSign.
- **Stripe is the database.** The record is chunked into customer metadata
  (`poof_record_1…n`) plus readable keys (`locations`, `pos`, `accepted_by`,
  `onboarding_stage`…) so you can see everything in the Stripe dashboard.
- **No webhook needed.** The card is confirmed client-side, then `/api/accept`
  verifies the SetupIntent server-side before recording anything.
- **Emails never block the retailer.** If Resend fails, the record and card
  are already on Stripe and the PDF link still works.
- **Clean URLs.** `vercel.json` has `cleanUrls: true`; the terms link is
  `business.poof.ca/terms`, no `.html`.

## Refreshing the AGCO list

1. Download the Cannabis Retail Store Applications CSV from agco.ca.
2. Filter to status `Authorized to Open`, geocode (postal-code centroid is
   fine), and write `data/agco.json` in the shape documented at the top of
   `scripts/build-data.js`. (The current file came from join.poof.ca.)
3. `npm run build:data` → check the chain spot-checks it prints → commit.
