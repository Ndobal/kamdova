/** Every timestamp written to D1 goes through here, so the format never drifts. */
export const nowIso = (): string => new Date().toISOString();

export const plusSeconds = (seconds: number, from: Date = new Date()): string =>
  new Date(from.getTime() + seconds * 1000).toISOString();

export const plusMinutes = (minutes: number, from: Date = new Date()): string =>
  plusSeconds(minutes * 60, from);

export const isPast = (iso: string | null | undefined): boolean =>
  !!iso && new Date(iso).getTime() <= Date.now();

/** Date-only (YYYY-MM-DD) or full ISO; used for agreement effective dates. */
export function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(value)) return false;
  return !Number.isNaN(new Date(value).getTime());
}

/** True when `at` falls inside [from, to). A null `to` means open-ended. */
export function isEffectiveAt(from: string, to: string | null, at: Date = new Date()): boolean {
  const t = at.getTime();
  if (t < new Date(from).getTime()) return false;
  if (to && t >= new Date(to).getTime()) return false;
  return true;
}
