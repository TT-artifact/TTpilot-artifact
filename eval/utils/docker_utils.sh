#!/bin/bash

check_port_free() {
  local port=$1
  if lsof -Pi ":$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "Error: Port $port is already in use"
    return 1
  fi
  return 0
}

extract_unpatched_src() {
  local src_dir=$1
  local unpatched_dir=$2
  local target_commit=$3
  rm -rf "$unpatched_dir"
  mkdir -p "$unpatched_dir"
  if git clone --quiet "$src_dir" "$unpatched_dir" \
      && git -C "$unpatched_dir" checkout --quiet "$target_commit"; then
    local upstream_url
    upstream_url=$(git -C "$src_dir" remote get-url origin 2>/dev/null || true)
    if [[ -n "$upstream_url" ]]; then
      git -C "$unpatched_dir" remote set-url origin "$upstream_url" 2>/dev/null || true
    fi
    return 0
  fi
  echo "Warning: git clone failed, falling back to archive extraction" >&2
  rm -rf "$unpatched_dir"
  mkdir -p "$unpatched_dir"
  if ! git -C "$src_dir" archive "$target_commit" | tar -x -C "$unpatched_dir"; then
    echo "Warning: git archive failed, falling back to cp" >&2
    cp -r "$src_dir"/* "$unpatched_dir/"
  fi
}

create_dockerfile_unpatched() {
  local src=$1
  local dst=$2
  cp "$src" "$dst"
  sed -i '/COPY tt-policy\.js/d' "$dst"
  sed -i '/# Declares the TT runtime helpers/,/COPY tt-globals\.d\.ts/d' "$dst"
  sed -i "/# The patcher's receiver-identity duck-typing wrapper/,/xargs -r sed -i/d" "$dst"
}

cleanup_reports_db() {
  local dir=$1
  rm -f "$dir/reports.db" "$dir/reports.db-shm" "$dir/reports.db-wal"
}

wait_for_container_ready() {
  local url=$1
  local timeout=${2:-130}
  local elapsed=0
  while ! curl -sf "$url" >/dev/null 2>&1; do
    if [[ $elapsed -ge $timeout ]]; then
      echo "Timeout: $url"
      return 1
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  echo "  OK: $url"
}

create_patched_eval_compose() {
  local runtime_dir=$1
  local runtime_eval_dir=$2
  local backend_port=$3
  local patched_port=$4

  RUNTIME_DIR="$runtime_dir" RUNTIME_EVAL_DIR="$runtime_eval_dir" \
  BACKEND_PORT="$backend_port" PATCHED_PORT="$patched_port" \
  python3 << 'PYEOF'
import os
import re
import yaml

runtime_dir = os.environ["RUNTIME_DIR"]
runtime_eval_dir = os.environ["RUNTIME_EVAL_DIR"]
backend_port = os.environ["BACKEND_PORT"]
patched_port = os.environ["PATCHED_PORT"]

compose_path = os.path.join(runtime_dir, "docker-compose.yml")
with open(compose_path) as f:
    compose = yaml.safe_load(f)

services = compose["services"]
services["backend"]["ports"] = [f"{backend_port}:9000"]
services["proxy"]["ports"] = [f"{patched_port}:8000"]

localhost_url_re = re.compile(r"http://localhost:\d+")
app_env = services.get("app", {}).get("environment")
if isinstance(app_env, dict):
    for key, value in app_env.items():
        if isinstance(value, str) and localhost_url_re.search(value):
            app_env[key] = localhost_url_re.sub(f"http://localhost:{patched_port}", value)
elif isinstance(app_env, list):
    for i, item in enumerate(app_env):
        if isinstance(item, str) and localhost_url_re.search(item):
            app_env[i] = localhost_url_re.sub(f"http://localhost:{patched_port}", item)

policy_path = os.path.join(runtime_eval_dir, "tt-policy.js")
proxy_context = services["proxy"]["build"]["context"]
services["proxy"]["build"]["args"]["TT_POLICY_SRC"] = os.path.relpath(policy_path, proxy_context)

out_path = os.path.join(runtime_eval_dir, "docker-compose.patched.yml")
with open(out_path, "w") as f:
    yaml.dump(compose, f, default_flow_style=False, allow_unicode=True, sort_keys=False)

print(f"Created: {out_path}")
PYEOF
}

create_eval_tt_policy() {
  local runtime_dir=$1
  local runtime_eval_dir=$2
  local backend_port=$3

  local src="$runtime_dir/tt-policy.js"
  local dst="$runtime_eval_dir/tt-policy.js"

  if [[ ! -f "$src" ]]; then
    echo "Error: tt-policy.js not found: $src" >&2
    return 1
  fi

  sed "s#http://localhost:9000/tt-report#http://localhost:${backend_port}/tt-report#g" "$src" > "$dst"
}

prepare_eval_runtime_dir() {
  local target_dir=$1
  local runtime_eval_dir=$2
  local results_dir=$3
  local src_dir=$4
  local target_commit=$5
  local runtime_dir=$6
  local docker_context_dir=${7:-}

  rm -rf "$runtime_eval_dir"
  mkdir -p "$runtime_eval_dir" "$results_dir"

  if [[ -f "$target_dir/sinks.db" ]]; then
    cp "$target_dir/sinks.db" "$runtime_eval_dir/sinks.db"
  fi

  extract_unpatched_src "$src_dir" "$runtime_eval_dir/unpatched" "$target_commit"

  if [[ -n "$docker_context_dir" ]] && [[ -d "$docker_context_dir" ]]; then
    find "$docker_context_dir" -maxdepth 1 -type f \
      ! -name "Dockerfile" ! -name "tt-globals.d.ts" \
      -exec cp {} "$runtime_eval_dir/unpatched/" \; || {
      echo "Error: failed to copy support files from $docker_context_dir" >&2
      return 1
    }
  fi

  create_dockerfile_unpatched "$runtime_dir/Dockerfile.patched" "$runtime_eval_dir/Dockerfile.unpatched"
  cleanup_reports_db "$runtime_eval_dir"
}

start_eval_containers() {
  local project_name=$1
  local runtime_dir=$2
  local runtime_eval_dir=$3
  local init_wait=${4:-10}
  local log_patched=${5:-}
  local log_unpatched=${6:-}
  local patched_port=${7:-8080}
  local unpatched_port=${8:-8081}
  local patched_compose_file=${9:-$runtime_dir/docker-compose.yml}

  cleanup_reports_db "$runtime_eval_dir"

  local patched_redir=">/dev/null 2>&1"
  local unpatched_redir=">/dev/null 2>&1"
  if [[ -n "$log_patched" ]]; then
    patched_redir="> $log_patched 2>&1"
  fi
  if [[ -n "$log_unpatched" ]]; then
    unpatched_redir="> $log_unpatched 2>&1"
  fi

  eval "docker compose -p \"${project_name}-patched\" \
    -f \"$patched_compose_file\" \
    -f \"$runtime_eval_dir/docker-compose.override.yml\" \
    build --no-cache $patched_redir && \
    docker compose -p \"${project_name}-patched\" \
    -f \"$patched_compose_file\" \
    -f \"$runtime_eval_dir/docker-compose.override.yml\" \
    up -d $patched_redir &"
  local patched_pid=$!

  eval "docker compose -p \"${project_name}-unpatched\" \
    -f \"$runtime_eval_dir/docker-compose.unpatched.yml\" \
    build --no-cache $unpatched_redir && \
    docker compose -p \"${project_name}-unpatched\" \
    -f \"$runtime_eval_dir/docker-compose.unpatched.yml\" \
    up -d $unpatched_redir &"
  local unpatched_pid=$!

  if ! wait $patched_pid; then
    kill $unpatched_pid 2>/dev/null || true
    echo "Error: patched container build failed" >&2
    [[ -n "$log_patched" ]] && echo "See: $log_patched" >&2
    return 1
  fi
  if ! wait $unpatched_pid; then
    echo "Error: unpatched container build failed" >&2
    [[ -n "$log_unpatched" ]] && echo "See: $log_unpatched" >&2
    return 1
  fi

  local startup_timeout=$((init_wait + 300))
  wait_for_container_ready "http://localhost:$patched_port" "$startup_timeout" || return 1
  wait_for_container_ready "http://localhost:$unpatched_port" "$startup_timeout" || return 1
  sleep "$init_wait"

  chmod 777 "$runtime_eval_dir" 2>/dev/null || true
  chmod 666 "$runtime_eval_dir/reports.db" 2>/dev/null || true
}

parse_target_config() {
  local target_yml_path=$1
  python3 << PYEOF
import yaml, json, shlex
with open('$target_yml_path') as f:
    cfg = yaml.safe_load(f)
target_name = cfg.get('target', {}).get('name', '')
target_commit = cfg.get('target', {}).get('commit', '')
serve_port = cfg.get('serve', {}).get('port', 8000)
docker_cfg = cfg.get('serve', {}).get('docker', {})
needs_mysql = str(docker_cfg.get('needs_mysql', False)).lower()
init_wait = docker_cfg.get('init_wait_sec', 10)
docker_context = docker_cfg.get('context', '')
volumes = docker_cfg.get('volumes', [])
volumes_json = json.dumps(volumes)
base_url = cfg.get('crawl', {}).get('base_url', 'http://localhost:8080/')

auth_cfg = cfg.get('crawl', {}).get('auth', {})
auth_enabled = str(auth_cfg.get('enabled', False)).lower()
auth_type = auth_cfg.get('type', 'form')
auth_creds = auth_cfg.get('credentials', {})
auth_login_url = auth_creds.get('login_url', '')
auth_email = auth_creds.get('email', auth_creds.get('username', ''))
auth_password = auth_creds.get('password', '')

print(f'TARGET_NAME={shlex.quote(target_name)}')
print(f'TARGET_COMMIT={shlex.quote(target_commit)}')
print(f'SERVE_PORT={serve_port}')
print(f'NEEDS_MYSQL={needs_mysql}')
print(f'INIT_WAIT={init_wait}')
print(f'DOCKER_CONTEXT={shlex.quote(docker_context)}')
print(f'VOLUMES_JSON={shlex.quote(volumes_json)}')
print(f'BASE_URL={shlex.quote(base_url)}')
print(f'TT_AUTH_ENABLED={auth_enabled}')
print(f'TT_AUTH_TYPE={shlex.quote(auth_type)}')
print(f'TT_AUTH_LOGIN_URL={shlex.quote(auth_login_url)}')
print(f'TT_AUTH_EMAIL={shlex.quote(auth_email)}')
print(f'TT_AUTH_PASSWORD={shlex.quote(auth_password)}')
PYEOF
}

setup_eval_paths() {
  local eval_type=$1
  local target_name=$2
  local target_dir=$3

  case "$eval_type" in
    functionality)
      EVAL_DIR="$target_dir/eval/functionality"
      ;;
    security)
      EVAL_DIR="$target_dir/eval/security"
      ;;
    overhead)
      EVAL_DIR="$target_dir/eval/overhead"
      ;;
    testurl)
      EVAL_DIR="$target_dir/eval/testurl"
      ;;
    *)
      echo "Error: Unknown eval_type: $eval_type" >&2
      return 1
      ;;
  esac

  RUNTIME_EVAL_DIR="$EVAL_DIR/runtime"
  RESULTS_DIR="$EVAL_DIR/results"
  UNPATCHED_DIR="$RUNTIME_EVAL_DIR/unpatched"
}

validate_eval_prerequisites() {
  local runtime_dir=$1
  local src_dir=$2
  local patched_port=${3:-8080}
  local unpatched_port=${4:-8081}

  if [[ ! -f "$runtime_dir/docker-compose.yml" ]]; then
    echo "Error: Patched docker-compose.yml not found: $runtime_dir/docker-compose.yml" >&2
    echo "Run ./scripts/run-app.sh to generate it first." >&2
    return 1
  fi

  if [[ ! -d "$src_dir/.git" ]]; then
    echo "Error: Git repository not found: $src_dir/.git" >&2
    return 1
  fi

  check_port_free "$patched_port" || return 1
  check_port_free "$unpatched_port" || return 1

  return 0
}

create_backend_volume_override() {
  local runtime_eval_dir=$1
  cat > "$runtime_eval_dir/docker-compose.override.yml" <<EOF
services:
  backend:
    volumes:
      - $(cd "$runtime_eval_dir" && pwd):/data
EOF
}

create_cleanup_trap() {
  _CLEANUP_PROJECT_NAME=$1
  _CLEANUP_RUNTIME_DIR=$2
  _CLEANUP_RUNTIME_EVAL_DIR=$3
  _CLEANUP_KEEP_CONTAINERS=$4
  _CLEANUP_EVAL_TYPE=${5:-"functionality"}
  _CLEANUP_PATCHED_COMPOSE_FILE=${6:-$_CLEANUP_RUNTIME_DIR/docker-compose.yml}

  cleanup() {
    cleanup_eval_containers "$_CLEANUP_PROJECT_NAME" "$_CLEANUP_RUNTIME_DIR" "$_CLEANUP_RUNTIME_EVAL_DIR" "$_CLEANUP_KEEP_CONTAINERS" "$_CLEANUP_PATCHED_COMPOSE_FILE"
  }

  trap cleanup EXIT INT TERM
}

extract_sink_urls_combined() {
  local target_dir=$1
  local base_url=$2
  local target_url=$3
  local script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

  python3 "$script_dir/get_combined_urls.py" \
    --target-dir "$target_dir" \
    --base-url "$base_url" \
    --target-url "$target_url"
}

normalize_base_url() {
  local url=$1
  BASE_URL="$url" python3 << 'PYEOF'
from urllib.parse import urlparse, urlunparse
import os
url = os.environ.get('BASE_URL', '')
u = urlparse(url)
path = u.path or '/'

if '.' in path.split('/')[-1]:
    normalized_path = '/' if path == '/' else path.rsplit('/', 1)[0] + '/'
else:
    normalized_path = path if path.endswith('/') else path + '/'

print(urlunparse((u.scheme, u.netloc, normalized_path, '', '', '')))
PYEOF
}

cleanup_eval_containers() {
  local project_name=$1
  local runtime_dir=$2
  local runtime_eval_dir=$3
  local keep_containers=${4:-false}
  local patched_compose_file=${5:-$runtime_dir/docker-compose.yml}

  echo ""
  echo "Cleaning up containers..."
  if [[ "$keep_containers" != "true" ]]; then
    docker compose -p "${project_name}-patched" \
      -f "$patched_compose_file" \
      -f "$runtime_eval_dir/docker-compose.override.yml" \
      down || echo "Warning: Failed to stop patched containers"

    docker compose -p "${project_name}-unpatched" \
      -f "$runtime_eval_dir/docker-compose.unpatched.yml" \
      down || echo "Warning: Failed to stop unpatched containers"

    echo "Containers cleaned up"
  fi
}
