#!/usr/bin/env bash
# Runs every suite against a clean database.
#
#   bash scripts/test-all.sh            # fast, no AI spend
#   RUN_AI=1 bash scripts/test-all.sh   # also makes live Workers AI calls
#
# Each suite gets a fresh database. The readiness gate waits for D1 to be
# genuinely queryable rather than just for the HTTP server to answer -- a
# health check passes before the local D1 has finished settling after a reset,
# and starting a suite in that window produces confusing downstream failures.
set -u

PORT="${PORT:-8787}"
BASE="http://127.0.0.1:$PORT"
DB="kamdova-db"
FAILED=0

stop() {
  taskkill //F //IM workerd.exe >/dev/null 2>&1 || true
  pkill -f "wrangler" 2>/dev/null || true
  sleep 3
}

reset_db() {
  stop
  rm -rf .wrangler/state/v3/d1 2>/dev/null || true
  npx wrangler d1 migrations apply "$DB" --local >/dev/null 2>&1
  for f in reference-data teaching-reference commerce-reference brand-reference; do
    npx wrangler d1 execute "$DB" --local --file="./seeds/$f.sql" >/dev/null 2>&1
  done

  npx wrangler pages dev --port "$PORT" > /tmp/pages.log 2>&1 &

  # 1. the server answers
  for _ in $(seq 1 50); do
    curl -s -m 2 "$BASE/api/health" >/dev/null 2>&1 && break
    sleep 1
  done

  # 2. and D1 is readable through the CLI, which is what the suites use to seed
  for _ in $(seq 1 20); do
    if npx wrangler d1 execute "$DB" --local \
         --command "SELECT 1 FROM lesson_templates LIMIT 1" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "  !! database did not become ready"
  return 1
}

reset_db; echo "=== Identity, partnership, administration ==="
bash scripts/smoke-test.sh 2>&1 | grep -E "FAIL|passed" || FAILED=1

reset_db; echo "=== Teaching: templates, lessons, notes, sharing ==="
bash scripts/smoke-test-teaching.sh 2>&1 | grep -E "FAIL|passed" || FAILED=1

reset_db; echo "=== Billing: brand, trials, quota, plans ==="
bash scripts/smoke-test-billing.sh 2>&1 | grep -E "FAIL|passed" || FAILED=1

stop
echo "=== Unit tests ==="
npx vitest run --reporter=basic 2>&1 | grep -E "Tests |Test Files"

echo "=== Typecheck ==="
npx tsc --noEmit && echo "  clean"
