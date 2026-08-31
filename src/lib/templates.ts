import { badRequest, notFound, unprocessable } from './http';

/**
 * Module 5 -- the lesson template engine.
 *
 * A template is an ordered list of sections held as JSON in the database, not
 * as code. Three things read that same list:
 *
 *   1. the generator, which derives a JSON Schema from it and makes the model
 *      fill exactly those fields (buildOutputSchema)
 *   2. the validator, which rejects anything the model returns that does not
 *      match the shape (validateContent)
 *   3. the renderer, which walks it to produce HTML, Markdown or a Flutter
 *      payload (render.ts)
 *
 * So adding Template 3 -- or a new section inside Template 1 -- is a row
 * change, not a deploy.
 */

export type SectionSource = 'input' | 'generated';

export interface FieldSpec {
  key: string;
  label: string;
  /** Where the value comes from when the section is `input`-sourced. */
  from?: string;
  source?: SectionSource;
  hint?: string;
}

export interface ColumnSpec {
  key: string;
  label: string;
}

interface BaseSection {
  key: string;
  label: string;
  source: SectionSource;
  hint?: string;
  /** Fixed text printed above the section body, e.g. the objectives preamble. */
  preamble?: string;
  optional?: boolean;
}

export interface FieldsSection extends BaseSection {
  type: 'fields';
  fields: FieldSpec[];
}

export interface TextSection extends BaseSection {
  type: 'text';
  minWords?: number;
  maxWords?: number;
}

export interface ListSection extends BaseSection {
  type: 'list';
  ordered?: boolean;
  minItems?: number;
  maxItems?: number;
}

/** Template 1's PRESENTATION: repeated STEP blocks, each with sub-fields. */
export interface StepsSection extends BaseSection {
  type: 'steps';
  stepLabel: string;
  minSteps?: number;
  maxSteps?: number;
  fields: FieldSpec[];
}

/** Template 2's LESSON DEVELOPMENT: a grid with fixed columns. */
export interface TableSection extends BaseSection {
  type: 'table';
  columns: ColumnSpec[];
  minRows?: number;
  maxRows?: number;
  /** Suggested row labels, e.g. Introduction / Step 1 / Evaluation. */
  suggestedRows?: string[];
}

export type TemplateSection =
  | FieldsSection | TextSection | ListSection | StepsSection | TableSection;

export interface TemplateStructure {
  sections: TemplateSection[];
}

export interface LessonTemplateRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  audience: 'TEACHER' | 'STUDENT';
  structure: string;
  version: number;
  is_system: number;
  is_active: number;
  sort_order: number;
}

export function parseStructure(row: Pick<LessonTemplateRow, 'structure' | 'code'>): TemplateStructure {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.structure);
  } catch {
    throw unprocessable(`Template ${row.code} has an unreadable structure.`);
  }
  const sections = (parsed as TemplateStructure)?.sections;
  if (!Array.isArray(sections) || sections.length === 0) {
    throw unprocessable(`Template ${row.code} has no sections.`);
  }
  return { sections };
}

export async function loadTemplate(db: D1Database, templateId: string) {
  const row = await db
    .prepare(`SELECT * FROM lesson_templates WHERE id = ? AND is_active = 1`)
    .bind(templateId)
    .first<LessonTemplateRow>();
  if (!row) throw notFound('Template');
  return { row, structure: parseStructure(row) };
}

export async function loadTemplateByCode(db: D1Database, code: string) {
  const row = await db
    .prepare(`SELECT * FROM lesson_templates WHERE code = ? AND is_active = 1`)
    .bind(code)
    .first<LessonTemplateRow>();
  if (!row) throw notFound(`Template ${code}`);
  return { row, structure: parseStructure(row) };
}

// ------------------------------------------------------- schema building ----

type JsonSchema = Record<string, unknown>;

/**
 * Derives the JSON Schema the model must fill, from the template's own
 * sections. Only `generated` sections appear -- the teacher's own inputs are
 * never round-tripped through the model, so it cannot quietly rewrite the
 * class, the date or the topic the teacher typed.
 *
 * Every object sets `additionalProperties: false` and lists every key in
 * `required`, which is what strict tool use needs to guarantee the shape.
 */
export function buildOutputSchema(structure: TemplateStructure): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const section of structure.sections) {
    if (section.source !== 'generated') continue;
    required.push(section.key);
    properties[section.key] = sectionSchema(section);
  }

  if (required.length === 0) {
    throw unprocessable('This template has no generated sections.');
  }

  return { type: 'object', properties, required, additionalProperties: false };
}

function sectionSchema(section: TemplateSection): JsonSchema {
  switch (section.type) {
    case 'text':
      // minLength tells the model the field is not optional. A nudge, not a
      // guarantee -- smaller models still return "" -- so completeness is
      // enforced again at publish.
      return { type: 'string', minLength: 1, description: describe(section) };

    case 'list':
      return {
        type: 'array',
        description: describe(section),
        items: { type: 'string' },
        minItems: section.minItems ?? 1,
        maxItems: section.maxItems ?? 12,
      };

    case 'fields': {
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const field of section.fields) {
        if (field.source === 'input') continue;
        properties[field.key] = { type: 'string', minLength: 1, description: field.hint ?? field.label };
        required.push(field.key);
      }
      return { type: 'object', description: describe(section), properties, required, additionalProperties: false };
    }

    case 'steps': {
      const properties: Record<string, JsonSchema> = { label: { type: 'string', description: `e.g. "${section.stepLabel} 1"` } };
      const required: string[] = ['label'];
      for (const field of section.fields) {
        properties[field.key] = { type: 'string', minLength: 1, description: field.hint ?? field.label };
        required.push(field.key);
      }
      return {
        type: 'array',
        description: describe(section),
        items: { type: 'object', properties, required, additionalProperties: false },
        minItems: section.minSteps ?? 3,
        maxItems: section.maxSteps ?? 6,
      };
    }

    case 'table': {
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const column of section.columns) {
        properties[column.key] = { type: 'string', description: column.label };
        required.push(column.key);
      }
      return {
        type: 'array',
        description: describe(section),
        items: { type: 'object', properties, required, additionalProperties: false },
        minItems: section.minRows ?? 3,
        maxItems: section.maxRows ?? 10,
      };
    }
  }
}

function describe(section: TemplateSection): string {
  const parts = [section.label];
  if (section.hint) parts.push(section.hint);
  if (section.preamble) parts.push(`Begins with: "${section.preamble}"`);
  if (section.type === 'table' && section.suggestedRows?.length) {
    parts.push(`Rows should cover: ${section.suggestedRows.join(', ')}.`);
  }
  return parts.join(' -- ');
}

// ----------------------------------------------------------- validation ----

export type NoteContent = Record<string, unknown>;

/**
 * Validates note content against the template.
 *
 * Runs on model output AND on teacher edits. A schema constrains the model but
 * does not bind it -- observed in practice: a model returning every declared
 * key with an empty string. And a teacher PATCHing content is plain untrusted
 * input. Zero trust applies to the model output exactly as to a request body.
 *
 * Two separate questions, deliberately asked at different moments:
 *
 *   requireGenerated  is every generated section PRESENT and well-shaped?
 *                     Checked when storing a generation, because a note
 *                     missing a whole section cannot be rendered at all.
 *
 *   requireNonEmpty   is every generated section actually FILLED IN?
 *                     Checked at publish, NOT at generation. A note with two
 *                     blank fields is still 90% useful, and discarding it
 *                     would burn a 20-second wait and one lesson plan from the
 *                     allowance. Far better to hand it over, let the teacher
 *                     type the two fields, and stop it reaching pupils until
 *                     they have.
 *
 * Returns the cleaned content with unknown keys dropped.
 */
export function validateContent(
  structure: TemplateStructure,
  content: unknown,
  opts: { requireGenerated?: boolean; requireNonEmpty?: boolean } = {},
): NoteContent {
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw badRequest('Note content must be an object.');
  }
  const input = content as Record<string, unknown>;
  const clean: NoteContent = {};
  const problems: string[] = [];
  const blanks: string[] = [];

  for (const section of structure.sections) {
    const value = input[section.key];
    const missing = value === undefined || value === null;

    if (missing) {
      if (section.source === 'generated' && opts.requireGenerated && !section.optional) {
        problems.push(`Missing section "${section.key}".`);
      }
      continue;
    }

    const mustBeFilled = opts.requireNonEmpty && section.source === 'generated' && !section.optional;

    switch (section.type) {
      case 'text': {
        if (typeof value !== 'string') {
          problems.push(`"${section.key}" must be text.`);
          break;
        }
        const text = value.trim();
        if (mustBeFilled && text === '') blanks.push(section.label);
        clean[section.key] = text;
        break;
      }

      case 'list': {
        if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
          problems.push(`"${section.key}" must be a list of text items.`);
          break;
        }
        const items = (value as string[]).map((item) => item.trim()).filter(Boolean);
        if (mustBeFilled && items.length === 0) blanks.push(section.label);
        clean[section.key] = items;
        break;
      }

      case 'fields': {
        if (typeof value !== 'object' || Array.isArray(value)) {
          problems.push(`"${section.key}" must be an object.`);
          break;
        }
        const allowed = new Set(section.fields.map((field) => field.key));
        const out: Record<string, string> = {};
        for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
          if (!allowed.has(key)) continue; // drop keys the template does not declare
          out[key] = typeof raw === 'string' ? raw.trim() : String(raw ?? '');
        }
        if (mustBeFilled) {
          // Reported per FIELD, not per section: "Lesson Context is blank" is
          // far less actionable than "Rationale is blank".
          for (const field of section.fields) {
            if (field.source === 'input') continue;
            if (!out[field.key]) blanks.push(field.label);
          }
        }
        clean[section.key] = out;
        break;
      }

      case 'steps':
      case 'table': {
        if (!Array.isArray(value)) {
          problems.push(`"${section.key}" must be a list of rows.`);
          break;
        }
        const allowed = new Set(
          section.type === 'steps'
            ? ['label', ...section.fields.map((field) => field.key)]
            : section.columns.map((column) => column.key),
        );
        const rows: Record<string, string>[] = [];
        for (const raw of value) {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            problems.push(`"${section.key}" contains a row that is not an object.`);
            break;
          }
          const row: Record<string, string> = {};
          for (const [key, cell] of Object.entries(raw as Record<string, unknown>)) {
            if (!allowed.has(key)) continue;
            row[key] = typeof cell === 'string' ? cell.trim() : String(cell ?? '');
          }
          rows.push(row);
        }
        if (mustBeFilled && rows.length === 0) blanks.push(section.label);
        clean[section.key] = rows;
        break;
      }
    }
  }

  if (problems.length > 0) {
    throw unprocessable('The note content does not match its template.', { problems });
  }
  if (blanks.length > 0) {
    throw unprocessable(
      `Fill in ${blanks.length === 1 ? 'this section' : 'these sections'} before publishing: ${blanks.join(', ')}.`,
      { blanks },
    );
  }
  return clean;
}

/**
 * Fills the `input`-sourced sections from the lesson record, so the header
 * block on the rendered note always reflects what the teacher actually
 * entered rather than anything the model produced.
 */
export function applyInputSections(
  structure: TemplateStructure,
  content: NoteContent,
  inputs: Record<string, string | number | null | undefined>,
): NoteContent {
  const merged: NoteContent = { ...content };

  for (const section of structure.sections) {
    if (section.type !== 'fields') continue;

    const existing = (merged[section.key] as Record<string, string> | undefined) ?? {};
    const out: Record<string, string> = { ...existing };

    for (const field of section.fields) {
      if (field.source === 'generated') continue;
      const value = inputs[field.from ?? field.key];
      out[field.key] = value === null || value === undefined ? '' : String(value);
    }
    merged[section.key] = out;
  }
  return merged;
}
