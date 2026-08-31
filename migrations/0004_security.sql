-- Rate limiting state.
--
-- Workers isolates are short-lived and there is no shared memory between them,
-- so an in-process counter would reset constantly and enforce nothing. This
-- keeps the counter in D1 where every isolate sees the same number.
--
-- Fixed-window counting: a row per (bucket, subject) pair, reset when the
-- window rolls over. Rows past expires_at are dead and get swept opportunistically.
CREATE TABLE rate_limits (
  key               TEXT PRIMARY KEY,
  count             INTEGER NOT NULL DEFAULT 0,
  window_started_at TEXT NOT NULL,
  expires_at        TEXT NOT NULL
);
CREATE INDEX idx_rate_limits_expires ON rate_limits (expires_at);
