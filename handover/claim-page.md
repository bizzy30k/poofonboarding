# Claim your listing — `/claim/<CRSA>`

The step **before** signup. A store owner gets a per-store link, confirms the listing, fills one
form, presses **Finalise details**. Nothing goes live by itself: Poof reviews it, puts it in HQ,
then publishes — which sends the owner the "it's live, have a look" email. The POS/signup ask
(`/s/<CRSA>`, the existing onboarding) appears only *after* finalising, on the page and in the
email. The claim page never mentions POS, pricing or agreements.

Reference implementation: front end in `poof-onboarding-react` (`src/components/ClaimPage.tsx`),
API in this repo (`api/claim.js`, `api/claims.js`, `lib/claims.js`). Both are tested
(`npm test` here; `npm test` + `npm run test:e2e` there).

## Run it

```bash
# API (this repo)
npm install && cp .env.example .env    # SIGNING_SECRET, ADMIN_KEY; BLOB_READ_WRITE_TOKEN for claims to persist
npm run dev                             # http://localhost:3000
npm test                                # 25 tests, Blob mocked

# Front end (bizzy30k/poof-onboarding-react, branch claim-listing)
npm install
VITE_API_PROXY=http://localhost:3000 npm run dev        # against the local API
# or offline:  node tests/mock-api.mjs & VITE_API_PROXY=http://localhost:8787 npm run dev
open http://localhost:5173/claim/CRSA1537578
npm test && npm run test:e2e            # vitest 30, Playwright 5
```

## The one form

Bare minimum for a claimed listing — **required**: name, email, logo, phone, website,
description, hours. Optional: public store email, Instagram.

| Field | Required | Prefilled from | Validation (server, `lib/claims.js`) |
|---|---|---|---|
| Your name | yes | — | 1–120 chars |
| Your email | yes | — | email; becomes the Klaviyo profile |
| Logo | yes | — | PNG/JPEG/WebP data URL ≤ 600 KB, magic bytes checked. Page resizes to ≤ 512 px PNG first. May be omitted on a re-submit when one is already on file |
| Store phone | yes | Places `phone` | 10 digits after stripping; stored as digits |
| Store email (public) | no | — | email |
| Website | yes | Places `website` | http(s) URL; scheme added if missing |
| Instagram | no | — | handle only, `[A-Za-z0-9._]{1,30}`; URL or `@` accepted and stripped |
| Description | yes | — | 1–300 chars |
| Hours | yes | Places `weekday_text` (else 10 am – 10 pm every day) | shape below; at least one open day |

Places comes from the existing `GET /api/lookup?store=<CRSA>&places=1` — nothing new to build.
The page parses `weekday_text` lines (`"Monday: 10:00 AM – 10:00 PM"`, `Closed`, `Open 24 hours`,
split days collapse to outer bounds) in `src/utils/hours.ts`.

## Hours shape — **please confirm for core**

No store in `core-stores.json` has `operationHours` populated, so this is a proposal. 12-hour
clock, `"h:mm AM|PM"`, `null` = closed that day. Always present; at least one day open.

```json
"operationHours": {
  "monday":    { "open": "10:00 AM", "close": "10:00 PM" },
  "tuesday":   { "open": "10:00 AM", "close": "10:00 PM" },
  "wednesday": { "open": "10:00 AM", "close": "10:00 PM" },
  "thursday":  { "open": "10:00 AM", "close": "10:00 PM" },
  "friday":    { "open": "10:00 AM", "close": "11:00 PM" },
  "saturday":  { "open": "10:00 AM", "close": "11:00 PM" },
  "sunday":    null
}
```

Past-midnight closes are expressed as a close earlier than the open (`"11:00 AM"` → `"1:00 AM"`).
The page edits hours as 24-hour `HH:MM` internally (native time inputs) and converts at the wire
(`src/utils/hours.ts → toWire / fromWire`). The API accepts `am`/`p.m.` spellings and normalises.

## API

### `POST /api/claim` (same-origin, rate-limited, Turnstile-verified)

```json
{
  "id": "CRSA1537578",
  "name": "Mo Khan",
  "email": "mo@store.ca",
  "turnstile": "<token or null>",
  "listing": {
    "logo": "data:image/png;base64,…",
    "phone": "(519) 555-0100",
    "email": "hello@store.ca",
    "website": "thewestore.ca",
    "instagram": "@thewestore",
    "description": "…",
    "hours": { "monday": { "open": "10:00 AM", "close": "10:00 PM" }, "…": "…", "sunday": null }
  }
}
```

Reply `{ ok, id, logoUrl, revision, token, chainName, siblings: [{ id, name, addr, city }] }`.
Errors `{ error, fields: [...] }` with 400/403/404/429 — `fields` names what's malformed or missing
(`Required: website, description.`).

**Lock.** The first claim wins. A later POST for the same CRSA returns
`409 { error: 'already_claimed', claimedAt }` unless it carries `t` = the owner's edit token
(returned above and in their email). With the token: previous logo kept if none is sent, `revision`
bumps, `contact` stays the original claimant (an edit can't hand the listing to a new email).
To move a listing to someone else, an admin **releases** it (below) after the owner writes in.

`token` = HMAC(`SIGNING_SECRET`, `claim-edit:<CRSA>:<email>`) — stable, never expires, bound to
the claiming email. Edit link: `/claim/<CRSA>?t=<token>`; "claim the rest" link: `…&more=1`.

### `GET /api/claim?id=CRSA…` (public) · `&t=<token>` (owner)

`{ claimed: false }` or `{ claimed: true, claimedAt, storeName, status }`. With the owner's token,
also `owner: true, contact, listing, siblings` — the page prefills the form from it.

### `POST /api/claim-bulk` — "claim the rest" (same-origin, token-authorised)

`{ from: CRSA, t: <token>, ids: [CRSA…] }` → `{ ok, claimed: [...], skipped: [{ id, reason }] }`.
Every `id` on the same licence that nobody has claimed gets a record with the source's logo,
website, Instagram, description and contact. **Phone and hours come from Google Places per
store**; when Google has nothing the source store's are copied and the record carries
`needsReview: [...]` (shown in the internal email). Skips: `already claimed`, `different licence`,
`no such store`. ≤60 ids; 3 runs/hr/source store. One owner email, one internal email, one
Klaviyo `Listing Claimed` with `locations: n, bulk: true`.

What it does, in order:

1. Logo → Vercel Blob, **public**, stable URL `…/claims/<CRSA>/logo.<ext>` (this is `imageUrl`)
2. Record → Vercel Blob, `claims/<CRSA>/claim.enc`, **encrypted** (AES-256-GCM keyed from `SIGNING_SECRET`) — the store is public but the owner's contact details are unreadable by URL
3. Retailer email (fixed copy, SendGrid/Resend via `lib/mail.js` → `claimReceivedHtml`)
4. Internal email to `ONBOARDING_INBOX`: every field, logo link + preview, and the core-shaped
   JSON block ready to paste into the HQ store record
5. Klaviyo `Listing Claimed` — profile `email`, `first_name`, `store`; props `store`,
   `entry_store`, `chain`, `logo`, `hours`, `description`, `revision`, `pos_url`

Brakes: 30 attempts/hr/IP before validation; 5 accepted/hr/IP and 3 accepted/hr/store after.
Honeypot: a top-level `website` key means bot → `200 {ok:true}`, nothing stored.

### `GET|POST /api/claims` (admin, `x-admin-key` header)

- `GET /api/claims` → `{ claims: [...] }` newest first
- `GET /api/claims?id=CRSA…` → `{ claim, core }` — `core` is the field set below
- `POST { "action": "publish", "id": "CRSA…", "url": "https://poof.ca/…" }` → marks published,
  sends email 2 ("<store> is live on Poof — have a look", link = `url`), fires Klaviyo
  `Listing Published`. `url` falls back to `MARKETPLACE_URL` env (default `https://poof.ca`).
  Idempotent: re-publishing re-sends the email, keeps the first `publishedAt`.
- `POST { "action": "resend", "id" }` re-sends email 1 + the internal email.
- `POST { "action": "release", "id" }` **unlocks** the store (deletes the claim record; the logo blob
  stays). Use when someone writes in saying "I didn't claim this". The store can then be claimed again.

### Ownership verdict (internal email)

Manual approval, but scored so it's a 10-second read. `lib/claims.js → ownership(rec, google)`:

- **LIKELY** — claimant's email domain matches the store website, or the phone they entered
  matches Google's phone for that store, or the website matches Google's.
- **REVIEW** — free-mail address (gmail, hotmail…) with nothing matching, or phone/website differ
  from Google, or Google has nothing to compare.

The subject line carries `[LIKELY]` / `[REVIEW]`; the first row is the full reason line. For REVIEW,
reply from contact@poof.ca asking them to confirm from the store's own email, or call the number
Google lists. Nothing is live until `publish`.

### Core fields a claim fills (`lib/claims.js → toCoreListing`)

```json
{
  "imageUrl": "https://….public.blob.vercel-storage.com/claims/CRSA1537578/logo.png",
  "description": "…",
  "contactName": "Mo Khan",
  "contactEmail": "hello@store.ca",
  "contactNumber": "5195550100",
  "website": "https://thewestore.ca/",
  "instagramUrl": "https://instagram.com/thewestore",
  "operationHours": { "…": "…" },
  "isProfileComplete": true,
  "poof": { "stage": "claimed" | "live", "claimedAt": "…", "onboardingUrl": "https://onboarding.poof.ca/s/CRSA1537578" }
}
```

`poof.stage` is `claimed` until published, then `live`; the signup later moves it to
`in_progress` / `accepted` as in `core-integration.md`.

## Emails (copy is fixed)

**1 — on Finalise** · subject `Your <store> listing on Poof has been updated`

> Awesome. This has been updated. You should see it live in 1 business day on the marketplace.
> We'll send you an email to have a look. In the meantime, if you are interested in connecting
> your point-of-sale system, follow this link: **[Connect your point-of-sale system]** → `/s/<CRSA>`

Email 1 also carries **Edit your listing** (the signed `?t=` link) and, when the licence has other
unclaimed stores, **Claim your other N locations** (`?t=…&more=1`).

**2 — on publish** · subject `<store> is live on Poof — have a look`
Button to the listing URL, then the same POS button.

**3 — on claim-bulk** · subject `Your N other <store> locations are updated on Poof`
Lists every location with its own Edit link, then the POS button with `?also=` so the signup
pre-selects all of them.

## SendGrid — configuration

Code: `lib/mail.js`. Picks SendGrid if `SENDGRID_API_KEY` is set, else Resend.

1. SendGrid → Sender Authentication → authenticate `poof.ca` (3 CNAMEs in Cloudflare).
2. API key with **Mail Send: Full Access** only.
3. Env: `SENDGRID_API_KEY`; `FROM_EMAIL=Poof <contact@poof.ca>` (code default is baz@poof.ca — override);
   `REPLY_TO=contact@poof.ca`; `ONBOARDING_INBOX` (default onboarding@poof.ca).
4. Senders: claim finalised → `claimReceivedHtml` (owner) + `sendClaimEmails` internal; publish →
   `claimLiveHtml`; signup accepted → order form + internal summary. Owner-facing claim copy is fixed.
5. Test on the preview with a real address — both claim emails arrive within a minute.

## Klaviyo — configuration

Code: `lib/klaviyo.js`, Events API revision 2025-01-15, one `track(metric, email, props)`.

1. Use the **existing** private key (`KLAVIYO_API_KEY`), production only. The live flow `XZfA2H`
   triggers on metric `TfdJen` (*Onboarding Started*) under that key's API source — a new key means
   new metric IDs and the flow goes silent.
2. Metric names are the contract, exact strings: `Onboarding Started`, `Onboarding Progress`
   (`stage`), `Onboarding Completed`, `Onboarding Waitlist`, `Listing Claimed`, `Listing Published`;
   `Call Booked` comes from Zapier/Calendly.
3. Profile on every event: `email`, `first_name`, `properties.store`, `properties.retailer: true`.
   Event props (snake_case): `store`, `chain`, `entry_store`, `resume_url`, `pos_url`, `live_url`,
   `revision`. Templates use `{{ event.store }}` — keep the key.
4. Existing flow: `XZfA2H` (trigger Onboarding Started; exits Onboarding Completed / Call Booked).
   Claim-side flows (outreach drip; Listing Claimed → nudge to `/s/`, exit Onboarding Started) are
   built in Klaviyo by Poof, not in code.
5. Test: fire a claim with a test email → Klaviyo → Profiles → activity shows *Listing Claimed*.

## Klaviyo

Two new metrics, same API key / API source as the onboarding metrics: `Listing Claimed`,
`Listing Published`. Suggested flow: trigger `Listing Claimed`, exit on `Onboarding Started`
(they went on to signup) — 2 emails, day 3 and day 10, both pointing at `pos_url`. Keep it
separate from `XZfA2H` (abandoned signup) so a claimed-only store never gets "your setup is saved".

## Analytics (GA4, same gtag)

`onb_claim_view {store, prefilled}` · `onb_claim_submit {store, filled, logo}` ·
`onb_claim_done {store}` · `onb_claim_pos {store}` (clicked the POS button).

## Env / infra

- `BLOB_READ_WRITE_TOKEN` — Vercel → Storage → Blob → create a store, copy the token. **New.**
- `MARKETPLACE_URL` — optional, default link in email 2.
- `vercel.json`: rewrite `/claim/:id → /`; CSP `img-src` now allows `*.public.blob.vercel-storage.com`.
- Core-team port: `lib/claims.js` is the storage seam (`putLogo`, `putRecord`, `getRecord`,
  `listRecords`). Swap for GCS / the core client; keep `toCoreListing()`.

## Returning stores

- `/claim/<CRSA>` — **done.** Claimed stores are locked; the owner's edit link prefills and saves
  (`GET /api/claim?id&t`). Anyone else sees "already claimed on <date> — not you? contact@poof.ca".
- `/s/<CRSA>` — **still to do.** If a signup exists (customer with this licence in `locations`):
  short-circuit to "This store is already on Poof — signed up <date> by <first name + initial>" with
  *That's me, resend my order form* and *Not me, contact us*. `lib/conflicts.js` already finds
  customers by licence; reuse it.
- Local draft (`sharedState.ts`) is per-browser and clears on completion by design.

## Flow (front end)

`/` finder → `/claim/<CRSA>` form → **Finalise** → (chain with unclaimed siblings) **Claim the rest**
(`ClaimMore.tsx`: all ticked, one button, "Just this one for now") → **Done** (`ClaimDone.tsx`: one
CTA, *Now connect your point-of-sale system* → `/s/<CRSA>?also=a,b,c`). `ClaimLocked.tsx` for a
claimed store without the token. `?t=` is read once and stripped from the URL before analytics loads.

## Outreach link

The per-store outreach email now points at `onboarding.poof.ca/claim/<CRSA>` instead of
`/s/<CRSA>`. `scripts/export-links.js` now writes a `claim_link` column next to `link` in
`data/store-links.csv` (`npm run links` to regenerate).

## Billing address (signup card step)

The Stripe customer's `address` is the **billing** address, taken from the card's billing details
after the card is saved (`/api/accept` reads `paymentMethods.retrieve(pm).billing_details`, never the
request body). The store's AGCO address is the customer's `shipping` address. The page collects the
billing address with Stripe's Address Element (mode `billing`, CA/US, mandatory) above the card
field; Link is disabled (`wallets.link: 'never'`) so the card is typed in as normal. If the card is
skipped, `address` falls back to the first store's address until the setup call.

## Fixed on the way

`lib/mail.js → internalEmail` passed `to` as a string; the SendGrid path calls `to.map(...)`, so
internal notifications would have thrown with SendGrid configured. Now an array.
