import { describe, expect, it } from 'vitest';
import { allocateByBps, distribute, formatKobo, linesForCategory } from '../src/lib/money';

describe('allocateByBps', () => {
  it('splits a clean amount exactly', () => {
    const result = allocateByBps(100_000_000, [
      { partnerId: 'A', bps: 4000 },
      { partnerId: 'B', bps: 3500 },
      { partnerId: 'C', bps: 2500 },
    ]);
    expect(result.get('A')).toBe(40_000_000);
    expect(result.get('B')).toBe(35_000_000);
    expect(result.get('C')).toBe(25_000_000);
  });

  it('never loses a kobo, whatever the pool', () => {
    // The property that matters: parts always sum to the whole. A naive
    // floor-and-hope split drifts by up to (n-1) kobo per distribution.
    const lines = [
      { partnerId: 'A', bps: 3333 },
      { partnerId: 'B', bps: 3333 },
      { partnerId: 'C', bps: 3334 },
    ];
    for (let pool = 0; pool <= 2000; pool++) {
      const total = [...allocateByBps(pool, lines).values()].reduce((a, b) => a + b, 0);
      expect(total).toBe(pool);
    }
  });

  it('hands the remainder to the largest fraction first', () => {
    // 10 kobo at 1/3 each: floors are 3,3,3 and one kobo is left over.
    const result = allocateByBps(10, [
      { partnerId: 'A', bps: 3333 },
      { partnerId: 'B', bps: 3333 },
      { partnerId: 'C', bps: 3334 },
    ]);
    expect(result.get('C')).toBe(4);
    expect(result.get('A')! + result.get('B')! + result.get('C')!).toBe(10);
  });

  it('is deterministic when remainders tie', () => {
    const lines = [
      { partnerId: 'B', bps: 5000 },
      { partnerId: 'A', bps: 5000 },
    ];
    const first = allocateByBps(101, lines);
    const second = allocateByBps(101, [...lines].reverse());
    expect(first.get('A')).toBe(second.get('A'));
    expect(first.get('B')).toBe(second.get('B'));
  });

  it('stays exact past Number.MAX_SAFE_INTEGER / 10000', () => {
    // pool * bps overflows a double here; the BigInt intermediate is what saves it.
    const pool = 9_007_199_254_740; // ~90 billion naira in kobo
    const result = allocateByBps(pool, [
      { partnerId: 'A', bps: 3333 },
      { partnerId: 'B', bps: 6667 },
    ]);
    expect(result.get('A')! + result.get('B')!).toBe(pool);
  });

  it('handles a zero pool', () => {
    const result = allocateByBps(0, [{ partnerId: 'A', bps: 10_000 }]);
    expect(result.get('A')).toBe(0);
  });
});

describe('distribute', () => {
  it('settles fixed amounts before percentages', () => {
    const result = distribute(100_000, [
      { partnerId: 'A', shareType: 'FIXED_AMOUNT', fixedAmountKobo: 20_000, priority: 1 },
      { partnerId: 'B', shareType: 'PERCENTAGE', shareBps: 5000 },
      { partnerId: 'C', shareType: 'PERCENTAGE', shareBps: 5000 },
    ]);
    const by = Object.fromEntries(result.allocations.map((a) => [a.partnerId, a.amountKobo]));
    expect(by.A).toBe(20_000);
    expect(by.B).toBe(40_000); // half of the 80,000 that remains
    expect(by.C).toBe(40_000);
    expect(result.unallocatedKobo).toBe(0);
  });

  it('reports a shortfall rather than going negative', () => {
    const result = distribute(5_000, [
      { partnerId: 'A', shareType: 'FIXED_AMOUNT', fixedAmountKobo: 20_000, priority: 1 },
      { partnerId: 'B', shareType: 'PERCENTAGE', shareBps: 10_000 },
    ]);
    const a = result.allocations.find((x) => x.partnerId === 'A')!;
    expect(a.amountKobo).toBe(5_000);
    expect(a.shortfallKobo).toBe(15_000);
    expect(result.allocations.find((x) => x.partnerId === 'B')!.amountKobo).toBe(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('honours priority order between fixed lines', () => {
    const result = distribute(30_000, [
      { partnerId: 'LATE', shareType: 'FIXED_AMOUNT', fixedAmountKobo: 25_000, priority: 50 },
      { partnerId: 'FIRST', shareType: 'FIXED_AMOUNT', fixedAmountKobo: 25_000, priority: 1 },
    ]);
    const by = Object.fromEntries(result.allocations.map((a) => [a.partnerId, a.amountKobo]));
    expect(by.FIRST).toBe(25_000);
    expect(by.LATE).toBe(5_000);
  });

  it('lets a residual line sweep what percentages leave behind', () => {
    const result = distribute(100_000, [
      { partnerId: 'A', shareType: 'PERCENTAGE', shareBps: 7000 },
      { partnerId: 'HOUSE', shareType: 'RESIDUAL' },
    ]);
    const by = Object.fromEntries(result.allocations.map((a) => [a.partnerId, a.amountKobo]));
    expect(by.A).toBe(70_000);
    expect(by.HOUSE).toBe(30_000);
    expect(result.unallocatedKobo).toBe(0);
  });

  it('pays only what a short formula promises, and reports the rest', () => {
    const result = distribute(100_000, [
      { partnerId: 'A', shareType: 'PERCENTAGE', shareBps: 4000 },
      { partnerId: 'B', shareType: 'PERCENTAGE', shareBps: 3000 },
    ]);
    const by = Object.fromEntries(result.allocations.map((a) => [a.partnerId, a.amountKobo]));
    // 40% and 30% of the pool -- not 57%/43% of it. A short formula must under-pay
    // and say so, never silently inflate the shares to absorb the difference.
    expect(by.A).toBe(40_000);
    expect(by.B).toBe(30_000);
    expect(result.unallocatedKobo).toBe(30_000);
    expect(result.warnings.join(' ')).toContain('do not total 100%');
    expect(result.allocations.reduce((s, a) => s + a.amountKobo, 0) + result.unallocatedKobo).toBe(100_000);
  });
});

describe('linesForCategory', () => {
  const lines = [
    { revenue_category: null, id: 'default' },
    { revenue_category: 'ADVERTISING', id: 'ads' },
  ];

  it('prefers a category-specific line', () => {
    expect(linesForCategory(lines, 'ADVERTISING').map((l) => l.id)).toEqual(['ads']);
  });

  it('falls back to the unscoped lines', () => {
    expect(linesForCategory(lines, 'STUDENT_PURCHASE').map((l) => l.id)).toEqual(['default']);
    expect(linesForCategory(lines, null).map((l) => l.id)).toEqual(['default']);
  });
});

describe('formatKobo', () => {
  it('renders naira and kobo', () => {
    expect(formatKobo(123_456)).toBe('₦1,234.56');
    expect(formatKobo(5)).toBe('₦0.05');
    expect(formatKobo(0)).toBe('₦0.00');
    expect(formatKobo(-123_456)).toBe('-₦1,234.56');
  });
});
