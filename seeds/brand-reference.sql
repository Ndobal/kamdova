-- KamDova: brand, capability map, and the founding partnership.
--
-- KamDova is a joint initiative of Ndovera and Kambi Academy.
-- Create. Teach. Learn. Earn.
--
-- Safe to re-run. Supersedes the earlier NKLearn naming, which is deactivated
-- rather than deleted so nothing that already references those rows breaks.

-- ------------------------------------------------ retire the old naming ----
UPDATE products SET is_active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE code LIKE 'NKLEARN_%';

-- --------------------------------------------------------- the four areas ----
INSERT INTO products (id, code, name, tagline, description, kind, parent_code, icon, module, sort_order, created_at, updated_at) VALUES
  ('area_teacher',     'TEACHER',     'Teacher',     'Plan, create, publish and earn.',
   'Everything a teacher uses to turn their knowledge into learning resources.', 'AREA', NULL, 'school', 'MODULES_4_7', 10,
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('area_student',     'STUDENT',     'Student',     'Read, practise and keep learning.',
   'Where learners reach notes, quizzes and practice beyond the classroom.', 'AREA', NULL, 'backpack', 'MODULES_6_8', 20,
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('area_marketplace', 'MARKETPLACE', 'Marketplace', 'Where educational knowledge is discovered.',
   'Free and paid resources, teacher profiles and discovery.', 'AREA', NULL, 'storefront', 'MODULES_8_9', 30,
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('area_partnership', 'PARTNERSHIP', 'Partnership', 'Ndovera and Kambi Academy.',
   'The partnership behind KamDova, and how revenue is shared.', 'AREA', NULL, 'handshake', 'MODULES_2_12', 40,
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(code) DO UPDATE SET
  name = excluded.name, tagline = excluded.tagline, description = excluded.description,
  kind = excluded.kind, parent_code = excluded.parent_code, icon = excluded.icon,
  is_active = 1, updated_at = excluded.updated_at;

-- ------------------------------------------------------------- TEACHER ----
INSERT INTO products (id, code, name, tagline, kind, parent_code, icon, module, sort_order, created_at, updated_at) VALUES
  ('ft_planner',   'TEACHER_AI_LESSON_PLANNER', 'AI Lesson Planner',  'Turn a topic into a full lesson plan.',   'FEATURE', 'TEACHER', 'auto_awesome',        'MODULE_4', 10, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('ft_templates', 'TEACHER_LESSON_TEMPLATES',  'Lesson Templates',   'Standard and professional formats.',      'FEATURE', 'TEACHER', 'dashboard_customize', 'MODULE_5', 20, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('ft_notes',     'TEACHER_STUDENT_NOTES',     'Student Notes',      'Learner notes alongside every lesson.',   'FEATURE', 'TEACHER', 'description',         'MODULE_6', 30, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('ft_quiz',      'TEACHER_QUIZ_GENERATOR',    'Quiz Generator',     'Questions generated from the lesson.',    'FEATURE', 'TEACHER', 'quiz',                'MODULE_7', 40, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('ft_assign',    'TEACHER_ASSIGNMENTS',       'Assignments',        'Homework learners can complete alone.',   'FEATURE', 'TEACHER', 'assignment',          'MODULE_7', 50, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('ft_resource',  'TEACHER_RESOURCE_CREATION', 'Resource Creation',  'Supporting materials for a topic.',       'FEATURE', 'TEACHER', 'folder_open',         'MODULE_7', 60, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('ft_publish',   'TEACHER_PUBLISH',           'Publish',            'Share by link, or list on the marketplace.','FEATURE','TEACHER', 'publish',             'MODULE_6', 70, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('ft_earn',      'TEACHER_EARN',              'Earn',               'Income from the resources you create.',   'FEATURE', 'TEACHER', 'payments',            'MODULE_10',80, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(code) DO UPDATE SET
  name = excluded.name, tagline = excluded.tagline, kind = excluded.kind,
  parent_code = excluded.parent_code, icon = excluded.icon, is_active = 1, updated_at = excluded.updated_at;

-- ------------------------------------------------------------- STUDENT ----
INSERT INTO products (id, code, name, tagline, kind, parent_code, icon, module, sort_order, created_at, updated_at) VALUES
  ('fs_access',    'STUDENT_ACCESS_TEACHER_CONTENT', 'Access Teacher Content', 'Resources from your own teachers.',   'FEATURE', 'STUDENT', 'menu_book',   'MODULE_8', 10, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fs_notes',     'STUDENT_NOTES',                  'Student Notes',          'Notes written for you to study from.','FEATURE', 'STUDENT', 'description', 'MODULE_6', 20, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fs_quizzes',   'STUDENT_QUIZZES',                'Quizzes',                'Check what you have understood.',     'FEATURE', 'STUDENT', 'quiz',        'MODULE_7', 30, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fs_practice',  'STUDENT_PRACTICE',               'Practice',               'Keep practising at your own pace.',   'FEATURE', 'STUDENT', 'repeat',      'MODULE_7', 40, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fs_discover',  'STUDENT_DISCOVER_TEACHERS',      'Discover Other Teachers','Find resources beyond your class.',   'FEATURE', 'STUDENT', 'travel_explore','MODULE_8',50, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fs_purchase',  'STUDENT_PURCHASE_CONTENT',       'Purchase Content',       'Buy access to a note, quiz or bundle.','FEATURE','STUDENT', 'shopping_cart','MODULE_9',60, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(code) DO UPDATE SET
  name = excluded.name, tagline = excluded.tagline, kind = excluded.kind,
  parent_code = excluded.parent_code, icon = excluded.icon, is_active = 1, updated_at = excluded.updated_at;

-- --------------------------------------------------------- MARKETPLACE ----
INSERT INTO products (id, code, name, tagline, kind, parent_code, icon, module, sort_order, created_at, updated_at) VALUES
  ('fm_free',      'MARKETPLACE_FREE_CONTENT',      'Free Content',       'Resources shared at no cost.',          'FEATURE', 'MARKETPLACE', 'volunteer_activism', 'MODULE_8', 10, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fm_paid',      'MARKETPLACE_PAID_CONTENT',      'Paid Content',       'Resources a teacher sells.',            'FEATURE', 'MARKETPLACE', 'sell',               'MODULE_9', 20, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fm_profiles',  'MARKETPLACE_TEACHER_PROFILES',  'Teacher Profiles',   'Who made it, and what else they made.', 'FEATURE', 'MARKETPLACE', 'badge',              'MODULE_8', 30, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fm_discovery', 'MARKETPLACE_CONTENT_DISCOVERY', 'Content Discovery',  'Search and recommendations.',           'FEATURE', 'MARKETPLACE', 'search',             'MODULE_11',40, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(code) DO UPDATE SET
  name = excluded.name, tagline = excluded.tagline, kind = excluded.kind,
  parent_code = excluded.parent_code, icon = excluded.icon, is_active = 1, updated_at = excluded.updated_at;

-- --------------------------------------------------------- PARTNERSHIP ----
INSERT INTO products (id, code, name, tagline, kind, parent_code, icon, module, sort_order, created_at, updated_at) VALUES
  ('fp_ndovera',   'PARTNERSHIP_NDOVERA',         'Ndovera',         'Technology, software and digital innovation.', 'FEATURE', 'PARTNERSHIP', 'memory',      'MODULE_2', 10, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fp_kambi',     'PARTNERSHIP_KAMBI_ACADEMY',   'Kambi Academy',   'Educational and teacher-focused expertise.',   'FEATURE', 'PARTNERSHIP', 'school',      'MODULE_2', 20, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fp_revenue',   'PARTNERSHIP_REVENUE_SHARING', 'Revenue Sharing', 'How income is divided between partners.',      'FEATURE', 'PARTNERSHIP', 'pie_chart',   'MODULE_2', 30, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fp_pricing',   'PARTNERSHIP_PRICING',         'Pricing',         'Plans, bundles and what they cost.',           'FEATURE', 'PARTNERSHIP', 'sell',        'MODULE_9', 40, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fp_agreements','PARTNERSHIP_AGREEMENTS',      'Agreements',      'Versioned sharing formulas and consent.',      'FEATURE', 'PARTNERSHIP', 'gavel',       'MODULE_2', 50, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(code) DO UPDATE SET
  name = excluded.name, tagline = excluded.tagline, kind = excluded.kind,
  parent_code = excluded.parent_code, icon = excluded.icon, is_active = 1, updated_at = excluded.updated_at;

-- ------------------------------------------------- plans follow the map ----
UPDATE pricing_plans SET product_code = 'TEACHER_AI_LESSON_PLANNER',
                         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE product_code = 'NKLEARN_NOTES' OR product_code IS NULL;

-- ------------------------------------------------------ brand settings ----
UPDATE platform_settings SET value = 'KamDova', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE key = 'platform.name';

INSERT INTO platform_settings (key, value, value_type, category, label, description, is_sensitive, created_at, updated_at) VALUES
  ('platform.tagline', 'Create. Teach. Learn. Earn.', 'string', 'GENERAL', 'Tagline', 'Shown under the product name.', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('platform.strapline', 'Empowering Teachers. Enriching Learning.', 'string', 'GENERAL', 'Strapline', 'The About page headline.', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('platform.partners', '["Ndovera","Kambi Academy"]', 'json', 'GENERAL', 'Founding partners', 'Named in the About page and the footer.', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(key) DO UPDATE SET value = excluded.value, label = excluded.label,
  description = excluded.description, updated_at = excluded.updated_at;

-- -------------------------------------------- the founding partnership ----
-- Seeded as PENDING, and with no agreement attached.
--
-- The revenue split between Ndovera and Kambi Academy is a business decision
-- that belongs to the partners, so it is deliberately NOT invented here: draft
-- an agreement in the partnership module, have both partners accept it, and
-- activate it. Bank details are likewise left blank.
INSERT INTO partners (id, code, legal_name, display_name, partner_type, status, notes, created_at, updated_at) VALUES
  ('ptr_ndovera', 'NDOVERA', 'Ndovera', 'Ndovera', 'COMPANY', 'PENDING',
   'Technology, software development and digital innovation.',
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('ptr_kambi', 'KAMBI', 'Kambi Academy', 'Kambi Academy', 'COMPANY', 'PENDING',
   'Educational expertise, teacher-focused development and academic perspective.',
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(code) DO UPDATE SET
  legal_name = excluded.legal_name, display_name = excluded.display_name,
  notes = excluded.notes, updated_at = excluded.updated_at;

INSERT INTO partnership_groups (id, code, name, description, status, created_at, updated_at) VALUES
  ('grp_kamdova', 'KAMDOVA', 'KamDova Founding Partners',
   'The joint initiative of Ndovera and Kambi Academy.', 'ACTIVE',
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(code) DO UPDATE SET name = excluded.name, description = excluded.description,
  updated_at = excluded.updated_at;

INSERT OR IGNORE INTO partnership_group_members (id, group_id, partner_id, role_in_group, joined_at) VALUES
  ('gm_ndovera', 'grp_kamdova', 'ptr_ndovera', 'MANAGING_PARTNER', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('gm_kambi',   'grp_kamdova', 'ptr_kambi',   'MANAGING_PARTNER', strftime('%Y-%m-%dT%H:%M:%fZ','now'));

UPDATE platform_settings SET value = 'KAMDOVA', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE key = 'partnership.default_group';
