#!/usr/bin/env bash
# HTTP smoke test against a running instance of the service.
#
# Usage: scripts/smoke-test.sh [base-url]
#   base-url defaults to http://localhost:8080
#
# For a deployed environment, port-forward first:
#   kubectl -n sample-service-uat port-forward svc/sample-service 8080:80
set -euo pipefail

base_url="${1:-http://localhost:8080}"
max_wait="${SMOKE_MAX_WAIT:-30}"

echo "==> waiting up to ${max_wait}s for ${base_url}/healthz"
for _ in $(seq 1 "${max_wait}"); do
  if curl -fsS --max-time 2 "${base_url}/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

check() {
  local path="$1" expected="$2"
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "${base_url}${path}")
  if [ "${code}" != "${expected}" ]; then
    echo "    FAIL ${path}: expected ${expected}, got ${code}"
    return 1
  fi
  echo "    ok   ${path} -> ${code}"
}

echo "==> endpoint checks"
check /healthz 200
check /readyz 200
check /api/v1/hello 200
check /metrics 200
check /does-not-exist 404

echo "==> payload checks"
curl -fsS --max-time 5 "${base_url}/api/v1/hello" | grep -q '"message"' \
  || { echo "    FAIL: /api/v1/hello missing message field"; exit 1; }
curl -fsS --max-time 5 "${base_url}/metrics" | grep -q '^http_requests_total' \
  || { echo "    FAIL: /metrics missing http_requests_total"; exit 1; }
echo "    ok   payloads"

echo "==> smoke test passed"
