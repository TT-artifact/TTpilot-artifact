#!/bin/bash
set -euo pipefail

TARGET_YML="${1:-}"
REPEAT=10
KEEP_CONTAINERS=false
PATCHED_PORT=8080
UNPATCHED_PORT=8081
BACKEND_PORT=9000
MYSQL_PORT=3307

if [[ -z "$TARGET_YML" ]]; then
  echo "Usage: $0 <target.yml> [--repeat N] [--patched-port N] [--unpatched-port N] [--backend-port N] [--mysql-port N] [--keep-containers]"
  echo "Example: $0 targets/001-urlpages.yml --repeat 20"
  exit 1
fi

shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repeat)
      REPEAT="${2:-10}"
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
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESEARCH_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

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
setup_eval_paths "overhead" "$TARGET_NAME" "$TARGET_DIR"

NORMALIZED_BASE_URL=$(normalize_base_url "$BASE_URL")

UNPATCHED_URL=$(BASE_URL="$NORMALIZED_BASE_URL" UNPATCHED_PORT="$UNPATCHED_PORT" python3 - <<'PYEOF'
import os, re
url = os.environ['BASE_URL']
port = os.environ['UNPATCHED_PORT']
m = re.match(r'(https?://[^:/]+)(:\d+)?(.*)', url)
if m:
    print(m.group(1) + ':' + port + (m.group(3) or '/'))
else:
    print(url)
PYEOF
)

PATCHED_URL=$(BASE_URL="$NORMALIZED_BASE_URL" PATCHED_PORT="$PATCHED_PORT" python3 - <<'PYEOF'
import os, re
url = os.environ['BASE_URL']
port = os.environ['PATCHED_PORT']
m = re.match(r'(https?://[^:/]+)(:\d+)?(.*)', url)
if m:
    print(m.group(1) + ':' + port + (m.group(3) or '/'))
else:
    print(url)
PYEOF
)

echo "=== Load Time Overhead Measurement ==="
echo "App: $TARGET_NAME"
echo "Patched URL: $PATCHED_URL"
echo "Unpatched URL: $UNPATCHED_URL"
echo "Repeat: $REPEAT"
echo ""

validate_eval_prerequisites "$RUNTIME_DIR" "$SRC_DIR" "$PATCHED_PORT" "$UNPATCHED_PORT" || exit 1

PATCHED_COMPOSE_FILE="$RUNTIME_EVAL_DIR/docker-compose.patched.yml"
create_cleanup_trap "$PROJECT_NAME" "$RUNTIME_DIR" "$RUNTIME_EVAL_DIR" "$KEEP_CONTAINERS" "overhead" "$PATCHED_COMPOSE_FILE"

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
  --host-port "$UNPATCHED_PORT" \
  --volumes-json "$VOLUMES_JSON" \
  --docker-context "$DOCKER_CONTEXT" \
  --research-root "$RESEARCH_ROOT" \
  --mysql-host-port "$MYSQL_PORT" \
  --patched-compose "$RUNTIME_DIR/docker-compose.yml" \
  --patched-port "$SERVE_PORT" \
  --unpatched-port "$UNPATCHED_PORT" \
  $NEEDS_MYSQL_FLAG

echo "[Step 2b/6] Creating docker-compose.override.yml..."
create_backend_volume_override "$RUNTIME_EVAL_DIR"

echo "[Step 2c/6] Creating eval-local patched compose + tt-policy.js (backend=$BACKEND_PORT, proxy=$PATCHED_PORT)..."
create_eval_tt_policy "$RUNTIME_DIR" "$RUNTIME_EVAL_DIR" "$BACKEND_PORT"
create_patched_eval_compose "$RUNTIME_DIR" "$RUNTIME_EVAL_DIR" "$BACKEND_PORT" "$PATCHED_PORT"

echo "[Step 3/6] Building and starting containers..."
start_eval_containers "$PROJECT_NAME" "$RUNTIME_DIR" "$RUNTIME_EVAL_DIR" "$INIT_WAIT" "" "" "$PATCHED_PORT" "$UNPATCHED_PORT" "$PATCHED_COMPOSE_FILE" || exit 1

echo "[Step 5/5] Preparing Experiment 2 (Real-world benchmark, repeat=$REPEAT)..."

echo "Reading URLs from target_urls.yaml..."
TARGET_URLS_FILE="$TARGET_DIR/eval/target_urls.yaml"
if [[ ! -f "$TARGET_URLS_FILE" ]]; then
  echo "Error: target_urls.yaml not found: $TARGET_URLS_FILE"
  echo "Run eval/testurl/run.sh first to generate target URLs."
  cleanup_eval_containers "$PROJECT_NAME" "$RUNTIME_DIR" "$RUNTIME_EVAL_DIR" "$KEEP_CONTAINERS" "$PATCHED_COMPOSE_FILE"
  exit 1
fi

SINK_URLS=$(python3 - <<PYEOF
import yaml, json
with open('$TARGET_URLS_FILE') as f:
    data = yaml.safe_load(f)
print(json.dumps(data.get('urls', [])))
PYEOF
)
NUM_URLS=$(echo "$SINK_URLS" | python3 -c 'import sys,json; print(len(json.load(sys.stdin)))')
echo "  Using target_urls.yaml: $NUM_URLS URLs"
cd "$SCRIPT_DIR"
npm install > "$RUNTIME_EVAL_DIR/npm-install.log" 2>&1 || \
npm ci >> "$RUNTIME_EVAL_DIR/npm-install.log" 2>&1 || \
{ echo "Error: npm install failed. See: $RUNTIME_EVAL_DIR/npm-install.log"; exit 1; }

echo "[Step 5a/5] Running raw invocation measurement..."
OVERHEAD_PATCHED_URL="$PATCHED_URL" \
OVERHEAD_UNPATCHED_URL="$UNPATCHED_URL" \
OVERHEAD_SINK_URLS="$SINK_URLS" \
OVERHEAD_REPEAT="$REPEAT" \
OVERHEAD_TARGET="$TARGET_NAME" \
OVERHEAD_OUTPUT_DIR="$RESULTS_DIR" \
TT_AUTH_ENABLED="$TT_AUTH_ENABLED" \
TT_AUTH_TYPE="$TT_AUTH_TYPE" \
TT_AUTH_LOGIN_URL="$TT_AUTH_LOGIN_URL" \
TT_AUTH_EMAIL="$TT_AUTH_EMAIL" \
TT_AUTH_PASSWORD="$TT_AUTH_PASSWORD" \
npx ts-node scripts/raw-invocation/index.ts

echo ""
echo "[Step 5b/5] Running Experiment 2 (Real-world benchmark, repeat=$REPEAT)..."
OVERHEAD_PATCHED_URL="$PATCHED_URL" \
OVERHEAD_UNPATCHED_URL="$UNPATCHED_URL" \
OVERHEAD_SINK_URLS="$SINK_URLS" \
OVERHEAD_REPEAT="$REPEAT" \
OVERHEAD_TARGET="$TARGET_NAME" \
OVERHEAD_OUTPUT_DIR="$RESULTS_DIR" \
TT_AUTH_ENABLED="$TT_AUTH_ENABLED" \
TT_AUTH_TYPE="$TT_AUTH_TYPE" \
TT_AUTH_LOGIN_URL="$TT_AUTH_LOGIN_URL" \
TT_AUTH_EMAIL="$TT_AUTH_EMAIL" \
TT_AUTH_PASSWORD="$TT_AUTH_PASSWORD" \
npx ts-node scripts/realworld.ts

echo ""
echo "=== Overhead measurement complete ==="
echo "Results saved to: $RESULTS_DIR/"
RESULT_FILE=$(ls -t "$RESULTS_DIR"/realworld_*.json 2>/dev/null | head -1)
if [[ -n "$RESULT_FILE" ]]; then
  echo "Latest: $(basename "$RESULT_FILE")"
fi

cleanup_eval_containers "$PROJECT_NAME" "$RUNTIME_DIR" "$RUNTIME_EVAL_DIR" "$KEEP_CONTAINERS" "$PATCHED_COMPOSE_FILE"
exit 0
