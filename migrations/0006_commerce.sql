-- NKLearn Modules 8-9 foundation: products, pricing, trials, subscriptions and
-- usage quota.
--
-- Deliberately NOT included: the payment gateway. Orders are recorded and can
-- be marked paid, so the gateway becomes one integration against an existing
-- ledger rather than a rewrite -- which is the separation the original spec
-- asked for (pricing -> payment -> revenue -> payout).

-- --------------------------------------------------------------- brand ----
-- The NKLearn product family, as data. Renaming a product, or adding a sixth,
-- is a row change: nothing in the code hard-codes a product name.
CREATE TABLE products (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  tagline     TEXT,
  description TEXT,
  module      TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- --------------------------------------------------------------- plans ----
-- A plan is what a teacher buys. Money is INTEGER kobo and quota is an INTEGER
-- count, both editable from the Super Admin dashboard -- pricing.manage is a
-- sensitive permission, so a deputy's edit becomes an approval request.
--
-- billing_period drives both what the buyer is charged for and how the usage
-- window rolls over:
--   ONE_OFF  -- a bundle of lesson plans that does not renew or reset
--   WEEKLY   -- quota resets every 7 days
--   MONTHLY  -- quota resets every calendar month
--   TERMLY   -- quota resets every school term (see billing.term_days)
CREATE TABLE pricing_plans (
  id             TEXT PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  description    TEXT,
  product_code   TEXT REFERENCES products(code),
  audience       TEXT NOT NULL DEFAULT 'TEACHER' CHECK (audience IN ('TEACHER','STUDENT')),

  price_kobo     INTEGER NOT NULL CHECK (price_kobo >= 0),
  currency       TEXT NOT NULL DEFAULT 'NGN',
  billing_period TEXT NOT NULL CHECK (billing_period IN ('ONE_OFF','WEEKLY','MONTHLY','TERMLY')),

  -- NULL means unlimited generations for the period.
  lesson_quota   INTEGER CHECK (lesson_quota IS NULL OR lesson_quota >= 0),

  is_active      INTEGER NOT NULL DEFAULT 1,
  is_featured    INTEGER NOT NULL DEFAULT 0,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  notes          TEXT,
  created_by     TEXT REFERENCES users(id),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_pricing_plans_active ON pricing_plans (audience, is_active, sort_order);

-- ---------------------------------------------------------- entitlement ----
-- One row per user per entitlement period. A trial is a subscription with
-- source = 'TRIAL' rather than a separate concept, so the quota engine and the
-- generation gate have exactly one thing to consult.
CREATE TABLE subscriptions (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id              TEXT REFERENCES pricing_plans(id),
  source               TEXT NOT NULL DEFAULT 'PURCHASE'
                         CHECK (source IN ('TRIAL','PURCHASE','GRANT')),
  status               TEXT NOT NULL DEFAULT 'ACTIVE'
                         CHECK (status IN ('ACTIVE','EXPIRED','CANCELLED','SUSPENDED')),

  started_at           TEXT NOT NULL,
  expires_at           TEXT,
  cancelled_at         TEXT,
  cancelled_by         TEXT REFERENCES users(id),

  -- Snapshotted from the plan at purchase, so a later price or quota change
  -- never silently alters what an existing subscriber already paid for.
  quota_limit          INTEGER,
  quota_period         TEXT CHECK (quota_period IN ('ONE_OFF','WEEKLY','MONTHLY','TERMLY')),
  price_paid_kobo      INTEGER,

  granted_by           TEXT REFERENCES users(id),
  grant_reason         TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX idx_subscriptions_user ON subscriptions (user_id, status);
CREATE INDEX idx_subscriptions_expires ON subscriptions (expires_at);

-- Usage inside one rolling window. Incremented only after a generation
-- actually succeeds, so a provider failure never costs the teacher a slot.
CREATE TABLE usage_counters (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id TEXT REFERENCES subscriptions(id) ON DELETE CASCADE,
  metric          TEXT NOT NULL DEFAULT 'LESSON_GENERATION',
  period_start    TEXT NOT NULL,
  period_end      TEXT NOT NULL,
  used            INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (user_id, metric, period_start)
);
CREATE INDEX idx_usage_counters_lookup ON usage_counters (user_id, metric, period_end);

-- ---------------------------------------------------------- trial abuse ----
-- Devices a user has signed in from.
--
-- device_hash is an HMAC of the client-reported id under a server secret -- the
-- raw identifier is never stored. It is still a CLIENT-REPORTED value and so
-- can be spoofed on a rooted device or a modified build; this is a deterrent,
-- not a proof, and the account-level rule below is the guarantee.
CREATE TABLE devices (
  id            TEXT PRIMARY KEY,
  device_hash   TEXT NOT NULL,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform      TEXT CHECK (platform IN ('ANDROID','IOS','WEB','OTHER')),
  model         TEXT,
  app_version   TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  UNIQUE (device_hash, user_id)
);
CREATE INDEX idx_devices_hash ON devices (device_hash);

-- The one-trial-per ledger.
--
-- UNIQUE on user_id is the hard guarantee. UNIQUE on device_hash is the
-- best-effort second layer: it stops the casual "make another account on the
-- same phone", and does not survive an Android factory reset or an iOS
-- reinstall. Rows persist after the trial ends -- deleting one would hand the
-- account a second trial.
CREATE TABLE trial_claims (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  device_hash  TEXT UNIQUE,
  platform     TEXT,
  ip_hash      TEXT,
  subscription_id TEXT REFERENCES subscriptions(id) ON DELETE SET NULL,
  claimed_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);
CREATE INDEX idx_trial_claims_device ON trial_claims (device_hash);

-- A refused claim is recorded too: a spike of DEVICE_ALREADY_CLAIMED is the
-- signal that someone is farming trials, and it is invisible if only successes
-- are stored.
CREATE TABLE trial_attempts (
  id          TEXT PRIMARY KEY,
  user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  device_hash TEXT,
  ip_hash     TEXT,
  outcome     TEXT NOT NULL
                CHECK (outcome IN ('GRANTED','ACCOUNT_ALREADY_CLAIMED','DEVICE_ALREADY_CLAIMED',
                                   'TRIALS_DISABLED','ALREADY_SUBSCRIBED')),
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_trial_attempts_created ON trial_attempts (created_at);

-- -------------------------------------------------------------- orders ----
-- Recorded now, charged later. status stays PENDING until Module 9 wires a
-- gateway; marking one PAID is what creates the subscription.
CREATE TABLE orders (
  id              TEXT PRIMARY KEY,
  reference       TEXT NOT NULL UNIQUE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id         TEXT NOT NULL REFERENCES pricing_plans(id),
  amount_kobo     INTEGER NOT NULL CHECK (amount_kobo >= 0),
  currency        TEXT NOT NULL DEFAULT 'NGN',
  status          TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','PAID','FAILED','CANCELLED','REFUNDED')),
  -- Set by the gateway in Module 9; unused for now.
  provider        TEXT,
  provider_ref    TEXT,
  paid_at         TEXT,
  failed_reason   TEXT,
  subscription_id TEXT REFERENCES subscriptions(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_orders_user ON orders (user_id, created_at);
CREATE INDEX idx_orders_status ON orders (status);
