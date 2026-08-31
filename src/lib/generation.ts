import type { EnvBindings } from '../types';
import { createGenerator, generatorUnavailableReason } from './ai';
import { GenerationError } from './ai/provider';
import { newId } from './crypto';
import { conflict, unprocessable } from './http';
import { nowIso } from './time';
import {
  applyInputSections, buildOutputSchema, loadTemplate, loadTemplateByCode,
  validateContent, type TemplateStructure,
} from './templates';

/**
 * Module 4's generation pipeline, and the Module 6 student-note pipeline that
 * runs on the same rails.
 *
 * The sequence is deliberately: lock -> build schema from template -> call the
 * model -> validate the result -> overwrite the input sections -> persist a new
 * version -> record cost. Nothing the model returns is written before it has
 * been checked against the template it was supposed to fill.
 */

export interface LessonRow {
  id: string;
  teacher_id: string;
  template_id: string;
  subject_name: string;
  class_name: string;
  school_name: string | null;
  theme: string | null;
  topic: string;
  subtopic: string | null;
  week: number | null;
  term: string | null;
  lesson_date: string | null;
  duration_minutes: number | null;
  class_size: number | null;
  average_age: number | null;
  sex_mix: string | null;
  curriculum: string | null;
  objectives: string | null;
  extra_instructions: string | null;
  status: string;
}

const TERM_LABELS: Record<string, string> = {
  FIRST: 'First Term', SECOND: 'Second Term', THIRD: 'Third Term',
};

const SEX_LABELS: Record<string, string> = {
  MIXED: 'Mixed', MALE: 'Male', FEMALE: 'Female',
};

/** The values that fill every `input`-sourced field across all templates. */
export function lessonInputs(lesson: LessonRow, teacherName: string) {
  return {
    schoolName: lesson.school_name ?? '',
    teacherName,
    subjectName: lesson.subject_name,
    className: lesson.class_name,
    theme: lesson.theme ?? '',
    topic: lesson.topic,
    subtopic: lesson.subtopic ?? '',
    week: lesson.week === null ? '' : `Week ${lesson.week}`,
    term: lesson.term ? (TERM_LABELS[lesson.term] ?? lesson.term) : '',
    lessonDate: lesson.lesson_date ?? '',
    durationMinutes: lesson.duration_minutes === null ? '' : `${lesson.duration_minutes} minutes`,
    classSize: lesson.class_size === null ? '' : String(lesson.class_size),
    averageAge: lesson.average_age === null ? '' : String(lesson.average_age),
    sexMix: lesson.sex_mix ? (SEX_LABELS[lesson.sex_mix] ?? lesson.sex_mix) : '',
  };
}

const TEACHER_SYSTEM = `You write lesson notes for Nigerian schoolteachers.

Write for a real classroom in Nigeria: large classes, limited equipment, and
pupils who learn best from familiar local examples. Prefer materials a teacher
can actually obtain -- cardboard, chalkboard, real objects from the market or
the home -- over specialised laboratory equipment.

Rules you must follow:
- Fill every field of the given structure. Never leave a field empty.
- Match the reading level and attention span of the stated class and age.
- Keep to the stated lesson duration. If the structure has timed steps, the
  times must add up to that duration.
- Learning objectives must be specific and measurable, and the evaluation
  questions must actually test those objectives.
- Use British spelling and Nigerian curriculum terminology.
- Write plain prose. No markdown, asterisks, or bullet characters inside a
  field -- the application handles all formatting.`;

const STUDENT_SYSTEM = `You write study notes for Nigerian pupils, from a teacher's lesson.

You are writing for the pupil, not the teacher. Address them directly and
simply. Never mention the teacher's method, timings, or the lesson plan itself.

Rules you must follow:
- Match the reading level of the stated class. For primary pupils use short
  sentences and everyday words.
- Explain, do not summarise: a pupil who missed the lesson should be able to
  learn the topic from these notes alone.
- Use familiar Nigerian examples.
- Fill every field. Write plain prose with no markdown or bullet characters.`;

function lessonBriefing(lesson: LessonRow, inputs: ReturnType<typeof lessonInputs>): string {
  const lines = [
    `Subject: ${inputs.subjectName}`,
    `Class: ${inputs.className}`,
    `Topic: ${inputs.topic}`,
  ];
  if (inputs.subtopic) lines.push(`Sub-topic: ${inputs.subtopic}`);
  if (inputs.theme) lines.push(`Theme: ${inputs.theme}`);
  if (inputs.term) lines.push(`Term: ${inputs.term}`);
  if (inputs.week) lines.push(inputs.week);
  if (inputs.durationMinutes) lines.push(`Duration: ${inputs.durationMinutes}`);
  if (inputs.classSize) lines.push(`Number in class: ${inputs.classSize}`);
  if (inputs.averageAge) lines.push(`Average age: ${inputs.averageAge}`);
  if (inputs.sexMix) lines.push(`Sex: ${inputs.sexMix}`);
  if (lesson.curriculum) lines.push(`Curriculum: ${lesson.curriculum}`);

  if (lesson.objectives) {
    const objectives = safeParseList(lesson.objectives);
    if (objectives.length > 0) {
      lines.push(
        '',
        'The teacher has already set these learning objectives. Use them exactly as given:',
        ...objectives.map((objective, index) => `${index + 1}. ${objective}`),
      );
    }
  }

  if (lesson.extra_instructions) {
    // Teacher-authored text. It steers content only -- it cannot change the
    // output shape, because the schema is fixed by the template and enforced
    // by strict tool use, and the result is validated again afterwards.
    lines.push('', 'Additional instructions from the teacher:', lesson.extra_instructions);
  }

  return lines.join('\n');
}

function safeParseList(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

interface GenerateOptions {
  db: D1Database;
  env: EnvBindings;
  lesson: LessonRow;
  teacherName: string;
  requestedBy: string;
}

/**
 * Checked before the lesson is claimed.
 *
 * A missing API key is a property of the deployment, not of the teacher's
 * lesson -- marking their work FAILED because the server was misconfigured
 * would be wrong, and would leave them staring at an error they cannot fix.
 */
function assertGeneratorConfigured(env: EnvBindings) {
  if (!createGenerator(env)) throw unprocessable(generatorUnavailableReason(env));
}

async function runGeneration(
  opts: GenerateOptions,
  kind: 'TEACHER_NOTE' | 'STUDENT_NOTE',
  templateId: string,
  structure: TemplateStructure,
  system: string,
  prompt: string,
) {
  const generator = createGenerator(opts.env)!;
  const generationId = newId();
  await opts.db
    .prepare(
      `INSERT INTO ai_generations (id, lesson_id, kind, provider, model, template_id,
                                   status, requested_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
    )
    .bind(generationId, opts.lesson.id, kind, generator.provider, generator.model,
          templateId, opts.requestedBy, nowIso())
    .run();

  try {
    const result = await generator.generate({
      system,
      prompt,
      schema: buildOutputSchema(structure),
      schemaName: kind === 'TEACHER_NOTE' ? 'lesson_note' : 'student_note',
      schemaDescription:
        kind === 'TEACHER_NOTE'
          ? 'The completed lesson note, with every section of the template filled in.'
          : 'The completed student notes, with every section filled in.',
    });

    // The model filled a schema derived from the template, but the content is
    // still checked against the template before anything is stored.
    const content = validateContent(structure, result.content, { requireGenerated: true });

    await opts.db
      .prepare(
        `UPDATE ai_generations
            SET status = 'SUCCEEDED', input_tokens = ?, output_tokens = ?, cache_read_tokens = ?,
                cost_kobo = ?, duration_ms = ?, model = ?, completed_at = ?
          WHERE id = ?`,
      )
      .bind(result.usage.inputTokens, result.usage.outputTokens, result.usage.cacheReadTokens,
            result.usage.costKobo, result.durationMs, result.model, nowIso(), generationId)
      .run();

    return { generationId, content, usage: result.usage };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A schema mismatch is REJECTED, a provider failure is FAILED -- they call
    // for different fixes, so they are not collapsed into one status.
    const status = error instanceof GenerationError ? 'FAILED' : 'REJECTED';
    await opts.db
      .prepare(`UPDATE ai_generations SET status = ?, error = ?, completed_at = ? WHERE id = ?`)
      .bind(status, message.slice(0, 500), nowIso(), generationId)
      .run();
    throw error;
  }
}

/**
 * Claims the lesson for generation.
 *
 * The UPDATE is conditional on the current status, so two concurrent requests
 * cannot both start a run -- the second one's UPDATE matches no rows. Without
 * this, a double-tap on the Generate button bills twice and races to write two
 * versions.
 */
async function claimLesson(db: D1Database, lessonId: string) {
  const result = await db
    .prepare(
      `UPDATE lessons SET status = 'GENERATING', last_error = NULL, updated_at = ?
        WHERE id = ? AND status IN ('DRAFT','READY','FAILED')`,
    )
    .bind(nowIso(), lessonId)
    .run();

  if (result.meta.changes === 0) {
    throw conflict('This lesson is already being generated. Please wait for it to finish.');
  }
}

async function releaseLesson(db: D1Database, lessonId: string, status: 'READY' | 'FAILED', error?: string) {
  await db
    .prepare(`UPDATE lessons SET status = ?, last_error = ?, updated_at = ? WHERE id = ?`)
    .bind(status, error?.slice(0, 500) ?? null, nowIso(), lessonId)
    .run();
}

async function nextVersion(db: D1Database, table: 'lesson_notes' | 'student_notes', lessonId: string) {
  const row = await db
    .prepare(`SELECT COALESCE(MAX(version), 0) AS version FROM ${table} WHERE lesson_id = ?`)
    .bind(lessonId)
    .first<{ version: number }>();
  return (row?.version ?? 0) + 1;
}

/** Module 4: generate the teacher's lesson note. */
export async function generateLessonNote(opts: GenerateOptions) {
  assertGeneratorConfigured(opts.env);

  const { row: templateRow, structure } = await loadTemplate(opts.db, opts.lesson.template_id);
  if (templateRow.audience !== 'TEACHER') {
    throw unprocessable('That template is not a teacher lesson-note template.');
  }

  await claimLesson(opts.db, opts.lesson.id);

  try {
    const inputs = lessonInputs(opts.lesson, opts.teacherName);
    const { generationId, content, usage } = await runGeneration(
      opts, 'TEACHER_NOTE', templateRow.id, structure, TEACHER_SYSTEM,
      `Write a complete lesson note for this lesson.\n\n${lessonBriefing(opts.lesson, inputs)}`,
    );

    const version = await nextVersion(opts.db, 'lesson_notes', opts.lesson.id);
    const noteId = newId();

    await opts.db.batch([
      // Older drafts are superseded, never deleted -- the teacher can still
      // read what a previous generation produced.
      opts.db.prepare(
        `UPDATE lesson_notes SET status = 'SUPERSEDED', updated_at = ?
          WHERE lesson_id = ? AND status = 'DRAFT'`,
      ).bind(nowIso(), opts.lesson.id),
      opts.db.prepare(
        `INSERT INTO lesson_notes (id, lesson_id, template_id, version, content, status, origin,
                                   generation_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'DRAFT', 'AI', ?, ?, ?)`,
      ).bind(
        noteId, opts.lesson.id, templateRow.id, version,
        JSON.stringify(applyInputSections(structure, content, inputs)),
        generationId, nowIso(), nowIso(),
      ),
    ]);

    await releaseLesson(opts.db, opts.lesson.id, 'READY');
    return { noteId, version, generationId, usage };
  } catch (error) {
    await releaseLesson(opts.db, opts.lesson.id, 'FAILED',
      error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/**
 * Module 6: generate the student notes.
 *
 * Written from the teacher's published or draft note when one exists, so the
 * two stay consistent -- the pupil should be reading about the same lesson the
 * teacher is delivering.
 */
export async function generateStudentNote(opts: GenerateOptions) {
  assertGeneratorConfigured(opts.env);

  const { row: templateRow, structure } = await loadTemplateByCode(opts.db, 'STUDENT_STANDARD');

  await claimLesson(opts.db, opts.lesson.id);

  try {
    const inputs = lessonInputs(opts.lesson, opts.teacherName);

    const teacherNote = await opts.db
      .prepare(
        `SELECT content FROM lesson_notes
          WHERE lesson_id = ? AND status IN ('PUBLISHED','DRAFT')
          ORDER BY CASE status WHEN 'PUBLISHED' THEN 0 ELSE 1 END, version DESC LIMIT 1`,
      )
      .bind(opts.lesson.id)
      .first<{ content: string }>();

    const prompt = [
      'Write study notes for the pupils of this lesson.',
      '',
      lessonBriefing(opts.lesson, inputs),
      ...(teacherNote
        ? ['', "The teacher's lesson note for this lesson is below. Cover the same",
           'content, but rewritten for the pupil to read and study from:', '',
           JSON.stringify(JSON.parse(teacherNote.content), null, 2)]
        : []),
    ].join('\n');

    const { generationId, content, usage } = await runGeneration(
      opts, 'STUDENT_NOTE', templateRow.id, structure, STUDENT_SYSTEM, prompt,
    );

    const version = await nextVersion(opts.db, 'student_notes', opts.lesson.id);
    const noteId = newId();

    await opts.db.batch([
      opts.db.prepare(
        `UPDATE student_notes SET status = 'SUPERSEDED', updated_at = ?
          WHERE lesson_id = ? AND status = 'DRAFT'`,
      ).bind(nowIso(), opts.lesson.id),
      opts.db.prepare(
        `INSERT INTO student_notes (id, lesson_id, template_id, version, title, content, status,
                                    origin, generation_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', 'AI', ?, ?, ?)`,
      ).bind(
        noteId, opts.lesson.id, templateRow.id, version,
        `${opts.lesson.topic} - ${opts.lesson.class_name}`,
        JSON.stringify(applyInputSections(structure, content, inputs)),
        generationId, nowIso(), nowIso(),
      ),
    ]);

    await releaseLesson(opts.db, opts.lesson.id, 'READY');
    return { noteId, version, generationId, usage };
  } catch (error) {
    await releaseLesson(opts.db, opts.lesson.id, 'FAILED',
      error instanceof Error ? error.message : String(error));
    throw error;
  }
}
