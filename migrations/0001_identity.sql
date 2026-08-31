-- TeachEasy Module 1 -- Authentication, Users, Roles & Permissions
--
-- Conventions used throughout every migration:
--   * ids are TEXT uuids generated in the Worker (crypto.randomUUID())
--   * timestamps are TEXT ISO-8601 UTC ('2026-09-01T10:30:00.000Z')
--   * booleans are INTEGER 0/1
--   * money is INTEGER kobo (never float); percentages are INTEGER basis points
--   * enum-ish columns are TEXT guarded by CHECK constraints

-- The credential record. Deliberately separate from `profiles` so that auth
-- churn (hashes, lockouts, verification) never mixes with displayable person data.
CREATE TABLE users (
  id                    TEXT PRIMARY KEY,
  email                 TEXT NOT NULL COLLATE NOCASE,
  password_hash         TEXT NOT NULL,
  password_algo         TEXT NOT NULL DEFAULT 'pbkdf2-sha256',
  email_verified_at     TEXT,
  status                TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION'
                          CHECK (status IN ('PENDING_VERIFICATION','ACTIVE','SUSPENDED','DEACTIVATED')),
  status_reason         TEXT,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until          TEXT,
  last_login_at         TEXT,
  password_changed_at   TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  deleted_at            TEXT
);
CREATE UNIQUE INDEX idx_users_email ON users (email);
CREATE INDEX idx_users_status ON users (status);

-- 1:1 personal details. Named `profiles` per the module spec.
CREATE TABLE profiles (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  first_name   TEXT,
  last_name    TEXT,
  display_name TEXT,
  phone        TEXT,
  avatar_url   TEXT,
  gender       TEXT CHECK (gender IN ('MALE','FEMALE','OTHER','UNDISCLOSED')),
  date_of_birth TEXT,
  country      TEXT NOT NULL DEFAULT 'NG',
  state        TEXT,
  city         TEXT,
  address      TEXT,
  timezone     TEXT NOT NULL DEFAULT 'Africa/Lagos',
  bio          TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_profiles_phone ON profiles (phone);

CREATE TABLE roles (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT,
  -- higher rank = more authority. Used to stop a deputy editing a super admin.
  rank        INTEGER NOT NULL DEFAULT 0,
  is_system   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE permissions (
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  description  TEXT,
  category     TEXT NOT NULL,
  -- sensitive permissions cannot be exercised directly by a deputy; the action
  -- is turned into an approval_request for a SUPER_ADMIN to decide.
  is_sensitive INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_permissions_category ON permissions (category);

CREATE TABLE role_permissions (
  role_id       TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE user_roles (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id    TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  granted_by TEXT REFERENCES users(id),
  granted_at TEXT NOT NULL,
  expires_at TEXT,
  UNIQUE (user_id, role_id)
);
CREATE INDEX idx_user_roles_user ON user_roles (user_id);

-- Per-user permission overrides. This is what makes Deputy Super Admins work:
-- the role grants a baseline, then the Super Admin hands an individual deputy
-- exactly the extra duties they should have -- or revokes one with a DENY.
CREATE TABLE user_permissions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  effect        TEXT NOT NULL DEFAULT 'GRANT' CHECK (effect IN ('GRANT','DENY')),
  granted_by    TEXT REFERENCES users(id),
  granted_at    TEXT NOT NULL,
  expires_at    TEXT,
  note          TEXT,
  UNIQUE (user_id, permission_id)
);
CREATE INDEX idx_user_permissions_user ON user_permissions (user_id);

-- One row per active refresh token. Storing the hash (not the token) means a
-- database leak cannot be replayed as a session.
CREATE TABLE sessions (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  user_agent         TEXT,
  ip_address         TEXT,
  expires_at         TEXT NOT NULL,
  revoked_at         TEXT,
  revoked_reason     TEXT,
  -- set when this session was produced by rotating an older one. If a token
  -- whose session is already rotated/revoked is presented again, that is a
  -- replay: the whole family gets revoked.
  rotated_from       TEXT REFERENCES sessions(id),
  created_at         TEXT NOT NULL,
  last_used_at       TEXT
);
CREATE INDEX idx_sessions_user ON sessions (user_id);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);

-- Single-use, hashed, expiring tokens for email verification and password reset.
CREATE TABLE auth_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('EMAIL_VERIFICATION','PASSWORD_RESET')),
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_auth_tokens_user_purpose ON auth_tokens (user_id, purpose);
