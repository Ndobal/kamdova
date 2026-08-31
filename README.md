# TeachEasy — Foundation (Modules 1–3)

Backend for TeachEasy: identity, permissions, and the partnership revenue ledger.
Cloudflare Workers + Hono + D1, TypeScript. The client is a Flutter app.

This repository currently implements the **foundation milestone only** — Modules
1–3 of [modules.md](modules.md). Lesson generation, quizzes, the marketplace and
payments (Modules 4–12) are deliberately not here yet; the point of doing this
first is that they can be built on top without a redesign.

---

## Quick start

```bash
npm install
cp .dev.vars.example .dev.vars        # then put real random secrets in it
npm run db:migrate                    # create the local D1 schema
npm run db:seed                       # roles, permissions, settings
npm run dev                           # http://127.0.0.1:8787
```

Create the first Super Admin (this endpoint closes permanently once one exists):

```bash
curl -X POST http://127.0.0.1:8787/api/bootstrap/super-admin \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"a-long-password","firstName":"Ada","lastName":"Okoro"}'
```

Then verify the whole thing works:

```bash
npm test                       # money engine unit tests
bash scripts/smoke-test.sh     # 44 end-to-end checks against a running dev server
```

---

## The three modules

**Module 1 — Authentication & accounts.** Registration, login, logout, email
verification, password reset, sessions, profiles, account status, role
assignment, and role-based dashboard routing. Roles: `SUPER_ADMIN`,
`DEPUTY_SUPER_ADMIN`, `PARTNER`, `TEACHER`, `STUDENT`.

**Module 2 — Partnership & revenue sharing.** Partners, partnership groups,
versioned agreements, revenue-sharing formulas, partner consent with an audit
trail, effective dates, and agreement lifecycle.

**Module 3 — Administration.** The Super Admin / Deputy Super Admin split, a
42-permission catalog, per-user permission overrides, an approval gate for
sensitive actions, append-only audit logs, and typed platform settings.

---

## Two ideas the design rests on

### The sharing formula is data, not code

No percentage is hard-coded anywhere. An agreement is a row set:

```
Agreement v1  (ACTIVE, effective 2026-09-01, basis NET)
├── Partner A → 4000 bps   (40%)
├── Partner B → 3500 bps   (35%)
└── Partner C → 2500 bps   (25%)
```

Changing the split creates **version 2**. Version 1 is never edited or deleted —
it is marked `SUPERSEDED` and given an `effective_to`, so what was in force on
any past date stays reconstructible. When a partner accepts a formula, the exact
lines they were shown are frozen into `agreement_approvals.formula_snapshot`
along with who clicked, when, and from where. Later edits elsewhere cannot
rewrite what they consented to.

`POST /api/agreements/:id/preview` runs a hypothetical pool through the live
formula without writing anything — the same engine Module 12 will use to cut
real distributions.

### Money is integers, always

Amounts are **kobo** (`INTEGER`), never floats. Shares are **basis points**
(`10000` = 100%). Distribution uses the largest-remainder method, so the parts
sum to exactly the pool — no kobo appears or vanishes. The `pool × bps` product
is done in `BigInt`, because it overflows `Number.MAX_SAFE_INTEGER` once the
pool passes roughly ₦90 billion.

A formula that totals less than 100% under-pays and reports the shortfall. It
does **not** inflate the remaining shares to absorb the difference.

---

## Zero trust

The security posture, and where each part of it lives:

| Principle | Where |
|---|---|
| Permissions are re-resolved from D1 on **every** request, never trusted from JWT claims — so a revoked permission takes effect at once | [rbac.ts](src/lib/rbac.ts) |
| Deny by default: `requireAuth` is mounted on the router prefix, then every route declares its own permission | [index.ts](src/index.ts) |
| Object ownership is checked on every single object access, not just at list level | `assertPartyTo` in [agreements.ts](src/routes/agreements.ts) |
| Partners get self-scoped permissions (`partner.self.*`) and never `partners.read`, so one partner cannot enumerate the others | [seeds/reference-data.sql](seeds/reference-data.sql) |
| Nobody may grant a permission they do not hold, or act on a user at or above their own authority rank | `assertOutranks` in [rbac.ts](src/lib/rbac.ts) |
| Sensitive actions by a non-Super-Admin become an approval request instead of a write | [approvals.ts](src/lib/approvals.ts) |
| Nobody decides their own approval request — Super Admin included | [admin/approvals.ts](src/routes/admin/approvals.ts) |
| Refresh tokens are opaque, stored hashed, and rotate on use; replaying a rotated token revokes the whole session family | [tokens.ts](src/lib/tokens.ts) |
| Losing `ACTIVE` status revokes live sessions immediately | [admin/users.ts](src/routes/admin/users.ts) |
| Login is rate limited on IP **and** email; identical error for unknown email and wrong password | [ratelimit.ts](src/lib/ratelimit.ts), [auth.ts](src/routes/auth.ts) |
| Bank/tax columns are only selected for the partner themselves or a Super Admin | [partners.ts](src/routes/partners.ts) |
| Unexpected exceptions are logged server-side and reduced to a generic client message | [index.ts](src/index.ts) |

The smoke test exercises these guards directly — a guard nobody tests is a guard
nobody knows is broken.

---

## Auth for a Flutter client

Native apps have no cookie jar, and httpOnly cookies are unreadable to Dart by
design. So auth is dual-mode: **tokens are returned in the JSON body** for
Flutter, and httpOnly cookies are set for a future web dashboard. Each client
uses one mechanism and ignores the other.

```
POST /api/auth/login
→ { "data": { "user": {...}, "roles": [...], "permissions": [...],
              "tokens": { "tokenType": "Bearer", "accessToken": "...",
                          "expiresIn": 900, "refreshToken": "...",
                          "refreshExpiresAt": "..." } } }
```

Store both in `flutter_secure_storage`. Send `Authorization: Bearer <accessToken>`.
On a 401, call `POST /api/auth/refresh` with `{"refreshToken": "..."}` — it
returns a new pair and invalidates the old one. **Always replace the stored
refresh token**: presenting a rotated one is treated as theft and kills every
session on the account.

`GET /api/me/dashboard` returns the navigation tree the caller is allowed to
see, so the app renders nav from the server rather than hardcoding permissions.

### Passwords and the Workers CPU limit

Passwords use PBKDF2-HMAC-SHA256 via WebCrypto (bcrypt/argon2 are native modules
and unavailable in the Workers runtime), 100,000 iterations by default. That
costs roughly 50–100 ms of CPU per login, which **exceeds the Workers free tier
10 ms budget** — login needs Workers Paid (30 s CPU). Lower
`PASSWORD_HASH_ITERATIONS` only with that trade-off in mind.

---

## API surface

```
POST   /api/bootstrap/super-admin      first Super Admin; closes after one exists

POST   /api/auth/register              login, verification, reset (all rate limited)
POST   /api/auth/login
POST   /api/auth/refresh
POST   /api/auth/logout                ?all=true ends every session
POST   /api/auth/verify-email
POST   /api/auth/resend-verification
POST   /api/auth/forgot-password
POST   /api/auth/reset-password
POST   /api/auth/change-password

GET    /api/me                         profile + roles + permissions + dashboard
GET    /api/me/dashboard
PATCH  /api/me/profile
GET    /api/me/sessions
DELETE /api/me/sessions/:id

GET    /api/admin/users                ?search= &status= &role= &page= &perPage=
POST   /api/admin/users
GET    /api/admin/users/:id
PATCH  /api/admin/users/:id
POST   /api/admin/users/:id/status
DELETE /api/admin/users/:id
POST   /api/admin/users/:id/roles
DELETE /api/admin/users/:id/roles/:roleCode
POST   /api/admin/users/:id/permissions
DELETE /api/admin/users/:id/permissions/:code

GET    /api/admin/roles
GET    /api/admin/roles/permissions    the full catalog, grouped
PUT    /api/admin/roles/:code/permissions

GET    /api/admin/settings             GET/PUT /api/admin/settings/:key
GET    /api/admin/audit-logs           GET /api/admin/audit-logs/:id
GET    /api/admin/approvals
POST   /api/admin/approvals/:id/decide
POST   /api/admin/approvals/:id/cancel

GET    /api/partners                   POST, GET/:id, PATCH/:id, POST/:id/status
GET    /api/partners/me                the caller's own partner record
GET    /api/partnership-groups         POST, GET/:id/members, POST/:id/members
DELETE /api/partnership-groups/:id/members/:partnerId

GET    /api/agreements                 ?groupId= &status=
POST   /api/agreements                 create a draft version
GET    /api/agreements/:id
GET    /api/agreements/:id/mine        partner view; ownership enforced
PUT    /api/agreements/:id/lines       replace the whole formula
POST   /api/agreements/:id/propose
POST   /api/agreements/:id/decision    "I agree to this sharing formula."
POST   /api/agreements/:id/activate
POST   /api/agreements/:id/terminate
POST   /api/agreements/:id/preview     model a distribution, writes nothing
```

Errors are always `{ "error": { "code", "message", "details?", "requestId" } }`,
so the client switches on `code` rather than parsing prose.

### Agreement lifecycle

```
DRAFT ─propose─> PROPOSED ─partner decisions─> UNDER_REVIEW ─all accept─> ACCEPTED
                     │                              │                        │
                     └──── any rejection ───────────┴──> REJECTED       activate
                                                                             │
                                                                             v
                                              SUPERSEDED <─new version─   ACTIVE ─> TERMINATED
```

Only these transitions are legal; anything else returns 409.

---

## Schema

Modules 1–3, in [migrations/](migrations/):

- **Identity** — `users`, `profiles`, `roles`, `permissions`, `role_permissions`,
  `user_roles`, `user_permissions`, `sessions`, `auth_tokens`
- **Partnership** — `revenue_categories`, `partners`, `partnership_groups`,
  `partnership_group_members`, `partnership_agreements`,
  `partnership_agreement_partners`, `agreement_expense_rules`, `agreement_approvals`
- **Administration** — `audit_logs`, `platform_settings`, `approval_requests`
- **Security** — `rate_limits`

Conventions: TEXT uuid ids, ISO-8601 UTC timestamps, INTEGER 0/1 booleans,
INTEGER kobo for money, INTEGER basis points for shares, `CHECK` constraints on
enum columns.

`users` and `profiles` are separate on purpose — auth churn (hashes, lockouts,
verification) has a different lifecycle and a different audience from displayable
person data.

### Where Modules 4–12 plug in

No tables were created for them, because they will be designed properly in their
own milestones and hollow schema written now would only be wrong later. The
attachment points already exist:

- `teachers` / `students` extend `users` 1:1, exactly as `profiles` does
- content, orders and payments reference `users.id`
- revenue posts against `revenue_categories.code`, which agreement lines already scope to
- `teacher_earnings` reads `revenue.teacher_share_bps` / `revenue.platform_fee_bps`
  from `platform_settings` — both seeded, so the split is configuration from day one
- `partner_distributions` calls `distribute()` from [money.ts](src/lib/money.ts)
  against the group's `ACTIVE` agreement
- payouts gate on `payouts.approve`, already in the catalog and marked sensitive

---

## Deploying

```bash
npx wrangler d1 create teacheasy-db      # put the id in wrangler.toml
npx wrangler d1 migrations apply teacheasy-db --remote
npx wrangler d1 execute teacheasy-db --remote --file=./seeds/reference-data.sql
npx wrangler secret put JWT_ACCESS_SECRET
npx wrangler secret put JWT_REFRESH_SECRET
npx wrangler deploy --env production
```

Before going live: set `CORS_ORIGIN` to the real dashboard origin, confirm
`COOKIE_SECURE=true`, run the bootstrap once and then remove the
`/api/bootstrap` route from [index.ts](src/index.ts), and wire a real mail
provider in [mailer.ts](src/lib/mailer.ts) — until then, verification and reset
tokens are only logged, and returned inline in development.
