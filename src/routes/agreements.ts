import { Hono } from 'hono';
import type { AgreementLineRow, App } from '../types';
import {
  activateAgreement, assertTransition, getAgreement, getAgreementLines,
  recomputeAcceptance, validateFormula,
} from '../lib/agreements';
import { gateSensitiveAction } from '../lib/approvals';
import { audit, clientIp } from '../lib/audit';
import { badRequest, conflict, forbidden, notFound, ok, routeParam, unprocessable } from '../lib/http';
import { BPS_TOTAL, distribute, formatKobo, linesForCategory } from '../lib/money';
import { requirePermission } from '../lib/rbac';
import { nowIso } from '../lib/time';
import { readJson, Validator } from '../lib/validate';

export const agreementRoutes = new Hono<App>();

/**
 * Verifies the caller is actually party to this agreement.
 *
 * Called on every partner-scoped read and on the accept/reject decision -- not
 * once at list level. Without a per-object check, any partner could read or
 * sign another group's formula by pasting its id into the URL.
 */
async function assertPartyTo(db: D1Database, agreementId: string, partnerId: string | null) {
  if (!partnerId) throw forbidden('This account is not linked to a partner record.');
  const line = await db
    .prepare(`SELECT id FROM partnership_agreement_partners WHERE agreement_id = ? AND partner_id = ?`)
    .bind(agreementId, partnerId)
    .first();
  if (!line) throw forbidden('You are not a party to this agreement.');
}

async function hydrate(db: D1Database, agreementId: string) {
  const agreement = await getAgreement(db, agreementId);
  if (!agreement) throw notFound('Agreement');

  // Three independent reads, issued concurrently and each typed at its own call
  // site -- db.batch() would force one shared row type across all three.
  const [lines, approvals, expenses] = await Promise.all([
    db.prepare(
      `SELECT l.*, p.code AS partnerCode, p.legal_name AS partnerName
         FROM partnership_agreement_partners l JOIN partners p ON p.id = l.partner_id
        WHERE l.agreement_id = ? ORDER BY l.priority, p.code`,
    ).bind(agreementId).all<AgreementLineRow & { partnerCode: string; partnerName: string }>(),
    db.prepare(
      `SELECT a.partner_id AS partnerId, p.code AS partnerCode, p.legal_name AS partnerName,
              a.decision, a.decided_at AS decidedAt, a.statement, a.comment
         FROM agreement_approvals a JOIN partners p ON p.id = a.partner_id
        WHERE a.agreement_id = ? ORDER BY p.code`,
    ).bind(agreementId).all<{ partnerId: string; partnerCode: string; decision: string }>(),
    db.prepare(
      `SELECT expense_category AS expenseCategory, is_deductible AS isDeductible, cap_kobo AS capKobo, note
         FROM agreement_expense_rules WHERE agreement_id = ?`,
    ).bind(agreementId).all<{ expenseCategory: string; isDeductible: number; capKobo: number | null; note: string | null }>(),
  ]);

  return {
    agreement,
    lines: lines.results.map((line) => ({
      partnerId: line.partner_id,
      partnerCode: line.partnerCode,
      partnerName: line.partnerName,
      shareType: line.share_type,
      shareBps: line.share_bps,
      sharePercent: line.share_bps === null ? null : line.share_bps / 100,
      fixedAmountKobo: line.fixed_amount_kobo,
      revenueCategory: line.revenue_category,
      priority: line.priority,
      note: line.note,
    })),
    approvals: approvals.results,
    expenseRules: expenses.results.map((row) => ({ ...row, isDeductible: row.isDeductible === 1 })),
  };
}

// --------------------------------------------------------------- reading ----
agreementRoutes.get('/', requirePermission('agreements.read'), async (c) => {
  const groupId = c.req.query('groupId');
  const status = c.req.query('status');

  const filters: string[] = [];
  const params: unknown[] = [];
  if (groupId) {
    filters.push('a.group_id = ?');
    params.push(groupId);
  }
  if (status) {
    filters.push('a.status = ?');
    params.push(status);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const { results } = await c.env.DB.prepare(
    `SELECT a.id, a.group_id AS groupId, g.code AS groupCode, a.version, a.title, a.status, a.basis,
            a.distribution_frequency AS distributionFrequency, a.effective_from AS effectiveFrom,
            a.effective_to AS effectiveTo, a.created_at AS createdAt, a.activated_at AS activatedAt,
            (SELECT COUNT(*) FROM partnership_agreement_partners l WHERE l.agreement_id = a.id) AS partnerCount
       FROM partnership_agreements a JOIN partnership_groups g ON g.id = a.group_id
       ${where} ORDER BY a.group_id, a.version DESC`,
  ).bind(...params).all();

  return ok(c, results);
});

agreementRoutes.get('/:id', requirePermission('agreements.read'), async (c) =>
  ok(c, await hydrate(c.env.DB, routeParam(c, 'id'))),
);

/** The partner's own view. Ownership is checked before anything is returned. */
agreementRoutes.get('/:id/mine', requirePermission('partner.self.agreements.read'), async (c) => {
  const auth = c.get('auth');
  const id = routeParam(c, 'id');
  await assertPartyTo(c.env.DB, id, auth.partnerId);

  const full = await hydrate(c.env.DB, id);
  return ok(c, {
    ...full,
    myLine: full.lines.find((line) => line.partnerId === auth.partnerId) ?? null,
    myDecision: (full.approvals as { partnerId: string }[]).find((a) => a.partnerId === auth.partnerId) ?? null,
  });
});

// -------------------------------------------------------------- drafting ----
agreementRoutes.post('/', requirePermission('agreements.create'), async (c) => {
  const auth = c.get('auth');
  const body = await readJson(c.req.raw);
  const v = new Validator(body);
  const groupId = v.string('groupId', { required: true, max: 64 });
  const title = v.string('title', { required: true, max: 200 });
  const summary = v.string('summary', { max: 1000 });
  const basis = v.enum('basis', ['GROSS', 'NET'] as const) ?? 'NET';
  const frequency = v.enum('distributionFrequency',
    ['MONTHLY', 'QUARTERLY', 'TERMLY', 'ANNUALLY', 'MANUAL'] as const) ?? 'MONTHLY';
  const effectiveFrom = v.date('effectiveFrom', { required: true });
  const effectiveTo = v.date('effectiveTo');
  const requiresAll = v.boolean('requiresAllPartners', true);
  const thresholdBps = v.integer('approvalThresholdBps', { min: 1, max: BPS_TOTAL });
  const parentAgreementId = v.string('parentAgreementId', { max: 64 });
  v.assert();

  const group = await c.env.DB.prepare(`SELECT id, code FROM partnership_groups WHERE id = ?`)
    .bind(groupId).first<{ id: string; code: string }>();
  if (!group) throw notFound('Partnership group');

  if (requiresAll === false && thresholdBps === undefined) {
    throw badRequest('Set approvalThresholdBps when not every partner has to accept.');
  }

  // Versions are per group and monotonic, so history reads in order.
  const latest = await c.env.DB.prepare(
    `SELECT COALESCE(MAX(version), 0) AS version FROM partnership_agreements WHERE group_id = ?`,
  ).bind(groupId).first<{ version: number }>();
  const version = (latest?.version ?? 0) + 1;

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO partnership_agreements (id, group_id, version, parent_agreement_id, title, summary, status,
                                         basis, distribution_frequency, effective_from, effective_to,
                                         requires_all_partners, approval_threshold_bps,
                                         created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, groupId, version, parentAgreementId ?? null, title, summary ?? null, basis, frequency,
    effectiveFrom, effectiveTo ?? null, requiresAll ? 1 : 0, thresholdBps ?? null,
    auth.userId, nowIso(), nowIso(),
  ).run();

  await audit(c, {
    action: 'agreement.drafted', entityType: 'partnership_agreement', entityId: id,
    summary: `Drafted ${group.code} agreement v${version}: ${title}.`, severity: 'NOTICE',
  });

  return ok(c, { id, groupId, version, status: 'DRAFT', title }, 201);
});

/**
 * Replaces the whole formula in one call rather than patching line by line.
 * A formula is only meaningful as a complete set -- editing one partner's
 * percentage in isolation is exactly how a split stops totalling 100%.
 */
agreementRoutes.put('/:id/lines', requirePermission('agreements.create'), async (c) => {
  const id = routeParam(c, 'id');
  const agreement = await getAgreement(c.env.DB, id);
  if (!agreement) throw notFound('Agreement');
  if (agreement.status !== 'DRAFT') {
    throw conflict('Only a draft can be edited. Create a new version instead.', { status: agreement.status });
  }

  const body = await readJson(c.req.raw);
  const v = new Validator(body);
  const rawLines = v.array<Record<string, unknown>>('lines', { required: true, min: 1 });
  v.assert();

  const prepared: {
    partnerId: string; shareType: string; shareBps: number | null;
    fixedAmountKobo: number | null; revenueCategory: string | null; priority: number; note: string | null;
  }[] = [];

  for (const [index, raw] of rawLines!.entries()) {
    const lv = new Validator(raw);
    const partnerId = lv.string('partnerId', { required: true, max: 64 });
    const shareType = lv.enum('shareType', ['PERCENTAGE', 'FIXED_AMOUNT', 'RESIDUAL'] as const, { required: true });
    const shareBps = lv.integer('shareBps', { min: 0, max: BPS_TOTAL });
    const fixedAmountKobo = lv.integer('fixedAmountKobo', { min: 0 });
    const revenueCategory = lv.string('revenueCategory', { max: 40 });
    const priority = lv.integer('priority', { min: 0, max: 1000 }) ?? 100;
    const note = lv.string('note', { max: 300 });
    try {
      lv.assert();
    } catch {
      throw badRequest(`Line ${index + 1} is invalid.`, { line: index + 1 });
    }

    if (shareType === 'PERCENTAGE' && shareBps === undefined) {
      throw badRequest(`Line ${index + 1}: a percentage line needs shareBps.`);
    }
    if (shareType === 'FIXED_AMOUNT' && fixedAmountKobo === undefined) {
      throw badRequest(`Line ${index + 1}: a fixed-amount line needs fixedAmountKobo.`);
    }

    prepared.push({
      partnerId: partnerId!,
      shareType: shareType!,
      shareBps: shareType === 'PERCENTAGE' ? shareBps! : null,
      fixedAmountKobo: shareType === 'FIXED_AMOUNT' ? fixedAmountKobo! : null,
      revenueCategory: revenueCategory ?? null,
      priority,
      note: note ?? null,
    });
  }

  // Every named partner must actually belong to this agreement's group.
  const { results: members } = await c.env.DB.prepare(
    `SELECT partner_id AS partnerId FROM partnership_group_members
      WHERE group_id = ? AND left_at IS NULL`,
  ).bind(agreement.group_id).all<{ partnerId: string }>();
  const memberIds = new Set(members.map((m) => m.partnerId));
  const strangers = prepared.filter((line) => !memberIds.has(line.partnerId));
  if (strangers.length > 0) {
    throw badRequest('Every partner in the formula must be a member of the group.', {
      notInGroup: strangers.map((line) => line.partnerId),
    });
  }

  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM partnership_agreement_partners WHERE agreement_id = ?`).bind(id),
    ...prepared.map((line) =>
      c.env.DB.prepare(
        `INSERT INTO partnership_agreement_partners (id, agreement_id, partner_id, share_type, share_bps,
                                                     fixed_amount_kobo, revenue_category, priority, note,
                                                     created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(), id, line.partnerId, line.shareType, line.shareBps,
        line.fixedAmountKobo, line.revenueCategory, line.priority, line.note, nowIso(), nowIso(),
      ),
    ),
  ]);

  const problems = validateFormula(await getAgreementLines(c.env.DB, id));

  await audit(c, {
    action: 'agreement.lines_set', entityType: 'partnership_agreement', entityId: id,
    summary: `Set ${prepared.length} line(s) on v${agreement.version}.`,
    after: { lines: prepared }, severity: 'WARNING',
  });

  // Saved either way -- a draft is allowed to be temporarily unbalanced, but the
  // problems come back so the UI can show them before anyone proposes it.
  return ok(c, { lines: prepared.length, valid: problems.length === 0, problems });
});

// ------------------------------------------------------------- lifecycle ----
agreementRoutes.post('/:id/propose', requirePermission('agreements.propose'), async (c) => {
  const auth = c.get('auth');
  const id = routeParam(c, 'id');
  const agreement = await getAgreement(c.env.DB, id);
  if (!agreement) throw notFound('Agreement');
  assertTransition(agreement.status, 'PROPOSED');

  const lines = await getAgreementLines(c.env.DB, id);
  const problems = validateFormula(lines);
  if (problems.length > 0) {
    throw unprocessable('This formula is not valid and cannot be proposed.', { problems });
  }

  // One PENDING approval row per distinct partner in the formula. These rows
  // are the record of who was asked, which matters as much as who answered.
  const partnerIds = [...new Set(lines.map((line) => line.partner_id))];

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE partnership_agreements SET status = 'PROPOSED', proposed_by = ?, proposed_at = ?, updated_at = ?
        WHERE id = ?`,
    ).bind(auth.userId, nowIso(), nowIso(), id),
    ...partnerIds.map((partnerId) =>
      c.env.DB.prepare(
        `INSERT INTO agreement_approvals (id, agreement_id, partner_id, decision, created_at, updated_at)
         VALUES (?, ?, ?, 'PENDING', ?, ?)
         ON CONFLICT(agreement_id, partner_id) DO NOTHING`,
      ).bind(crypto.randomUUID(), id, partnerId, nowIso(), nowIso()),
    ),
  ]);

  await audit(c, {
    action: 'agreement.proposed', entityType: 'partnership_agreement', entityId: id,
    summary: `Proposed v${agreement.version} to ${partnerIds.length} partner(s).`, severity: 'CRITICAL',
  });

  return ok(c, { id, status: 'PROPOSED', awaitingDecisionFrom: partnerIds.length });
});

/**
 * "I agree to this sharing formula."
 *
 * The exact lines the partner is looking at are frozen into formula_snapshot
 * alongside the decision, so what they consented to is reconstructible even if
 * every other row in the database changes afterwards.
 */
agreementRoutes.post('/:id/decision', requirePermission('partner.self.agreements.decide'), async (c) => {
  const auth = c.get('auth');
  const id = routeParam(c, 'id');
  await assertPartyTo(c.env.DB, id, auth.partnerId);

  const agreement = await getAgreement(c.env.DB, id);
  if (!agreement) throw notFound('Agreement');
  if (!['PROPOSED', 'UNDER_REVIEW'].includes(agreement.status)) {
    throw conflict('This agreement is not open for decisions.', { status: agreement.status });
  }

  const body = await readJson(c.req.raw);
  const v = new Validator(body);
  const decision = v.enum('decision', ['ACCEPTED', 'REJECTED', 'ABSTAINED'] as const, { required: true });
  const comment = v.string('comment', { max: 1000 });
  v.assert();

  const existing = await c.env.DB.prepare(
    `SELECT id, decision FROM agreement_approvals WHERE agreement_id = ? AND partner_id = ?`,
  ).bind(id, auth.partnerId).first<{ id: string; decision: string }>();
  if (!existing) throw notFound('Approval record');
  if (existing.decision !== 'PENDING') {
    throw conflict(`You have already recorded a decision (${existing.decision}).`);
  }

  const lines = await getAgreementLines(c.env.DB, id);
  const statement = decision === 'ACCEPTED'
    ? 'I agree to this sharing formula.'
    : decision === 'REJECTED'
      ? 'I do not agree to this sharing formula.'
      : 'I abstain from this decision.';

  await c.env.DB.prepare(
    `UPDATE agreement_approvals
        SET decision = ?, decided_by = ?, decided_at = ?, statement = ?, comment = ?,
            ip_address = ?, user_agent = ?, formula_snapshot = ?, updated_at = ?
      WHERE id = ?`,
  ).bind(
    decision, auth.userId, nowIso(), statement, comment ?? null,
    clientIp(c), c.req.header('User-Agent') ?? null,
    JSON.stringify({
      agreementId: id,
      version: agreement.version,
      basis: agreement.basis,
      effectiveFrom: agreement.effective_from,
      effectiveTo: agreement.effective_to,
      lines: lines.map((line) => ({
        partnerId: line.partner_id,
        shareType: line.share_type,
        shareBps: line.share_bps,
        fixedAmountKobo: line.fixed_amount_kobo,
        revenueCategory: line.revenue_category,
      })),
    }),
    nowIso(), existing.id,
  ).run();

  const status = await recomputeAcceptance(c.env.DB, id);

  await audit(c, {
    action: 'agreement.decision', entityType: 'partnership_agreement', entityId: id,
    summary: `Partner recorded ${decision} on v${agreement.version}. Agreement is now ${status}.`,
    after: { decision, statement }, severity: 'CRITICAL',
  });

  return ok(c, { decision, statement, agreementStatus: status });
});

agreementRoutes.post('/:id/activate', requirePermission('agreements.activate'), async (c) => {
  const auth = c.get('auth');
  const id = routeParam(c, 'id');
  const agreement = await getAgreement(c.env.DB, id);
  if (!agreement) throw notFound('Agreement');
  if (agreement.status !== 'ACCEPTED') {
    throw conflict('Only an accepted agreement can be activated.', { status: agreement.status });
  }

  const gated = await gateSensitiveAction(c, {
    permission: 'agreements.activate', requestType: 'AGREEMENT_ACTIVATE',
    entityType: 'partnership_agreement', entityId: id,
    payload: { version: agreement.version }, summary: `Activate agreement v${agreement.version}.`,
  });
  if (gated) return ok(c, { pendingApproval: true, request: gated }, 202);

  await activateAgreement(c.env.DB, id, auth.userId);
  await audit(c, {
    action: 'agreement.activated', entityType: 'partnership_agreement', entityId: id,
    summary: `Activated v${agreement.version}. Any previous version is now superseded.`, severity: 'CRITICAL',
  });

  return ok(c, { id, status: 'ACTIVE' });
});

agreementRoutes.post('/:id/terminate', requirePermission('agreements.terminate'), async (c) => {
  const auth = c.get('auth');
  const id = routeParam(c, 'id');
  const body = await readJson(c.req.raw);
  const v = new Validator(body);
  const reason = v.string('reason', { required: true, max: 500 });
  v.assert();

  const agreement = await getAgreement(c.env.DB, id);
  if (!agreement) throw notFound('Agreement');
  assertTransition(agreement.status, 'TERMINATED');

  const gated = await gateSensitiveAction(c, {
    permission: 'agreements.terminate', requestType: 'AGREEMENT_TERMINATE',
    entityType: 'partnership_agreement', entityId: id,
    payload: { reason }, summary: `Terminate agreement v${agreement.version}.`, reason,
  });
  if (gated) return ok(c, { pendingApproval: true, request: gated }, 202);

  await c.env.DB.prepare(
    `UPDATE partnership_agreements
        SET status = 'TERMINATED', terminated_by = ?, terminated_at = ?, termination_reason = ?,
            effective_to = COALESCE(effective_to, ?), updated_at = ?
      WHERE id = ?`,
  ).bind(auth.userId, nowIso(), reason, nowIso(), nowIso(), id).run();

  await audit(c, {
    action: 'agreement.terminated', entityType: 'partnership_agreement', entityId: id,
    summary: `Terminated v${agreement.version}: ${reason}.`, severity: 'CRITICAL',
  });

  return ok(c, { id, status: 'TERMINATED' });
});

// -------------------------------------------------------------- modelling ----
/**
 * Runs a hypothetical pool through the formula without writing anything.
 *
 * This is what proves "the formula is data, not code": the same engine that
 * Module 12 will use to cut real distributions answers a what-if here, and a
 * partner can see exactly what a given month would pay them before they sign.
 */
agreementRoutes.post('/:id/preview', requirePermission('agreements.read', 'partner.self.agreements.read'), async (c) => {
  const auth = c.get('auth');
  const id = routeParam(c, 'id');

  // A partner may only model an agreement they are actually party to.
  if (!auth.permissions.includes('agreements.read') && !auth.isSuperAdmin) {
    await assertPartyTo(c.env.DB, id, auth.partnerId);
  }

  const body = await readJson(c.req.raw);
  const v = new Validator(body);
  const poolKobo = v.integer('poolKobo', { required: true, min: 0 });
  const revenueCategory = v.string('revenueCategory', { max: 40 });
  v.assert();

  const agreement = await getAgreement(c.env.DB, id);
  if (!agreement) throw notFound('Agreement');

  const allLines = await getAgreementLines(c.env.DB, id);
  const applicable = linesForCategory(allLines, revenueCategory ?? null);
  if (applicable.length === 0) {
    throw unprocessable('No formula lines apply to that revenue category.');
  }

  const result = distribute(
    poolKobo!,
    applicable.map((line) => ({
      partnerId: line.partner_id,
      shareType: line.share_type,
      shareBps: line.share_bps,
      fixedAmountKobo: line.fixed_amount_kobo,
      priority: line.priority,
    })),
    agreement.rounding_mode,
  );

  const { results: partners } = await c.env.DB.prepare(
    `SELECT id, code, legal_name AS legalName FROM partners
      WHERE id IN (${applicable.map(() => '?').join(',')})`,
  ).bind(...applicable.map((line) => line.partner_id)).all<{ id: string; code: string; legalName: string }>();
  const byId = new Map(partners.map((partner) => [partner.id, partner]));

  return ok(c, {
    agreementId: id,
    version: agreement.version,
    basis: agreement.basis,
    revenueCategory: revenueCategory ?? null,
    poolKobo,
    poolFormatted: formatKobo(poolKobo!),
    allocations: result.allocations.map((allocation) => ({
      ...allocation,
      partnerCode: byId.get(allocation.partnerId)?.code ?? null,
      partnerName: byId.get(allocation.partnerId)?.legalName ?? null,
      amountFormatted: formatKobo(allocation.amountKobo),
      effectivePercent: allocation.effectiveBps / 100,
    })),
    // Should always be 0 for a valid formula; surfaced so a bad one is visible.
    unallocatedKobo: result.unallocatedKobo,
    warnings: result.warnings,
  });
});
