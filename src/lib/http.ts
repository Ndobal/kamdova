import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * Every failure leaves the API in the same envelope:
 *   { error: { code, message, details? } }
 * so the Flutter client can switch on `code` instead of parsing prose.
 */
export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new ApiError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = 'Authentication required.') =>
  new ApiError(401, 'UNAUTHENTICATED', message);
export const forbidden = (message = 'You do not have permission to do that.', details?: unknown) =>
  new ApiError(403, 'FORBIDDEN', message, details);
export const notFound = (what = 'Resource') =>
  new ApiError(404, 'NOT_FOUND', `${what} not found.`);
export const conflict = (message: string, details?: unknown) =>
  new ApiError(409, 'CONFLICT', message, details);
export const unprocessable = (message: string, details?: unknown) =>
  new ApiError(422, 'UNPROCESSABLE', message, details);
export const tooManyRequests = (message: string, details?: unknown) =>
  new ApiError(429, 'TOO_MANY_REQUESTS', message, details);

export function ok<T>(c: Context, data: T, status: ContentfulStatusCode = 200) {
  return c.json({ data }, status);
}

export function paginated<T>(
  c: Context,
  items: T[],
  meta: { page: number; perPage: number; total: number },
) {
  return c.json({
    data: items,
    meta: { ...meta, totalPages: Math.max(1, Math.ceil(meta.total / meta.perPage)) },
  });
}

/** Clamped so a caller cannot ask for an unbounded page. */
export function readPagination(c: Context) {
  const page = Math.max(1, Number(c.req.query('page') ?? 1) || 1);
  const perPage = Math.min(100, Math.max(1, Number(c.req.query('perPage') ?? 25) || 25));
  return { page, perPage, offset: (page - 1) * perPage };
}

/**
 * Reads a declared route parameter. Hono types these as possibly-undefined even
 * when the path declares them, so this asserts the guarantee in one place
 * instead of scattering non-null assertions through every handler.
 */
export function routeParam(c: Context, name: string): string {
  const value = c.req.param(name);
  if (!value) throw badRequest(`Missing ${name} in the request path.`);
  return value;
}
