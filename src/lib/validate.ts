import { ApiError, badRequest } from './http';

/**
 * A small hand-rolled validator. The existing Worker in this codebase carries
 * only `hono` as a dependency, so this keeps that shape rather than pulling in
 * a schema library for what amounts to a few dozen field checks.
 *
 * Collects every problem before throwing, so the Flutter client can highlight
 * all the bad fields in one pass instead of one error at a time.
 */
export class Validator {
  private readonly errors: Record<string, string> = {};

  constructor(private readonly body: Record<string, unknown>) {}

  private fail(field: string, message: string) {
    if (!this.errors[field]) this.errors[field] = message;
  }

  string(field: string, opts: { min?: number; max?: number; required?: boolean } = {}): string | undefined {
    const raw = this.body[field];
    if (raw === undefined || raw === null || raw === '') {
      if (opts.required) this.fail(field, 'This field is required.');
      return undefined;
    }
    if (typeof raw !== 'string') {
      this.fail(field, 'Must be text.');
      return undefined;
    }
    const value = raw.trim();
    if (opts.min !== undefined && value.length < opts.min) {
      this.fail(field, `Must be at least ${opts.min} characters.`);
      return undefined;
    }
    if (opts.max !== undefined && value.length > opts.max) {
      this.fail(field, `Must be at most ${opts.max} characters.`);
      return undefined;
    }
    return value;
  }

  email(field: string, required = true): string | undefined {
    const value = this.string(field, { required, max: 254 });
    if (value === undefined) return undefined;
    // Deliberately permissive: real validation is the verification email.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
      this.fail(field, 'Enter a valid email address.');
      return undefined;
    }
    return value.toLowerCase();
  }

  /**
   * Length is the control that matters; composition rules mostly push people
   * toward predictable substitutions. 10 characters minimum, and long
   * passphrases are allowed up to 200.
   */
  password(field: string, required = true): string | undefined {
    const raw = this.body[field];
    if (raw === undefined || raw === null || raw === '') {
      if (required) this.fail(field, 'This field is required.');
      return undefined;
    }
    if (typeof raw !== 'string') {
      this.fail(field, 'Must be text.');
      return undefined;
    }
    if (raw.length < 10) {
      this.fail(field, 'Use at least 10 characters.');
      return undefined;
    }
    if (raw.length > 200) {
      this.fail(field, 'Must be at most 200 characters.');
      return undefined;
    }
    return raw;
  }

  integer(field: string, opts: { min?: number; max?: number; required?: boolean } = {}): number | undefined {
    const raw = this.body[field];
    if (raw === undefined || raw === null || raw === '') {
      if (opts.required) this.fail(field, 'This field is required.');
      return undefined;
    }
    const value = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isInteger(value)) {
      this.fail(field, 'Must be a whole number.');
      return undefined;
    }
    if (opts.min !== undefined && value < opts.min) {
      this.fail(field, `Must be at least ${opts.min}.`);
      return undefined;
    }
    if (opts.max !== undefined && value > opts.max) {
      this.fail(field, `Must be at most ${opts.max}.`);
      return undefined;
    }
    return value;
  }

  boolean(field: string, fallback?: boolean): boolean | undefined {
    const raw = this.body[field];
    if (raw === undefined || raw === null) return fallback;
    if (typeof raw === 'boolean') return raw;
    if (raw === 'true' || raw === 1) return true;
    if (raw === 'false' || raw === 0) return false;
    this.fail(field, 'Must be true or false.');
    return undefined;
  }

  enum<T extends string>(field: string, allowed: readonly T[], opts: { required?: boolean } = {}): T | undefined {
    const value = this.string(field, { required: opts.required });
    if (value === undefined) return undefined;
    if (!allowed.includes(value as T)) {
      this.fail(field, `Must be one of: ${allowed.join(', ')}.`);
      return undefined;
    }
    return value as T;
  }

  date(field: string, opts: { required?: boolean } = {}): string | undefined {
    const value = this.string(field, { required: opts.required });
    if (value === undefined) return undefined;
    if (Number.isNaN(new Date(value).getTime())) {
      this.fail(field, 'Enter a valid date.');
      return undefined;
    }
    return value;
  }

  array<T = unknown>(field: string, opts: { required?: boolean; min?: number } = {}): T[] | undefined {
    const raw = this.body[field];
    if (raw === undefined || raw === null) {
      if (opts.required) this.fail(field, 'This field is required.');
      return undefined;
    }
    if (!Array.isArray(raw)) {
      this.fail(field, 'Must be a list.');
      return undefined;
    }
    if (opts.min !== undefined && raw.length < opts.min) {
      this.fail(field, `Provide at least ${opts.min} item(s).`);
      return undefined;
    }
    return raw as T[];
  }

  add(field: string, message: string) {
    this.fail(field, message);
  }

  /** Throws a single 400 carrying every field error found. */
  assert(): void {
    if (Object.keys(this.errors).length > 0) {
      throw badRequest('Some fields need attention.', { fields: this.errors });
    }
  }
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw badRequest('Request body must be a JSON object.');
    }
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw badRequest('Request body must be valid JSON.');
  }
}
