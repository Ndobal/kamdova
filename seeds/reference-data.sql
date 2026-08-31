-- TeachEasy reference data: roles, the permission catalog, role defaults,
-- revenue categories and platform settings.
--
-- Safe to re-run: every statement is INSERT OR IGNORE, and role_permissions is
-- rebuilt from the catalog below. Ids are readable literals rather than uuids
-- so this file stays diffable and a permission keeps its id across environments.
--
-- No user is created here. Passwords must be hashed by the Worker (PBKDF2), so
-- the first Super Admin is created once via POST /api/bootstrap/super-admin,
-- which refuses to run as soon as a Super Admin exists.

-- ---------------------------------------------------------------- roles ----
INSERT OR IGNORE INTO roles (id, code, name, description, rank, is_system, created_at, updated_at) VALUES
  ('role_super_admin',        'SUPER_ADMIN',        'Super Admin',        'Unrestricted control of the platform.', 100, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('role_deputy_super_admin', 'DEPUTY_SUPER_ADMIN', 'Deputy Super Admin', 'Delegated administration. Sensitive actions require Super Admin approval.', 80, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('role_partner',            'PARTNER',            'Partner',            'Business partner sharing in platform revenue.', 60, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('role_teacher',            'TEACHER',            'Teacher',            'Creates lesson notes, student notes and quizzes.', 40, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('role_student',            'STUDENT',            'Student',            'Consumes notes, resources and quizzes.', 20, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- ---------------------------------------------------------- permissions ----
-- is_sensitive = 1 means a Deputy Super Admin cannot perform it directly; the
-- attempt becomes an approval_request for a Super Admin to decide.
INSERT OR IGNORE INTO permissions (id, code, name, description, category, is_sensitive, created_at, updated_at) VALUES
  ('perm_users_read',        'users.read',        'View users',            'List and view user accounts.',                    'USERS',      0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('perm_users_create',      'users.create',      'Create users',          'Create user accounts directly.',                  'USERS',      0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('perm_users_update',      'users.update',      'Edit users',            'Edit profile and account details.',               'USERS',      0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('perm_users_suspend',     'users.suspend',     'Suspend users',         'Suspend or reactivate an account.',               'USERS',      0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('perm_users_delete',      'users.delete',      'Delete users',          'Soft-delete a user account.',                     'USERS',      1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  ('perm_roles_read',        'roles.read',        'View roles',            'View roles and their permissions.',               'ROLES',      0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('perm_roles_assign',      'roles.assign',      'Assign roles',          'Grant or revoke a role on a user.',               'ROLES',      0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('perm_roles_manage',      'roles.manage',      'Manage roles',          'Create roles and change role permissions.',       'ROLES',      1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('perm_permissions_grant', 'permissions.grant', 'Grant permissions',     'Grant or deny a permission on an individual.',    'ROLES',      1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  ('perm_teachers_read',     'teachers.read',     'View teachers',         'View teacher accounts and activity.',             'TEACHERS',   0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('perm_teachers_manage',   'teachers.manage',   'Manage teachers',       'Edit and administer teacher accounts.',           'TEACHERS',   0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('perm_teachers_approve',  'teachers.approve',  'Approve teachers',      'Approve or reject teacher applications.',         'TEACHERS',   0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  ('perm_students_read',     'students.read',     'View students',         'View student accounts and activity.',             'STUDENTS',   0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('perm_students_manage',   'students.manage',   'Manage students',       'Edit and administer student accounts.',           'STUDENTS',   0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  ('perm_content_read',      'content.read',      'View content',          'View lesson notes, student notes and quizzes.',   'CONTENT',    0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('perm_content_review',    'content.review',    'Review content',        'Review and approve submitted content.',           'CONTENT',    0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('perm_content_moderate',  'content.moderate',  'Moderate content',      'Unpublish or remove content.',                    'CONTENT',    0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  ('perm_partners_read',     'partners.read',     'View partners',         'View all partner records.',                       'PARTNERS',   0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('perm_partners_create',   'partners.create',   'Create partners',       'Register a new partner.',                         'PARTNERS',   0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('perm_partners_update',   'partners.update',   'Edit partners',         'Edit partner details and bank information.',      'PARTNERS',   0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('perm_partners_suspend',  'partners.suspend',  'Suspend partners',      'Suspend or exit a partner.',                      'PARTNERS',   1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  ('perm_agree_read',        'agreements.read',   'View agreements',       'View partnership agreements and versions.',       'AGREEMENTS', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('perm_agree_create',      'agreements.create', 'Draft agreements',      'Create a draft agreement version.',               'AGREEMENTS', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('perm_agree_propose',     'agreements.propose','Propose agreements',    'Send a draft to partners for review.',            'AGREEMENTS', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('perm_agree_activate',    'agreements.activate','Activate agreements',  'Make an accepted agreement the active formula.',  'AGREEMENTS', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('perm_agree_terminate',   'agreements.terminate','Terminate agreements','Terminate an active agreement.',                  'AGREEMENTS', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  ('perm_revenue_read',      'revenue.read',      'View revenue',          'View platform revenue figures.',                  'FINANCE',    0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('perm_payments_read',     'payments.read',     'View payments',         'View payment transactions.',                      'FINANCE',    0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('perm_pricing_manage',    'pricing.manage',    'Manage pricing',        'Change platform pricing and fee splits.',         'FINANCE',    1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('perm_payouts_approve',   'payouts.approve',   'Approve payouts',       'Approve partner and teacher payouts.',            'FINANCE',    1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  ('perm_reports_read',      'reports.read',      'View reports',          'View operational reports.',                       'REPORTS',    0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('perm_reports_financial', 'reports.financial.read','View financial reports','View financial and revenue reports.',        'REPORTS',    0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  ('perm_settings_read',     'settings.read',     'View settings',         'View platform configuration.',                    'SETTINGS',   0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('perm_settings_manage',   'settings.manage',   'Manage settings',       'Change platform configuration.',                  'SETTINGS',   1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  ('perm_audit_read',        'audit.read',        'View audit logs',       'Read the platform audit trail.',                  'AUDIT',      0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  ('perm_approvals_read',    'approvals.read',    'View approval requests','View pending approval requests.',                 'APPROVALS',  0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('perm_approvals_decide',  'approvals.decide',  'Decide approvals',      'Approve or reject a pending request.',            'APPROVALS',  1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  -- Self-scoped partner permissions. A PARTNER never receives partners.read,
  -- so there is no path by which one partner can enumerate the others.
  ('perm_self_partner',      'partner.self.read',            'View own partner record',   'View own partner profile.',                'PARTNER_SELF', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('perm_self_agree_read',   'partner.self.agreements.read', 'View own agreements',       'View agreements this partner is party to.', 'PARTNER_SELF', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('perm_self_agree_decide', 'partner.self.agreements.decide','Accept or reject formula', 'Record acceptance of a sharing formula.',    'PARTNER_SELF', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('perm_self_revenue',      'partner.self.revenue.read',    'View own share',            'View own revenue share and distributions.', 'PARTNER_SELF', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('perm_self_statements',   'partner.self.statements.read', 'View own statements',       'View own payout statements.',               'PARTNER_SELF', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  -- Modules 4-6. Templates are readable by anyone who writes lessons; changing
  -- one rewrites what the AI produces for every teacher, so that is sensitive.
  ('perm_templates_read',    'templates.read',    'View lesson templates', 'View the lesson note templates.',            'TEMPLATES', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('perm_templates_manage',  'templates.manage',  'Manage lesson templates','Create and edit lesson note templates.',    'TEMPLATES', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  -- Self-scoped teacher permissions. A teacher never receives teachers.read or
  -- content.read, so one teacher can never list or open another's lessons.
  ('perm_self_t_profile_r',  'teacher.self.profile.read',    'View own teacher profile',   'View own teaching profile.',            'TEACHER_SELF', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('perm_self_t_profile_w',  'teacher.self.profile.update',  'Edit own teacher profile',   'Edit own profile, subjects and classes.','TEACHER_SELF', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('perm_self_lessons_r',    'teacher.self.lessons.read',    'View own lessons',           'View own lessons and notes.',           'TEACHER_SELF', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('perm_self_lessons_w',    'teacher.self.lessons.write',   'Create and edit own lessons','Create, edit and delete own lessons.',  'TEACHER_SELF', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('perm_self_lessons_gen',  'teacher.self.lessons.generate','Generate lesson content',    'Use AI to generate notes. Costs money per call.', 'TEACHER_SELF', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('perm_self_lessons_pub',  'teacher.self.lessons.publish', 'Publish and share notes',    'Publish notes and create share links.', 'TEACHER_SELF', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  -- NKLearn Marketplace. Buying and claiming a trial are self-scoped; the
  -- marketplace catalog itself is readable by any signed-in user.
  ('perm_self_billing_r',    'billing.self.read',    'View own plan',    'View own subscription, allowance and orders.', 'TEACHER_SELF', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('perm_self_billing_buy',  'billing.self.purchase','Buy a plan',       'Claim a trial and place orders for plans.',    'TEACHER_SELF', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- ------------------------------------------------------ role defaults ----
-- Rebuilt on every seed run so the catalog above stays the single source of
-- truth. Per-user grants in user_permissions are untouched.
DELETE FROM role_permissions WHERE role_id IN
  ('role_super_admin','role_deputy_super_admin','role_partner','role_teacher','role_student');

-- Super Admin: everything. The middleware also short-circuits for this role,
-- but the rows are written so the admin UI can render the grid truthfully.
INSERT INTO role_permissions (role_id, permission_id, created_at)
  SELECT 'role_super_admin', id, strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM permissions WHERE category NOT IN ('PARTNER_SELF','TEACHER_SELF');

-- Deputy Super Admin: a read-heavy baseline only. Real duties ("manage
-- teachers", "review content", "view financial reports") are handed to an
-- individual deputy through user_permissions, which is what the spec describes.
INSERT INTO role_permissions (role_id, permission_id, created_at)
  SELECT 'role_deputy_super_admin', id, strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM permissions WHERE code IN (
    'users.read','teachers.read','students.read','content.read',
    'partners.read','agreements.read','reports.read','audit.read','approvals.read',
    'templates.read'
  );

INSERT INTO role_permissions (role_id, permission_id, created_at)
  SELECT 'role_partner', id, strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM permissions WHERE category = 'PARTNER_SELF';

-- Teachers get the self-scoped family plus template reading. Nothing here
-- reaches another teacher's work.
INSERT INTO role_permissions (role_id, permission_id, created_at)
  SELECT 'role_teacher', id, strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM permissions WHERE category = 'TEACHER_SELF' OR code = 'templates.read';

-- STUDENT still carries no permissions: learners reach published notes through
-- share links today, and Modules 8-9 add entitlement-based access.

-- ------------------------------------------------- revenue categories ----
INSERT OR IGNORE INTO revenue_categories (id, code, name, description, sort_order, created_at, updated_at) VALUES
  ('rev_teacher_sub',   'TEACHER_SUBSCRIPTION', 'Teacher subscriptions', 'Recurring teacher plan fees.',             10, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('rev_student_buy',   'STUDENT_PURCHASE',     'Student purchases',     'One-off note, quiz and bundle purchases.', 20, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('rev_student_prem',  'STUDENT_PREMIUM',      'Premium student access','Recurring student access plans.',          30, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('rev_advertising',   'ADVERTISING',          'Advertising',           'Sponsored and recommended content.',       40, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('rev_other',         'OTHER',                'Other income',          'Any other platform income.',               90, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- --------------------------------------------------- platform settings ----
INSERT OR IGNORE INTO platform_settings (key, value, value_type, category, label, description, is_sensitive, created_at, updated_at) VALUES
  ('platform.name',                 'TeachEasy',    'string',  'GENERAL', 'Platform name',              'Displayed across the product.',                      0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('platform.currency',             'NGN',          'string',  'GENERAL', 'Currency',                   'ISO code. Amounts are stored in the minor unit.',    1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('platform.support_email',        '',             'string',  'GENERAL', 'Support email',              'Shown to users needing help.',                       0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('auth.require_email_verification','true',        'boolean', 'AUTH',    'Require email verification', 'Block login until the address is verified.',         0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('auth.allow_self_registration',  'true',         'boolean', 'AUTH',    'Allow self registration',    'Let teachers and students register themselves.',     0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('auth.self_registration_roles',  '["TEACHER","STUDENT"]','json','AUTH','Self-registration roles',    'Roles a visitor may choose when registering.',       1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('partnership.default_group',     'TEACHEASY',    'string',  'PARTNERSHIP','Default partnership group','Group used when none is specified.',                0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('partnership.require_super_admin_activation','true','boolean','PARTNERSHIP','Super Admin activates agreements','Only a Super Admin may make a formula active.', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- Module 10 reads this; defined now so the split is configuration from day one.
  ('revenue.teacher_share_bps',     '8000',         'number',  'FINANCE', 'Teacher share (bps)',        'Teacher share of a content sale. 8000 = 80%.',       1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('revenue.platform_fee_bps',      '2000',         'number',  'FINANCE', 'Platform fee (bps)',         'Platform share of a content sale. 2000 = 20%.',      1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
