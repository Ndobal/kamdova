-- TeachEasy Module 2 -- Partnership & Revenue Sharing
--
-- Governing principle from the spec: the sharing formula is DATA, not code.
-- Nothing here hard-codes a percentage. A new formula is a new agreement
-- VERSION -- the previous version is never mutated or deleted, so the audit
-- trail (who agreed to what, and when) stays intact forever.

-- Revenue buckets an agreement line can be scoped to. Modules 9-12 will post
-- real revenue against these; for now they exist so a formula can say
-- "Partner A takes 40% of STUDENT_PURCHASE but 20% of ADVERTISING".
CREATE TABLE revenue_categories (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- A partner is a business entity, not a login. user_id is nullable so the
-- Super Admin can record a partner before that person has an account.
CREATE TABLE partners (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  code                TEXT NOT NULL UNIQUE,
  legal_name          TEXT NOT NULL,
  display_name        TEXT,
  partner_type        TEXT NOT NULL DEFAULT 'INDIVIDUAL'
                        CHECK (partner_type IN ('INDIVIDUAL','COMPANY')),
  email               TEXT,
  phone               TEXT,
  tax_id              TEXT,
  bank_name           TEXT,
  bank_account_name   TEXT,
  bank_account_number TEXT,
  status              TEXT NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING','ACTIVE','SUSPENDED','EXITED')),
  joined_at           TEXT,
  exited_at           TEXT,
  notes               TEXT,
  created_by          TEXT REFERENCES users(id),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  deleted_at          TEXT
);
CREATE INDEX idx_partners_status ON partners (status);

-- The set of partners who share in a given pool. Most deployments have one
-- group (TeachEasy Founding Partners), but a second group can exist for a
-- regional or product-specific arrangement without disturbing the first.
CREATE TABLE partnership_groups (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'ACTIVE'
                CHECK (status IN ('ACTIVE','INACTIVE','DISSOLVED')),
  created_by  TEXT REFERENCES users(id),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE partnership_group_members (
  id            TEXT PRIMARY KEY,
  group_id      TEXT NOT NULL REFERENCES partnership_groups(id) ON DELETE CASCADE,
  partner_id    TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  role_in_group TEXT NOT NULL DEFAULT 'PARTNER'
                  CHECK (role_in_group IN ('PARTNER','MANAGING_PARTNER','SILENT_PARTNER')),
  joined_at     TEXT NOT NULL,
  left_at       TEXT,
  UNIQUE (group_id, partner_id)
);

-- One immutable version of a sharing arrangement.
CREATE TABLE partnership_agreements (
  id                    TEXT PRIMARY KEY,
  group_id              TEXT NOT NULL REFERENCES partnership_groups(id) ON DELETE CASCADE,
  version               INTEGER NOT NULL,
  -- the version this one replaces; walking the chain gives full history
  parent_agreement_id   TEXT REFERENCES partnership_agreements(id),
  title                 TEXT NOT NULL,
  summary               TEXT,

  status                TEXT NOT NULL DEFAULT 'DRAFT'
                          CHECK (status IN ('DRAFT','PROPOSED','UNDER_REVIEW','ACCEPTED',
                                            'ACTIVE','REJECTED','CANCELLED','SUPERSEDED',
                                            'TERMINATED','EXPIRED')),

  -- ---- the shape of the formula (the lines live in the child table) ----
  -- GROSS shares total revenue; NET shares revenue after deductible expenses.
  basis                 TEXT NOT NULL DEFAULT 'NET' CHECK (basis IN ('GROSS','NET')),
  distribution_frequency TEXT NOT NULL DEFAULT 'MONTHLY'
                          CHECK (distribution_frequency IN ('MONTHLY','QUARTERLY','TERMLY','ANNUALLY','MANUAL')),
  -- how sub-kobo remainders are settled so shares always sum to the pool exactly
  rounding_mode         TEXT NOT NULL DEFAULT 'LARGEST_REMAINDER'
                          CHECK (rounding_mode IN ('LARGEST_REMAINDER','TO_FIRST_PARTNER')),

  effective_from        TEXT NOT NULL,
  effective_to          TEXT,

  -- ---- how this version gets accepted ----
  requires_all_partners INTEGER NOT NULL DEFAULT 1,
  -- when requires_all_partners = 0, the share of partners that must accept
  approval_threshold_bps INTEGER CHECK (approval_threshold_bps BETWEEN 1 AND 10000),
  -- role code that must sign off before a payout runs under this agreement
  payout_approver_role  TEXT,

  proposed_by           TEXT REFERENCES users(id),
  proposed_at           TEXT,
  accepted_at           TEXT,
  activated_by          TEXT REFERENCES users(id),
  activated_at          TEXT,
  terminated_by         TEXT REFERENCES users(id),
  terminated_at         TEXT,
  termination_reason    TEXT,

  notes                 TEXT,
  created_by            TEXT REFERENCES users(id),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (group_id, version)
);
CREATE INDEX idx_agreements_group_status ON partnership_agreements (group_id, status);
CREATE INDEX idx_agreements_effective ON partnership_agreements (effective_from, effective_to);

-- The formula lines. Percentages are basis points (4000 = 40.00%) so the
-- arithmetic is exact integer maths -- no floating point anywhere near money.
CREATE TABLE partnership_agreement_partners (
  id                TEXT PRIMARY KEY,
  agreement_id      TEXT NOT NULL REFERENCES partnership_agreements(id) ON DELETE CASCADE,
  partner_id        TEXT NOT NULL REFERENCES partners(id),
  share_type        TEXT NOT NULL CHECK (share_type IN ('PERCENTAGE','FIXED_AMOUNT','RESIDUAL')),
  share_bps         INTEGER CHECK (share_bps BETWEEN 0 AND 10000),
  fixed_amount_kobo INTEGER CHECK (fixed_amount_kobo >= 0),
  -- NULL means every revenue category
  revenue_category  TEXT REFERENCES revenue_categories(code),
  -- FIXED_AMOUNT lines are settled first (low priority number = paid earlier),
  -- then PERCENTAGE lines split what remains, then RESIDUAL sweeps the rest.
  priority          INTEGER NOT NULL DEFAULT 100,
  note              TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (agreement_id, partner_id, revenue_category),
  -- a line must carry the number its own type requires
  CHECK ((share_type = 'PERCENTAGE'   AND share_bps IS NOT NULL) OR
         (share_type = 'FIXED_AMOUNT' AND fixed_amount_kobo IS NOT NULL) OR
         (share_type = 'RESIDUAL'))
);
CREATE INDEX idx_agreement_partners_agreement ON partnership_agreement_partners (agreement_id);

-- Expenses that come off the top before a NET agreement is shared.
CREATE TABLE agreement_expense_rules (
  id               TEXT PRIMARY KEY,
  agreement_id     TEXT NOT NULL REFERENCES partnership_agreements(id) ON DELETE CASCADE,
  expense_category TEXT NOT NULL,
  is_deductible    INTEGER NOT NULL DEFAULT 1,
  cap_kobo         INTEGER CHECK (cap_kobo >= 0),
  note             TEXT,
  created_at       TEXT NOT NULL,
  UNIQUE (agreement_id, expense_category)
);

-- "I agree to this sharing formula." One row per partner per agreement version.
-- formula_snapshot freezes the exact lines the partner saw at decision time, so
-- a later edit to any related record can never rewrite what they consented to.
CREATE TABLE agreement_approvals (
  id               TEXT PRIMARY KEY,
  agreement_id     TEXT NOT NULL REFERENCES partnership_agreements(id) ON DELETE CASCADE,
  partner_id       TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  decision         TEXT NOT NULL DEFAULT 'PENDING'
                     CHECK (decision IN ('PENDING','ACCEPTED','REJECTED','ABSTAINED')),
  decided_by       TEXT REFERENCES users(id),
  decided_at       TEXT,
  statement        TEXT,
  comment          TEXT,
  ip_address       TEXT,
  user_agent       TEXT,
  formula_snapshot TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (agreement_id, partner_id)
);
CREATE INDEX idx_agreement_approvals_agreement ON agreement_approvals (agreement_id);
