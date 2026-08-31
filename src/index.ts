import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import type { App } from './types';
import { ApiError } from './lib/http';
import { requireAuth } from './lib/rbac';
import { agreementRoutes } from './routes/agreements';
import { authRoutes } from './routes/auth';
import { bootstrapRoutes } from './routes/bootstrap';
import { meRoutes } from './routes/me';
import { partnerRoutes, partnershipGroupRoutes } from './routes/partners';
import { adminApprovalRoutes } from './routes/admin/approvals';
import { adminAuditRoutes } from './routes/admin/audit';
import { adminRoleRoutes } from './routes/admin/roles';
import { adminSettingsRoutes } from './routes/admin/settings';
import { adminUserRoutes } from './routes/admin/users';
import { adminBillingRoutes, billingRoutes, marketplaceRoutes } from './routes/billing';
import { lessonRoutes } from './routes/lessons';
import { noteRoutes } from './routes/notes';
import { publicRoutes } from './routes/public';
import { referenceRoutes, teacherRoutes } from './routes/teachers';
import { templateRoutes } from './routes/templates';

const app = new Hono<App>();

// Every response carries a request id, and every audit line records it, so a
// user-reported failure can be traced to the exact request that caused it.
app.use('*', async (c, next) => {
  const requestId = c.req.header('CF-Ray') ?? crypto.randomUUID();
  c.set('requestId', requestId);
  c.header('X-Request-Id', requestId);
  await next();
});

app.use('*', secureHeaders());

/**
 * A single allowed origin from configuration -- never a reflected request
 * origin, and never `*` alongside credentials. The Flutter mobile client sends
 * no Origin header and is unaffected by CORS; this exists for the web dashboard.
 */
app.use('*', (c, next) =>
  cors({
    origin: c.env.CORS_ORIGIN,
    credentials: true,
    allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    exposeHeaders: ['X-Request-Id', 'Retry-After'],
    maxAge: 600,
  })(c, next),
);

app.get('/api/health', (c) =>
  c.json({ data: { status: 'ok', environment: c.env.ENVIRONMENT, time: new Date().toISOString() } }),
);

// ---- public: rate-limited, no session required -----------------------------
app.route('/api/auth', authRoutes);
app.route('/api/bootstrap', bootstrapRoutes);

// The read-only student page. Deliberately unauthenticated -- access is proved
// by an unguessable, revocable, expiring share slug rather than a session.
app.route('/', publicRoutes);

// ---- authenticated ---------------------------------------------------------
app.route('/api/me', meRoutes);

/**
 * Deny by default.
 *
 * Everything below this line requires a verified session before the router is
 * even consulted, and each route then declares the permission it needs. A new
 * handler added under these prefixes cannot accidentally ship unauthenticated:
 * the worst mistake possible is authenticated-but-unauthorised, not open.
 */
app.use('/api/admin/*', requireAuth);
app.use('/api/partners/*', requireAuth);
app.use('/api/partnership-groups/*', requireAuth);
app.use('/api/agreements/*', requireAuth);
app.use('/api/teachers/*', requireAuth);
app.use('/api/lessons/*', requireAuth);
app.use('/api/notes/*', requireAuth);
app.use('/api/templates/*', requireAuth);
app.use('/api/reference/*', requireAuth);
app.use('/api/billing/*', requireAuth);
app.use('/api/marketplace/*', requireAuth);

app.route('/api/admin/users', adminUserRoutes);
app.route('/api/admin/roles', adminRoleRoutes);
app.route('/api/admin/settings', adminSettingsRoutes);
app.route('/api/admin/audit-logs', adminAuditRoutes);
app.route('/api/admin/approvals', adminApprovalRoutes);
app.route('/api/partners', partnerRoutes);
app.route('/api/partnership-groups', partnershipGroupRoutes);
app.route('/api/agreements', agreementRoutes);
app.route('/api/teachers', teacherRoutes);
app.route('/api/lessons', lessonRoutes);
app.route('/api/notes', noteRoutes);
app.route('/api/templates', templateRoutes);
app.route('/api/reference', referenceRoutes);
app.route('/api/billing', billingRoutes);
app.route('/api/marketplace', marketplaceRoutes);
app.route('/api/admin/billing', adminBillingRoutes);

app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'No such endpoint.' } }, 404));

/**
 * One error shape for the whole API.
 *
 * Known ApiErrors report their own message. Anything else is logged in full
 * server-side and reduced to a generic message for the client -- an unexpected
 * exception can carry SQL, table names or row contents, none of which belong in
 * a response body.
 */
app.onError((error, c) => {
  const requestId = c.get('requestId');

  if (error instanceof ApiError) {
    return c.json(
      { error: { code: error.code, message: error.message, details: error.details, requestId } },
      error.status,
    );
  }

  console.error('unhandled error', requestId, error);
  return c.json(
    { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.', requestId } },
    500,
  );
});

export default app;
