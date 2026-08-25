#!/bin/bash
set -euo pipefail

KEEP_CONTAINERS=false
PATCHED_PORT=8080
UNPATCHED_PORT=8081
BACKEND_PORT=9000
MYSQL_PORT=3307

TARGET_YML="${1:-}"
POC_YML=""

if [[ -z "$TARGET_YML" ]]; then
  echo "Usage: $0 <target.yml> [<poc.yml>] [--patched-port N] [--unpatched-port N] [--backend-port N] [--mysql-port N] [--keep-containers]"
  echo "Example: $0 targets/beep.js.yml eval/security/poc/CVE-2024-26465.yml"
  exit 1
fi
shift

if [[ $# -gt 0 ]] && [[ "$1" != --* ]]; then
  POC_YML="$1"
  shift
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
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
RESEARCH_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"

source "$RESEARCH_ROOT/eval/utils/docker_utils.sh"

TARGET_YML_PATH="$RESEARCH_ROOT/$TARGET_YML"
POC_YML_PATH=""
[[ -n "$POC_YML" ]] && POC_YML_PATH="$RESEARCH_ROOT/$POC_YML"

if [[ ! -f "$TARGET_YML_PATH" ]]; then
  echo "Error: Target file not found: $TARGET_YML_PATH"
  exit 1
fi

if [[ -n "$POC_YML_PATH" ]] && [[ ! -f "$POC_YML_PATH" ]]; then
  echo "Error: PoC file not found: $POC_YML_PATH"
  exit 1
fi

eval "$(parse_target_config "$TARGET_YML_PATH")"
PROJECT_NAME="${TARGET_NAME//./-}"

TARGET_DIR="$RESEARCH_ROOT/out/targets/$TARGET_NAME"
SRC_DIR="$TARGET_DIR/src"
RUNTIME_DIR="$TARGET_DIR/runtime"
setup_eval_paths "security" "$TARGET_NAME" "$TARGET_DIR"

echo "=== Security Regression Testing Framework ==="
echo "App: $TARGET_NAME"
echo "Commit: $TARGET_COMMIT"
echo "Patched port: $PATCHED_PORT / Unpatched port: $UNPATCHED_PORT / Backend port: $BACKEND_PORT"
echo ""

validate_eval_prerequisites "$RUNTIME_DIR" "$SRC_DIR" "$PATCHED_PORT" "$UNPATCHED_PORT" || exit 1

PATCHED_COMPOSE_FILE="$RUNTIME_EVAL_DIR/docker-compose.patched.yml"
create_cleanup_trap "$PROJECT_NAME" "$RUNTIME_DIR" "$RUNTIME_EVAL_DIR" "$KEEP_CONTAINERS" "security" "$PATCHED_COMPOSE_FILE"

echo "[Step 1/3] Preparing evaluation runtime environment..."
CONTEXT_ARG=""
[[ -n "$DOCKER_CONTEXT" ]] && CONTEXT_ARG="$RESEARCH_ROOT/$DOCKER_CONTEXT"
prepare_eval_runtime_dir "$TARGET_DIR" "$RUNTIME_EVAL_DIR" "$RESULTS_DIR" "$SRC_DIR" "$TARGET_COMMIT" "$RUNTIME_DIR" "$CONTEXT_ARG"

echo "[Step 2/3] Creating docker-compose files..."
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

echo "[Step 2b/3] Creating docker-compose.override.yml..."
create_backend_volume_override "$RUNTIME_EVAL_DIR"

echo "[Step 2c/3] Creating eval-local patched compose + tt-policy.js (backend=$BACKEND_PORT, proxy=$PATCHED_PORT)..."
create_eval_tt_policy "$RUNTIME_DIR" "$RUNTIME_EVAL_DIR" "$BACKEND_PORT"
create_patched_eval_compose "$RUNTIME_DIR" "$RUNTIME_EVAL_DIR" "$BACKEND_PORT" "$PATCHED_PORT"

echo "[Step 3/3] Building and starting containers..."
start_eval_containers "$PROJECT_NAME" "$RUNTIME_DIR" "$RUNTIME_EVAL_DIR" "$INIT_WAIT" "" "" "$PATCHED_PORT" "$UNPATCHED_PORT" "$PATCHED_COMPOSE_FILE" || exit 1

if [[ -z "$POC_YML_PATH" ]]; then
  echo ""
  echo "Docker setup complete (no PoC provided)"
  echo "  Patched ($PATCHED_PORT): ${PROJECT_NAME}-patched"
  echo "  Unpatched ($UNPATCHED_PORT): ${PROJECT_NAME}-unpatched"
  echo "  Runtime eval dir: $RUNTIME_EVAL_DIR"
else
  echo ""
  echo "[Running PoC tests...]"
  PYTHON="${RESEARCH_ROOT}/.venv/bin/python"
  [[ -f "$PYTHON" ]] || PYTHON="python3"
  "$PYTHON" "$SCRIPT_DIR/run.py" "$POC_YML_PATH" "$TARGET_YML_PATH" \
    --patched-port "$PATCHED_PORT" \
    --unpatched-port "$UNPATCHED_PORT" \
    --backend-port "$BACKEND_PORT" \
    --reports-db "$RUNTIME_EVAL_DIR/reports.db"

  echo ""
  echo "Evaluation complete"
  echo "  Results: $RESULTS_DIR"
fi

cleanup_eval_containers "$PROJECT_NAME" "$RUNTIME_DIR" "$RUNTIME_EVAL_DIR" "$KEEP_CONTAINERS" "$PATCHED_COMPOSE_FILE"
exit 0
