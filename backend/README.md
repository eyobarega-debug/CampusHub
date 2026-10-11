# CampusHub — Phase 1 + Phase 2 + Phase 3 Backend (merged)

This is a working implementation of the **Graduation MVP** (Phase 1) scope
defined in `CampusHub_SRS.docx` (v1.1), Section 19, plus the Phase 2
additions described in `CampusHub_Phase2_Build_Prompt.md`. It is a real
Node.js/Express + PostgreSQL API — not a mock-up — and has been verified
end-to-end via `test/smoke.sh` (Phase 1, every SRS Section 23 acceptance
criterion), `test/smoke_phase2.sh` (Phase 2 additions), `test/tenancy.sh` (Phase 3
multi-university isolation) and `test/tenancy_phase2.sh` (Phase 2 features under
Phase 3 isolation). All four phases of work live in this one backend.

## Quick start

Prerequisites: Node.js 18+, PostgreSQL 14+. Redis is optional (Phase 2's
rate limiting and caching both degrade gracefully without it) but
recommended — `apt-get install redis-server` or point `REDIS_URL` at a
hosted instance.

```bash
cd backend
npm install
cp .env.example .env          # then edit the secrets — see below
createdb campushub             # or: psql -c "CREATE DATABASE campushub"
npm run db:migrate:all         # schema.sql (Phase 1+2) + 003 (Phase 3 tenancy) + 004 (Phase 2 under tenancy)
npm run db:seed                # creates demo accounts + sample data
npm run dev                    # starts on http://localhost:4000 (nodemon)
```

Then run the smoke tests against the running server:

```bash
# Load .env first so the test's QR signing uses the same secret as the server:
set -a; source .env; set +a
bash test/smoke.sh            # Phase 1 acceptance criteria
bash test/smoke_phase2.sh     # Phase 2 additions (run on a freshly seeded DB)
bash test/tenancy.sh          # Phase 3 isolation (fresh DB)
bash test/tenancy_phase2.sh   # Phase 2 features stay inside one university (fresh DB)
```

This exercises registration/login, browse→purchase→track an order, a P2P buy
request, a full rental lifecycle (book → pickup → return with late-fee
math), the event approve → publish → ticket-purchase → **QR scan with
duplicate-use prevention** flow, merchant apply → approve → add product,
admin report resolution, and RBAC leak checks — i.e., every item in SRS
Section 23. If it prints `🎉 ALL ACCEPTANCE-CRITERIA SMOKE TESTS PASSED`,
the build is in a good state.

### Demo accounts (created by `npm run db:seed`)

All use password `Password123!`.

| Email | Role | Notes |
|---|---|---|
| `admin@aastu.edu.et` | admin | approves merchants/events, moderates, resolves reports |
| `sara@aastu.edu.et` | student | buys products, books rentals, buys tickets |
| `dawit@aastu.edu.et` | student | owns the seeded rental item (projector) |
| `selam@aastu.edu.et` | merchant | already-approved store with 4 products |
| `robel@aastu.edu.et` | organizer | leads "AASTU Tech Club", has 1 published + 1 pending event |

## Environment variables (`.env`)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | Sign/verify JWTs (SRS Section 15) — **must** be long random values in any real deployment |
| `TICKET_QR_SECRET` | HMAC key used to sign ticket QR tokens (SRS FR-029) — rotating this invalidates every unscanned ticket, so treat it like a production secret |
| `COMMISSION_RATE` | Illustrative default (0.05 = 5%) used when a payment confirms — see SRS Section 18 on why this is a placeholder, not a validated figure |
| `PORT` | API port (default 4000) |

## Project structure

```
backend/
  db/schema.sql        # full schema — 27 tables (Phase 1 + Phase 2)
  db/seed.js            # demo data covering every module
  src/
    app.js               # mounts every module router + error handler
    server.js             # entry point
    db.js                  # pg pool + withTransaction() helper
    redis.js               # Phase 2 — Redis client, degrades gracefully if unreachable
    middleware/            # auth (JWT + RBAC), validate (zod), rateLimit (Redis-backed)
    utils/                 # hash, jwt, qr, notify/audit, errors, cache, csv
    services/
      payments.js           # Payment Gateway Abstraction Layer (SRS §16)
      providers/            # Phase 2 — mock.js (default) + chapa.js (reference, unverified)
    modules/<name>/routes.js   # one folder per SRS functional module
  test/
    smoke.sh                 # Phase 1 end-to-end acceptance-criteria test
    smoke_phase2.sh           # Phase 2 additions test
```

Each `modules/<name>/routes.js` file has comments citing the specific FR-IDs
it implements, so you can cross-reference directly against the SRS.

## What's implemented vs. simplified for this Phase 1 build

Everything in the SRS Section 19 "Graduation MVP" column is implemented with
real logic — password hashing, JWT + refresh-token rotation with reuse
detection, server-side RBAC on every protected route, atomic stock/capacity
handling, the payment abstraction layer, and (most importantly) the
signed/atomic QR ticket verification that prevents duplicate entry. A few
things were deliberately simplified to keep this a buildable, honest Phase 1
rather than a simulation of a bigger system — each is called out in a code
comment at the relevant spot, summarized here:

- **Payments**: only the mock/sandbox provider is implemented (per SRS
  Section 16.1 — this is explicitly what the Graduation MVP calls for). A
  real provider integration is Phase 2 scope. `POST
  /api/payments/mock/:id/complete` simulates the provider's webhook.
- **Email/SMS**: notifications are persisted in-app (`notifications` table)
  and readable via `GET /api/notifications`, matching FR-045's in-app
  channel. No real email/SMS provider is configured (no credentials exist
  for this local build) — password-reset tokens are logged to the server
  console instead of emailed (`[DEV EMAIL] ...`), clearly marked dev-only,
  and surfaced directly in the Forgot Password screen for local testing.
- **Student ID manual-verification fallback (FR-002)**: automatic
  university-domain verification is fully implemented. The manual
  admin-review fallback for non-matching emails works via the existing
  `PATCH /api/admin/users/:id { verified: true }` endpoint rather than a
  dedicated document-upload UI, which is a reasonable Phase 1 scope cut.
- **Ticket purchase quantity**: fixed at 1 per API call (buying 3 tickets =
  3 calls). Noted in code; trivial to extend later.
- **Refunds on event cancellation**: when an organizer cancels an event, all
  active tickets are marked cancelled and holders are notified; per-ticket
  refund calls are not automatically fired in bulk (each holder/admin can
  still call `POST /api/tickets/:id/cancel` or `POST
  /api/payments/:id/refund`). A bulk-refund job is flagged in code as
  reasonable Phase 2 scope.
- **Offline QR scanning**: explicitly Phase 2 per the SRS (Section 17/19) —
  not attempted here.

Since the initial Phase 1 pass, the following were also closed out and are
now real, not simplified: **image uploads** (real multipart upload to local
disk via `POST /api/uploads`, served from `/uploads`, wired into every
product/listing/rental image field — no more URL-only inputs), **merchant
promotions/featured listings (FR-038)** (`POST /api/products/:id/promote`,
billed through the same payment abstraction, sorts featured products first
in `GET /api/products`), an **audit log viewer** (`GET
/api/admin/audit-logs`), **password reset** end-to-end in the UI, **category
filters** on marketplace/listings/rentals browsing, a **favorites page**,
**notification-preference toggles**, and baseline **security headers**
(`helmet`).

None of these simplifications touch the security-critical paths (auth,
RBAC, payment state transitions, duplicate-ticket prevention) — those are
implemented for real and covered by the smoke test.

## Design decisions worth knowing about

- **Raw SQL over an ORM.** The project started with Prisma, but the
  environment resolved a `8.0.0-rc.12` (pre-release) version with an
  unfamiliar CLI/config surface. Rather than risk subtle bugs from
  unfamiliar release-candidate behavior, the backend uses `pg` directly with
  hand-written, parameterized SQL. Slightly more code, much more
  predictable.
- **QR signing scheme.** An early version stored only a hash of a
  per-ticket random secret (like a password-reset token) — but that would
  have made it impossible to satisfy FR-030 ("view my tickets" at any later
  time), since the plaintext secret would only ever have existed once. The
  shipped design instead HMAC-signs the ticket's own ID with a server-wide
  secret (`TICKET_QR_SECRET`), so the QR can be deterministically
  regenerated on demand but still can't be forged without the server
  secret. See `src/utils/qr.js` for the full reasoning in comments.
- **Duplicate-ticket prevention is a single SQL statement.** `UPDATE
  tickets SET status='used', ... WHERE id=$1 AND status='active'` — the
  database's own row-level locking during that statement is what makes two
  concurrent scans of the same ticket structurally unable to both succeed,
  not application-level logic. See `src/modules/tickets/routes.js`.
- **Payment finalizer registry.** Orders, rental bookings, and tickets never
  import each other or hard-code payment-provider logic; each module
  registers an `onConfirmed`/`onFailed` callback with
  `src/services/payments.js` at load time. This is the mechanism that lets
  SRS Section 16's "swap the provider without touching business logic"
  claim actually hold up in code, not just in the spec's prose.

## Phase 2 additions

Built on top of the Phase 1 base above, verified by `test/smoke_phase2.sh`:

- **Redis** (`src/redis.js`) — rate limiting (`middleware/rateLimit.js`) and
  event-list caching (`utils/cache.js`) now use Redis when available, with
  automatic fallback to Phase 1's in-process behavior if Redis is down.
  Install with `apt-get install redis-server` or point `REDIS_URL` at a
  hosted instance.
- **SMS notifications** (`utils/notify.js`) — simulated the same way Phase
  1 simulated email (`[DEV SMS]` console logs), respecting the same
  per-category notification preferences.
- **P2P in-app payment** — `p2p_orders` table + `POST
  /api/listings/requests/:requestId/pay`, routed through the existing
  payment abstraction. Off-platform handover (Phase 1's only option) is
  still supported as an alternative.
- **Tiered rental late fees** — `rental_items.late_fee_policy` (JSONB), see
  `computeLateFee()` in `modules/rentals/routes.js`.
- **Recurring events + waitlists** — `POST
  /api/events/:id/generate-occurrences`, `POST
  /api/events/:eventId/waitlist`, auto-notification when a cancellation
  frees a waitlisted spot (`notifyWaitlistIfAvailable()` in
  `modules/tickets/routes.js`).
- **Offline ticket scan batch verification** — `POST
  /api/tickets/verify-batch`. The single-scan atomic verification logic was
  refactored into a shared `verifyOneTicket()` function so there's exactly
  one implementation of the security-critical duplicate-use guard, used by
  both the online and offline-sync endpoints.
- **Pluggable payment providers with failover** — `src/services/providers/`.
  `mock` always works; `src/services/providers/chapa.js` is a **reference,
  unverified** adapter for a real Ethiopian PSP — read the warning comment
  at the top of that file before ever pointing it at real money.
- **CSV export** — `GET /api/admin/reports/export?type=orders|transactions|users`
  and `GET /api/merchants/:storeId/orders/export`.

Two real bugs were caught and fixed by actually running the test suite
during this work, not by code review: a table-creation ordering error in
`db/schema.sql` (`waitlist_entries` referenced `ticket_types` before that
table existed), and a repeat of an earlier "unregistered transaction type"
bug in the payment-ownership check when `p2p_order` was added — fixed this
time by rewriting that check as an explicit switch that fails loudly on an
unhandled type instead of silently building a broken query.

## Not yet built (next steps)

- Advanced merchant analytics (trend charts, cohort/repeat-purchase views)
  and bulk product upload/editing — Phase 2 spec items A and F, not
  attempted in this pass.
- Improved manual student-ID verification workflow — deferred because it's
  meant to respond to real pilot bottlenecks (SRS Section 8), which don't
  exist yet for this project.

- Automated test suite beyond `test/smoke.sh` (e.g., Jest unit tests per
  module) — the smoke test currently is the regression safety net.
- Rate limiting is in-memory only — fine for one server instance, will not
  coordinate correctly across multiple instances (Redis is the documented
  Phase 2 upgrade, SRS Section 19).
- No CI pipeline running the smoke test automatically on changes.

## Phase 3 — multi-university tenancy (merged in)

The Phase 3 layer (shared schema scoped by `university_id`, Super Admin API under
`/api/super`, per-university feature flags and fee schedules) is described in
[`../docs/PHASE3.md`](../docs/PHASE3.md). The Phase 2 features above were merged
underneath it:

- Every Phase 2 query is tenant-scoped: the event-list cache key includes the
  university, waitlist / recurring-event / merchant-export routes use
  `assertSameTenant`/`scopeTo`, and admin CSV exports only contain the caller's
  university (a super admin without `X-University-Id` gets the cross-campus export).
- `p2p_orders` and `waitlist_entries` carry `university_id` (set by DB trigger, like the
  other tenant tables), and `p2p_order` payments are stamped with their university.
- Commission on every payment type, including P2P, comes from the university's fee
  schedule (`services/fees.js`); the Phase 2 provider registry (`mock` / `chapa`) is
  unchanged.

### Database setup and upgrade paths

| Situation | Commands |
|---|---|
| Fresh database | `npm run db:migrate:all` then `npm run db:seed` |
| Existing Phase 1 database | `db:migrate` is NOT needed again — run `db:migrate:phase3` then `db:migrate:phase2` |
| Existing Phase 3 database (no Phase 2 yet) | `npm run db:migrate:phase2` (creates the missing Phase 2 tables/columns, then tenant-stamps them) |

All migrations are idempotent. Demo super admin: `super@campushub.et` (password
`Password123!`). With two or more universities, anonymous browsing must send
`X-University-Id` / `X-University-Slug` or `?universityId=`.
