#!/usr/bin/env bash
set -euo pipefail

if [ $# -ne 1 ]; then
    echo "Usage: $0 targets/<app>.yml"
    exit 1
fi

YML_FILE="$1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RESEARCH_DIR="$(dirname "$SCRIPT_DIR")"

TARGETS_ROOT="${TARGETS_ROOT:-$RESEARCH_DIR/out/targets}"

TARGET_NAME=$(python3 -c "import yaml,sys; d=yaml.safe_load(open('$YML_FILE')); print(d['target']['name'])")
TARGET_REPO=$(python3 -c "import yaml,sys; d=yaml.safe_load(open('$YML_FILE')); print(d['target']['repo'])")
TARGET_COMMIT=$(python3 -c "import yaml,sys; d=yaml.safe_load(open('$YML_FILE')); print(d['target']['commit'])")
APP_ID=$(basename "$YML_FILE" .yml)

SRC_DIR="$TARGETS_ROOT/$TARGET_NAME/src"
DB_OUT="$TARGETS_ROOT/$TARGET_NAME/sinks.db"
DETECTOR="$RESEARCH_DIR/babel-sink-detector/src/index.js"
CODEQL_DB_DIR="$TARGETS_ROOT/$TARGET_NAME/analyze"
TAINT_DB="$CODEQL_DB_DIR/codeql_taint.db"
CODEQL_QUERY="$RESEARCH_DIR/babel-sink-detector/taint/codeql/queries/SinkDataFlowPaths.ql"
SAVE_DATAFLOW_PY="$RESEARCH_DIR/babel-sink-detector/taint/scripts-codeql/save_dataflow_to_db.py"
CODEQL="$RESEARCH_DIR/tools/codeql/codeql"

echo "=========================================="
echo "Sink Detection: $APP_ID"
echo "=========================================="
echo "Name:     $TARGET_NAME"
echo "Repo:     $TARGET_REPO"
echo "Commit:   $TARGET_COMMIT"
echo "Src:      $SRC_DIR"
echo "Database: $DB_OUT"
echo ""

CLONE_START=$(date +%s%N)
if [ ! -d "$SRC_DIR/.git" ]; then
    echo "Cloning repository..."
    mkdir -p "$(dirname "$SRC_DIR")"
    git clone "$TARGET_REPO" "$SRC_DIR"
else
    echo "Repository already exists."
fi
CLONE_ELAPSED=$(( ($(date +%s%N) - CLONE_START) / 1000000 ))

echo "Checking out target commit..."
CHECKOUT_START=$(date +%s%N)
git -C "$SRC_DIR" fetch --tags --quiet 2>/dev/null || true
git -C "$SRC_DIR" checkout "$TARGET_COMMIT" --quiet
CHECKOUT_ELAPSED=$(( ($(date +%s%N) - CHECKOUT_START) / 1000000 ))

echo "Running CodeQL taint flow analysis..."
mkdir -p "$CODEQL_DB_DIR"

CODEQL_DB="$CODEQL_DB_DIR/codeql-db"
CODEQL_DB_START=$(date +%s%N)
if [ ! -d "$CODEQL_DB" ]; then
    echo "  Creating CodeQL database..."
    "$CODEQL" database create "$CODEQL_DB" \
        --language=javascript \
        --source-root "$SRC_DIR" \
        --quiet 2>/dev/null || echo "  Warning: CodeQL database creation failed"
fi
CODEQL_DB_ELAPSED=$(( ($(date +%s%N) - CODEQL_DB_START) / 1000000 ))

CODEQL_QUERY_ELAPSED=0
if [ -d "$CODEQL_DB" ]; then
    echo "  Running SinkDataFlowPaths query..."
    CODEQL_QUERY_START=$(date +%s%N)
    BQRS_OUT="$CODEQL_DB_DIR/dataflow.bqrs"
    "$CODEQL" query run --database="$CODEQL_DB" "$CODEQL_QUERY" \
        --output="$BQRS_OUT" \
        --quiet || echo "  Warning: CodeQL query execution failed"

    if [ -f "$BQRS_OUT" ]; then
        echo "  Converting BQRS to database..."
        python3 "$SAVE_DATAFLOW_PY" \
            --bqrs-file "$BQRS_OUT" \
            --out-db "$TAINT_DB" \
            --app-name "$TARGET_NAME" \
            || echo "  Warning: BQRS conversion failed"
    fi
    CODEQL_QUERY_ELAPSED=$(( ($(date +%s%N) - CODEQL_QUERY_START) / 1000000 ))
fi

echo "Running sink detection..."
mkdir -p "$(dirname "$DB_OUT")"
TAINT_DB_OPT=""
if [ -f "$TAINT_DB" ]; then
    TAINT_DB_OPT="--taint-db $TAINT_DB"
fi

LOGS_DIR="$TARGETS_ROOT/$TARGET_NAME/logs"
mkdir -p "$LOGS_DIR"
DETECTION_LOG="$LOGS_DIR/detection.log"
DETECTION_START=$(date +%s%N)

EXCLUDE_DIRS=$(python3 -c "import yaml; d=yaml.safe_load(open('$YML_FILE')); print(','.join(d.get('detect',{}).get('exclude_dirs',[]) or []))")
EXCLUDE_OPT=""
if [ -n "$EXCLUDE_DIRS" ]; then
    EXCLUDE_OPT="--exclude-dirs $EXCLUDE_DIRS"
    echo "Extra excluded dirs: $EXCLUDE_DIRS"
fi

node "$DETECTOR" --format json --db "$DB_OUT" --app "$APP_ID" $TAINT_DB_OPT $EXCLUDE_OPT "$SRC_DIR" > "$DETECTION_LOG" 2>&1

DETECTION_END=$(date +%s%N)
DETECTION_ELAPSED=$(( (DETECTION_END - DETECTION_START) / 1000000 ))

FILE_COUNT=$(grep -oP 'Scanning \K\d+(?= file)' "$DETECTION_LOG" 2>/dev/null | head -1)

echo "Running backfill..."
BACKFILL_START=$(date +%s%N)
node "$RESEARCH_DIR/babel-sink-detector/src/backfillRefactor.js" "$DB_OUT"
BACKFILL_ELAPSED=$(( ($(date +%s%N) - BACKFILL_START) / 1000000 ))

TOTAL_ELAPSED=$(( CLONE_ELAPSED + CHECKOUT_ELAPSED + CODEQL_DB_ELAPSED + CODEQL_QUERY_ELAPSED + DETECTION_ELAPSED + BACKFILL_ELAPSED ))

echo "" >> "$DETECTION_LOG"
if [ -n "$FILE_COUNT" ]; then
    echo "File count: $FILE_COUNT" >> "$DETECTION_LOG"
fi
echo "Elapsed time: ${DETECTION_ELAPSED}ms" >> "$DETECTION_LOG"
echo "" >> "$DETECTION_LOG"
echo "Stage timings:" >> "$DETECTION_LOG"
echo "  Clone:            ${CLONE_ELAPSED}ms" >> "$DETECTION_LOG"
echo "  Checkout:         ${CHECKOUT_ELAPSED}ms" >> "$DETECTION_LOG"
echo "  CodeQL DB create: ${CODEQL_DB_ELAPSED}ms" >> "$DETECTION_LOG"
echo "  CodeQL query run: ${CODEQL_QUERY_ELAPSED}ms" >> "$DETECTION_LOG"
echo "  Detection:        ${DETECTION_ELAPSED}ms" >> "$DETECTION_LOG"
echo "  Backfill:         ${BACKFILL_ELAPSED}ms" >> "$DETECTION_LOG"
echo "  Total:            ${TOTAL_ELAPSED}ms" >> "$DETECTION_LOG"

echo ""
echo "Complete: $DB_OUT"
