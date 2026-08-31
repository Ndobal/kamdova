# KamDova

**Create. Teach. Learn. Earn.**
*A joint initiative of Ndovera and Kambi Academy.*

Backend for KamDova: identity, permissions, AI lesson planning, student notes,
subscriptions, and the partnership revenue ledger. Cloudflare Workers + Hono +
D1, TypeScript. The client is a Flutter app.

> The repository and the Worker are still named `teacheasy` from the original
> project. Renaming them is a separate, outward-facing change — say the word and
> I'll rename the GitHub repo, the Worker and the D1 database together.

---

## What is built

| Module | Area | Status |
|---|---|---|
| 1 — Authentication & accounts | — | Built |
| 2 — Partnership & revenue sharing | Partnership | Built |
| 3 — Super Admin & Deputy Super Admin | — | Built |
| 4 — Teacher management & AI lesson planning | Teacher | Built |
| 5 — Lesson template engine | Teacher | Built |
| 6 — Student notes | Teacher / Student | Built |
| Trials, plans, quota | Marketplace | Built |
| 7 — Quiz engine | Teacher | Not started |
| 8 — Marketplace & content access | Marketplace | Catalog only |
| 9 — Student payments | Marketplace | Orders only, **no gateway** |
| 10–12 — Earnings, ads, finance | Partnership | Not started |

**Not built on purpose:** the payment gateway. Orders are recorded and can be
marked paid, so wiring a gateway later is one integration against an existing
ledger rather than a rewrite — the pricing → payment → revenue → payout
separation the architecture called for.

---

## Quick start

```bash
npm install
cp .dev.vars.example .dev.vars        # then put real random secrets in it
npm run db:migrate                    # schema
npm run db:seed                       # roles, permissions, templates, plans, brand
npm run dev                           # http://127.0.0.1:8787
```

Create the first Super Admin (this endpoint closes permanently once one exists):

```bash
curl -X POST http://127.0.0.1:8787/api/bootstrap/super-admin \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"a-long-password","firstName":"Ada","lastName":"Okoro"}'
```

Verify:

```bash
npm test                                   # 32 unit tests
bash scripts/smoke-test.sh                 # 44 checks — identity, partnership, admin
bash scripts/smoke-test-teaching.sh        # 53 checks — templates, lessons, notes, sharing
bash scripts/smoke-test-billing.sh         # 67 checks — brand, trials, quota, plans
```

AI generation needs `ANTHROPIC_API_KEY` in `.dev.vars`. Without it every other
endpoint works and the generate endpoints return a clear 422.

---

## The capability map

The four areas and their features live in the `products` table as a tree, served
by `GET /api/marketplace/products`. Moving a feature between areas is a row
change, not a client release.

```
KamDova
├── Teacher      AI Lesson Planner · Lesson Templates · Student Notes · Quiz Generator
│                Assignments · Resource Creation · Publish · Earn
├── Student      Access Teacher Content · Student Notes · Quizzes · Practice
│                Discover Other Teachers · Purchase Content
├── Marketplace  Free Content · Paid Content · Teacher Profiles · Content Discovery
└── Partnership  Ndovera · Kambi Academy · Revenue Sharing · Pricing · Agreements
```

---

## Three ideas the design rests on

### 1. The lesson template is data

A template is an ordered list of sections stored as JSON. Three things read that
same list: the **generator** derives a JSON Schema from it, the **validator**
checks content against it, and the **renderer** walks it to produce blocks,
Markdown or HTML. A new template is a row, not a deploy.

Two templates ship, and they are structurally different:

- **Template 1 — Standard**: header, objectives, instructional materials,
  previous knowledge, introduction, `PRESENTATION` as **STEP blocks** with
  Teacher's and Students' Activities, evaluation, conclusion, assignment.
- **Template 2 — Professional**: expanded header with class profile, rationale
  and prerequisites, then `LESSON DEVELOPMENT` as a **four-column grid**
  (Step/Time · Teacher's Activities · Pupils' Activities · Learning Point),
  assessment, homework and board notes.

The section engine supports both through `steps` and `table` section types.
`GET /api/templates/:code/schema` shows exactly what the AI will be asked to fill.

### 2. The sharing formula is data

No percentage is hard-coded. An agreement is a row set; changing the split
creates a **new version**, and the old one is marked `SUPERSEDED` with an
`effective_to` rather than edited — so what was in force on any past date stays
reconstructible. Partner consent freezes a snapshot of the exact formula they
were shown.

`POST /api/agreements/:id/preview` runs a hypothetical pool through the live
formula without writing anything.

### 3. Money is integers, always

Amounts are **kobo** (`INTEGER`), never floats. Shares are **basis points**
(`10000` = 100%). Distribution uses largest-remainder, so parts sum to exactly
the pool. The `pool × bps` product is done in `BigInt` because it overflows
`Number.MAX_SAFE_INTEGER` past roughly ₦90 billion.

Per-call AI token usage and cost are recorded in kobo on `ai_generations`,
because Module 12 deducts AI cost as an expense before partners share revenue,
and it cannot be reconstructed from a provider invoice later.

---

## Trials, plans and quota

### The one-trial rule, honestly

Two layers with genuinely different strengths:

| Layer | Mechanism | Strength |
|---|---|---|
| **Account** | `UNIQUE` on `trial_claims.user_id` | **A real guarantee.** No client can get around it. |
| **Device** | `UNIQUE` on `trial_claims.device_hash` | **A deterrent, not a proof.** |

The device identifier is reported by the app, so a rooted phone, a modified
build or an emulator can send a fresh one. Android's SSAID survives an app
reinstall but not a factory reset; iOS `identifierForVendor` does not survive a
reinstall. It stops the casual second account on the same phone — which is most
of the abuse — and nothing more.

If the leak rate ever matters commercially, the two real upgrades are **phone
OTP verification** (SIMs are NIN-registered in Nigeria, so they are far harder
to farm) and **iOS DeviceCheck** (2 bits of Apple-managed per-device storage
that survive reinstall *and* factory reset — literally designed for this).

The raw device id is **never stored**: it is HMAC'd under a server secret.
Refused attempts are recorded in `trial_attempts`, so a spike of
`DEVICE_ALREADY_CLAIMED` is visible rather than silent.

IP is recorded as a signal but **never blocks** — Nigerian carriers NAT heavily,
and blocking on it would deny trials to innocent users sharing an operator.

### Plans

Seeded from the supplied pricing; every number is editable from the Super Admin
dashboard.

| Code | Name | Price | Period | Lesson plans |
|---|---|---|---|---|
| `STARTER_5` | Starter Bundle | ₦1,000 | one-off | 5 |
| `VALUE_10` | Value Bundle | ₦1,500 | one-off | 10 |
| `WEEKLY_10` | Weekly 10 | ₦1,000 | weekly | 10 |
| `MONTHLY_18` | Monthly 18 | ₦2,000 | monthly | 18 |
| `WEEKLY_PRO` | Weekly Pro | ₦3,000 | weekly | 40 ⚠️ |
| `TERMLY_ALL` | Termly Unlimited | ₦8,000 | termly | unlimited ⚠️ |

> ⚠️ **Two of these need your confirmation.** Neither `WEEKLY_PRO` nor
> `TERMLY_ALL` came with a stated quota, so the numbers above are assumptions
> recorded in each plan's `notes` column. **Also check the Weekly Pro price:**
> ₦3,000/week is about ₦12,000/month against ₦2,000 for Monthly 18 — as listed,
> nobody would buy it.

Quota is **snapshotted onto the subscription at purchase**, so raising a plan's
allowance changes what new subscribers get without retroactively altering what
an existing subscriber already paid for.

The trial default is **3 days / 5 lesson plans**; the paid default weekly cap is
**10**. Both are `platform_settings` keys, editable from the Super Admin
dashboard and marked sensitive, so a Deputy's change becomes an approval request.

---

## Zero trust

| Principle | Where |
|---|---|
| Permissions re-resolved from D1 on **every** request, never trusted from JWT claims — a revoked permission takes effect at once | [rbac.ts](src/lib/rbac.ts) |
| Deny by default: `requireAuth` on the router prefix, then every route declares its permission | [index.ts](src/index.ts) |
| Object ownership checked on every object access, not just at list level | `loadLesson` in [lessons.ts](src/routes/lessons.ts), `assertPartyTo` in [agreements.ts](src/routes/agreements.ts) |
| Self-scoped permissions (`teacher.self.*`, `partner.self.*`) so nobody can enumerate their peers | [seeds/reference-data.sql](seeds/reference-data.sql) |
| **The model's output is re-validated against the template before storage**, and input-sourced header fields are overwritten from the lesson so it cannot rewrite the class, date or topic the teacher typed | [templates.ts](src/lib/templates.ts) |
| Billing gates **before** the AI is called, so an unentitled request costs nothing | [entitlements.ts](src/lib/entitlements.ts) |
| Quota is booked before the call and refunded if it fails — a provider error never costs a teacher a lesson plan | [lessons.ts](src/routes/lessons.ts) |
| Sensitive actions by a non-Super-Admin become approval requests | [approvals.ts](src/lib/approvals.ts) |
| Nobody decides their own approval request — Super Admin included | [admin/approvals.ts](src/routes/admin/approvals.ts) |
| Refresh tokens are opaque, stored hashed, rotate on use; replaying a rotated one revokes the whole session family | [tokens.ts](src/lib/tokens.ts) |
| The public share page requires all four of slug / not-revoked / not-expired / still-published | [public.ts](src/routes/public.ts) |
| Device ids are HMAC'd, never stored raw | [trials.ts](src/lib/trials.ts) |

---

## Auth for a Flutter client

Native apps have no cookie jar, and httpOnly cookies are unreadable to Dart. So
auth is dual-mode: **tokens in the JSON body** for Flutter, httpOnly cookies for
a future web dashboard.

```
POST /api/auth/login
→ { "data": { "user": {...}, "roles": [...], "permissions": [...],
              "tokens": { "tokenType": "Bearer", "accessToken": "...",
                          "expiresIn": 900, "refreshToken": "...",
                          "refreshExpiresAt": "..." } } }
```

Store both in `flutter_secure_storage`. Send `Authorization: Bearer <accessToken>`.
On a 401, `POST /api/auth/refresh` with `{"refreshToken": "..."}` returns a new
pair. **Always replace the stored refresh token** — presenting a rotated one is
treated as theft and kills every session on the account.

`GET /api/me/dashboard` returns the navigation tree the caller may see, so the
app renders nav from the server rather than hardcoding permissions.

**Passwords and the Workers CPU limit:** PBKDF2-HMAC-SHA256 via WebCrypto
(bcrypt/argon2 are native modules, unavailable in Workers), 100,000 iterations.
That costs ~50–100 ms CPU per login, which **exceeds the Workers free tier 10 ms
budget** — login needs Workers Paid.

---

## API surface

```
POST   /api/bootstrap/super-admin      first Super Admin; closes after one exists

POST   /api/auth/{register,login,refresh,logout}          all rate limited
POST   /api/auth/{verify-email,resend-verification}
POST   /api/auth/{forgot-password,reset-password,change-password}

GET    /api/me                         profile + roles + permissions + dashboard
GET    /api/me/dashboard
PATCH  /api/me/profile
GET    /api/me/sessions                DELETE /api/me/sessions/:id

GET    /api/admin/users                POST, GET/:id, PATCH/:id, DELETE/:id
POST   /api/admin/users/:id/status     roles and permissions sub-resources
GET    /api/admin/roles                GET /permissions, PUT /:code/permissions
GET    /api/admin/settings             GET/PUT /:key
GET    /api/admin/audit-logs           GET /:id
GET    /api/admin/approvals            POST /:id/decide, POST /:id/cancel

GET    /api/partners                   POST, GET/:id, PATCH/:id, POST/:id/status
GET    /api/partners/me
GET    /api/partnership-groups         POST, members sub-resource
GET    /api/agreements                 POST, GET/:id, GET/:id/mine
PUT    /api/agreements/:id/lines       replace the whole formula
POST   /api/agreements/:id/{propose,decision,activate,terminate,preview}

GET    /api/teachers/me                PATCH, PUT /me/subjects, PUT /me/classes
GET    /api/teachers                   GET/:id, POST/:id/status
GET    /api/templates                  GET/:code, GET/:code/schema, POST, PUT/:code
GET    /api/reference/{subjects,class-levels}

GET    /api/lessons                    POST, GET/:id, PATCH/:id, DELETE/:id
POST   /api/lessons/:id/generate                  AI: teacher lesson note
POST   /api/lessons/:id/generate-student-notes    AI: student notes
GET    /api/lessons/:id/generations                token usage and cost

GET    /api/notes/:kind/:id            kind = teacher | student
PATCH  /api/notes/:kind/:id            edit; validated against the template
POST   /api/notes/:kind/:id/{publish,unpublish}
GET    /api/notes/:kind/:id/export     ?format=markdown|html
POST   /api/notes/student/:id/shares   GET, DELETE /:shareId

GET    /api/marketplace/products       the KamDova capability tree
GET    /api/marketplace/plans
GET    /api/billing/me                 entitlement, allowance, trial state
POST   /api/billing/trial              claim the free trial
POST   /api/billing/orders             GET
GET    /api/admin/billing/plans        POST, PATCH /:code
GET    /api/admin/billing/subscriptions
POST   /api/admin/billing/orders/:id/mark-paid
POST   /api/admin/billing/subscriptions/grant
GET    /api/admin/billing/trial-attempts

GET    /s/:slug                        public read-only student page
GET    /s/:slug/json                   the same, for the app
```

Errors are always `{ "error": { "code", "message", "details?", "requestId" } }`.

---

## Schema

`migrations/` holds DDL only; `seeds/` holds re-runnable reference data.

- **Identity** — `users`, `profiles`, `roles`, `permissions`, `role_permissions`,
  `user_roles`, `user_permissions`, `sessions`, `auth_tokens`
- **Partnership** — `revenue_categories`, `partners`, `partnership_groups`,
  `partnership_group_members`, `partnership_agreements`,
  `partnership_agreement_partners`, `agreement_expense_rules`, `agreement_approvals`
- **Administration** — `audit_logs`, `platform_settings`, `approval_requests`, `rate_limits`
- **Teaching** — `subjects`, `class_levels`, `lesson_templates`, `teachers`,
  `teacher_subjects`, `teacher_classes`, `lessons`, `lesson_notes`,
  `student_notes`, `note_shares`, `ai_generations`
- **Commerce** — `products`, `pricing_plans`, `subscriptions`, `usage_counters`,
  `devices`, `trial_claims`, `trial_attempts`, `orders`

Conventions: TEXT uuid ids, ISO-8601 UTC timestamps, INTEGER 0/1 booleans,
INTEGER kobo for money, INTEGER basis points for shares, `CHECK` constraints on
enum columns.

---

## Deploying

```bash
npx wrangler d1 create teacheasy-db      # put the id in wrangler.toml
npx wrangler d1 migrations apply teacheasy-db --remote
for f in reference-data teaching-reference commerce-reference brand-reference; do
  npx wrangler d1 execute teacheasy-db --remote --file=./seeds/$f.sql
done
npx wrangler secret put JWT_ACCESS_SECRET
npx wrangler secret put JWT_REFRESH_SECRET
npx wrangler secret put DEVICE_HASH_SECRET
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler deploy --env production
```

Before going live: set `CORS_ORIGIN` and `PUBLIC_BASE_URL`, confirm
`COOKIE_SECURE=true`, run the bootstrap once and then remove the
`/api/bootstrap` route from [index.ts](src/index.ts), wire a real mail provider
in [mailer.ts](src/lib/mailer.ts), confirm the two flagged plan quotas, and
draft the Ndovera / Kambi Academy revenue agreement (both partners are seeded as
`PENDING` with **no agreement**, because the split is yours to decide).
