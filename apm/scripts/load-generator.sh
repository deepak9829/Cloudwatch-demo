#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# load-generator.sh
#
# Sends mixed traffic to the CloudWatch APM demo API to populate X-Ray traces,
# the service map, and CloudWatch metrics with meaningful data.
#
# Usage:
#   ./scripts/load-generator.sh <API_URL> [REQUESTS] [CONCURRENCY]
#
# Example:
#   ./scripts/load-generator.sh https://abc123.execute-api.us-east-1.amazonaws.com/prod 200 5
#
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

API_URL="${1:?Usage: $0 <API_URL> [REQUESTS] [CONCURRENCY]}"
TOTAL_REQUESTS="${2:-100}"
CONCURRENCY="${3:-3}"

# Strip trailing slash
API_URL="${API_URL%/}"

PASS=0; FAIL=0; TOTAL=0

# ── Colour helpers ────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

log()  { echo -e "${CYAN}[$(date '+%H:%M:%S')]${NC} $*"; }
ok()   { echo -e "${GREEN}  ✓${NC} $*"; ((PASS++)) || true; }
err()  { echo -e "${RED}  ✗${NC} $*"; ((FAIL++)) || true; }
warn() { echo -e "${YELLOW}  ~${NC} $*"; }

# ── Scenario catalogue ────────────────────────────────────────────────────────
# Each entry: "PRODUCT_ID|CUSTOMER_ID|QTY|LABEL"
SCENARIOS=(
  "PROD-001|CUST-0042|2|standard headphones"
  "PROD-001|CUST-0043|1|standard headphones"
  "PROD-002|CUST-VIP-007|1|VIP keyboard (30% OOS, SMS notif)"
  "PROD-002|CUST-0010|3|keyboard (30% OOS)"
  "PROD-003|CUST-0099|1|USB hub (intentionally slow 300-800ms)"
  "PROD-004|CUST-0001|1|monitor stand (always OOS – expect 409)"
  "PROD-005|CUST-VIP-001|2|VIP webcam order"
  "PROD-001|CUST-0077|5|bulk headphones"
  "PROD-999|CUST-0050|1|unknown product (default behaviour)"
)

send_order() {
  local product_id="$1" customer_id="$2" qty="$3" label="$4"
  local body
  body=$(printf '{"customerId":"%s","productId":"%s","quantity":%d}' \
    "$customer_id" "$product_id" "$qty")

  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "${API_URL}/orders" \
    -H "Content-Type: application/json" \
    -d "$body" \
    --max-time 35)

  ((TOTAL++)) || true
  case "$http_code" in
    201) ok "POST /orders [${label}] → 201 Created" ;;
    409) warn "POST /orders [${label}] → 409 Out of Stock (expected for PROD-004)" ;;
    400) err "POST /orders [${label}] → 400 Bad Request" ;;
    5*)  err "POST /orders [${label}] → ${http_code} Server Error" ;;
    *)   warn "POST /orders [${label}] → ${http_code}" ;;
  esac
}

get_orders() {
  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" \
    "${API_URL}/orders?limit=20" --max-time 15)
  ((TOTAL++)) || true
  [[ "$http_code" == "200" ]] && ok "GET /orders → 200" || err "GET /orders → ${http_code}"
}

health_check() {
  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" "${API_URL}/health" --max-time 10)
  [[ "$http_code" == "200" ]] && log "Health check passed (200)" \
    || { echo -e "${RED}Health check FAILED (${http_code}) – is the API URL correct?${NC}"; exit 1; }
}

# ── Main ──────────────────────────────────────────────────────────────────────
log "Target  : ${API_URL}"
log "Requests: ${TOTAL_REQUESTS}  Concurrency: ${CONCURRENCY}"
echo ""

log "Running health check…"
health_check
echo ""

log "Starting load generation (${TOTAL_REQUESTS} requests, ${CONCURRENCY} parallel)…"

REQUEST_COUNT=0
PIDS=()

while [[ $REQUEST_COUNT -lt $TOTAL_REQUESTS ]]; do
  # Pick scenario
  idx=$(( RANDOM % ${#SCENARIOS[@]} ))
  IFS='|' read -r pid cid qty label <<< "${SCENARIOS[$idx]}"

  # Occasionally do a GET to mix read traffic
  if (( RANDOM % 5 == 0 )); then
    get_orders &
  else
    send_order "$pid" "$cid" "$qty" "$label" &
  fi

  PIDS+=($!)
  ((REQUEST_COUNT++)) || true

  # Throttle to CONCURRENCY parallel jobs
  if (( ${#PIDS[@]} >= CONCURRENCY )); then
    wait "${PIDS[0]}"
    PIDS=("${PIDS[@]:1}")
  fi

  sleep 0.2  # slight delay to spread requests over time
done

# Wait for remaining jobs
for pid in "${PIDS[@]}"; do wait "$pid"; done

echo ""
log "─────────────────────────────────────"
log "Done. Total: ${TOTAL}  Pass: ${PASS}  Fail/Warn: ${FAIL}"
log "─────────────────────────────────────"
echo ""
echo -e "${CYAN}Next steps:${NC}"
echo "  1. CloudWatch → X-Ray → Service Map"
echo "     https://console.aws.amazon.com/xray/home#/service-map"
echo "  2. CloudWatch → X-Ray → Traces (filter by Annotation.orderStatus)"
echo "  3. CloudWatch → Dashboards → CloudWatch-APM-Demo-*"
