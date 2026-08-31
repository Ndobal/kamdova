import { handle } from 'hono/cloudflare-pages';
import app from '../src/index';

/**
 * The Pages Functions entry point.
 *
 * A single catch-all so the Hono router owns every path it declares -- the API
 * under /api and the public student page under /s/:slug.
 *
 * Pages serves a matching static file before it reaches a Function, so the
 * Flutter web build in `public/` wins for its own assets and this only runs for
 * everything else. That ordering is why the app and the API can share one
 * origin, which in turn means the browser never makes a cross-origin request
 * and there is no CORS preflight on the hot path.
 */
export const onRequest = handle(app);
