# Claim your listing — `/claim/<CRSA>`

The step **before** signup. A store owner gets a per-store link, confirms the listing, fills one
form, presses **Finalise details**. Nothing goes live by itself: Poof reviews it, puts it in HQ,
then publishes — which sends the owner the "it's live, have a look" email. The POS/signup ask
(`/s/<CRSA>`, the existing onboarding) appears only *after* finalising, on the page and in the
email. The claim page never mentions POS, pricing or agreements.

Reference implementation: front end in `poof-onboarding-react` (`src/components/ClaimPage.tsx`),
API in this repo (`api/claim.js`, `api/claims.js`, `lib/claims.js`). Both are tested
(`npm test` here; `npm test` + `npm run test:e2e` there).

## The one form

| Field | Required | Prefilled from | Validation (server, `lib/claims.js`) |
|---|---|---|---|
| Your name | yes | — | 1–120 chars |
| Your email | yes | — | email; becomes the Klaviyo profile |
| Logo | no | — | PNG/JPEG/WebP data URL ≤ 600 KB, magic bytes checked. Page resizes to ≤ 512 px PNG first |
| Store phone | no | Places `phone` | 10 digits after stripping; stored as digits |
| Store email (public) | no | — | email |
| Website | no | Places `website` | http(s) URL; scheme added if missing |
| Instagram | no | — | handle only, `[A-Za-z0-9._]{1,30}`; URL or `@` accepted and stripped |
| Description | no | — | ≤ 300 chars |
| Hours | no | Places `weekday_text` | shape below |

Places comes from the existing `GET /api/lookup?store=<CRSA>&places=1` — nothing new to build.
The page parses `weekday_text` lines (`"Monday: 10:00 AM – 10:00 PM"`, `Closed`, `Open 24 hours`,
split days collapse to outer bounds) in `src/utils/hours.ts`.

## Hours shape — **please confirm for core**

No store in `core-stores.json` has `operationHours` populated, so this is a proposal. 24-hour
`HH:MM`, `null` = closed, whole object `null` = owner chose not to show hours.

```json
"operationHours": {
  "monday":    { "open": "10:00", "close": "22:00" },
  "tuesday":   { "open": "10:00", "close": "22:00" },
  "wednesday": { "open": "10:00", "close": "22:00" },
  "thursday":  { "open": "10:00", "close": "22:00" },
  "friday":    { "open": "10:00", "close": "23:00" },
  "saturday":  { "open": "10:00", "close": "23:00" },
  "sunday":    null
}
```

Past-midnight closes are expressed as `close < open` (`"11:00"` → `"01:00"`).

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
    "hours": { "monday": { "open": "10:00", "close": "22:00" }, "…": "…", "sunday": null }
  }
}
```

Reply `{ ok, id, logoUrl, revision }`. Errors `{ error, fields: [...] }` with 400/403/404/429.
A second submit for the same store keeps the previous logo if none is sent and bumps `revision`.

What it does, in order:

1. Logo → Vercel Blob, **public**, stable URL `…/claims/<CRSA>/logo.<ext>` (this is `imageUrl`)
2. Record → Vercel Blob, **private**, `claims/<CRSA>/claim.json` (has the owner's email, so never public)
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

**2 — on publish** · subject `<store> is live on Poof — have a look`
Button to the listing URL, then the same POS button.

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

## Outreach link

The per-store outreach email now points at `onboarding.poof.ca/claim/<CRSA>` instead of
`/s/<CRSA>`. `scripts/export-links.js` now writes a `claim_link` column next to `link` in
`data/store-links.csv` (`npm run links` to regenerate).

## Fixed on the way

`lib/mail.js → internalEmail` passed `to` as a string; the SendGrid path calls `to.map(...)`, so
internal notifications would have thrown with SendGrid configured. Now an array.
