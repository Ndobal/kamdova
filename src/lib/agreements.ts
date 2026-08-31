import type { AgreementLineRow, AgreementRow } from '../types';
import { conflict, unprocessable } from './http';
import { BPS_TOTAL } from './money';
import { nowIso } from './time';

/**
 * Validates a sharing formula before it can leave DRAFT.
 *
 * The rule that matters: within any one revenue category the percentage lines
 * must total exactly 100%, unless a RESIDUAL line exists to sweep the rest. A
 * formula totalling 97% would silently strand 3% of every distribution, and a
 * formula totalling 103% would promise money that does not exist.
 */
export function validateFormula(lines: AgreementLineRow[]): string[] {
  const problems: string[] = [];
  if (lines.length === 0) return ['The agreement has no partner lines.'];

  const byCategory = new Map<string, AgreementLineRow[]>();
  for (const line of lines) {
    const key = line.revenue_category ?? '*';
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key)!.push(line);
  }

  for (const [category, group] of byCategory) {
    const label = category === '*' ? 'the default scope' : `category ${category}`;

    const percentageTotal = group
      .filter((line) => line.share_type === 'PERCENTAGE')
      .reduce((sum, line) => sum + (line.share_bps ?? 0), 0);
    const hasResidual = group.some((line) => line.share_type === 'RESIDUAL');
    const hasPercentage = group.some((line) => line.share_type === 'PERCENTAGE');

    if (hasPercentage && !hasResidual && percentageTotal !== BPS_TOTAL) {
      problems.push(
        `Percentages in ${label} total ${(percentageTotal / 100).toFixed(2)}%, not 100%. ` +
          `Adjust the shares or add a residual line.`,
      );
    }
    if (hasResidual && percentageTotal > BPS_TOTAL) {
      problems.push(`Percentages in ${label} exceed 100% (${(percentageTotal / 100).toFixed(2)}%).`);
    }
    if (group.filter((line) => line.share_type === 'RESIDUAL').length > 1) {
      problems.push(`${label} has more than one residual line; only one may sweep the remainder.`);
    }

    const seen = new Set<string>();
    for (const line of group) {
      if (seen.has(line.partner_id)) problems.push(`A partner appears twice in ${label}.`);
      seen.add(line.partner_id);
    }
  }

  return problems;
}

export async function getAgreementLines(db: D1Database, agreementId: string): Promise<AgreementLineRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM partnership_agreement_partners WHERE agreement_id = ? ORDER BY priority, created_at`,
    )
    .bind(agreementId)
    .all<AgreementLineRow>();
  return results;
}

export async function getAgreement(db: D1Database, agreementId: string): Promise<AgreementRow | null> {
  return await db
    .prepare(`SELECT * FROM partnership_agreements WHERE id = ?`)
    .bind(agreementId)
    .first<AgreementRow>();
}

/** Only these transitions are legal; anything else is rejected as a conflict. */
const TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['PROPOSED', 'CANCELLED'],
  PROPOSED: ['UNDER_REVIEW', 'ACCEPTED', 'REJECTED', 'CANCELLED'],
  UNDER_REVIEW: ['ACCEPTED', 'REJECTED', 'CANCELLED'],
  ACCEPTED: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['SUPERSEDED', 'TERMINATED', 'EXPIRED'],
  REJECTED: [],
  CANCELLED: [],
  SUPERSEDED: [],
  TERMINATED: [],
  EXPIRED: [],
};

export function assertTransition(from: string, to: string) {
  if (!TRANSITIONS[from]?.includes(to)) {
    throw conflict(`An agreement cannot move from ${from} to ${to}.`, {
      allowed: TRANSITIONS[from] ?? [],
    });
  }
}

/**
 * Re-evaluates whether a proposed agreement has cleared its approval bar.
 *
 * Called after every partner decision. A single rejection kills the version
 * outright -- a formula nobody can veto is not an agreement.
 */
export async function recomputeAcceptance(db: D1Database, agreementId: string): Promise<string> {
  const agreement = await getAgreement(db, agreementId);
  if (!agreement) throw conflict('Agreement no longer exists.');
  if (!['PROPOSED', 'UNDER_REVIEW'].includes(agreement.status)) return agreement.status;

  const { results } = await db
    .prepare(`SELECT decision FROM agreement_approvals WHERE agreement_id = ?`)
    .bind(agreementId)
    .all<{ decision: string }>();

  const total = results.length;
  const accepted = results.filter((row) => row.decision === 'ACCEPTED').length;
  const rejected = results.filter((row) => row.decision === 'REJECTED').length;
  const pending = results.filter((row) => row.decision === 'PENDING').length;

  if (rejected > 0) {
    await db
      .prepare(`UPDATE partnership_agreements SET status = 'REJECTED', updated_at = ? WHERE id = ?`)
      .bind(nowIso(), agreementId)
      .run();
    return 'REJECTED';
  }

  const cleared = agreement.requires_all_partners === 1
    ? pending === 0 && accepted === total && total > 0
    : total > 0 && Math.round((accepted / total) * BPS_TOTAL) >= (agreement.approval_threshold_bps ?? BPS_TOTAL);

  const next = cleared ? 'ACCEPTED' : 'UNDER_REVIEW';
  await db
    .prepare(
      `UPDATE partnership_agreements
          SET status = ?, accepted_at = CASE WHEN ? = 'ACCEPTED' THEN ? ELSE accepted_at END, updated_at = ?
        WHERE id = ?`,
    )
    .bind(next, next, nowIso(), nowIso(), agreementId)
    .run();

  return next;
}

/**
 * Makes an accepted version the live formula.
 *
 * The previously active version is marked SUPERSEDED and given an effective_to
 * rather than being edited or deleted, so the history of what was in force on
 * any past date stays reconstructible -- which is the whole point of versioning
 * the agreement instead of updating a percentage in place.
 */
export async function activateAgreement(
  db: D1Database,
  agreementId: string,
  activatedBy: string,
): Promise<void> {
  const agreement = await getAgreement(db, agreementId);
  if (!agreement) throw conflict('Agreement no longer exists.');
  assertTransition(agreement.status, 'ACTIVE');

  const problems = validateFormula(await getAgreementLines(db, agreementId));
  if (problems.length > 0) {
    throw unprocessable('This formula is not valid and cannot be activated.', { problems });
  }

  const current = await db
    .prepare(
      `SELECT id FROM partnership_agreements WHERE group_id = ? AND status = 'ACTIVE' AND id <> ?`,
    )
    .bind(agreement.group_id, agreementId)
    .first<{ id: string }>();

  const statements = [];
  if (current) {
    statements.push(
      db
        .prepare(
          `UPDATE partnership_agreements
              SET status = 'SUPERSEDED', effective_to = COALESCE(effective_to, ?), updated_at = ?
            WHERE id = ?`,
        )
        .bind(nowIso(), nowIso(), current.id),
    );
  }
  statements.push(
    db
      .prepare(
        `UPDATE partnership_agreements
            SET status = 'ACTIVE', activated_by = ?, activated_at = ?, updated_at = ?
          WHERE id = ?`,
      )
      .bind(activatedBy, nowIso(), nowIso(), agreementId),
  );

  await db.batch(statements);
}

/** The formula in force for a group right now, lines included. */
export async function getActiveAgreement(db: D1Database, groupId: string) {
  const agreement = await db
    .prepare(`SELECT * FROM partnership_agreements WHERE group_id = ? AND status = 'ACTIVE'`)
    .bind(groupId)
    .first<AgreementRow>();
  if (!agreement) return null;
  return { agreement, lines: await getAgreementLines(db, agreement.id) };
}
