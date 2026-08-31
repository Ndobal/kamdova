/**
 * Writes a SQL file that inserts one draft student note, for the Module 6
 * smoke test.
 *
 * This exists as a file rather than a `node -e` one-liner because the SQL
 * contains JSON containing quotes, nested inside a shell string -- three
 * levels of quoting that no one should have to read.
 *
 *   node scripts/seed-test-note.mjs <noteId> <lessonId> <templateId> <outFile>
 */
import { writeFileSync } from 'node:fs';

const [noteId, lessonId, templateId, outFile] = process.argv.slice(2);
if (!noteId || !lessonId || !templateId || !outFile) {
  console.error('usage: seed-test-note.mjs <noteId> <lessonId> <templateId> <outFile>');
  process.exit(1);
}

const content = {
  header: { subject: 'Basic Science', class: 'Primary 3', topic: 'Booting' },
  introduction: 'Booting is how a computer wakes up.',
  keyPoints: ['Booting starts a computer', 'There are two types of booting'],
  explanation: 'When you press the power button, the computer loads its programs.',
  vocabulary: [{ term: 'Booting', meaning: 'Starting a computer' }],
  summary: 'Booting starts the computer.',
  practiceQuestions: ['What is booting?', 'Name two types of booting.'],
};

const QUOTE = String.fromCharCode(39);
const q = (value) => QUOTE + String(value).split(QUOTE).join(QUOTE + QUOTE) + QUOTE;

const columns = 'id,lesson_id,template_id,version,title,content,status,origin,created_at,updated_at';
const values = [
  q(noteId), q(lessonId), q(templateId), '1', q('Booting'),
  q(JSON.stringify(content)), q('DRAFT'), q('AI'),
  q('2026-08-31T00:00:00Z'), q('2026-08-31T00:00:00Z'),
].join(',');

writeFileSync(outFile, `INSERT INTO student_notes (${columns}) VALUES (${values});\n`);
