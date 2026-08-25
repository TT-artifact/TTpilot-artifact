#!/bin/bash
set -euo pipefail

TARGET_YML="${1:-}"
REPEAT=10
KEEP_CONTAINERS=false

if [[ -z "$TARGET_YML" ]]; then
  echo "Usage: $0 <target.yml> [--repeat N] [--keep-containers]"
  echo "Example: $0 targets/001-urlpages.yml --repeat 20"
  exit 1
fi

shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep-containers)
      KEEP_CONTAINERS=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESEARCH_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# shellcheck source=../utils/docker_utils.sh
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
setup_eval_paths "testurl" "$TARGET_NAME" "$TARGET_DIR"

NORMALIZED_BASE_URL=$(normalize_base_url "$BASE_URL")

UNPATCHED_URL=$(BASE_URL="$NORMALIZED_BASE_URL" python3 - <<'PYEOF'
import os, re
url = os.environ['BASE_URL']
m = re.match(r'(https?://[^:/]+)(:\d+)?(.*)', url)
if m:
    print(m.group(1) + ':8081' + (m.group(3) or '/'))
else:
    print(url)
PYEOF
)

PATCHED_URL=$(BASE_URL="$NORMALIZED_BASE_URL" python3 - <<'PYEOF'
import os, re
url = os.environ['BASE_URL']
m = re.match(r'(https?://[^:/]+)(:\d+)?(.*)', url)
if m:
    print(m.group(1) + ':8080' + (m.group(3) or '/'))
else:
    print(url)
PYEOF
)

echo "=== Load Time Overhead Measurement ==="
echo "App: $TARGET_NAME"
echo "Patched URL: $PATCHED_URL"
echo "Unpatched URL: $UNPATCHED_URL"
echo ""

validate_eval_prerequisites "$RUNTIME_DIR" "$SRC_DIR" || exit 1

create_cleanup_trap "$PROJECT_NAME" "$RUNTIME_DIR" "$RUNTIME_EVAL_DIR" "$KEEP_CONTAINERS"

echo "[Step 1/6] Preparing evaluation runtime environment..."
CONTEXT_ARG=""
[[ -n "$DOCKER_CONTEXT" ]] && CONTEXT_ARG="$RESEARCH_ROOT/$DOCKER_CONTEXT"
prepare_eval_runtime_dir "$TARGET_DIR" "$RUNTIME_EVAL_DIR" "$RESULTS_DIR" "$SRC_DIR" "$TARGET_COMMIT" "$RUNTIME_DIR" "$CONTEXT_ARG"

echo "[Step 2/6] Creating docker-compose files..."
NEEDS_MYSQL_FLAG=""
[[ "$NEEDS_MYSQL" == "true" ]] && NEEDS_MYSQL_FLAG="--needs-mysql"

python3 "$RESEARCH_ROOT/eval/utils/compose_utils.py" \
  --output "$RUNTIME_EVAL_DIR/docker-compose.unpatched.yml" \
  --unpatched-dir "$RUNTIME_EVAL_DIR/unpatched" \
  --dockerfile "$RUNTIME_EVAL_DIR/Dockerfile.unpatched" \
  --serve-port "$SERVE_PORT" \
  --host-port 8081 \
  --volumes-json "$VOLUMES_JSON" \
  --docker-context "$DOCKER_CONTEXT" \
  --research-root "$RESEARCH_ROOT" \
  --mysql-host-port 3307 \
  --patched-compose "$RUNTIME_DIR/docker-compose.yml" \
  --patched-port "$SERVE_PORT" \
  --unpatched-port "$SERVE_PORT" \
  $NEEDS_MYSQL_FLAG

echo "[Step 2b/6] Creating docker-compose.override.yml..."
create_backend_volume_override "$RUNTIME_EVAL_DIR"

echo "[Step 3/6] Building and starting containers..."
PATCHED_LOG="$RUNTIME_EVAL_DIR/build-patched.log"
UNPATCHED_LOG="$RUNTIME_EVAL_DIR/build-unpatched.log"
start_eval_containers "$PROJECT_NAME" "$RUNTIME_DIR" "$RUNTIME_EVAL_DIR" "$INIT_WAIT" "$PATCHED_LOG" "$UNPATCHED_LOG" || {
  echo "Build logs:"
  [[ -f "$PATCHED_LOG" ]] && echo "=== PATCHED ===" && tail -50 "$PATCHED_LOG"
  [[ -f "$UNPATCHED_LOG" ]] && echo "=== UNPATCHED ===" && tail -50 "$UNPATCHED_LOG"
  exit 1
}

echo "[Step 4/6] Testing URLs..."
URLS_FILE="$TARGET_DIR/eval/combined_urls.yaml"

if [[ ! -f "$URLS_FILE" ]]; then
  echo "Warning: $URLS_FILE not found, skipping URL tests"
else
  TESTURL_TARGET="$TARGET_NAME" \
  TESTURL_PATCHED_URL="$PATCHED_URL" \
  TESTURL_URLS_FILE="$URLS_FILE" \
  TESTURL_OUTPUT_DIR="$RESULTS_DIR" \
  TT_AUTH_ENABLED="$TT_AUTH_ENABLED" \
  TT_AUTH_TYPE="$TT_AUTH_TYPE" \
  TT_AUTH_LOGIN_URL="$TT_AUTH_LOGIN_URL" \
  TT_AUTH_EMAIL="$TT_AUTH_EMAIL" \
  TT_AUTH_PASSWORD="$TT_AUTH_PASSWORD" \
    npx --prefix "$SCRIPT_DIR" ts-node "$SCRIPT_DIR/scripts/test_urls.ts"

  echo "[Step 5/6] Generating target_urls.yaml from test results..."
  LATEST_JSON=$(find "$RESULTS_DIR" -name "testurl_*.json" -type f | sort -r | head -1)

  if [[ -z "$LATEST_JSON" ]]; then
    echo "Warning: No testurl_*.json found, skipping target_urls.yaml generation"
  else
    python3 "$SCRIPT_DIR/scripts/generate_target_urls.py" \
      --json-file "$LATEST_JSON" \
      --output "$TARGET_DIR/eval/target_urls.yaml"
  fi
fi

cleanup_eval_containers "$PROJECT_NAME" "$RUNTIME_DIR" "$RUNTIME_EVAL_DIR" "$KEEP_CONTAINERS"
exit 0
