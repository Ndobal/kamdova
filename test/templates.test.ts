import { describe, expect, it } from 'vitest';
import {
  applyInputSections, buildOutputSchema, validateContent,
  type TemplateStructure,
} from '../src/lib/templates';
import { toBlocks, toHtml, toMarkdown } from '../src/lib/render';

/** Template 1, transcribed exactly as the seed encodes it. */
const TEMPLATE_1: TemplateStructure = {
  sections: [
    { key: 'header', label: 'Lesson Note', type: 'fields', source: 'input', fields: [
      { key: 'school', label: 'School', from: 'schoolName', source: 'input' },
      { key: 'subject', label: 'Subject', from: 'subjectName', source: 'input' },
      { key: 'topic', label: 'Topic', from: 'topic', source: 'input' },
    ] },
    { key: 'learningObjectives', label: 'Learning Objectives', type: 'list', source: 'generated',
      ordered: true, minItems: 3, maxItems: 5,
      preamble: 'By the end of the lesson, pupils should be able to:' },
    { key: 'previousKnowledge', label: 'Previous Knowledge', type: 'text', source: 'generated' },
    { key: 'presentation', label: 'Presentation', type: 'steps', source: 'generated',
      stepLabel: 'STEP', minSteps: 3, fields: [
        { key: 'teacherActivities', label: "Teacher's Activities" },
        { key: 'studentActivities', label: "Students' Activities" },
      ] },
  ],
};

/** Template 2's distinguishing feature: the tabular lesson development grid. */
const TEMPLATE_2: TemplateStructure = {
  sections: [
    { key: 'header', label: 'Lesson Plan', type: 'fields', source: 'input', fields: [
      { key: 'subject', label: 'Subject', from: 'subjectName', source: 'input' },
      { key: 'classSize', label: 'No. in Class', from: 'classSize', source: 'input' },
    ] },
    { key: 'lessonDevelopment', label: 'Lesson Development', type: 'table', source: 'generated',
      minRows: 5, maxRows: 6,
      suggestedRows: ['Introduction (5 min)', 'Conclusion (5 min)'],
      columns: [
        { key: 'step', label: 'Step/Time' },
        { key: 'teacherActivities', label: "Teacher's Activities" },
        { key: 'pupilActivities', label: "Pupils' Activities" },
        { key: 'learningPoint', label: 'Learning Point' },
      ] },
  ],
};

describe('buildOutputSchema', () => {
  it('asks the model only for generated sections', () => {
    const schema = buildOutputSchema(TEMPLATE_1) as any;
    // The header is the teacher's own input; round-tripping it through the
    // model would let it silently rewrite the class or the topic.
    expect(Object.keys(schema.properties)).toEqual(
      ['learningObjectives', 'previousKnowledge', 'presentation'],
    );
    expect(schema.required).toHaveLength(3);
  });

  it('is strict-tool-use ready at every level', () => {
    const schema = buildOutputSchema(TEMPLATE_1) as any;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.presentation.items.additionalProperties).toBe(false);
    // required must list every property for strict mode to accept the schema
    expect(schema.properties.presentation.items.required.sort())
      .toEqual(['label', 'studentActivities', 'teacherActivities']);
  });

  it('carries list and step bounds through to the schema', () => {
    const schema = buildOutputSchema(TEMPLATE_1) as any;
    expect(schema.properties.learningObjectives.minItems).toBe(3);
    expect(schema.properties.learningObjectives.maxItems).toBe(5);
    expect(schema.properties.presentation.minItems).toBe(3);
  });

  it('turns a table section into a row schema keyed by column', () => {
    const schema = buildOutputSchema(TEMPLATE_2) as any;
    const table = schema.properties.lessonDevelopment;
    expect(table.type).toBe('array');
    expect(table.items.required.sort())
      .toEqual(['learningPoint', 'pupilActivities', 'step', 'teacherActivities']);
    expect(table.minItems).toBe(5);
    expect(table.description).toContain('Introduction (5 min)');
  });

  it('refuses a template with nothing to generate', () => {
    expect(() => buildOutputSchema({ sections: [TEMPLATE_1.sections[0]!] })).toThrow();
  });
});

describe('validateContent', () => {
  const good = {
    learningObjectives: ['State what booting means', 'Identify two types', 'Explain why it matters'],
    previousKnowledge: 'Pupils can switch on a television.',
    presentation: [
      { label: 'STEP 1', teacherActivities: 'Defines booting.', studentActivities: 'Listen and answer.' },
    ],
  };

  it('accepts well-formed content', () => {
    const clean = validateContent(TEMPLATE_1, good);
    expect(clean.learningObjectives).toHaveLength(3);
    expect((clean.presentation as any[])[0].label).toBe('STEP 1');
  });

  it('drops keys the template does not declare', () => {
    const clean = validateContent(TEMPLATE_1, {
      ...good,
      presentation: [{ ...(good.presentation[0]!), injected: 'ignore me' }],
      somethingElse: 'not in the template',
    });
    expect(clean).not.toHaveProperty('somethingElse');
    expect((clean.presentation as any[])[0]).not.toHaveProperty('injected');
  });

  it('rejects a section of the wrong type', () => {
    expect(() => validateContent(TEMPLATE_1, { ...good, learningObjectives: 'not a list' })).toThrow();
    expect(() => validateContent(TEMPLATE_1, { ...good, previousKnowledge: ['not text'] })).toThrow();
  });

  it('only demands every generated section when asked to', () => {
    const partial = { previousKnowledge: 'Something.' };
    expect(() => validateContent(TEMPLATE_1, partial)).not.toThrow();
    expect(() => validateContent(TEMPLATE_1, partial, { requireGenerated: true })).toThrow();
  });

  it('rejects a non-object body', () => {
    expect(() => validateContent(TEMPLATE_1, 'a string')).toThrow();
    expect(() => validateContent(TEMPLATE_1, ['a', 'list'])).toThrow();
  });
});

describe('applyInputSections', () => {
  it('overwrites header fields from the lesson, not from the model', () => {
    // The model tried to set its own school and topic; the teacher's values win.
    const content = validateContent(TEMPLATE_1, {
      header: { school: 'Wrong School', topic: 'Wrong Topic' },
      previousKnowledge: 'x',
    });
    const merged = applyInputSections(TEMPLATE_1, content, {
      schoolName: 'Government Primary School, Ikeja',
      subjectName: 'Basic Science and Technology',
      topic: 'Introduction to Booting',
    });
    const header = merged.header as Record<string, string>;
    expect(header.school).toBe('Government Primary School, Ikeja');
    expect(header.topic).toBe('Introduction to Booting');
  });

  it('renders a missing input as empty rather than "undefined"', () => {
    const merged = applyInputSections(TEMPLATE_1, {}, { subjectName: 'Mathematics' });
    expect((merged.header as Record<string, string>).school).toBe('');
  });
});

describe('render', () => {
  const content = applyInputSections(
    TEMPLATE_1,
    validateContent(TEMPLATE_1, {
      learningObjectives: ['State what booting means', 'Identify two types'],
      previousKnowledge: 'Pupils can switch on a television.',
      presentation: [{ label: 'STEP 1', teacherActivities: 'Defines booting.', studentActivities: 'Listen.' }],
    }),
    { schoolName: 'GPS Ikeja', subjectName: 'Basic Science', topic: 'Booting' },
  );

  it('emits one block per populated section, in template order', () => {
    const blocks = toBlocks(TEMPLATE_1, content);
    expect(blocks.map((b) => b.key))
      .toEqual(['header', 'learningObjectives', 'previousKnowledge', 'presentation']);
  });

  it('carries the objectives preamble through', () => {
    const blocks = toBlocks(TEMPLATE_1, content);
    expect(blocks.find((b) => b.key === 'learningObjectives')!.preamble)
      .toBe('By the end of the lesson, pupils should be able to:');
  });

  it('escapes HTML rather than emitting it', () => {
    const hostile = applyInputSections(
      TEMPLATE_1,
      validateContent(TEMPLATE_1, { previousKnowledge: '<script>alert(1)</script>' }),
      { schoolName: '<img src=x onerror=alert(1)>', subjectName: 'S', topic: 'T' },
    );
    const html = toHtml(TEMPLATE_1, hostile, { title: 'T', heading: 'Lesson Note' });
    // What matters is that no injected content survives as a live tag. The
    // characters `onerror=` appearing inside escaped text are inert, so the
    // assertion is on the angle brackets, not on the attribute name.
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('escapes pipes so a table cell cannot break the markdown table', () => {
    const table = applyInputSections(
      TEMPLATE_2,
      validateContent(TEMPLATE_2, {
        lessonDevelopment: [
          { step: 'Introduction', teacherActivities: 'Asks | a question', pupilActivities: 'Answer', learningPoint: 'Recall' },
        ],
      }),
      { subjectName: 'Basic Science', classSize: 8 },
    );
    const markdown = toMarkdown(TEMPLATE_2, table, 'Lesson');
    const rows = markdown.split('\n').filter((line) => line.startsWith('|'));
    // header, separator, one data row -- the escaped pipe must not add a column
    expect(rows).toHaveLength(3);
    expect(rows[2]!.split(/(?<!\\)\|/).filter(Boolean)).toHaveLength(4);
  });

  it('renders the Template 2 grid as a real table', () => {
    const table = applyInputSections(
      TEMPLATE_2,
      validateContent(TEMPLATE_2, {
        lessonDevelopment: [
          { step: 'Introduction (5 min)', teacherActivities: 'Asks pupils.', pupilActivities: 'Answer.', learningPoint: 'Review.' },
        ],
      }),
      { subjectName: 'Basic Science', classSize: 8 },
    );
    const html = toHtml(TEMPLATE_2, table, { title: 'T', heading: 'Lesson Plan' });
    expect(html).toContain('<th>Step/Time</th>');
    expect(html).toContain('<td>Introduction (5 min)</td>');
    expect(html).toContain('No. in Class');
  });

  it('omits sections the note does not carry', () => {
    const sparse = validateContent(TEMPLATE_1, { previousKnowledge: 'Only this.' });
    const blocks = toBlocks(TEMPLATE_1, sparse);
    expect(blocks.map((b) => b.key)).toEqual(['previousKnowledge']);
  });
});
