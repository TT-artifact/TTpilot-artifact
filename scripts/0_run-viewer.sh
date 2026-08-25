#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESEARCH_DIR="$(dirname "$SCRIPT_DIR")"
VIEWER_DIR="$RESEARCH_DIR/babel-sink-detector/report-web"
PID_FILE="/tmp/sink-viewer.pid"
PORT=8000
BACKGROUND=false

show_usage() {
    cat << EOF
Usage: $0 [OPTIONS] [COMMAND] [PORT]

Commands:
  start       Start the viewer (default)
  stop        Stop the viewer
  restart     Restart the viewer

Options:
  -b, --background  Run in background
  -p, --port PORT   Specify port (default: 8000)

Examples:
  $0
  $0 8001
  $0 start -b -p 8001
  $0 stop
EOF
}

stop_viewer() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            echo "Stopping Sink Viewer (PID: $PID)..."
            kill "$PID"
            rm -f "$PID_FILE"
            sleep 1
            if kill -0 "$PID" 2>/dev/null; then
                echo "Force killing..."
                kill -9 "$PID"
            fi
            echo "Sink Viewer stopped"
        else
            echo "No running Sink Viewer found (PID file stale)"
            rm -f "$PID_FILE"
        fi
    else
        echo "Sink Viewer not running"
    fi
}

start_viewer() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            echo "Sink Viewer already running (PID: $PID)"
            return 0
        fi
    fi

    echo "=========================================="
    echo "Starting Sink Viewer (Host)"
    echo "=========================================="
    echo "Port:     $PORT"
    echo "Directory: $VIEWER_DIR"
    echo ""

    if [ ! -d "$VIEWER_DIR/venv" ]; then
        echo "Creating virtual environment..."
        python3 -m venv "$VIEWER_DIR/venv"
    fi

    source "$VIEWER_DIR/venv/bin/activate"

    if [ ! -f "$RESEARCH_DIR/requirements.txt" ]; then
        echo "Error: requirements.txt not found"
        exit 1
    fi

    echo "Installing dependencies..."
    pip install -q --upgrade pip
    pip install -q -r "$RESEARCH_DIR/requirements.txt"

    echo ""
    if [ "$BACKGROUND" = true ]; then
        echo "Starting uvicorn in background..."
        cd "$VIEWER_DIR"
        nohup uvicorn main:app --host 0.0.0.0 --port $PORT --reload > /tmp/sink-viewer.log 2>&1 &
        echo $! > "$PID_FILE"
        sleep 2
        if kill -0 "$(cat $PID_FILE)" 2>/dev/null; then
            echo "Sink Viewer started (PID: $(cat $PID_FILE))"
            echo "Access at: http://localhost:$PORT"
            echo "Logs: tail -f /tmp/sink-viewer.log"
        else
            echo "Error: Failed to start Sink Viewer"
            exit 1
        fi
    else
        echo "Starting uvicorn..."
        echo "Access at: http://localhost:$PORT"
        echo ""
        cd "$VIEWER_DIR"
        trap "echo ''; echo 'Shutting down...'; exit 0" SIGINT
        uvicorn main:app --host 0.0.0.0 --port $PORT --reload
    fi
}

ACTION="start"
while [[ $# -gt 0 ]]; do
    case $1 in
        start)
            ACTION="start"
            shift
            ;;
        stop)
            ACTION="stop"
            shift
            ;;
        restart)
            ACTION="restart"
            shift
            ;;
        -h|--help)
            show_usage
            exit 0
            ;;
        -b|--background)
            BACKGROUND=true
            shift
            ;;
        -p|--port)
            PORT="$2"
            shift 2
            ;;
        *)
            if [[ "$1" =~ ^[0-9]+$ ]]; then
                PORT="$1"
            else
                echo "Unknown option: $1"
                show_usage
                exit 1
            fi
            shift
            ;;
    esac
done

case "$ACTION" in
    start)
        start_viewer
        ;;
    stop)
        stop_viewer
        ;;
    restart)
        stop_viewer
        sleep 1
        start_viewer
        ;;
    *)
        show_usage
        exit 1
        ;;
esac
