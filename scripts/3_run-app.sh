#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RESEARCH_DIR="$(dirname "$SCRIPT_DIR")"
PY="$RESEARCH_DIR/.venv/bin/python3"
[ -x "$PY" ] || PY="python3"

show_usage() {
    cat << EOF
Usage: $0 [COMMAND] targets/<app>.yml

Commands:
  start   Start the app in background (default)
  stop    Stop the app
  restart Restart the app
  status  Show container status
  logs    Show app logs (follow mode)

Examples:
  $0 targets/001-urlpages.yml
  $0 stop targets/001-urlpages.yml
  $0 restart targets/001-urlpages.yml
  $0 logs targets/001-urlpages.yml
EOF
}

ACTION="start"
YML_FILE=""

while [ $# -gt 0 ]; do
    case "$1" in
        start|stop|restart|status|logs)
            ACTION="$1"
            shift
            ;;
        targets/*)
            YML_FILE="$1"
            shift
            ;;
        -h|--help)
            show_usage
            exit 0
            ;;
        *)
            YML_FILE="$1"
            shift
            ;;
    esac
done

if [ -z "$YML_FILE" ]; then
    echo "Error: Specify a targets/*.yml file"
    show_usage
    exit 1
fi
YML_FILE="$(cd "$(dirname "$YML_FILE")" && pwd)/$(basename "$YML_FILE")"

TARGET_NAME=$("$PY" -c "import yaml; d=yaml.safe_load(open('$YML_FILE')); print(d['target']['name'])")
RUNTIME_DIR="$RESEARCH_DIR/out/targets/$TARGET_NAME/runtime"
COMPOSE_FILE="$RUNTIME_DIR/docker-compose.yml"

LOGS_DIR="$RESEARCH_DIR/out/targets/$TARGET_NAME/logs"
mkdir -p "$LOGS_DIR"
RUN_APP_LOG="$LOGS_DIR/run_app.log"
exec > >(tee "$RUN_APP_LOG") 2>&1

if [ ! -f "$COMPOSE_FILE" ]; then
    echo "Error: $COMPOSE_FILE was not found."
    echo "First click 'Patch Checked' in report-web to generate docker-compose.yml."
    exit 1
fi

case "$ACTION" in
    start)
        echo "=========================================="
        echo "Starting: $TARGET_NAME"
        echo "=========================================="
        echo "Runtime:  $RUNTIME_DIR"
        echo "Services: app (8080), proxy (8080), backend (9000)"
        echo ""
        cd "$RUNTIME_DIR"
        docker compose -f "$COMPOSE_FILE" build --no-cache
        docker compose -f "$COMPOSE_FILE" up -d
        sleep 2
        docker compose -f "$COMPOSE_FILE" ps
        echo ""
        echo "Waiting for the app to actually be ready (not just the container)..."
        "$PY" "$RESEARCH_DIR/scripts/utils/wait_for_app_ready.py" "$YML_FILE"
        echo ""
        echo "Started (running in background)"
        echo "Commands:"
        echo "  $0 logs targets/$(basename "$YML_FILE")"
        echo "  $0 stop targets/$(basename "$YML_FILE")"
        echo "  $0 status targets/$(basename "$YML_FILE")"
        ;;
    stop)
        echo "Stopping: $TARGET_NAME"
        cd "$RUNTIME_DIR"
        docker compose -f "$COMPOSE_FILE" down
        echo "Stopped"
        ;;
    restart)
        echo "Restarting: $TARGET_NAME"
        cd "$RUNTIME_DIR"
        docker compose -f "$COMPOSE_FILE" down
        sleep 1
        docker compose -f "$COMPOSE_FILE" up -d
        sleep 2
        docker compose -f "$COMPOSE_FILE" ps
        echo ""
        echo "Waiting for the app to actually be ready (not just the container)..."
        "$PY" "$RESEARCH_DIR/scripts/utils/wait_for_app_ready.py" "$YML_FILE"
        echo ""
        echo "Restarted (running in background)"
        ;;
    status)
        cd "$RUNTIME_DIR"
        echo "Status: $TARGET_NAME"
        docker compose -f "$COMPOSE_FILE" ps
        ;;
    logs)
        cd "$RUNTIME_DIR"
        echo "Showing logs for: $TARGET_NAME (Press Ctrl+C to exit)"
        docker compose -f "$COMPOSE_FILE" logs -f
        ;;
esac
