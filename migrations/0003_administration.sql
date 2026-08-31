-- TeachEasy Module 3 -- Super Admin, Deputy Super Admin, Audit & Settings

-- Append-only. No route in this codebase issues UPDATE or DELETE against it.
-- Actor identity is denormalised so a log line still reads correctly years
-- later, even if the user record is gone.
CREATE TABLE audit_logs (
  id           TEXT PRIMARY KEY,
  actor_id     TEXT,
  actor_email  TEXT,
  actor_roles  TEXT,
  action       TEXT NOT NULL,
  entity_type  TEXT,
  entity_id    TEXT,
  summary      TEXT,
  before_json  TEXT,
  after_json   TEXT,
  metadata     TEXT,
  ip_address   TEXT,
  user_agent   TEXT,
  request_id   TEXT,
  severity     TEXT NOT NULL DEFAULT 'INFO'
                 CHECK (severity IN ('INFO','NOTICE','WARNING','CRITICAL')),
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_audit_logs_created ON audit_logs (created_at);
CREATE INDEX idx_audit_logs_actor ON audit_logs (actor_id, created_at);
CREATE INDEX idx_audit_logs_entity ON audit_logs (entity_type, entity_id);
CREATE INDEX idx_audit_logs_action ON audit_logs (action, created_at);

-- Typed key/value configuration. Modules 4-12 add their own keys without a
-- schema migration. Keys flagged is_sensitive route through approval_requests
-- when the actor is not a Super Admin.
CREATE TABLE platform_settings (
  key          TEXT PRIMARY KEY,
  value        TEXT NOT NULL,
  value_type   TEXT NOT NULL DEFAULT 'string'
                 CHECK (value_type IN ('string','number','boolean','json')),
  category     TEXT NOT NULL,
  label        TEXT,
  description  TEXT,
  is_sensitive INTEGER NOT NULL DEFAULT 0,
  updated_by   TEXT REFERENCES users(id),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_platform_settings_category ON platform_settings (category);

-- The mechanism that makes a Deputy Super Admin safe to hand real duties to.
-- When a deputy attempts a sensitive action, the change is not applied -- it is
-- captured here as a PENDING request carrying its own payload, and a Super
-- Admin approves or rejects it. Approval applies the change and stamps
-- applied_at, so an approved-but-failed request is distinguishable from a
-- request that actually took effect.
CREATE TABLE approval_requests (
  id             TEXT PRIMARY KEY,
  request_type   TEXT NOT NULL,
  entity_type    TEXT,
  entity_id      TEXT,
  payload        TEXT NOT NULL,
  reason         TEXT,
  status         TEXT NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED','EXPIRED','APPLIED','FAILED')),
  requested_by   TEXT NOT NULL REFERENCES users(id),
  requested_at   TEXT NOT NULL,
  decided_by     TEXT REFERENCES users(id),
  decided_at     TEXT,
  decision_note  TEXT,
  applied_at     TEXT,
  failure_reason TEXT,
  expires_at     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_approval_requests_status ON approval_requests (status, requested_at);
CREATE INDEX idx_approval_requests_requester ON approval_requests (requested_by);
