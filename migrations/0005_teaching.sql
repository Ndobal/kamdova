-- TeachEasy Modules 4-6 -- Teacher Management, Lesson Template Engine, Student Notes
--
-- Same conventions as Modules 1-3: TEXT uuid ids, ISO-8601 UTC timestamps,
-- INTEGER 0/1 booleans, CHECK constraints on enum columns.

-- ------------------------------------------------------------ reference ----
CREATE TABLE subjects (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  stage      TEXT,                        -- NULL = applies to every stage
  is_active  INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Nigerian school ladder: Primary 1-6, JSS 1-3, SSS 1-3.
CREATE TABLE class_levels (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  stage      TEXT NOT NULL CHECK (stage IN ('EARLY_YEARS','PRIMARY','JUNIOR_SECONDARY','SENIOR_SECONDARY')),
  typical_age INTEGER,
  is_active  INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ----------------------------------------- Module 5: the template engine ----
-- A template is DATA, like a partnership formula. `structure` is an ordered
-- JSON array of sections; the generator derives its output schema from that
-- array and the renderer walks the same array. Adding a template -- or a new
-- section inside one -- needs no code change and no migration.
--
-- Section shape:
--   { key, label, type, source, ... }
--   type   : fields | text | list | steps | table
--   source : input     (the teacher supplies it)
--          | generated (the AI writes it)
CREATE TABLE lesson_templates (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT,
  audience    TEXT NOT NULL DEFAULT 'TEACHER' CHECK (audience IN ('TEACHER','STUDENT')),
  structure   TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  is_system   INTEGER NOT NULL DEFAULT 0,
  is_active   INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT REFERENCES users(id),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_lesson_templates_audience ON lesson_templates (audience, is_active);

-- ------------------------------------------------- Module 4: teachers ----
-- Extends users 1:1, exactly as profiles does. Module 1 left this to Module 4
-- rather than guessing the shape early.
CREATE TABLE teachers (
  user_id             TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  school_name         TEXT,
  school_address      TEXT,
  qualifications      TEXT,
  years_experience    INTEGER CHECK (years_experience >= 0),
  headline            TEXT,
  -- The teacher's chosen default; every new lesson starts from it.
  default_template_id TEXT REFERENCES lesson_templates(id),
  status              TEXT NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING','APPROVED','REJECTED','SUSPENDED')),
  approved_by         TEXT REFERENCES users(id),
  approved_at         TEXT,
  rejection_reason    TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX idx_teachers_status ON teachers (status);

CREATE TABLE teacher_subjects (
  teacher_id TEXT NOT NULL REFERENCES teachers(user_id) ON DELETE CASCADE,
  subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (teacher_id, subject_id)
);

CREATE TABLE teacher_classes (
  teacher_id     TEXT NOT NULL REFERENCES teachers(user_id) ON DELETE CASCADE,
  class_level_id TEXT NOT NULL REFERENCES class_levels(id) ON DELETE CASCADE,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (teacher_id, class_level_id)
);

-- ------------------------------------------------- Module 4: lessons ----
-- The teacher's INPUT. Generated prose lives in lesson_notes / student_notes,
-- so regenerating a note never disturbs what the teacher actually typed.
CREATE TABLE lessons (
  id                TEXT PRIMARY KEY,
  teacher_id        TEXT NOT NULL REFERENCES teachers(user_id) ON DELETE CASCADE,
  template_id       TEXT NOT NULL REFERENCES lesson_templates(id),

  subject_id        TEXT REFERENCES subjects(id),
  class_level_id    TEXT REFERENCES class_levels(id),
  -- Free-text fallbacks so a teacher is never blocked by a missing reference row.
  subject_name      TEXT NOT NULL,
  class_name        TEXT NOT NULL,

  school_name       TEXT,
  theme             TEXT,
  topic             TEXT NOT NULL,
  subtopic          TEXT,
  week              INTEGER CHECK (week BETWEEN 1 AND 20),
  term              TEXT CHECK (term IN ('FIRST','SECOND','THIRD')),
  lesson_date       TEXT,
  duration_minutes  INTEGER CHECK (duration_minutes BETWEEN 5 AND 240),
  class_size        INTEGER CHECK (class_size >= 0),
  average_age       INTEGER CHECK (average_age BETWEEN 2 AND 60),
  sex_mix           TEXT CHECK (sex_mix IN ('MIXED','MALE','FEMALE')),

  curriculum        TEXT,
  -- Teacher-supplied objectives. When empty the generator writes them.
  objectives        TEXT,
  extra_instructions TEXT,

  status            TEXT NOT NULL DEFAULT 'DRAFT'
                      CHECK (status IN ('DRAFT','GENERATING','READY','FAILED','ARCHIVED')),
  last_error        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT
);
CREATE INDEX idx_lessons_teacher ON lessons (teacher_id, created_at);
CREATE INDEX idx_lessons_status ON lessons (status);

-- The teacher-facing lesson note. Versioned: regenerating supersedes rather
-- than overwrites, so a teacher never loses an edit to a regeneration.
CREATE TABLE lesson_notes (
  id            TEXT PRIMARY KEY,
  lesson_id     TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  template_id   TEXT NOT NULL REFERENCES lesson_templates(id),
  version       INTEGER NOT NULL,
  content       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'DRAFT'
                  CHECK (status IN ('DRAFT','PUBLISHED','SUPERSEDED','ARCHIVED')),
  origin        TEXT NOT NULL DEFAULT 'AI' CHECK (origin IN ('AI','MANUAL','AI_EDITED')),
  generation_id TEXT,
  edited_by     TEXT REFERENCES users(id),
  edited_at     TEXT,
  published_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (lesson_id, version)
);
CREATE INDEX idx_lesson_notes_lesson ON lesson_notes (lesson_id, version);

-- --------------------------------------------- Module 6: student notes ----
-- A separate content object, not a re-render of the teacher's note: it is
-- written for the learner, edited independently, and published on its own.
CREATE TABLE student_notes (
  id            TEXT PRIMARY KEY,
  lesson_id     TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  template_id   TEXT NOT NULL REFERENCES lesson_templates(id),
  version       INTEGER NOT NULL,
  title         TEXT,
  content       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'DRAFT'
                  CHECK (status IN ('DRAFT','PUBLISHED','SUPERSEDED','ARCHIVED')),
  origin        TEXT NOT NULL DEFAULT 'AI' CHECK (origin IN ('AI','MANUAL','AI_EDITED')),
  generation_id TEXT,
  edited_by     TEXT REFERENCES users(id),
  edited_at     TEXT,
  published_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (lesson_id, version)
);
CREATE INDEX idx_student_notes_lesson ON student_notes (lesson_id, version);

-- Read-only public links to a published student note.
--
-- The slug is high-entropy so it cannot be guessed or enumerated, and the row
-- is revocable and optionally expiring -- a link handed out over WhatsApp can
-- be withdrawn later without unpublishing the note itself.
CREATE TABLE note_shares (
  id              TEXT PRIMARY KEY,
  student_note_id TEXT NOT NULL REFERENCES student_notes(id) ON DELETE CASCADE,
  slug            TEXT NOT NULL UNIQUE,
  created_by      TEXT NOT NULL REFERENCES users(id),
  label           TEXT,
  expires_at      TEXT,
  revoked_at      TEXT,
  revoked_by      TEXT REFERENCES users(id),
  view_count      INTEGER NOT NULL DEFAULT 0,
  last_viewed_at  TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_note_shares_note ON note_shares (student_note_id);

-- Every model call, with its token counts and cost.
--
-- Module 12 lists "AI/API costs" as an expense deducted before partners share
-- revenue, so the cost has to be captured per call at the moment it happens --
-- there is no way to reconstruct it later from a provider invoice per lesson.
CREATE TABLE ai_generations (
  id                TEXT PRIMARY KEY,
  lesson_id         TEXT REFERENCES lessons(id) ON DELETE SET NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('TEACHER_NOTE','STUDENT_NOTE')),
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL,
  template_id       TEXT REFERENCES lesson_templates(id),
  status            TEXT NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','SUCCEEDED','FAILED','REJECTED')),
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  cache_read_tokens INTEGER,
  cost_kobo         INTEGER,
  duration_ms       INTEGER,
  error             TEXT,
  requested_by      TEXT REFERENCES users(id),
  created_at        TEXT NOT NULL,
  completed_at      TEXT
);
CREATE INDEX idx_ai_generations_lesson ON ai_generations (lesson_id, created_at);
CREATE INDEX idx_ai_generations_created ON ai_generations (created_at);
