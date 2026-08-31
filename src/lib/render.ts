import type { NoteContent, TemplateSection, TemplateStructure } from './templates';

/**
 * Renders a note by walking the same template structure the generator filled.
 *
 * Three outputs, one traversal:
 *   toBlocks()   -- a flat typed payload the Flutter client renders natively
 *   toMarkdown() -- for copy/paste and WhatsApp sharing
 *   toHtml()     -- the read-only student page, and what a browser prints to PDF
 *
 * PDF and Word are deliberately not produced here. A Worker has no rendering
 * engine, and shipping one would mean bundling a headless layout engine into a
 * request path with a CPU budget. Flutter renders the blocks and produces a PDF
 * on-device (the `printing` package); the HTML below prints cleanly for anyone
 * on the web.
 */

export interface RenderedBlock {
  key: string;
  label: string;
  type: TemplateSection['type'];
  preamble?: string;
  fields?: { key: string; label: string; value: string }[];
  text?: string;
  items?: string[];
  ordered?: boolean;
  steps?: { label: string; fields: { key: string; label: string; value: string }[] }[];
  columns?: { key: string; label: string }[];
  rows?: Record<string, string>[];
}

export function toBlocks(structure: TemplateStructure, content: NoteContent): RenderedBlock[] {
  const blocks: RenderedBlock[] = [];

  for (const section of structure.sections) {
    const value = content[section.key];
    if (value === undefined || value === null) continue;

    const base = { key: section.key, label: section.label, type: section.type, preamble: section.preamble };

    switch (section.type) {
      case 'fields': {
        const record = (value as Record<string, string>) ?? {};
        const fields = section.fields
          .map((field) => ({ key: field.key, label: field.label, value: record[field.key] ?? '' }))
          // An empty header field would print as a stray label with a blank rule.
          .filter((field) => field.value !== '');
        if (fields.length > 0) blocks.push({ ...base, fields });
        break;
      }

      case 'text': {
        const text = String(value).trim();
        if (text) blocks.push({ ...base, text });
        break;
      }

      case 'list': {
        const items = (value as string[]).filter(Boolean);
        if (items.length > 0) blocks.push({ ...base, items, ordered: section.ordered ?? false });
        break;
      }

      case 'steps': {
        const steps = (value as Record<string, string>[]).map((row, index) => ({
          label: row.label || `${section.stepLabel} ${index + 1}`,
          fields: section.fields.map((field) => ({
            key: field.key, label: field.label, value: row[field.key] ?? '',
          })),
        }));
        if (steps.length > 0) blocks.push({ ...base, steps });
        break;
      }

      case 'table': {
        const rows = value as Record<string, string>[];
        if (rows.length > 0) blocks.push({ ...base, columns: section.columns, rows });
        break;
      }
    }
  }
  return blocks;
}

// ------------------------------------------------------------- markdown ----

export function toMarkdown(structure: TemplateStructure, content: NoteContent, title: string): string {
  const out: string[] = [`# ${title}`, ''];

  for (const block of toBlocks(structure, content)) {
    if (block.type === 'fields' && block.key === 'header') {
      for (const field of block.fields!) out.push(`**${field.label}:** ${field.value}  `);
      out.push('');
      continue;
    }

    out.push(`## ${block.label.toUpperCase()}`, '');
    if (block.preamble) out.push(block.preamble, '');

    switch (block.type) {
      case 'fields':
        for (const field of block.fields!) out.push(`**${field.label}:** ${field.value}`, '');
        break;

      case 'text':
        out.push(block.text!, '');
        break;

      case 'list':
        block.items!.forEach((item, index) => out.push(block.ordered ? `${index + 1}. ${item}` : `- ${item}`));
        out.push('');
        break;

      case 'steps':
        for (const step of block.steps!) {
          out.push(`### ${step.label}`, '');
          for (const field of step.fields) out.push(`**${field.label}:** ${field.value}`, '');
        }
        break;

      case 'table': {
        const columns = block.columns!;
        out.push(`| ${columns.map((c) => c.label).join(' | ')} |`);
        out.push(`| ${columns.map(() => '---').join(' | ')} |`);
        for (const row of block.rows!) {
          // A literal pipe inside a cell would break the table.
          out.push(`| ${columns.map((c) => (row[c.key] ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`);
        }
        out.push('');
        break;
      }
    }
  }
  return out.join('\n').trim() + '\n';
}

// ----------------------------------------------------------------- html ----

/** Everything interpolated into the page goes through here first. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const paragraphs = (text: string): string =>
  text.split(/\n{2,}/).map((part) => `<p>${escapeHtml(part.trim()).replace(/\n/g, '<br>')}</p>`).join('');

const PAGE_CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #f4f5f7; color: #16202c;
         font: 16px/1.6 "Segoe UI", Roboto, system-ui, sans-serif; }
  .sheet { max-width: 820px; margin: 24px auto; padding: 40px 44px;
           background: #fff; border-radius: 6px; box-shadow: 0 1px 4px rgba(0,0,0,.12); }
  h1 { margin: 0 0 4px; font-size: 22px; text-align: center; letter-spacing: .06em; text-transform: uppercase; }
  .rule { height: 2px; background: #16202c; margin: 0 0 22px; }
  h2 { margin: 26px 0 10px; font-size: 13px; letter-spacing: .09em; text-transform: uppercase;
       color: #fff; background: #1f3864; padding: 5px 10px; display: inline-block; border-radius: 2px; }
  h3 { margin: 16px 0 6px; font-size: 15px; }
  p { margin: 0 0 10px; }
  .head { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 28px; margin-bottom: 6px; }
  .head div { border-bottom: 1px dotted #9aa4b0; padding: 4px 0; font-size: 15px; }
  .head b { font-weight: 600; }
  .preamble { font-style: italic; color: #465261; margin-bottom: 8px; }
  ul, ol { margin: 0 0 10px; padding-left: 22px; }
  li { margin-bottom: 5px; }
  .step { border-left: 3px solid #1f3864; padding: 2px 0 2px 14px; margin-bottom: 14px; }
  .kv { margin-bottom: 8px; }
  .kv b { display: block; font-size: 13px; color: #465261; }
  .tablewrap { overflow-x: auto; margin-bottom: 12px; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { border: 1px solid #b9c0c8; padding: 8px 10px; text-align: left; vertical-align: top; }
  th { background: #eef1f6; font-size: 12px; letter-spacing: .04em; text-transform: uppercase; }
  footer { max-width: 820px; margin: 0 auto 40px; padding: 0 44px;
           font-size: 12px; color: #6b7683; text-align: center; }
  @media print {
    body { background: #fff; }
    .sheet { box-shadow: none; margin: 0; max-width: none; padding: 0; border-radius: 0; }
    h2 { color: #1f3864; background: none; padding: 0; border-bottom: 2px solid #1f3864; }
    footer { display: none; }
  }
  @media (max-width: 640px) {
    .sheet { margin: 0; padding: 24px 18px; border-radius: 0; }
    .head { grid-template-columns: 1fr; }
  }`;

export function toHtml(
  structure: TemplateStructure,
  content: NoteContent,
  options: { title: string; heading: string; footer?: string },
): string {
  const body: string[] = [];

  for (const block of toBlocks(structure, content)) {
    if (block.type === 'fields' && block.key === 'header') {
      body.push(
        `<div class="head">${block.fields!
          .map((f) => `<div><b>${escapeHtml(f.label)}:</b> ${escapeHtml(f.value)}</div>`)
          .join('')}</div>`,
      );
      continue;
    }

    body.push(`<h2>${escapeHtml(block.label)}</h2>`);
    if (block.preamble) body.push(`<p class="preamble">${escapeHtml(block.preamble)}</p>`);

    switch (block.type) {
      case 'fields':
        body.push(block.fields!
          .map((f) => `<div class="kv"><b>${escapeHtml(f.label)}</b>${paragraphs(f.value)}</div>`)
          .join(''));
        break;

      case 'text':
        body.push(paragraphs(block.text!));
        break;

      case 'list': {
        const tag = block.ordered ? 'ol' : 'ul';
        body.push(`<${tag}>${block.items!.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</${tag}>`);
        break;
      }

      case 'steps':
        body.push(block.steps!
          .map((step) => `<div class="step"><h3>${escapeHtml(step.label)}</h3>${step.fields
            .map((f) => `<div class="kv"><b>${escapeHtml(f.label)}</b>${paragraphs(f.value)}</div>`)
            .join('')}</div>`)
          .join(''));
        break;

      case 'table':
        body.push(
          `<div class="tablewrap"><table><thead><tr>${block.columns!
            .map((c) => `<th>${escapeHtml(c.label)}</th>`).join('')}</tr></thead><tbody>${block.rows!
            .map((row) => `<tr>${block.columns!
              .map((c) => `<td>${escapeHtml(row[c.key] ?? '').replace(/\n/g, '<br>')}</td>`)
              .join('')}</tr>`)
            .join('')}</tbody></table></div>`,
        );
        break;
    }
  }

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(options.title)}</title>
<style>${PAGE_CSS}</style>
</head><body>
<main class="sheet">
<h1>${escapeHtml(options.heading)}</h1><div class="rule"></div>
${body.join('\n')}
</main>
${options.footer ? `<footer>${escapeHtml(options.footer)}</footer>` : ''}
</body></html>`;
}
