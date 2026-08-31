import type { Context } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import type { App, EnvBindings } from '../types';

/**
 * Cookies exist for a future browser dashboard. The Flutter client ignores them
 * entirely and uses the tokens returned in the response body -- a native app has
 * no cookie jar, and httpOnly cookies are unreadable to Dart by design.
 *
 * SameSite=None is required whenever the web dashboard sits on a different
 * origin from the Worker; browsers only accept it together with Secure, so it
 * is only used when COOKIE_SECURE is on.
 */
export const ACCESS_COOKIE = 'teacheasy_access_token';
export const REFRESH_COOKIE = 'teacheasy_refresh_token';

function options(env: EnvBindings, maxAge: number) {
  const secure = env.COOKIE_SECURE === 'true';
  return {
    httpOnly: true,
    secure,
    sameSite: (secure ? 'None' : 'Lax') as 'None' | 'Lax',
    path: '/',
    maxAge,
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  };
}

export function setAuthCookies(
  c: Context<App>,
  tokens: { accessToken: string; refreshToken: string },
) {
  setCookie(c, ACCESS_COOKIE, tokens.accessToken, options(c.env, Number(c.env.ACCESS_TOKEN_TTL_SECONDS) || 900));
  setCookie(c, REFRESH_COOKIE, tokens.refreshToken, options(c.env, Number(c.env.REFRESH_TOKEN_TTL_SECONDS) || 2_592_000));
}

export function clearAuthCookies(c: Context<App>) {
  const base = options(c.env, 0);
  deleteCookie(c, ACCESS_COOKIE, base);
  deleteCookie(c, REFRESH_COOKIE, base);
}
