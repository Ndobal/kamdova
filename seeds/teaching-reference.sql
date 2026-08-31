-- TeachEasy Modules 4-6 reference data: subjects, class levels, and the
-- lesson templates themselves.
--
-- Safe to re-run. Templates are UPDATEd on conflict so an edit to a structure
-- here reaches an existing database without a migration.

-- ------------------------------------------------------------- subjects ----
INSERT OR IGNORE INTO subjects (id, code, name, stage, sort_order, created_at, updated_at) VALUES
  ('sub_english',    'ENGLISH',       'English Language',              NULL,               10, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('sub_maths',      'MATHEMATICS',   'Mathematics',                   NULL,               20, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('sub_bst',        'BASIC_SCIENCE', 'Basic Science and Technology',  'PRIMARY',          30, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('sub_bs',         'BASIC_STUDIES', 'Basic Science',                 'JUNIOR_SECONDARY', 40, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('sub_physics',    'PHYSICS',       'Physics',                       'SENIOR_SECONDARY', 50, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('sub_chemistry',  'CHEMISTRY',     'Chemistry',                     'SENIOR_SECONDARY', 60, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('sub_biology',    'BIOLOGY',       'Biology',                       'SENIOR_SECONDARY', 70, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('sub_civic',      'CIVIC',         'Civic Education',               NULL,               80, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('sub_social',     'SOCIAL_STUDIES','Social Studies',                NULL,               90, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('sub_economics',  'ECONOMICS',     'Economics',                     'SENIOR_SECONDARY',100, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('sub_commerce',   'COMMERCE',      'Commerce',                      'SENIOR_SECONDARY',110, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('sub_agric',      'AGRIC',         'Agricultural Science',          NULL,              120, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('sub_computer',   'COMPUTER',      'Computer Studies / ICT',        NULL,              130, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('sub_crs',        'CRS',           'Christian Religious Studies',   NULL,              140, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('sub_irs',        'IRS',           'Islamic Religious Studies',     NULL,              150, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- --------------------------------------------------------- class levels ----
INSERT OR IGNORE INTO class_levels (id, code, name, stage, typical_age, sort_order, created_at, updated_at) VALUES
  ('cls_pry1', 'PRY1', 'Primary 1', 'PRIMARY',           6, 10, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('cls_pry2', 'PRY2', 'Primary 2', 'PRIMARY',           7, 20, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('cls_pry3', 'PRY3', 'Primary 3', 'PRIMARY',           8, 30, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('cls_pry4', 'PRY4', 'Primary 4', 'PRIMARY',           9, 40, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('cls_pry5', 'PRY5', 'Primary 5', 'PRIMARY',          10, 50, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('cls_pry6', 'PRY6', 'Primary 6', 'PRIMARY',          11, 60, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('cls_jss1', 'JSS1', 'JSS 1',     'JUNIOR_SECONDARY', 12, 70, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('cls_jss2', 'JSS2', 'JSS 2',     'JUNIOR_SECONDARY', 13, 80, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('cls_jss3', 'JSS3', 'JSS 3',     'JUNIOR_SECONDARY', 14, 90, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('cls_ss1',  'SS1',  'SS 1',      'SENIOR_SECONDARY', 15,100, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('cls_ss2',  'SS2',  'SS 2',      'SENIOR_SECONDARY', 16,110, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('cls_ss3',  'SS3',  'SS 3',      'SENIOR_SECONDARY', 17,120, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- ------------------------------------------------------------ TEMPLATE 1 ----
-- Standard Lesson Note. Structure transcribed from the supplied template:
-- header block, LEARNING OBJECTIVES, INSTRUCTIONAL MATERIALS, PREVIOUS
-- KNOWLEDGE, INTRODUCTION, PRESENTATION (STEP 1/2/3 with Teacher's and
-- Students' Activities), EVALUATION, CONCLUSION, ASSIGNMENT.
INSERT INTO lesson_templates (id, code, name, description, audience, structure, version, is_system, sort_order, created_at, updated_at)
VALUES (
  'tpl_standard',
  'STANDARD',
  'Template 1 - Standard Lesson Note',
  'The simple, practical lesson note most teachers use day to day.',
  'TEACHER',
  json('{
    "sections": [
      { "key": "header", "label": "Lesson Note", "type": "fields", "source": "input",
        "fields": [
          { "key": "school",   "label": "School",    "from": "schoolName",       "source": "input" },
          { "key": "teacher",  "label": "Teacher",   "from": "teacherName",      "source": "input" },
          { "key": "subject",  "label": "Subject",   "from": "subjectName",      "source": "input" },
          { "key": "class",    "label": "Class",     "from": "className",        "source": "input" },
          { "key": "term",     "label": "Term",      "from": "term",             "source": "input" },
          { "key": "week",     "label": "Week",      "from": "week",             "source": "input" },
          { "key": "date",     "label": "Date",      "from": "lessonDate",       "source": "input" },
          { "key": "topic",    "label": "Topic",     "from": "topic",            "source": "input" },
          { "key": "subtopic", "label": "Sub-topic", "from": "subtopic",         "source": "input" },
          { "key": "duration", "label": "Duration",  "from": "durationMinutes",  "source": "input" }
        ] },

      { "key": "learningObjectives", "label": "Learning Objectives", "type": "list",
        "source": "generated", "ordered": true, "minItems": 3, "maxItems": 5,
        "preamble": "By the end of the lesson, pupils should be able to:",
        "hint": "Each objective starts with a measurable verb (state, identify, explain, demonstrate) and is achievable within the lesson duration." },

      { "key": "instructionalMaterials", "label": "Instructional Materials", "type": "list",
        "source": "generated", "minItems": 3, "maxItems": 8,
        "hint": "Concrete, low-cost teaching aids realistically available in a Nigerian classroom." },

      { "key": "previousKnowledge", "label": "Previous Knowledge", "type": "text",
        "source": "generated",
        "hint": "One or two sentences stating what the pupils already know that this lesson builds on." },

      { "key": "introduction", "label": "Introduction", "type": "text",
        "source": "generated",
        "hint": "How the teacher opens the lesson and connects it to the pupils everyday experience." },

      { "key": "presentation", "label": "Presentation", "type": "steps",
        "source": "generated", "stepLabel": "STEP", "minSteps": 3, "maxSteps": 4,
        "fields": [
          { "key": "teacherActivities",  "label": "Teacher''s Activities",  "hint": "What the teacher does and says in this step." },
          { "key": "studentActivities",  "label": "Students'' Activities",  "hint": "What the pupils do in response in this step." }
        ] },

      { "key": "evaluation", "label": "Evaluation", "type": "list",
        "source": "generated", "ordered": true, "minItems": 3, "maxItems": 5,
        "hint": "Oral questions that test whether each learning objective was met." },

      { "key": "conclusion", "label": "Conclusion", "type": "text",
        "source": "generated",
        "hint": "How the teacher summarises and closes the lesson." },

      { "key": "assignment", "label": "Assignment", "type": "text",
        "source": "generated",
        "hint": "Homework the pupils can complete without the teacher present." }
    ]
  }'),
  1, 1, 10, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
)
ON CONFLICT(code) DO UPDATE SET
  structure = excluded.structure, name = excluded.name, description = excluded.description,
  version = lesson_templates.version + 1, updated_at = excluded.updated_at;

-- ------------------------------------------------------------ TEMPLATE 2 ----
-- Professional Detailed Lesson Plan. Structure transcribed from the supplied
-- template: an expanded header (theme, class profile, materials), a rationale
-- and prerequisite block, then LESSON DEVELOPMENT as a four-column grid
-- (Step/Time, Teacher's Activities, Pupils' Activities, Learning Point),
-- followed by Assessment, Homework and board NOTES.
INSERT INTO lesson_templates (id, code, name, description, audience, structure, version, is_system, sort_order, created_at, updated_at)
VALUES (
  'tpl_professional',
  'PROFESSIONAL',
  'Template 2 - Professional Detailed Lesson Plan',
  'The full lesson plan, with a class profile, rationale and a tabular lesson development grid.',
  'TEACHER',
  json('{
    "sections": [
      { "key": "header", "label": "Lesson Plan", "type": "fields", "source": "input",
        "fields": [
          { "key": "subject",    "label": "Subject",      "from": "subjectName",     "source": "input" },
          { "key": "theme",      "label": "Theme",        "from": "theme",           "source": "input" },
          { "key": "topic",      "label": "Topic",        "from": "topic",           "source": "input" },
          { "key": "class",      "label": "Class",        "from": "className",       "source": "input" },
          { "key": "date",       "label": "Date",         "from": "lessonDate",      "source": "input" },
          { "key": "duration",   "label": "Duration",     "from": "durationMinutes", "source": "input" },
          { "key": "classSize",  "label": "No. in Class", "from": "classSize",       "source": "input" },
          { "key": "averageAge", "label": "Average Age",  "from": "averageAge",      "source": "input" },
          { "key": "sex",        "label": "Sex",          "from": "sexMix",          "source": "input" }
        ] },

      { "key": "materials", "label": "Materials", "type": "fields", "source": "generated",
        "fields": [
          { "key": "learningMaterials",  "label": "Learning Materials",  "hint": "Comma-separated teaching aids: charts, models, flashcards, real or toy objects, craft materials." },
          { "key": "referenceMaterials", "label": "Reference Materials", "hint": "Named textbook or scheme of work reference appropriate to the class." }
        ] },

      { "key": "context", "label": "Lesson Context", "type": "fields", "source": "generated",
        "fields": [
          { "key": "rationale",              "label": "Rationale",              "hint": "Why this topic matters for these pupils at this stage." },
          { "key": "prerequisiteKnowledge",  "label": "Prerequisite Knowledge",  "hint": "What the pupils are assumed to already know before this lesson." }
        ] },

      { "key": "learningObjectives", "label": "Learning Objectives", "type": "list",
        "source": "generated", "ordered": true, "minItems": 3, "maxItems": 5,
        "preamble": "At the end of the lesson, pupils should be able to:",
        "hint": "Measurable and achievable within the stated duration." },

      { "key": "lessonDevelopment", "label": "Lesson Development", "type": "table",
        "source": "generated", "minRows": 5, "maxRows": 6,
        "suggestedRows": ["Introduction (5 min)", "Presentation: Step 1 (10 min)", "Step 2 (10 min)", "Evaluation (5 min)", "Conclusion (5 min)"],
        "hint": "The step timings must add up to the lesson duration.",
        "columns": [
          { "key": "step",              "label": "Step/Time" },
          { "key": "teacherActivities", "label": "Teacher''s Activities" },
          { "key": "pupilActivities",   "label": "Pupils'' Activities" },
          { "key": "learningPoint",     "label": "Learning Point" }
        ] },

      { "key": "assessment", "label": "Assessment", "type": "text", "source": "generated",
        "hint": "How the teacher checks understanding, e.g. thumbs-up/down activity, verbal questioning." },

      { "key": "homework", "label": "Homework", "type": "text", "source": "generated",
        "hint": "A short task the pupil can do at home." },

      { "key": "boardNotes", "label": "Notes", "type": "text", "source": "generated",
        "hint": "The board summary the teacher writes for learners to copy. Short, complete sentences a pupil of this age can copy and understand." }
    ]
  }'),
  1, 1, 20, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
)
ON CONFLICT(code) DO UPDATE SET
  structure = excluded.structure, name = excluded.name, description = excluded.description,
  version = lesson_templates.version + 1, updated_at = excluded.updated_at;

-- -------------------------------------------------- STUDENT NOTE TEMPLATE ----
-- Module 6: the learner-facing note is its own content object with its own
-- shape, not a re-render of the teacher's plan.
INSERT INTO lesson_templates (id, code, name, description, audience, structure, version, is_system, sort_order, created_at, updated_at)
VALUES (
  'tpl_student_standard',
  'STUDENT_STANDARD',
  'Student Notes - Standard',
  'The note the learner reads, downloads or receives by link.',
  'STUDENT',
  json('{
    "sections": [
      { "key": "header", "label": "Student Notes", "type": "fields", "source": "input",
        "fields": [
          { "key": "subject", "label": "Subject", "from": "subjectName", "source": "input" },
          { "key": "class",   "label": "Class",   "from": "className",   "source": "input" },
          { "key": "topic",   "label": "Topic",   "from": "topic",       "source": "input" },
          { "key": "teacher", "label": "Teacher", "from": "teacherName", "source": "input" },
          { "key": "date",    "label": "Date",    "from": "lessonDate",  "source": "input" }
        ] },

      { "key": "introduction", "label": "Introduction", "type": "text", "source": "generated",
        "hint": "Speak directly to the pupil in short, plain sentences at their reading level." },

      { "key": "keyPoints", "label": "Key Points", "type": "list", "source": "generated",
        "minItems": 4, "maxItems": 8,
        "hint": "The facts the pupil must remember, one per line." },

      { "key": "explanation", "label": "Explanation", "type": "text", "source": "generated",
        "hint": "The topic explained for the pupil, with a familiar Nigerian everyday example." },

      { "key": "vocabulary", "label": "New Words", "type": "table", "source": "generated",
        "minRows": 3, "maxRows": 8,
        "columns": [
          { "key": "term",    "label": "Word" },
          { "key": "meaning", "label": "Meaning" }
        ] },

      { "key": "summary", "label": "Summary", "type": "text", "source": "generated",
        "hint": "Two or three sentences the pupil can revise from." },

      { "key": "practiceQuestions", "label": "Practice Questions", "type": "list",
        "source": "generated", "ordered": true, "minItems": 4, "maxItems": 8,
        "hint": "Questions the pupil can answer alone from these notes." },

      { "key": "assignment", "label": "Assignment", "type": "text", "source": "generated",
        "optional": true, "hint": "Homework, written for the pupil." }
    ]
  }'),
  1, 1, 30, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
)
ON CONFLICT(code) DO UPDATE SET
  structure = excluded.structure, name = excluded.name, description = excluded.description,
  version = lesson_templates.version + 1, updated_at = excluded.updated_at;
