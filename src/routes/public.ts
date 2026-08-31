import { Hono } from 'hono';
import type { App } from '../types';
import { routeParam } from '../lib/http';
import { escapeHtml, toBlocks, toHtml } from '../lib/render';
import { parseStructure, type LessonTemplateRow } from '../lib/templates';
import { isPast, nowIso } from '../lib/time';

export const publicRoutes = new Hono<App>();

/**
 * The read-only student page.
 *
 * This is the only unauthenticated content route in TeachEasy, so the checks
 * are explicit and all four must pass: the slug must exist, the link must not
 * be revoked, it must not have expired, and the note behind it must still be
 * PUBLISHED. Unpublishing a note therefore kills every link to it immediately.
 *
 * Every failure returns the same page and the same 404. Distinguishing
 * "revoked" from "never existed" would confirm to a stranger that a particular
 * slug was once real.
 */

const GONE_PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Link unavailable</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#f4f5f7;
         color:#16202c; font:16px/1.6 "Segoe UI", Roboto, system-ui, sans-serif; }
  .box { max-width:420px; padding:36px 32px; background:#fff; border-radius:8px; text-align:center;
         box-shadow:0 1px 4px rgba(0,0,0,.12); }
  h1 { margin:0 0 10px; font-size:19px; }
  p { margin:0; color:#465261; }
</style>
</head><body>
<div class="box">
  <h1>This link is no longer available</h1>
  <p>The teacher may have unpublished these notes or withdrawn the link. Ask them for a new one.</p>
</div>
</body></html>`;

interface ShareRow {
  share_id: string;
  expires_at: string | null;
  revoked_at: string | null;
  note_id: string;
  content: string;
  title: string | null;
  status: string;
  template_id: string;
  structure: string;
  template_code: string;
  topic: string;
  subject_name: string;
  class_name: string;
  teacher_name: string | null;
}

async function resolveShare(db: D1Database, slug: string): Promise<ShareRow | null> {
  const row = await db
    .prepare(
      `SELECT sh.id AS share_id, sh.expires_at, sh.revoked_at,
              n.id AS note_id, n.content, n.title, n.status, n.template_id,
              t.structure, t.code AS template_code,
              l.topic, l.subject_name, l.class_name,
              COALESCE(p.display_name, u.email) AS teacher_name
         FROM note_shares sh
         JOIN student_notes n ON n.id = sh.student_note_id
         JOIN lesson_templates t ON t.id = n.template_id
         JOIN lessons l ON l.id = n.lesson_id
         JOIN users u ON u.id = l.teacher_id
         LEFT JOIN profiles p ON p.user_id = l.teacher_id
        WHERE sh.slug = ?`,
    )
    .bind(slug)
    .first<ShareRow>();

  if (!row) return null;
  if (row.revoked_at) return null;
  if (isPast(row.expires_at)) return null;
  if (row.status !== 'PUBLISHED') return null;
  if (!row.content) return null;
  return row;
}

publicRoutes.get('/s/:slug', async (c) => {
  const share = await resolveShare(c.env.DB, routeParam(c, 'slug'));
  if (!share) return c.html(GONE_PAGE, 404);

  // Counted after the checks pass, so a rejected attempt never inflates the
  // teacher's view count. Failure to count must not fail the page.
  c.executionCtx.waitUntil(
    c.env.DB
      .prepare(`UPDATE note_shares SET view_count = view_count + 1, last_viewed_at = ? WHERE id = ?`)
      .bind(nowIso(), share.share_id)
      .run()
      .catch((error) => console.error('share view count failed', error)),
  );

  const structure = parseStructure({ structure: share.structure, code: share.template_code } as LessonTemplateRow);
  const html = toHtml(structure, JSON.parse(share.content), {
    title: share.title || `${share.topic} - ${share.class_name}`,
    heading: 'Student Notes',
    footer: `${escapeHtml(share.subject_name)} · ${escapeHtml(share.class_name)} · ${escapeHtml(share.teacher_name ?? '')}`,
  });

  return c.html(html, 200, {
    // A shared note is not secret, but it should not be indexed or cached by
    // an intermediary that would keep serving it after the link is revoked.
    'Cache-Control': 'private, max-age=0, must-revalidate',
    'X-Robots-Tag': 'noindex, nofollow',
  });
});

/** JSON form of the same page, for the Flutter app opening a shared link in-app. */
publicRoutes.get('/s/:slug/json', async (c) => {
  const share = await resolveShare(c.env.DB, routeParam(c, 'slug'));
  if (!share) return c.json({ error: { code: 'NOT_FOUND', message: 'This link is no longer available.' } }, 404);

  const structure = parseStructure({ structure: share.structure, code: share.template_code } as LessonTemplateRow);
  const content = JSON.parse(share.content);

  return c.json({
    data: {
      title: share.title || `${share.topic} - ${share.class_name}`,
      subject: share.subject_name,
      className: share.class_name,
      topic: share.topic,
      teacher: share.teacher_name,
      blocks: toBlocks(structure, content),
    },
  });
});
