# Tradespeople Quotes Agent

AI-assisted quotes and invoices for one trade (residential electricians first).
The model extracts, code prices, a human approves every send.
Design: [Tradespeople Quotes Agent HLD and LLD v1.1.html](Tradespeople%20Quotes%20Agent%20HLD%20and%20LLD%20v1.1.html).

## Repo layout (so far)

```
apps/api/          Fastify API (src/server.ts) and worker (src/worker.ts) — same code, two modes
  src/services/quoteEngine.ts   pure money engine — the only code that produces totals
  src/jobs/                     queue handlers: fetch-inbound, extract, notify, stuck-sweep
  src/llm/prompts/              versioned extraction prompts
  drizzle/                      migrations (0001_rls.sql = row-level security)
  scripts/eval.ts               golden-set evaluation (pnpm eval)
apps/web/          Next.js review UI (sign in, onboarding, jobs, quote review)
packages/shared/   Zod contracts + money.ts integer helpers
data/trade-packs/  starter price books per trade (electrical)
data/golden/       evaluation set + dated reports
spikes/            Day-1 throwaway experiments — not imported by the apps
infra/             docker-compose: Postgres 16 + SeaweedFS (local S3)
```


## Setup

```bash
pnpm install
cp .env.example .env          # fill in keys yourself; never commit .env
pnpm dev:infra                # Postgres on 56432, S3 on 8333
pnpm migrate                  # creates the "app" role + applies migrations
pnpm dev:api                  # API on http://localhost:8080
pnpm dev:worker               # queue worker (extraction, email fetch, notifications)
pnpm dev:web                  # UI on http://localhost:3000 (proxies /api/auth and /backend to the API)
```

Without `OPENAI_API_KEY` + `STRONG_MODEL`, set `FAKE_LLM_FILE=../../data/dev/fake-extraction.json`
to have the worker answer every extraction with a fixed fixture (development only;
ignored in production). Without Resend keys, owner notifications are printed by the
worker instead of emailed, and the inbound webhook is disabled.

Node 24 is pinned (`.nvmrc`, `engines`); pnpm 10. Postgres uses host port
56432 because native and other-project Postgres instances often hold 5432–5433.
`BETTER_AUTH_SECRET` in `.env` must be at least 32 characters.

## Tests

```bash
pnpm test                     # unit + property + integration (needs pnpm dev:infra)
```

Integration tests create a throwaway `quotes_test` database. CI
(`.github/workflows/ci.yml`) runs everything against Postgres on every push,
plus the isolation suites a second time with RLS bypassed
(`TEST_BYPASS_RLS=1`) to prove the code-level tenant filters on their own.

## Days 6–10 — status (2026-11-02)

| Area | What exists |
|---|---|
| Worker + queue | pg-boss on Postgres; every enqueue is in the same transaction as the change that causes it; a 5-minute stuck-sweep re-drives anything left behind. |
| Intake | Paste / upload / site notes (`POST /jobs`, multipart); Resend inbound webhook with raw-body signature check, sender allowlist + quarantine, per-business rate limit; body and attachments fetched by the worker. |
| Photos | HEIC via native libheif (JS fallback), EXIF/GPS stripped, ≤1600 px preview; originals download-only. |
| Extraction | Versioned prompt, forwarded-header contact hint, validation (fuzzy source quotes, foreign ids nulled, unstated quantities flagged), one retry, spend cap, cost logged per call. |
| Matching | Catalogue id (sanity-checked) → unique exact name/core name/alias → trigram with a clear lead. Assemblies expand into priced parts; anything else needs a price, with suggestions. |
| Review screen v1 | Original beside editable lines; source quotes highlighted; sentences no line used are shaded; needs-price / quantity-to-confirm / from-photo flags; suggestions; live totals from the server engine; save with optimistic locking; phone layout with Message/Quote tabs. |
| Notifications | Owner emails for draft ready, needs info, failed, quarantined, rate-limited, spend cap. |

Exit test: the pipeline-level parts pass — every unpriced line is flagged and
none guessed, no labour hours are invented, and a worker killed mid-extraction
loses no job (integration tests). The live part — 15 messy enquiries through the
real model — needs `OPENAI_API_KEY` + `STRONG_MODEL` in `.env`, then:

```bash
pnpm eval
```

Found while running it end to end and fixed: the matcher missed long catalogue
names ("GFCI receptacle, 15 A") — it now also scores the core name; pasted
forwards weren't parsed for the customer's address; quoted reply text was being
dropped; "not used" shading flagged headers and greetings.

Not yet: price-book editing screen and full onboarding (Days 16–21);
approval, PDF, sending, invoices (Days 11–15).

## Days 2–5 — status (2026-11-01)

Exit test passed: two seeded businesses cannot see each other's data through
any endpoint or via raw SQL as the app role, and a hand-built quote with an
assembly, a discount and GST + QST totals correctly to the cent ($885.13).

| Area | What exists |
|---|---|
| Quote engine | Integer cents + milli-quantities, per-line half-up, tax components in ppm, discount bound, optional lines, preview, deposit split. 24 tests, ~37k property cases. |
| Data model | All §12 tables. RLS on every tenant table (fails closed when the tenant is unset), append-only audit for the app role, DB checks for the totals identity and discount bound. |
| Auth + tenancy | Better Auth email/password; tenant from the session; every query filters `business_id` *and* runs under RLS. Origin check on cookie writes. |
| Price book | Items, cost + markup, assemblies priced as the sum of parts, deactivate-not-delete, electrical starter template. |
| Quotes | Per-business numbers, line editing with row lock + optimistic `lockVersion`, engine recompute in the same transaction, assembly expansion, preview totals, audit trail. |
| Not yet | Approval/sending, PDFs, invoices (Days 11–15); intake/extraction (Days 6–10); email verification + magic link (Days 16–21). |

### API (so far)

| Route | |
|---|---|
| `POST /api/auth/sign-up/email`, `/api/auth/sign-in/email`, … | Better Auth |
| `POST /businesses` | onboarding: create business, become owner |
| `GET / PATCH /settings/business` | tax components, terms, deposit default, allowlist… |
| `GET / POST /price-book`, `POST /price-book/starter`, `PATCH / DELETE /price-book/:id` | price book + assemblies |
| `GET / POST /customers`, `GET / PATCH /customers/:id` | customers (email or phone required) |
| `GET / POST /quotes`, `GET / PATCH /quotes/:id` | draft quotes (PATCH needs `lockVersion`) |
| `POST /quotes/:id/lines/from-price-book` | add an item or expand an assembly |
| `POST /quotes/:id/preview-totals` | live totals, writes nothing |

## Day 1 — spike results (2026-11-01)

| # | Spike | Status | Result |
|---|---|---|---|
| 1 | Resend inbound email | **Waiting on your account** | Receiver + signature check written; local signed-request test passes (valid → 200, tampered → 401). Real-provider run needs `RESEND_API_KEY` + `RESEND_INBOUND_SECRET`. |
| 2 | iPhone photos (HEIC) | **Pass, with a change** | Decodes, auto-rotates, strips EXIF/GPS, resizes to ≤1600 px — on Windows and in `node:24-bookworm-slim`. `heic-convert` is slow in the container (~12 s per 12 MP photo); native `heif-convert` (libheif) ~2 s. |
| 3 | PDF quote (PDFKit) | **Pass** | Embedded Noto Sans renders accents (Hélène Côté, François Lévesque-Gagné); 2-page table paginates with repeated headers and page numbers. Two renders were byte-identical. |
| 4 | Extraction schema → OpenAI | **Offline pass; live call waiting on your key** | SDK `openai@6.49` accepts Zod 4.6; generated strict schema has every object closed, every field required, all 5 nullable fields as unions, no unusual keywords. A smuggled `unitPriceCents` is stripped by the Zod parse. |
| 5 | Local S3 (added) | **Pass** | `minio/minio` images are no longer published; switched local dev to SeaweedFS 4.50. Put → head → get round-trip is byte-identical with metadata kept. |

### Decisions and design updates from Day 1

1. **HEIC conversion: use native libheif in the worker image.** Install `libheif-examples` (Debian) in the worker Dockerfile and shell out to `heif-convert`; keep `heic-convert` (pure JS/WASM) as the fallback. Process a message's photos in parallel. At ~12 s per photo the JS path alone would break the 2-minute draft target for messages with several photos.
2. **Local S3 = SeaweedFS** (`chrislusf/seaweedfs:4.50`, `weed mini`). MinIO's community edition went source-only in 2025 and its Docker Hub / quay.io images are no longer available. Production is still R2/S3; the code only sees the S3 API (`forcePathStyle: true` locally).
3. **PDF money columns must be fixed-width and right-aligned.** Without a width PDFKit wraps at the margin and `$3,479.10` breaks across two lines.
4. **Re-rendering was byte-identical** with dates taken from the snapshot. v1.1 still stores the rendered bytes and never relies on this — a library upgrade could change output.
5. **Resend webhooks carry metadata only.** Body, headers and attachments come from `resend.emails.receiving.get(id)` and `resend.emails.receiving.attachments.list({ emailId })` (attachments have short-lived `download_url`s, so fetch them promptly in the worker). Signatures are Svix-style (`svix-id`, `svix-timestamp`, `svix-signature`) over the **raw** body; verify with `resend.webhooks.verify`.
6. **Resend SDK types lag the docs:** `authentication` (SPF/DKIM/DMARC) is documented on received emails but missing from `resend@6.37` types — read it defensively.

### Still to run (needs your accounts)

**Spike 1 — inbound email** (the one that decides Resend vs Postmark):

1. In Resend: add your intake domain (or use the Resend-provided receiving address), add the MX record, create a webhook for `email.received`, copy its signing secret.
2. Put `RESEND_API_KEY` and `RESEND_INBOUND_SECRET` in `.env`.
3. Run the receiver and a tunnel:
   ```bash
   pnpm spike:inbound
   cloudflared tunnel --url http://localhost:8787
   ```
4. Set the webhook URL to `<tunnel-url>/webhooks/resend/inbound`.
5. From your phone, forward a real email **with an iPhone photo attached** to `quote+spike123@<your receiving domain>`.
6. **Pass** = the console shows `plus-address token: spike123`, the body and forwarded `From:` lines, and the photo processed to a `.model.jpg`. If the token is missing or attachments can't be fetched, switch inbound to Postmark (design §7).

**Spike 4b — live extraction:**

1. Put `OPENAI_API_KEY` and `STRONG_MODEL` (an exact snapshot ID, not an alias) in `.env`.
2. Run `pnpm spike:extract`. It runs the three sample messages in `spikes/samples/messages/`:
   - forwarded email: should read the customer from the forwarded headers and match the EV assembly
   - vague message: should return questions and no lines
   - prompt injection: should produce no price and flag the attempt
3. Note the token counts printed per call; they feed the cost-per-draft target (≪ $0.50).

## Spike commands

| Command | What it does | Needs |
|---|---|---|
| `pnpm spike:photo` | HEIC/JPEG pipeline on `spikes/samples/photos` (+ `samples/private/` for your real photos, git-ignored) | — |
| `sh spikes/docker-photo-check.sh` | Same, inside `node:24-bookworm-slim` | Docker |
| `pnpm spike:pdf` | Renders `spikes/out/quote-spike.pdf` twice, compares hashes | — |
| `pnpm spike:schema` | Generates and lints the strict extraction schema | — |
| `pnpm spike:extract` | Live extraction on sample messages | OpenAI key |
| `pnpm spike:inbound` | Webhook receiver for real inbound email | Resend key + secret |
| `pnpm --filter @qa/spikes s3` | S3 round-trip against local SeaweedFS | `pnpm dev:infra` |
| `pnpm --filter @qa/spikes sign-test` | Signed/tampered requests against a running `spike:inbound` | inbound running |
