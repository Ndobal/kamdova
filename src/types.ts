export interface EnvBindings {
  DB: D1Database;
  R2: R2Bucket;

  // Secrets. Local: .dev.vars. Production: wrangler secret put.
  JWT_ACCESS_SECRET: string;
  JWT_REFRESH_SECRET: string;

  ENVIRONMENT: string;
  CORS_ORIGIN: string;
  COOKIE_SECURE: string;
  COOKIE_DOMAIN: string;
  ACCESS_TOKEN_TTL_SECONDS: string;
  REFRESH_TOKEN_TTL_SECONDS: string;
  PASSWORD_HASH_ITERATIONS: string;
  MAX_FAILED_LOGINS: string;
  ACCOUNT_LOCK_MINUTES: string;

  /** Workers AI. Inference runs on this binding, with no external call. */
  AI?: Ai;
  /** "workers-ai" (default) or "anthropic". */
  AI_PROVIDER?: string;
  AI_MODEL?: string;
  /** Estimated ledger cost for Workers AI, which bills in neurons not tokens. */
  AI_KOBO_PER_1K_TOKENS?: string;
  /** Only needed when AI_PROVIDER is "anthropic". */
  ANTHROPIC_API_KEY?: string;
  USD_TO_NGN?: string;
  /** Origin used to build share links; falls back to the request origin. */
  PUBLIC_BASE_URL?: string;
  /** Keys the device-id HMAC. Falls back to JWT_REFRESH_SECRET if unset. */
  DEVICE_HASH_SECRET?: string;
}

/** Resolved once per request by requireAuth and read by every handler after it. */
export interface AuthContext {
  userId: string;
  email: string;
  sessionId: string;
  roles: string[];
  permissions: string[];
  isSuperAdmin: boolean;
  /** Set when this user is linked to a partner record; drives self-scoped access. */
  partnerId: string | null;
}

export interface AppVariables {
  auth: AuthContext;
  requestId: string;
  /** Set by requireGenerationAllowance; read after a successful generation. */
  entitlement?: import('./lib/entitlements').Entitlement;
}

export type App = { Bindings: EnvBindings; Variables: AppVariables };

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  password_algo: string;
  email_verified_at: string | null;
  status: 'PENDING_VERIFICATION' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
  status_reason: string | null;
  failed_login_attempts: number;
  locked_until: string | null;
  last_login_at: string | null;
  password_changed_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface AgreementRow {
  id: string;
  group_id: string;
  version: number;
  parent_agreement_id: string | null;
  title: string;
  summary: string | null;
  status:
    | 'DRAFT' | 'PROPOSED' | 'UNDER_REVIEW' | 'ACCEPTED' | 'ACTIVE'
    | 'REJECTED' | 'CANCELLED' | 'SUPERSEDED' | 'TERMINATED' | 'EXPIRED';
  basis: 'GROSS' | 'NET';
  distribution_frequency: string;
  rounding_mode: 'LARGEST_REMAINDER' | 'TO_FIRST_PARTNER';
  effective_from: string;
  effective_to: string | null;
  requires_all_partners: number;
  approval_threshold_bps: number | null;
  payout_approver_role: string | null;
  proposed_by: string | null;
  proposed_at: string | null;
  accepted_at: string | null;
  activated_by: string | null;
  activated_at: string | null;
  terminated_by: string | null;
  terminated_at: string | null;
  termination_reason: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgreementLineRow {
  id: string;
  agreement_id: string;
  partner_id: string;
  share_type: 'PERCENTAGE' | 'FIXED_AMOUNT' | 'RESIDUAL';
  share_bps: number | null;
  fixed_amount_kobo: number | null;
  revenue_category: string | null;
  priority: number;
  note: string | null;
  created_at: string;
  updated_at: string;
}
