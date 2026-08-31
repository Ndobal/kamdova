import { Hono } from 'hono';
import type { App } from '../types';
import { gateSensitiveAction } from '../lib/approvals';
import { audit } from '../lib/audit';
import { badRequest, conflict, forbidden, notFound, ok, paginated, readPagination, routeParam } from '../lib/http';
import { requirePermission } from '../lib/rbac';
import { nowIso } from '../lib/time';
import { readJson, Validator } from '../lib/validate';

export const partnerRoutes = new Hono<App>();

/**
 * Bank and tax details are payout credentials, not directory data, so they are
 * only selected for the partner reading their own record or for a Super Admin.
 * Least privilege applies to columns, not just to rows.
 */
const partnerSelect = (withPayoutDetails = false) => `
  SELECT p.id, p.user_id AS userId, p.code, p.legal_name AS legalName, p.display_name AS displayName,
         p.partner_type AS partnerType, p.email, p.phone, p.status, p.joined_at AS joinedAt,
         p.exited_at AS exitedAt, p.notes, p.created_at AS createdAt, p.updated_at AS updatedAt
         ${withPayoutDetails
           ? `, p.tax_id AS taxId, p.bank_name AS bankName,
              p.bank_account_name AS bankAccountName, p.bank_account_number AS bankAccountNumber`
           : ''}
    FROM partners p`;

// ------------------------------------------------------------ own record ----
/**
 * Declared before `/:id` so the literal path wins the match, and scoped to the
 * caller's own partner id from the verified session -- never from the URL.
 */
partnerRoutes.get('/me', requirePermission('partner.self.read'), async (c) => {
  const auth = c.get('auth');
  if (!auth.partnerId) throw notFound('Partner record for this account');

  const partner = await c.env.DB.prepare(`${partnerSelect(true)} WHERE p.id = ?`)
    .bind(auth.partnerId).first();

  const { results: groups } = await c.env.DB.prepare(
    `SELECT g.id, g.code, g.name, m.role_in_group AS roleInGroup, m.joined_at AS joinedAt
       FROM partnership_group_members m JOIN partnership_groups g ON g.id = m.group_id
      WHERE m.partner_id = ? AND m.left_at IS NULL`,
  ).bind(auth.partnerId).all();

  return ok(c, { partner, groups });
});

// --------------------------------------------------------------- listing ----
partnerRoutes.get('/', requirePermission('partners.read'), async (c) => {
  const { page, perPage, offset } = readPagination(c);
  const status = c.req.query('status');
  const search = c.req.query('search')?.trim();

  const filters = ['p.deleted_at IS NULL'];
  const params: unknown[] = [];
  if (status) {
    filters.push('p.status = ?');
    params.push(status);
  }
  if (search) {
    filters.push('(p.legal_name LIKE ? OR p.display_name LIKE ? OR p.code LIKE ? OR p.email LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  const where = `WHERE ${filters.join(' AND ')}`;

  const countRow = await c.env.DB.prepare(`SELECT COUNT(*) AS total FROM partners p ${where}`)
    .bind(...params).first<{ total: number }>();
  const { results } = await c.env.DB.prepare(
    `${partnerSelect()} ${where} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
  ).bind(...params, perPage, offset).all();

  return paginated(c, results, { page, perPage, total: countRow?.total ?? 0 });
});

partnerRoutes.get('/:id', requirePermission('partners.read'), async (c) => {
  const auth = c.get('auth');
  const id = routeParam(c, 'id');

  const partner = await c.env.DB.prepare(
    `${partnerSelect(auth.isSuperAdmin)} WHERE p.id = ? AND p.deleted_at IS NULL`,
  )
    .bind(id).first();
  if (!partner) throw notFound('Partner');

  const { results: agreements } = await c.env.DB.prepare(
    `SELECT a.id, a.title, a.version, a.status, a.effective_from AS effectiveFrom, a.effective_to AS effectiveTo,
            l.share_type AS shareType, l.share_bps AS shareBps, l.fixed_amount_kobo AS fixedAmountKobo
       FROM partnership_agreement_partners l
       JOIN partnership_agreements a ON a.id = l.agreement_id
      WHERE l.partner_id = ? ORDER BY a.version DESC`,
  ).bind(id).all();

  return ok(c, { ...partner, agreements });
});

// -------------------------------------------------------------- creation ----
partnerRoutes.post('/', requirePermission('partners.create'), async (c) => {
  const auth = c.get('auth');
  const body = await readJson(c.req.raw);
  const v = new Validator(body);
  const code = v.string('code', { required: true, max: 40 });
  const legalName = v.string('legalName', { required: true, max: 200 });
  const displayName = v.string('displayName', { max: 200 });
  const partnerType = v.enum('partnerType', ['INDIVIDUAL', 'COMPANY'] as const) ?? 'INDIVIDUAL';
  const email = v.email('email', false);
  const phone = v.string('phone', { max: 32 });
  const userId = v.string('userId', { max: 64 });
  const notes = v.string('notes', { max: 1000 });
  v.assert();

  const taken = await c.env.DB.prepare(`SELECT id FROM partners WHERE code = ?`).bind(code).first();
  if (taken) throw conflict(`Partner code ${code} is already in use.`);

  if (userId) {
    const user = await c.env.DB.prepare(`SELECT id FROM users WHERE id = ? AND deleted_at IS NULL`)
      .bind(userId).first();
    if (!user) throw badRequest('That user account does not exist.');

    const linked = await c.env.DB.prepare(`SELECT id FROM partners WHERE user_id = ?`).bind(userId).first();
    if (linked) throw conflict('That user is already linked to a partner record.');
  }

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO partners (id, user_id, code, legal_name, display_name, partner_type, email, phone,
                           status, notes, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?)`,
  ).bind(
    id, userId ?? null, code, legalName, displayName ?? legalName, partnerType,
    email ?? null, phone ?? null, notes ?? null, auth.userId, nowIso(), nowIso(),
  ).run();

  await audit(c, {
    action: 'partner.created', entityType: 'partner', entityId: id,
    summary: `Registered partner ${code} (${legalName}).`,
    after: { code, legalName, partnerType, userId }, severity: 'NOTICE',
  });

  return ok(c, await c.env.DB.prepare(`${partnerSelect()} WHERE p.id = ?`).bind(id).first(), 201);
});

partnerRoutes.patch('/:id', requirePermission('partners.update'), async (c) => {
  const id = routeParam(c, 'id');
  const partner = await c.env.DB.prepare(`SELECT * FROM partners WHERE id = ? AND deleted_at IS NULL`)
    .bind(id).first<Record<string, unknown>>();
  if (!partner) throw notFound('Partner');

  const body = await readJson(c.req.raw);
  const v = new Validator(body);
  const fields: Record<string, unknown> = {
    legal_name: v.string('legalName', { max: 200 }),
    display_name: v.string('displayName', { max: 200 }),
    email: v.email('email', false),
    phone: v.string('phone', { max: 32 }),
    tax_id: v.string('taxId', { max: 60 }),
    bank_name: v.string('bankName', { max: 120 }),
    bank_account_name: v.string('bankAccountName', { max: 200 }),
    bank_account_number: v.string('bankAccountNumber', { max: 40 }),
    notes: v.string('notes', { max: 1000 }),
  };
  v.assert();

  const updates = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (updates.length === 0) return ok(c, { updated: false });

  await c.env.DB.prepare(
    `UPDATE partners SET ${updates.map(([column]) => `${column} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
  ).bind(...updates.map(([, value]) => value), nowIso(), id).run();

  const changedBankDetails = updates.some(([column]) => column.startsWith('bank_'));
  await audit(c, {
    action: 'partner.updated', entityType: 'partner', entityId: id,
    summary: changedBankDetails ? 'Updated partner details including payout account.' : 'Updated partner details.',
    before: partner,
    after: await c.env.DB.prepare(`SELECT * FROM partners WHERE id = ?`).bind(id).first(),
    // Changing where the money goes is the highest-risk edit on this record.
    severity: changedBankDetails ? 'CRITICAL' : 'NOTICE',
  });

  return ok(c, { updated: true });
});

partnerRoutes.post('/:id/status', requirePermission('partners.suspend'), async (c) => {
  const id = routeParam(c, 'id');
  const body = await readJson(c.req.raw);
  const v = new Validator(body);
  const status = v.enum('status', ['PENDING', 'ACTIVE', 'SUSPENDED', 'EXITED'] as const, { required: true });
  const reason = v.string('reason', { max: 500 });
  v.assert();

  const partner = await c.env.DB.prepare(`SELECT id, status, code FROM partners WHERE id = ? AND deleted_at IS NULL`)
    .bind(id).first<{ id: string; status: string; code: string }>();
  if (!partner) throw notFound('Partner');

  // A partner named in an ACTIVE agreement cannot simply be removed; the
  // agreement has to be dealt with first, or the live formula loses a party.
  if (status === 'EXITED') {
    const active = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM partnership_agreement_partners l
         JOIN partnership_agreements a ON a.id = l.agreement_id
        WHERE l.partner_id = ? AND a.status = 'ACTIVE'`,
    ).bind(id).first<{ n: number }>();
    if ((active?.n ?? 0) > 0) {
      throw conflict('This partner is party to an active agreement. Supersede or terminate it first.');
    }
  }

  const gated = await gateSensitiveAction(c, {
    permission: 'partners.suspend', requestType: 'PARTNER_SUSPEND', entityType: 'partner', entityId: id,
    payload: { status, reason }, summary: `Set partner ${partner.code} to ${status}.`, reason,
  });
  if (gated) return ok(c, { pendingApproval: true, request: gated }, 202);

  await c.env.DB.prepare(
    `UPDATE partners SET status = ?, updated_at = ?,
                         joined_at = CASE WHEN ? = 'ACTIVE' AND joined_at IS NULL THEN ? ELSE joined_at END,
                         exited_at = CASE WHEN ? = 'EXITED' THEN ? ELSE exited_at END
      WHERE id = ?`,
  ).bind(status, nowIso(), status, nowIso(), status, nowIso(), id).run();

  await audit(c, {
    action: 'partner.status_changed', entityType: 'partner', entityId: id,
    summary: `Partner ${partner.code}: ${partner.status} -> ${status}.`,
    before: { status: partner.status }, after: { status, reason }, severity: 'CRITICAL',
  });
  return ok(c, { id, status });
});

// ---------------------------------------------------------------- groups ----
export const partnershipGroupRoutes = new Hono<App>();

partnershipGroupRoutes.get('/', requirePermission('partners.read', 'agreements.read'), async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT g.id, g.code, g.name, g.description, g.status, g.created_at AS createdAt,
            (SELECT COUNT(*) FROM partnership_group_members m WHERE m.group_id = g.id AND m.left_at IS NULL) AS memberCount,
            (SELECT a.id FROM partnership_agreements a WHERE a.group_id = g.id AND a.status = 'ACTIVE') AS activeAgreementId
       FROM partnership_groups g ORDER BY g.created_at DESC`,
  ).all();
  return ok(c, results);
});

partnershipGroupRoutes.post('/', requirePermission('partners.create'), async (c) => {
  const auth = c.get('auth');
  const body = await readJson(c.req.raw);
  const v = new Validator(body);
  const code = v.string('code', { required: true, max: 40 });
  const name = v.string('name', { required: true, max: 200 });
  const description = v.string('description', { max: 1000 });
  v.assert();

  const taken = await c.env.DB.prepare(`SELECT id FROM partnership_groups WHERE code = ?`).bind(code).first();
  if (taken) throw conflict(`Group code ${code} is already in use.`);

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO partnership_groups (id, code, name, description, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, code, name, description ?? null, auth.userId, nowIso(), nowIso()).run();

  await audit(c, {
    action: 'partnership_group.created', entityType: 'partnership_group', entityId: id,
    summary: `Created partnership group ${code}.`, severity: 'NOTICE',
  });
  return ok(c, { id, code, name }, 201);
});

partnershipGroupRoutes.get('/:id/members', requirePermission('partners.read', 'agreements.read'), async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT m.id, m.partner_id AS partnerId, p.code, p.legal_name AS legalName, p.status,
            m.role_in_group AS roleInGroup, m.joined_at AS joinedAt, m.left_at AS leftAt
       FROM partnership_group_members m JOIN partners p ON p.id = m.partner_id
      WHERE m.group_id = ? ORDER BY m.joined_at`,
  ).bind(routeParam(c, 'id')).all();
  return ok(c, results);
});

partnershipGroupRoutes.post('/:id/members', requirePermission('partners.update'), async (c) => {
  const groupId = routeParam(c, 'id');
  const body = await readJson(c.req.raw);
  const v = new Validator(body);
  const partnerId = v.string('partnerId', { required: true, max: 64 });
  const roleInGroup = v.enum('roleInGroup', ['PARTNER', 'MANAGING_PARTNER', 'SILENT_PARTNER'] as const) ?? 'PARTNER';
  v.assert();

  const [group, partner] = await Promise.all([
    c.env.DB.prepare(`SELECT id FROM partnership_groups WHERE id = ?`).bind(groupId).first(),
    c.env.DB.prepare(`SELECT id, code FROM partners WHERE id = ? AND deleted_at IS NULL`).bind(partnerId).first<{ id: string; code: string }>(),
  ]);
  if (!group) throw notFound('Partnership group');
  if (!partner) throw notFound('Partner');

  await c.env.DB.prepare(
    `INSERT INTO partnership_group_members (id, group_id, partner_id, role_in_group, joined_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(group_id, partner_id) DO UPDATE SET role_in_group = excluded.role_in_group, left_at = NULL`,
  ).bind(crypto.randomUUID(), groupId, partnerId, roleInGroup, nowIso()).run();

  await audit(c, {
    action: 'partnership_group.member_added', entityType: 'partnership_group', entityId: groupId,
    summary: `Added partner ${partner.code} as ${roleInGroup}.`, severity: 'NOTICE',
  });
  return ok(c, { groupId, partnerId, roleInGroup }, 201);
});

partnershipGroupRoutes.delete('/:id/members/:partnerId', requirePermission('partners.update'), async (c) => {
  const groupId = routeParam(c, 'id');
  const partnerId = routeParam(c, 'partnerId');

  const active = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM partnership_agreement_partners l
       JOIN partnership_agreements a ON a.id = l.agreement_id
      WHERE l.partner_id = ? AND a.group_id = ? AND a.status = 'ACTIVE'`,
  ).bind(partnerId, groupId).first<{ n: number }>();
  if ((active?.n ?? 0) > 0) {
    throw forbidden('This partner is named in the active agreement and cannot be removed from the group.');
  }

  await c.env.DB.prepare(
    `UPDATE partnership_group_members SET left_at = ? WHERE group_id = ? AND partner_id = ? AND left_at IS NULL`,
  ).bind(nowIso(), groupId, partnerId).run();

  await audit(c, {
    action: 'partnership_group.member_removed', entityType: 'partnership_group', entityId: groupId,
    summary: `Removed partner ${partnerId} from the group.`, severity: 'WARNING',
  });
  return ok(c, { removed: true });
});
