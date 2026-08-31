/**
 * Money and share arithmetic.
 *
 * Two rules hold everywhere in TeachEasy:
 *   1. Money is an INTEGER count of kobo. Never a float. 1 naira = 100 kobo.
 *   2. Shares are INTEGER basis points. 10000 bps = 100%, 4000 bps = 40%.
 *
 * Floating point cannot represent 0.1 exactly, so a naive percentage split
 * loses or invents fractions of a kobo. Everything below is exact integer
 * maths, and the intermediate `pool * bps` product is done in BigInt because it
 * overflows Number.MAX_SAFE_INTEGER once the pool passes ~90 billion naira.
 */

export const KOBO_PER_NAIRA = 100;
export const BPS_TOTAL = 10_000;

export const nairaToKobo = (naira: number): number => Math.round(naira * KOBO_PER_NAIRA);
export const koboToNaira = (kobo: number): number => kobo / KOBO_PER_NAIRA;

/** Formats kobo for display, e.g. 123456 -> "₦1,234.56". */
export function formatKobo(kobo: number, currency = '₦'): string {
  const negative = kobo < 0;
  const absolute = Math.abs(kobo);
  const major = Math.floor(absolute / KOBO_PER_NAIRA).toLocaleString('en-NG');
  const minor = String(absolute % KOBO_PER_NAIRA).padStart(2, '0');
  return `${negative ? '-' : ''}${currency}${major}.${minor}`;
}

export const bpsToPercent = (bps: number): number => bps / 100;
export const percentToBps = (percent: number): number => Math.round(percent * 100);

export interface ShareLine {
  partnerId: string;
  shareType: 'PERCENTAGE' | 'FIXED_AMOUNT' | 'RESIDUAL';
  shareBps?: number | null;
  fixedAmountKobo?: number | null;
  priority?: number;
}

export interface Allocation {
  partnerId: string;
  shareType: ShareLine['shareType'];
  amountKobo: number;
  /** Share of the original pool this allocation represents, for display. */
  effectiveBps: number;
  /** Set when a FIXED_AMOUNT line could not be paid in full from the pool. */
  shortfallKobo?: number;
}

export interface DistributionResult {
  poolKobo: number;
  allocations: Allocation[];
  /** Always 0 for a valid formula; non-zero means the formula left money unassigned. */
  unallocatedKobo: number;
  warnings: string[];
}

/**
 * Splits `poolKobo` across lines that carry basis points, using the largest
 * remainder method: every line gets its floor, then the leftover kobo are handed
 * out one at a time to the lines with the biggest discarded fraction.
 *
 * Each share is a fraction of 10,000 -- NOT a fraction of whatever the lines
 * happen to add up to. That distinction is the whole point: if the lines total
 * 7000 bps, they collectively receive 70% of the pool and the other 30% stays
 * unassigned for a residual line to sweep or for the caller to flag. Dividing
 * by the sum instead would quietly inflate every share to fill the pool, paying
 * out money the formula never promised.
 *
 * When the lines do total 10,000 bps the parts sum to exactly the pool -- the
 * property that keeps a partner ledger from drifting by a kobo per distribution.
 * Ties are broken by partnerId so the same inputs always produce the same split.
 */
export function allocateByBps(
  poolKobo: number,
  lines: { partnerId: string; bps: number }[],
): Map<string, number> {
  const result = new Map<string, number>();
  if (lines.length === 0) return result;

  const totalBps = lines.reduce((sum, line) => sum + line.bps, 0);
  if (totalBps <= 0 || poolKobo === 0) {
    for (const line of lines) result.set(line.partnerId, 0);
    return result;
  }

  const pool = BigInt(poolKobo);
  const denominator = BigInt(BPS_TOTAL);

  const parts = lines.map((line) => {
    const exact = pool * BigInt(line.bps);
    return {
      partnerId: line.partnerId,
      floor: Number(exact / denominator),
      remainder: exact % denominator,
    };
  });

  // What these lines are collectively entitled to. Equals poolKobo exactly when
  // they total 100%, which is why the no-kobo-lost property still holds there.
  const target = Number((pool * BigInt(totalBps)) / denominator);
  let leftover = target - parts.reduce((sum, part) => sum + part.floor, 0);

  // Biggest discarded fraction first; partnerId as a deterministic tie-break.
  const byRemainder = [...parts].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    return a.partnerId < b.partnerId ? -1 : 1;
  });

  let index = 0;
  while (leftover > 0 && byRemainder.length > 0) {
    byRemainder[index % byRemainder.length]!.floor += 1;
    leftover -= 1;
    index++;
  }

  for (const part of parts) result.set(part.partnerId, part.floor);
  return result;
}

/**
 * Equal split of a pool, exact to the kobo. Used for residual lines, where the
 * shares carry no basis points of their own.
 */
export function splitEvenly(poolKobo: number, partnerIds: string[]): Map<string, number> {
  const result = new Map<string, number>();
  if (partnerIds.length === 0) return result;

  const base = Math.trunc(poolKobo / partnerIds.length);
  let leftover = poolKobo - base * partnerIds.length;

  // Deterministic order so the extra kobo always lands on the same partner.
  for (const partnerId of [...partnerIds].sort()) {
    const extra = leftover > 0 ? 1 : 0;
    leftover -= extra;
    result.set(partnerId, base + extra);
  }
  return result;
}

/**
 * Runs a full agreement formula against a pool.
 *
 * Order of settlement:
 *   1. FIXED_AMOUNT lines, lowest `priority` number first. If the pool runs
 *      out, the line is paid what remains and the shortfall is reported rather
 *      than silently going negative.
 *   2. PERCENTAGE lines split whatever is left, by basis points.
 *   3. RESIDUAL lines share anything still unassigned, evenly.
 */
export function distribute(
  poolKobo: number,
  lines: ShareLine[],
  _roundingMode: 'LARGEST_REMAINDER' | 'TO_FIRST_PARTNER' = 'LARGEST_REMAINDER',
): DistributionResult {
  const warnings: string[] = [];
  const allocations: Allocation[] = [];

  if (poolKobo < 0) {
    return { poolKobo, allocations: [], unallocatedKobo: poolKobo, warnings: ['Pool is negative.'] };
  }

  let remaining = poolKobo;

  const fixed = lines
    .filter((line) => line.shareType === 'FIXED_AMOUNT')
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));

  for (const line of fixed) {
    const wanted = line.fixedAmountKobo ?? 0;
    const paid = Math.min(wanted, remaining);
    remaining -= paid;
    const allocation: Allocation = {
      partnerId: line.partnerId,
      shareType: 'FIXED_AMOUNT',
      amountKobo: paid,
      effectiveBps: poolKobo === 0 ? 0 : Math.round((paid / poolKobo) * BPS_TOTAL),
    };
    if (paid < wanted) {
      allocation.shortfallKobo = wanted - paid;
      warnings.push(
        `Partner ${line.partnerId} is short ${wanted - paid} kobo: the pool does not cover the fixed amount.`,
      );
    }
    allocations.push(allocation);
  }

  const percentage = lines.filter((line) => line.shareType === 'PERCENTAGE');
  if (percentage.length > 0) {
    const split = allocateByBps(
      remaining,
      percentage.map((line) => ({ partnerId: line.partnerId, bps: line.shareBps ?? 0 })),
    );
    let assigned = 0;
    for (const line of percentage) {
      const amount = split.get(line.partnerId) ?? 0;
      assigned += amount;
      allocations.push({
        partnerId: line.partnerId,
        shareType: 'PERCENTAGE',
        amountKobo: amount,
        effectiveBps: poolKobo === 0 ? 0 : Math.round((amount / poolKobo) * BPS_TOTAL),
      });
    }
    remaining -= assigned;
  }

  const residual = lines.filter((line) => line.shareType === 'RESIDUAL');
  if (residual.length > 0 && remaining !== 0) {
    // Residual lines carry no basis points, so they share equally rather than
    // going through the bps path.
    const split = splitEvenly(remaining, residual.map((line) => line.partnerId));
    for (const line of residual) {
      const amount = split.get(line.partnerId) ?? 0;
      allocations.push({
        partnerId: line.partnerId,
        shareType: 'RESIDUAL',
        amountKobo: amount,
        effectiveBps: poolKobo === 0 ? 0 : Math.round((amount / poolKobo) * BPS_TOTAL),
      });
    }
    remaining = 0;
  } else if (residual.length > 0) {
    for (const line of residual) {
      allocations.push({ partnerId: line.partnerId, shareType: 'RESIDUAL', amountKobo: 0, effectiveBps: 0 });
    }
  }

  if (remaining !== 0) {
    warnings.push(`${remaining} kobo is unallocated: the percentage lines do not total 100%.`);
  }

  return { poolKobo, allocations, unallocatedKobo: remaining, warnings };
}

/**
 * Picks the lines that govern a given revenue category.
 * A line scoped to the category wins over an unscoped one, so an agreement can
 * say "40/35/25 in general, but advertising splits 50/50" without ambiguity.
 */
export function linesForCategory<T extends { revenue_category: string | null }>(
  lines: T[],
  category: string | null,
): T[] {
  if (category) {
    const specific = lines.filter((line) => line.revenue_category === category);
    if (specific.length > 0) return specific;
  }
  return lines.filter((line) => line.revenue_category === null);
}
