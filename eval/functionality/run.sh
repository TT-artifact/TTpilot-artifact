#!/bin/bash
set -euo pipefail

TARGET_YML="${1:-}"
MAX_PAGES=50
KEEP_CONTAINERS=false
PAGE_SOURCE="target-urls"
PATCHED_PORT=8080
UNPATCHED_PORT=8081
BACKEND_PORT=9000
MYSQL_PORT=3307

if [[ -z "$TARGET_YML" ]]; then
  echo "Usage: $0 <target.yml> [--max-pages N] [--patched-port N] [--unpatched-port N] [--backend-port N] [--mysql-port N] [--keep-containers] [--page-source {reports-db|discover}]"
  echo "Example: $0 targets/001-urlpages.yml --max-pages 20"
  echo "Example: $0 targets/001-urlpages.yml --page-source discover"
  exit 1
fi

shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --max-pages)
      MAX_PAGES="${2:-50}"
      shift 2
      ;;
    --patched-port)
      PATCHED_PORT="$2"
      shift 2
      ;;
    --unpatched-port)
      UNPATCHED_PORT="$2"
      shift 2
      ;;
    --backend-port)
      BACKEND_PORT="$2"
      shift 2
      ;;
    --mysql-port)
      MYSQL_PORT="$2"
      shift 2
      ;;
    --keep-containers)
      KEEP_CONTAINERS=true
      shift
      ;;
    --page-source)
      PAGE_SOURCE="${2:-reports-db}"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESEARCH_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"

source "$RESEARCH_ROOT/eval/utils/docker_utils.sh"

TARGET_YML_PATH="$RESEARCH_ROOT/$TARGET_YML"

if [[ ! -f "$TARGET_YML_PATH" ]]; then
  echo "Error: Target file not found: $TARGET_YML_PATH"
  exit 1
fi

eval "$(parse_target_config "$TARGET_YML_PATH")"
PROJECT_NAME="${TARGET_NAME//./-}"

TARGET_DIR="$RESEARCH_ROOT/out/targets/$TARGET_NAME"
SRC_DIR="$TARGET_DIR/src"
RUNTIME_DIR="$TARGET_DIR/runtime"
setup_eval_paths "functionality" "$TARGET_NAME" "$TARGET_DIR"

echo "=== Regression Testing Framework ==="
echo "App: $TARGET_NAME"
echo "Commit: $TARGET_COMMIT"
echo "Patched port: $PATCHED_PORT / Unpatched port: $UNPATCHED_PORT"
echo "Max pages: $MAX_PAGES"
echo ""

validate_eval_prerequisites "$RUNTIME_DIR" "$SRC_DIR" "$PATCHED_PORT" "$UNPATCHED_PORT" || exit 1

PATCHED_COMPOSE_FILE="$RUNTIME_EVAL_DIR/docker-compose.patched.yml"
create_cleanup_trap "$PROJECT_NAME" "$RUNTIME_DIR" "$RUNTIME_EVAL_DIR" "$KEEP_CONTAINERS" "functionality" "$PATCHED_COMPOSE_FILE"

echo "[Step 1/9] Preparing evaluation runtime environment..."
CONTEXT_ARG=""
[[ -n "$DOCKER_CONTEXT" ]] && CONTEXT_ARG="$RESEARCH_ROOT/$DOCKER_CONTEXT"
prepare_eval_runtime_dir "$TARGET_DIR" "$RUNTIME_EVAL_DIR" "$RESULTS_DIR" "$SRC_DIR" "$TARGET_COMMIT" "$RUNTIME_DIR" "$CONTEXT_ARG"

echo "[Step 2/9] Creating docker-compose files..."
NEEDS_MYSQL_FLAG=""
[[ "$NEEDS_MYSQL" == "true" ]] && NEEDS_MYSQL_FLAG="--needs-mysql"

python3 "$RESEARCH_ROOT/eval/utils/compose_utils.py" \
  --output "$RUNTIME_EVAL_DIR/docker-compose.unpatched.yml" \
  --unpatched-dir "$RUNTIME_EVAL_DIR/unpatched" \
  --dockerfile "$RUNTIME_EVAL_DIR/Dockerfile.unpatched" \
  --serve-port "$SERVE_PORT" \
  --host-port "$UNPATCHED_PORT" \
  --volumes-json "$VOLUMES_JSON" \
  --docker-context "$DOCKER_CONTEXT" \
  --research-root "$RESEARCH_ROOT" \
  --mysql-host-port "$MYSQL_PORT" \
  --patched-compose "$RUNTIME_DIR/docker-compose.yml" \
  --patched-port "$SERVE_PORT" \
  --unpatched-port "$UNPATCHED_PORT" \
  $NEEDS_MYSQL_FLAG

echo "[Step 2b/9] Creating docker-compose.override.yml..."
create_backend_volume_override "$RUNTIME_EVAL_DIR"

echo "[Step 2c/9] Creating eval-local patched compose + tt-policy.js (backend=$BACKEND_PORT, proxy=$PATCHED_PORT)..."
create_eval_tt_policy "$RUNTIME_DIR" "$RUNTIME_EVAL_DIR" "$BACKEND_PORT"
create_patched_eval_compose "$RUNTIME_DIR" "$RUNTIME_EVAL_DIR" "$BACKEND_PORT" "$PATCHED_PORT"

echo "[Step 3/9] Building and starting containers..."
start_eval_containers "$PROJECT_NAME" "$RUNTIME_DIR" "$RUNTIME_EVAL_DIR" "$INIT_WAIT" "" "" "$PATCHED_PORT" "$UNPATCHED_PORT" "$PATCHED_COMPOSE_FILE" || exit 1

echo "[Step 4/9] Phase 1: Discovering page actions ($PAGE_SOURCE)..."
cd "$SCRIPT_DIR"
npm install >/dev/null 2>&1 || npm ci >/dev/null 2>&1

ACTIONS_FILE="$RESULTS_DIR/actions-$TARGET_NAME.json"
NORMALIZED_BASE_URL=$(normalize_base_url "$BASE_URL")
TARGET_URL=""

TARGET_URLS_FILE="$TARGET_DIR/eval/target_urls.yaml"
if [[ "$PAGE_SOURCE" == "target-urls" ]]; then
  if [[ ! -f "$TARGET_URLS_FILE" ]]; then
    echo "Error: target_urls.yaml not found: $TARGET_URLS_FILE"
    echo "Run eval/testurl/run.sh first to generate target URLs."
    cleanup_eval_containers "$PROJECT_NAME" "$RUNTIME_DIR" "$RUNTIME_EVAL_DIR" "$KEEP_CONTAINERS" "$PATCHED_COMPOSE_FILE"
    exit 1
  fi
  echo "Using target_urls.yaml for action generation..."
  PAGE_SOURCE="reports-db"
fi

if [[ "$PAGE_SOURCE" == "reports-db" ]]; then
  echo "Using reports.db from TT crawler..."
  TARGET_URL=$(NORMALIZED_BASE_URL="$NORMALIZED_BASE_URL" UNPATCHED_PORT="$UNPATCHED_PORT" python3 -c "
import os
from urllib.parse import urlparse, urlunparse
u = urlparse(os.environ['NORMALIZED_BASE_URL'])
new_netloc = (u.hostname or 'localhost') + ':' + os.environ['UNPATCHED_PORT']
print(urlunparse(u._replace(netloc=new_netloc)))
")
  python3 "$RESEARCH_ROOT/eval/utils/build_actions.py" \
    --target-dir "$TARGET_DIR" \
    --base-url "$NORMALIZED_BASE_URL" \
    --target-url "$TARGET_URL" \
    --out "$ACTIONS_FILE" || {
      echo "Error: build_actions.py failed"
      cleanup_eval_containers "$PROJECT_NAME" "$RUNTIME_DIR" "$RUNTIME_EVAL_DIR" "$KEEP_CONTAINERS" "$PATCHED_COMPOSE_FILE"
      exit 1
    }
fi

echo "[Step 5/9] Phase 2: Replaying and comparing..."
REGRESSION_PATCHED_URL="http://localhost:$PATCHED_PORT" \
REGRESSION_UNPATCHED_URL="http://localhost:$UNPATCHED_PORT" \
REGRESSION_APP="$TARGET_NAME" \
REGRESSION_APP_ID="$TARGET_NAME" \
REGRESSION_ACTIONS_FILE="$ACTIONS_FILE" \
REGRESSION_RESULTS_DIR="$RESULTS_DIR" \
REGRESSION_DB_PATH="$RESULTS_DIR/regression_results.db" \
TT_AUTH_ENABLED="$TT_AUTH_ENABLED" \
TT_AUTH_TYPE="$TT_AUTH_TYPE" \
TT_AUTH_LOGIN_URL="$TT_AUTH_LOGIN_URL" \
TT_AUTH_EMAIL="$TT_AUTH_EMAIL" \
TT_AUTH_PASSWORD="$TT_AUTH_PASSWORD" \
npx playwright test tests/regression-check.spec.ts --reporter=list 2>&1 || true

echo "[Step 6/9] Test complete"
REPORT_FILE=$(find "$RESULTS_DIR" -name "regression-$TARGET_NAME-*.html" -type f | head -1)
SUMMARY_FILE=$(find "$RESULTS_DIR" -name "regression-summary-$TARGET_NAME-*.json" -type f | head -1)

if [[ -n "$REPORT_FILE" ]] || [[ -n "$SUMMARY_FILE" ]]; then
  echo "Results generated:"
  [[ -n "$SUMMARY_FILE" ]] && echo "  JSON Summary: $SUMMARY_FILE"
  [[ -n "$REPORT_FILE" ]] && echo "  HTML Report: $REPORT_FILE"
  echo ""
  echo "All results saved to: $EVAL_DIR"
else
  echo "Warning: Report files not found"
  echo "Check results at: $RESULTS_DIR"
fi

echo ""
echo "=== Complete ==="

cleanup_eval_containers "$PROJECT_NAME" "$RUNTIME_DIR" "$RUNTIME_EVAL_DIR" "$KEEP_CONTAINERS" "$PATCHED_COMPOSE_FILE"
exit 0
