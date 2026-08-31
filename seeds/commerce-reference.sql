-- NKLearn products, pricing plans and billing settings.
--
-- Safe to re-run. Plans are UPDATEd on conflict so a price change here reaches
-- an existing database -- but note that editing a plan only affects NEW
-- purchases: an existing subscriber keeps the quota snapshotted on their
-- subscription row.

-- ------------------------------------------------- the NKLearn products ----
INSERT INTO products (id, code, name, tagline, description, module, sort_order, created_at, updated_at) VALUES
  ('prd_notes',       'NKLEARN_NOTES',       'NKLearn Notes',       'Lesson notes and student notes.',
   'Teacher lesson notes and the student notes generated alongside them, on either template.', 'MODULES_4_6', 10,
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  ('prd_quiz',        'NKLEARN_QUIZ',        'NKLearn Quiz',        'Quizzes generated from any lesson.',
   'Multiple choice, true/false, fill-in-the-blank, matching, short answer and essay questions.', 'MODULE_7', 20,
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  ('prd_ai',          'NKLEARN_AI',          'NKLearn AI',          'The engine behind every generation.',
   'The generation service that writes lesson notes, student notes and quizzes from a topic.', 'MODULES_4_7', 30,
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  ('prd_studio',      'NKLEARN_STUDIO',      'NKLearn Studio',      'Where teachers create and publish.',
   'The teacher workspace: create lessons, choose a template, edit notes, publish and share.', 'MODULES_4_6', 40,
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  ('prd_marketplace', 'NKLEARN_MARKETPLACE', 'NKLearn Marketplace', 'Plans, bundles and teacher content.',
   'Where subscriptions and bundles are bought, and where students discover content from other teachers.', 'MODULES_8_9', 50,
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(code) DO UPDATE SET
  name = excluded.name, tagline = excluded.tagline, description = excluded.description,
  updated_at = excluded.updated_at;

-- --------------------------------------------------------- pricing plans ----
-- Seeded from the prices supplied. Two of them arrived without a stated quota
-- and are marked in `notes` -- confirm those numbers before launch:
--
--   * WEEKLY_PRO (N3,000 weekly) had no quota given. Set to 40/week as a
--     placeholder. NOTE ALSO that N3,000 per week is roughly N12,000 a month,
--     which is six times the N2,000 MONTHLY_18 plan -- as listed, no one would
--     ever buy it. Either the period or the price is likely not intended.
--   * TERMLY_ALL (N8,000 termly) had no quota given. Set to unlimited, since a
--     term-length plan at that price reads as the "everything" tier.
--
-- ONE_OFF plans are bundles: the quota is a total that never resets.
INSERT INTO pricing_plans (id, code, name, description, product_code, audience, price_kobo,
                           currency, billing_period, lesson_quota, is_featured, sort_order, notes,
                           created_at, updated_at) VALUES

  ('plan_starter_5', 'STARTER_5', 'Starter Bundle',
   '5 lesson plans. Use them whenever you like -- they do not expire.',
   'NKLEARN_NOTES', 'TEACHER', 100000, 'NGN', 'ONE_OFF', 5, 0, 10, NULL,
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  ('plan_value_10', 'VALUE_10', 'Value Bundle',
   '10 lesson plans. Better value per plan than the Starter Bundle.',
   'NKLEARN_NOTES', 'TEACHER', 150000, 'NGN', 'ONE_OFF', 10, 0, 20, NULL,
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  ('plan_weekly_10', 'WEEKLY_10', 'Weekly 10',
   '10 lesson plans every week.',
   'NKLEARN_NOTES', 'TEACHER', 100000, 'NGN', 'WEEKLY', 10, 0, 30, NULL,
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  ('plan_monthly_18', 'MONTHLY_18', 'Monthly 18',
   '18 lesson plans every month.',
   'NKLEARN_NOTES', 'TEACHER', 200000, 'NGN', 'MONTHLY', 18, 1, 40, NULL,
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  ('plan_weekly_pro', 'WEEKLY_PRO', 'Weekly Pro',
   'A high-volume weekly plan for teachers covering several classes.',
   'NKLEARN_NOTES', 'TEACHER', 300000, 'NGN', 'WEEKLY', 40, 0, 50,
   'QUOTA ASSUMED: no quota was specified for this plan. Also review the price: N3,000/week is about N12,000/month against N2,000 for MONTHLY_18.',
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  ('plan_termly_all', 'TERMLY_ALL', 'Termly Unlimited',
   'Unlimited lesson plans for a full school term.',
   'NKLEARN_NOTES', 'TEACHER', 800000, 'NGN', 'TERMLY', NULL, 1, 60,
   'QUOTA ASSUMED: no quota was specified, so this is seeded as unlimited for the term.',
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))

ON CONFLICT(code) DO UPDATE SET
  name = excluded.name, description = excluded.description, price_kobo = excluded.price_kobo,
  billing_period = excluded.billing_period, lesson_quota = excluded.lesson_quota,
  product_code = excluded.product_code, notes = excluded.notes, updated_at = excluded.updated_at;

-- ---------------------------------------------------- billing settings ----
-- All editable from the Super Admin dashboard. Marked sensitive, so a Deputy
-- Super Admin's change becomes an approval request rather than a write.
INSERT OR IGNORE INTO platform_settings (key, value, value_type, category, label, description, is_sensitive, created_at, updated_at) VALUES
  ('trial.enabled',            'true', 'boolean', 'BILLING', 'Free trial enabled',       'Whether new teachers can claim a free trial.',                    1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('trial.days',               '3',    'number',  'BILLING', 'Trial length (days)',      'How long a free trial lasts.',                                    1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('trial.lesson_quota',       '5',    'number',  'BILLING', 'Trial lesson plans',       'How many lesson plans the free trial includes in total.',         1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('trial.device_check',       'true', 'boolean', 'BILLING', 'One trial per device',     'Best-effort: refuse a trial if the device already claimed one.',  1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- The weekly cap for paid teachers. Plans carry their own quota; this is the
  -- fallback when a plan does not specify one.
  ('billing.default_weekly_lesson_quota', '10', 'number', 'BILLING', 'Default weekly lesson plans', 'Weekly allowance when a plan does not set its own.', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('billing.term_days',        '91',   'number',  'BILLING', 'Term length (days)',       'How long a school term runs, for termly plans.',                  1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- ------------------------------------------------------------- rebrand ----
UPDATE platform_settings SET value = 'NKLearn', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE key = 'platform.name' AND value = 'TeachEasy';
