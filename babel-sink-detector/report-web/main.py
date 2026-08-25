from fastapi import FastAPI, Request, Query, HTTPException, Body
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
import json
import db
import html as html_module
import os
import subprocess
import sqlite3
import re
import shutil
import urllib.error
import urllib.request
from datetime import datetime
from typing import List, Dict, Set, Union, Optional, Literal
import yaml
from pygments import highlight
from pygments.lexers import get_lexer_for_filename
from pygments.formatters import HtmlFormatter

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

def _load_js_signatures(reports_db_path: str) -> List[str]:

    if not os.path.exists(reports_db_path):
        return []
    try:
        conn = sqlite3.connect(reports_db_path)
        rows = conn.execute('SELECT signature FROM js_signatures').fetchall()
        conn.close()
        return [r[0] for r in rows]
    except Exception:
        return []

def _load_js_signatures_with_sink_info(reports_db_path: str) -> list[dict]:

    if not os.path.exists(reports_db_path):
        return []
    try:
        conn = sqlite3.connect(reports_db_path)
        rows = conn.execute('SELECT id, signature, sink_key, sink_id, note FROM js_signatures ORDER BY id DESC').fetchall()
        conn.close()
        return [{"id": r[0], "signature": r[1], "sink_key": r[2], "sink_id": r[3], "note": r[4]} for r in rows]
    except Exception:
        return []

def _load_url_signatures(reports_db_path: str) -> List[Dict]:
    if not os.path.exists(reports_db_path):
        return []
    try:
        conn = sqlite3.connect(reports_db_path)
        rows = conn.execute('SELECT url, sri FROM url_signatures').fetchall()
        conn.close()
        return [{"url": r[0], "sri": r[1]} for r in rows]
    except Exception:
        return []

_ORACLE_POLICY = {
    "TYPE5": "sanitizePolicy",
    "TYPE4": "monitorPolicy",
    "TYPE2": "passThruPolicy",
}

def _apply_oracle_patch_preview(original_snippet: Optional[str], display_suggestion: Optional[str], verdict: str) -> str:
    fallback = original_snippet or ""

    if verdict in ("NO_VIOLATION", "TYPE1"):
        return fallback
    target = _ORACLE_POLICY.get(verdict)

    if not target or not display_suggestion:
        return fallback
    return re.sub(r'\b\w+Policy\b', target, display_suggestion)

def _apply_oracle_refactor(original_snippet: Optional[str], refactor_suggestion: Optional[str], patch_verdict: str) -> Optional[str]:

    if patch_verdict == "NO_VIOLATION":

        return "__UNPATCH_SENTINEL__"

    if patch_verdict == "TYPE1":

        return refactor_suggestion

    target = _ORACLE_POLICY.get(patch_verdict)
    if not target or not refactor_suggestion:
        return refactor_suggestion

    return re.sub(r'\b\w+Policy\b', target, refactor_suggestion)

def _normalize_patch_result(r: dict) -> dict:

    status = r.get("status")
    if status == "ok":
        return {**r, "status": "skipped" if r.get("note") else "success"}
    if status == "error":
        return {**r, "status": "failed"}
    return r

def _wrapper_to_regex(patch_wrapper: Optional[str]) -> Optional[str]:

    if not patch_wrapper:
        return None
    escaped = re.escape(patch_wrapper)
    return re.sub(r'[A-Za-z_][A-Za-z0-9_]*Policy', r'\\w+Policy', escaped)

def _guarded_wrapper_to_regex(patch_wrapper: Optional[str]) -> Optional[str]:

    if not patch_wrapper or '.' not in patch_wrapper:
        return None
    method_name = patch_wrapper.split('.', 1)[1]
    if not method_name:
        return None
    return r'__ttGuardedPolicyCall\(\s*\w+Policy\s*,\s*["\']' + re.escape(method_name) + r'["\']'

def _build_js_to_py_table(text: str):

    if not any(ord(c) > 0xFFFF for c in text):
        return None
    table = []
    for py_idx, c in enumerate(text):
        table.append(py_idx)
        if ord(c) > 0xFFFF:
            table.append(py_idx)
    return table

def _js_to_py_idx(table, js_offset: int, text_len: int) -> int:

    if table is None:
        return js_offset
    if js_offset >= len(table):
        return text_len
    return table[js_offset]

def _update_node_offsets_after_patch(patched_files: List[str], patched_sink_keys: Set[str], sinks_db_path: str, base: str, src_dir: str) -> None:

    if not patched_files or not patched_sink_keys:
        return

    con = sqlite3.connect(sinks_db_path)
    placeholders = ','.join('?' * len(patched_sink_keys))
    file_rows = con.execute(
        f"SELECT DISTINCT file FROM sinks WHERE sink_key IN ({placeholders})",
        list(patched_sink_keys)
    ).fetchall()
    affected_files = [r[0] for r in file_rows]

    import sys as _sys
    print(f"[_update_node_offsets] Found {len(affected_files)} affected files from {len(patched_sink_keys)} patched sinks", file=_sys.stderr)

    if not affected_files:
        con.close()
        return

    file_placeholders = ','.join('?' * len(affected_files))
    patched_placeholders = ','.join('?' * len(patched_sink_keys)) if patched_sink_keys else '(NULL)'
    params = affected_files + (list(patched_sink_keys) if patched_sink_keys else [])
    rows = con.execute(
        f"SELECT sink_key, line, col, file FROM sinks WHERE file IN ({file_placeholders})"
        f" AND NOT (sink_key IN ({patched_placeholders}) AND patch_strategy = 'replaceNode')",
        params
    ).fetchall()
    con.close()

    print(f"[_update_node_offsets] Loaded {len(rows)} total sinks from affected files", file=_sys.stderr)

    sink_list = []
    for sk, line, col, file in rows:
        kind = sk.split(":", 1)[1] if ":" in sk else sk
        sink_list.append((file, line, col, kind, sk))

    def find_sink_exact(target_file: str, target_line: int, target_col: int | None, target_kind: str) -> str | None:

        candidates = [
            (col, sk) for file, line, col, kind, sk in sink_list
            if file == target_file and line == target_line and kind == target_kind
        ]
        if not candidates:
            return None
        if len(candidates) == 1:
            return candidates[0][1]

        if target_col is not None:
            for col, sk in candidates:
                if col == target_col:
                    return sk
        return None

    index_js = os.path.join(base, "babel-sink-detector", "src", "index.js")
    updates = []
    for file_path in patched_files:
        try:
            proc = subprocess.run(
                ["node", index_js, file_path, "-f", "json", "--source-root", src_dir, "-q"],
                capture_output=True, text=True, timeout=120
            )
            if proc.returncode != 0 or not proc.stdout.strip():
                import sys as _sys
                print(f"[_update_node_offsets] index.js error for {file_path}: rc={proc.returncode}, stderr={proc.stderr[:200]}", file=_sys.stderr)
                continue
            result = json.loads(proc.stdout)
            findings = result.get("findings", []) if isinstance(result, dict) else result
            for r in findings:
                sc = r.get("sinkCode", "")
                kind = sc.split(":", 1)[1] if ":" in sc else sc
                line = r.get("line")
                sk = find_sink_exact(file_path, line, r.get("col"), kind)
                if sk:
                    updates.append((r.get("node_start"), r.get("node_end"),
                                    r.get("arg_start"), r.get("arg_end"), sk))
        except Exception as e:
            import sys as _sys
            print(f"[_update_node_offsets] {file_path}: {e}", file=_sys.stderr)

    import sys as _sys

    if updates:
        con = sqlite3.connect(sinks_db_path)
        print(f"[_update_node_offsets] Updating {len(updates)} sink offsets", file=_sys.stderr)
        con.executemany("UPDATE sinks SET node_start=?, node_end=?, arg_start=?, arg_end=? WHERE sink_key=?", updates)
        con.commit()
        con.close()
    else:

        if patched_sink_keys and sink_list:

            raise RuntimeError(
                f"[_update_node_offsets] No offsets updated despite {len(patched_sink_keys)} patched sinks "
                f"- index.js rescan may have failed (keys: {patched_sink_keys})"
            )

def _load_oracle_verdicts(reports_db_path: str, sinks_db_path: str) -> list[dict]:
    if not os.path.exists(reports_db_path):
        return []
    try:
        conn = sqlite3.connect(reports_db_path)
        rows = conn.execute(
            'SELECT sink_key, oracle_verdict, patch_verdict FROM oracle_verdicts'
            ' WHERE is_patch_target = 1 ORDER BY updated_at DESC'
        ).fetchall()
        conn.close()
    except Exception:
        return []

    result = []
    for row in rows:
        sink_key, oracle_verdict, patch_verdict = row
        sink_id, display_suggestion, file_, line_, original_snippet = None, None, None, None, None
        if sinks_db_path and os.path.exists(sinks_db_path):
            try:
                sinks_conn = sqlite3.connect(sinks_db_path)
                s = sinks_conn.execute(
                    'SELECT id, display_suggestion, file, line, original_snippet FROM sinks WHERE sink_key = ? LIMIT 1',
                    (sink_key,)
                ).fetchone()
                sinks_conn.close()
                if s:
                    sink_id, display_suggestion, file_, line_, original_snippet = s[0], s[1], s[2], s[3], s[4]
            except Exception:
                pass
        result.append({
            "sink_key": sink_key,
            "oracle_verdict": oracle_verdict,
            "patch_verdict": patch_verdict,
            "sink_id": sink_id,
            "display_suggestion": display_suggestion,
            "file": file_,
            "line": line_,
            "original_snippet": original_snippet,
        })
    return result

def short_path(p: str) -> str:
    parts = p.replace("\\", "/").rstrip("/").split("/")
    return "/".join(parts[-2:]) if len(parts) >= 2 else p

def format_timestamp(ts: int) -> str:

    if not ts:
        return ""
    try:
        return datetime.fromtimestamp(ts / 1000).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return str(ts)

templates.env.filters["short_path"] = short_path
templates.env.filters["fromjson"] = json.loads
templates.env.filters["format_timestamp"] = format_timestamp

def get_target_name(app: str) -> str | None:

    _default_base = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    base = os.environ.get("RESEARCH_DIR", _default_base)
    targets_dir = os.path.join(base, "targets")

    yml_path = os.path.join(targets_dir, f"{app}.yml")
    if os.path.exists(yml_path):
        try:
            data = yaml.safe_load(open(yml_path))
            return data["target"]["name"]
        except:
            pass

    import glob
    pattern = os.path.join(targets_dir, f"*-{app}.yml")
    matches = glob.glob(pattern)
    if matches:
        yml_path = matches[0]
        try:
            data = yaml.safe_load(open(yml_path))
            return data["target"]["name"]
        except:
            pass

    pattern = os.path.join(targets_dir, f"*{app}.yml")
    matches = glob.glob(pattern)
    for yml_path in matches:
        try:
            data = yaml.safe_load(open(yml_path))
            return data["target"]["name"]
        except:
            pass

    return None

def git_run(args: list, cwd: str, check=True) -> subprocess.CompletedProcess:
    return subprocess.run(["git"] + args, cwd=cwd, capture_output=True, text=True, check=check)

def prepare_branch(setup_src: str, branch_name: str) -> None:

    git_run(["restore", "."], setup_src)
    existing = git_run(["branch", "--list", branch_name], setup_src).stdout.strip()
    if existing:
        git_run(["checkout", branch_name], setup_src)
    else:
        git_run(["checkout", "-b", branch_name], setup_src)

def commit_patches(setup_src: str, n: int, msg_prefix: str = "refactor") -> str:

    git_run(["add", "-A"], setup_src)

    staged = git_run(["diff", "--cached", "--quiet"], setup_src, check=False)
    if staged.returncode == 0:
        return git_run(["rev-parse", "--short", "HEAD"], setup_src).stdout.strip()
    git_run(["commit", "-m", f"{msg_prefix}: apply TT policy to {n} sinks"], setup_src)
    return git_run(["rev-parse", "--short", "HEAD"], setup_src).stdout.strip()

def rescan_patched_files(patched_files: list[str], app: str, sinks_db_path: str, base: str, src_dir: str | None = None) -> None:

    index_js = os.path.join(base, "babel-sink-detector", "src", "index.js")
    if not os.path.exists(index_js):
        return
    for file_path in patched_files:
        if not os.path.exists(file_path):
            continue
        try:

            cmd = ["node", index_js, file_path, "--db", sinks_db_path, "--app", app, "--rescan-file", "-q"]
            if src_dir:
                cmd += ["--source-root", src_dir]
            subprocess.run(cmd, capture_output=True, text=True, timeout=60)

            _rescan_refactor_from_originals(file_path, app, sinks_db_path, index_js)
        except Exception:
            pass

def _rescan_refactor_from_originals(file_path: str, app: str, sinks_db_path: str, index_js: str) -> None:

    import tempfile

    con = sqlite3.connect(sinks_db_path)
    con.row_factory = sqlite3.Row
    rows = con.execute(
        "SELECT id, sink_key, original_snippet FROM sinks WHERE file = ? AND patch_count > 0 AND original_snippet IS NOT NULL",
        (file_path,)
    ).fetchall()
    con.close()

    if not rows:
        return

    lines = []
    line_to_id: dict[int, int] = {}
    for row in rows:
        line_to_id[len(lines) + 1] = row["id"]
        lines.append(row["original_snippet"])

    with tempfile.NamedTemporaryFile(suffix=".js", mode="w", delete=False) as f:
        f.write("\n".join(lines))
        tmpfile = f.name

    try:
        proc = subprocess.run(
            ["node", index_js, tmpfile, "-f", "json", "-q"],
            capture_output=True, text=True, timeout=120
        )
        if proc.returncode != 0 or not proc.stdout.strip():
            return
        findings = json.loads(proc.stdout)
    except Exception:
        return
    finally:
        try:
            os.unlink(tmpfile)
        except Exception:
            pass

    updates = []
    for f in findings:
        sink_id = line_to_id.get(f.get("line"))
        if sink_id and (f.get("refactorSuggestion") or f.get("displaySuggestion")):
            updates.append((f.get("refactorSuggestion"), f.get("displaySuggestion"), sink_id))

    if not updates:
        return

    con = sqlite3.connect(sinks_db_path)
    try:
        con.executemany(
            "UPDATE sinks SET refactor_suggestion = ?, display_suggestion = ? WHERE id = ?",
            updates
        )
        con.commit()
    finally:
        con.close()

def _is_git_run_block(line: str) -> bool:

    stripped = line.strip()
    return (
        (stripped.startswith("RUN") and "--mount=type=ssh" in stripped) or
        (stripped.startswith("RUN") and "git" in stripped and "clone" in stripped)
    )

def _is_post_clone_git_cmd(line: str) -> bool:

    stripped = line.strip()
    return stripped.startswith("RUN git ") and "clone" not in stripped

def _parse_clone_dest(lines: list, start: int) -> str:

    i = start
    dest = "/app"
    while i < len(lines):
        line = lines[i].rstrip()

        clean = line.rstrip("\\").strip()
        parts = clean.split()
        for part in reversed(parts):
            if part.startswith("/") and not part.startswith("//"):
                dest = part
                break
        if dest != "/app":
            break
        if not line.endswith("\\"):
            break
        i += 1
    return dest

def _skip_continuation_block(lines: list, start: int) -> int:

    i = start
    while i < len(lines):
        if lines[i].rstrip().endswith("\\"):
            i += 1
        else:
            i += 1
            break
    return i

def _patch_dockerfile(content: str, port: int) -> str:

    lines = content.split("\n")
    new_lines = []
    i = 0
    copy_inserted = False
    copy_dest = None

    while i < len(lines):
        line = lines[i]

        if _is_git_run_block(line):
            dest = _parse_clone_dest(lines, i)
            copy_dest = dest

            mv_dest = None
            j = i
            while j < len(lines):
                block_line = lines[j]
                if "mv " in block_line and dest in block_line:

                    match = re.search(rf"mv\s+{re.escape(dest)}\s+(\S+)", block_line)
                    if match:
                        mv_dest = match.group(1)
                if not block_line.rstrip().endswith("\\"):
                    break
                j += 1

            i = _skip_continuation_block(lines, i)
            if not copy_inserted:
                new_lines.append(f"COPY . {dest}/")

                if mv_dest:
                    new_lines.append(f"RUN rm -rf {mv_dest} && mv {dest} {mv_dest}")
                copy_inserted = True
        elif not copy_inserted and _is_post_clone_git_cmd(line):

            new_lines.append(line)
            i += 1
        elif copy_inserted and _is_post_clone_git_cmd(line):

            i = _skip_continuation_block(lines, i)
        else:
            new_lines.append(line)
            i += 1

    return "\n".join(new_lines)

_DRAWIO_CANVAS_DRAWIMAGE_SHIM = r"""
;(function(){
  try {
    var proto = CanvasRenderingContext2D.prototype;
    var orig = proto.drawImage;
    proto.drawImage = function(img){
      try {
        var src = img && (img.src || img.currentSrc);
        if (typeof src === 'string' && src.indexOf('data:image/svg') === 0) return undefined;
      } catch (e) {}
      return orig.apply(this, arguments);
    };
  } catch (e) {}
})();
"""

def generate_runtime(app: str, name: str, src_dir: str, base: str) -> None:

    yml_path = os.path.join(base, "targets", f"{app}.yml")
    if not os.path.exists(yml_path):
        return

    try:
        cfg = yaml.safe_load(open(yml_path))
    except Exception:
        return

    serve = cfg.get("serve", {})
    serve_type = serve.get("type", "docker")
    if serve_type != "docker":
        return

    port = serve.get("port", 8080)
    docker_cfg = serve.get("docker", {})
    docker_context = docker_cfg.get("context", "")
    needs_mysql = docker_cfg.get("needs_mysql", False)
    init_wait_sec = docker_cfg.get("init_wait_sec", 10)
    extra_ports = docker_cfg.get("extra_ports", [])
    proxy_flags = docker_cfg.get("proxy_flags", [])
    extra_env = docker_cfg.get("environment", {})
    docker_context_abs = os.path.join(base, docker_context) if docker_context else base
    extra_volumes = [
        v.replace("{docker_context}", docker_context_abs)
        for v in docker_cfg.get("volumes", [])
    ]

    runtime_dir = os.path.join(base, "out", "targets", name, "runtime")
    target_dir = os.path.join(base, "out", "targets", name)
    os.makedirs(runtime_dir, exist_ok=True)

    tpl_path = os.path.join(base, "runtime", "reverse-proxy", "src", "tt-policy.tpl.js")
    acorn_path = os.path.join(base, "runtime", "reverse-proxy", "src", "acorn.min.js")
    walk_path = os.path.join(base, "runtime", "reverse-proxy", "src", "walk.min.js")
    forge_path = os.path.join(base, "runtime", "reverse-proxy", "src", "forge.min.js")
    purify_path = os.path.join(base, "runtime", "reverse-proxy", "src", "purify.min.js")
    policy_path = os.path.join(runtime_dir, "tt-policy.js")
    url_config_path = os.path.join(base, "babel-sink-detector", "url_config.json")

    if os.environ.get("REGRESSION_EVAL_MODE") == "true":
        reports_db_path = os.path.join(base, "out", "targets", name, "eval", "functionality", "reports.db")
    else:
        reports_db_path = os.path.join(base, "out", "targets", name, "reports.db")
    js_signatures = _load_js_signatures(reports_db_path)
    url_signatures = _load_url_signatures(reports_db_path)
    if not url_signatures:
        try:
            with open(url_config_path, "r") as f:
                url_cfg = json.load(f)
            url_signatures = url_cfg.get("allowedUrls", [])
        except Exception:
            url_signatures = []
    try:
        with open(purify_path, "r") as f:
            purify_js = f.read()
        with open(forge_path, "r") as f:
            forge_js = f.read()
        with open(acorn_path, "r") as f:
            acorn_js = f.read()
        with open(walk_path, "r") as f:
            walk_js = f.read()
        with open(tpl_path, "r") as f:
            tpl = f.read()
        content = (
            purify_js + "\n" + forge_js + "\n" + acorn_js + "\n" + walk_js + "\n" + tpl
            .replace("__TT_REPORT_URL__", "http://localhost:9000/tt-report")
            .replace("__ALLOWED_URLS__", json.dumps(url_signatures))
            .replace("__ALLOWED_SCRIPTS__", json.dumps(js_signatures))
        )

        if name == "draw.io":
            content += _DRAWIO_CANVAS_DRAWIMAGE_SHIM
        with open(policy_path, "w") as f:
            f.write(content)
    except Exception as e:
        import sys
        print(f"[ERROR] Failed to generate tt-policy.js: {e}", file=sys.stderr)
        return

    app_depends = {"backend": {"condition": "service_started"}}
    if needs_mysql:
        app_depends["mysql"] = {"condition": "service_healthy"}

    app_service: dict = {
        "build": {
            "context": src_dir,
            "dockerfile": f"{runtime_dir}/Dockerfile.patched"
        },
        "expose": [str(port)],
        "depends_on": app_depends
    }
    if extra_ports:
        app_service = {**app_service, "ports": extra_ports}
    if extra_volumes:
        app_service = {**app_service, "volumes": extra_volumes}

    app_env = extra_env if extra_env else {}
    if needs_mysql and not app_env:
        app_env = {
            "DB_HOST": "mysql",
            "DB_PORT": "3306",
            "DB_USERNAME": "root",
            "DB_PASSWORD": "root",
            "DB_DATABASE": "app_db"
        }
    if app_env:
        app_service = {**app_service, "environment": app_env}

    proxy_command = [
        "node", "src/proxy.js",
        "--target", f"http://app:{port}",
        "--bootstrap", "/app/tt-policy.js",
        "--port", "8000",
        *proxy_flags
    ]

    compose = {
        "services": {
            "app": app_service,
            "backend": {
                "build": {
                    "context": base,
                    "dockerfile": "docker/Dockerfile.backend"
                },
                "volumes": [f"{target_dir}:/data"],

                "ports": ["9000:9000"]
            },
            "proxy": {
                "build": {
                    "context": base,
                    "dockerfile": "docker/Dockerfile.reverse-proxy",
                    "args": {"TT_POLICY_SRC": os.path.relpath(policy_path, base)}
                },
                "command": proxy_command,
                "ports": [f"{port}:8000"],
                "depends_on": {
                    "app": {"condition": "service_started"},
                    "backend": {"condition": "service_started"}
                }
            }
        }
    }

    if needs_mysql:
        compose["services"]["mysql"] = {
            "image": "mysql:8.0",
            "environment": {
                "MYSQL_ROOT_PASSWORD": "root",
                "MYSQL_DATABASE": "app_db"
            },
            "healthcheck": {
                "test": ["CMD", "mysqladmin", "ping", "-h", "localhost"],
                "interval": "5s",
                "timeout": "3s",
                "retries": 10
            },
            "volumes": ["mysql-data:/var/lib/mysql"]
        }
        compose["volumes"] = {"mysql-data": {}}

    compose_path = os.path.join(runtime_dir, "docker-compose.yml")
    with open(compose_path, "w") as f:
        yaml.dump(compose, f, default_flow_style=False, allow_unicode=True, sort_keys=False)

    dockerfile_path = os.path.join(base, docker_context, "Dockerfile")
    patched_dockerfile_path = os.path.join(runtime_dir, "Dockerfile.patched")

    try:
        with open(dockerfile_path, "r") as f:
            content = f.read()

        content = _patch_dockerfile(content, port)

        with open(patched_dockerfile_path, "w") as f:
            f.write(content)

        copy_pattern = re.compile(r'^COPY\s+(?!--|\.\s)(\S+)\s+\S+', re.MULTILINE)
        for match in copy_pattern.finditer(content):
            src_file = match.group(1)
            if src_file == '.':
                continue
            src_abs = os.path.join(docker_context_abs, src_file)
            dst_abs = os.path.join(src_dir, src_file)
            if os.path.isfile(src_abs) and not os.path.exists(dst_abs):
                shutil.copy2(src_abs, dst_abs)
    except Exception:
        pass

@app.get("/", response_class=HTMLResponse)
async def dashboard(request: Request):
    stats = db.get_dashboard_stats()
    total_row = {
        "app": "TOTAL",
        "total": sum(row["total"] for row in stats),
        "target": sum(row["target"] for row in stats),
        "type5": sum(row["type5"] for row in stats),
        "type5_target": sum(row["type5_target"] for row in stats),
        "type4": sum(row["type4"] for row in stats),
        "type4_target": sum(row["type4_target"] for row in stats),
        "type3": sum(row["type3"] for row in stats),
        "type3_target": sum(row["type3_target"] for row in stats),
        "type2": sum(row["type2"] for row in stats),
        "type2_target": sum(row["type2_target"] for row in stats),
        "type1": sum(row["type1"] for row in stats),
        "type1_target": sum(row["type1_target"] for row in stats),
        "skipped": sum(row["skipped"] for row in stats),
    }
    return templates.TemplateResponse("dashboard.html", {
        "request": request,
        "stats": stats,
        "total": total_row
    })

@app.get("/sinks/{app}", response_class=HTMLResponse)
async def app_detail(request: Request, app: str):
    app_stats = db.get_app_stats(app)
    default_statuses = ["RECEIVER_MATCH", "NO_RECEIVER"]
    findings = db.get_findings(apps=[app], statuses=default_statuses, offset=0, limit=50)
    total = db.get_findings_count(apps=[app], statuses=default_statuses)

    name = get_target_name(app)
    _default_base = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    base = os.environ.get("RESEARCH_DIR", _default_base)

    if os.environ.get("REGRESSION_EVAL_MODE") == "true":
        reports_db_path = os.path.join(base, "out", "targets", name, "eval", "functionality", "reports.db")
    else:
        reports_db_path = os.path.join(base, "out", "targets", name, "reports.db")

    js_signatures = _load_js_signatures_with_sink_info(reports_db_path) if name else []
    url_signatures = _load_url_signatures(reports_db_path) if name else []

    sinks_db_path = None
    if name:
        try:
            sinks_db_path = db.get_db_path(app)
        except Exception:
            sinks_db_path = os.path.join(base, "out", "targets", name, "sinks.db")

    oracle_verdicts = _load_oracle_verdicts(reports_db_path, sinks_db_path) if name and sinks_db_path else []

    return templates.TemplateResponse("app_detail.html", {
        "request": request,
        "app": app,
        "app_stats": app_stats,
        "findings": findings,
        "total": total,
        "page": 1,
        "per_page": 50,
        "expand_mode": True,
        "selected_statuses": default_statuses,
        "js_signatures": js_signatures,
        "url_signatures": url_signatures,
        "oracle_verdicts": oracle_verdicts,
    })

@app.get("/sinks/{app}/findings", response_class=HTMLResponse)
async def app_findings_partial(
    request: Request,
    app: str,
    verdict: list[str] = Query(default=[]),
    sink_type: list[str] = Query(default=[]),
    status: list[str] = Query(default=[]),
    kind: list[str] = Query(default=[]),
    page: int = 1
):
    per_page = 50
    offset = (page - 1) * per_page
    kind = [k for k in kind if k]
    if not status:
        status = ["RECEIVER_MATCH", "NO_RECEIVER"]
    findings = db.get_findings(
        apps=[app],
        verdicts=verdict,
        sink_types=sink_type,
        statuses=status,
        kinds=kind,
        offset=offset,
        limit=per_page
    )
    total = db.get_findings_count(
        apps=[app],
        verdicts=verdict,
        sink_types=sink_type,
        statuses=status,
        kinds=kind
    )

    if request.headers.get("HX-Request"):
        return templates.TemplateResponse("partials/findings_table.html", {
            "request": request,
            "app": app,
            "findings": findings,
            "total": total,
            "page": page,
            "per_page": per_page,
            "expand_mode": True
        })
    return RedirectResponse(f"/sinks/{app}")

@app.post("/sinks/{app}/patch")
async def patch_findings(app: str, finding_ids: list[int] = Body(...)):

    all_apps = db.get_all_apps()
    if app not in all_apps:
        raise HTTPException(status_code=404, detail=f"App not found: {app}")

    if len(finding_ids) > 500:
        raise HTTPException(status_code=400, detail="Too many findings (max 500)")

    name = get_target_name(app)
    if not name:
        raise HTTPException(status_code=404, detail=f"targets YAML not found for {app}")

    _default_base = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    base = os.environ.get("RESEARCH_DIR", _default_base)
    src_dir = os.path.join(base, "out", "targets", name, "src")
    if not os.path.isdir(os.path.join(src_dir, ".git")):
        raise HTTPException(status_code=404, detail=f"git repo not found at {src_dir}")

    sinks_db_path = db.get_db_path(app)

    rows = [db.get_finding_in_app(app, fid) for fid in finding_ids]
    rows = [dict(r) if r else None for r in rows]
    rows = [r for r in rows if r]

    skipped = [
        {"id": r["id"], "status": "skipped", "message": "no refactor_suggestion"}
        for r in rows if not r["refactor_suggestion"]
    ]
    to_patch = [r for r in rows if r["refactor_suggestion"]]

    if not to_patch:
        return {"results": skipped}

    file_groups = {}
    for r in to_patch:
        file_path = r["file"]

        if not os.path.isabs(file_path):
            file_path = os.path.abspath(os.path.join(src_dir, file_path))
        if file_path not in file_groups:
            file_groups[file_path] = []
        finding_data = {
            "id": r["id"],
            "line": r["line"],
            "col": r["col"],
            "refactor_suggestion": r["refactor_suggestion"],
            "display_suggestion": r["display_suggestion"],
            "original_snippet": r["original_snippet"],
            "sink_key": r["sink_key"],
        }

        if r.get("node_start") is not None:
            finding_data["node_start"] = r["node_start"]
            finding_data["node_end"] = r["node_end"]
            finding_data["arg_start"] = r["arg_start"]
            finding_data["arg_end"] = r["arg_end"]
            finding_data["patch_strategy"] = r["patch_strategy"]
            finding_data["patch_wrapper"] = r["patch_wrapper"]

        if (r.get("patch_strategy") == "wrapArgument" and
            r.get("kind") in ("eval", "setTimeout.string", "setInterval.string")):
            finding_data["with_typeof"] = True
        if (r.get("patch_strategy") == "wrapArgument" and
            str(r.get("kind") or "").startswith("jquery.") and
            r.get("kind") not in ("jquery.attr.src", "jquery.prop.src")):
            finding_data["with_value_guard"] = "jquery"
            finding_data["kind"] = r["kind"]
        file_groups[file_path].append(finding_data)

    if not file_groups:
        return {"results": skipped}

    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    branch_name = f"ttgen-patch/{ts}"
    try:
        prepare_branch(src_dir, branch_name)
    except subprocess.CalledProcessError:
        raise HTTPException(status_code=500, detail="git operation failed")

    for file_path in file_groups:
        file_groups[file_path].sort(key=lambda f: f.get("node_start") or 0, reverse=True)

    payload = [
        {"file": f, "findings": finds}
        for f, finds in file_groups.items()
    ]

    patcher_path = os.path.join(base, "babel-sink-detector", "src", "patcher.js")

    try:
        import sys
        print(f"[patch_findings] Payload files: {[p['file'] for p in payload]}", file=sys.stderr)
        proc = subprocess.run(
            ["node", patcher_path],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            timeout=300
        )

        if proc.returncode != 0:
            print(f"Patcher error: {proc.stderr}", file=sys.stderr)
            raise HTTPException(status_code=500, detail="Patching operation failed")

        if proc.stderr:
            import sys
            print(f"Patcher warning: {proc.stderr}", file=sys.stderr)

        patch_results = json.loads(proc.stdout)

        patched_ids = [
            r["id"] for r in patch_results
            if r.get("status") == "ok" and r.get("verified") is True and not r.get("note")
        ]

        n_ok = len(patched_ids)
        commit_hash = ""
        if n_ok > 0:
            try:
                commit_hash = commit_patches(src_dir, n_ok)
                generate_runtime(app, name, src_dir, base)
            except subprocess.CalledProcessError:
                pass

            if patched_ids:
                con = None
                try:
                    con = sqlite3.connect(sinks_db_path)
                    con.executemany(
                        "UPDATE sinks SET patch_count = patch_count + 1 WHERE id = ?",
                        [(fid,) for fid in patched_ids]
                    )
                    con.commit()
                except Exception as e:
                    import sys as _sys
                    print(f"patch_count update failed: {e}", file=_sys.stderr)
                finally:
                    if con:
                        con.close()

            ok_ids = set(patched_ids)
            patched_sink_keys = {
                item["sink_key"]
                for items in file_groups.values()
                for item in items
                if item.get("id") in ok_ids and item.get("sink_key")
            }
            _update_node_offsets_after_patch(
                list(file_groups.keys()), patched_sink_keys, sinks_db_path, base, src_dir
            )

        return {
            "results": skipped + [_normalize_patch_result(r) for r in patch_results],
            "branch": branch_name if commit_hash else "",
            "commit": commit_hash
        }
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=500, detail="Patching operation timed out")
    except json.JSONDecodeError as e:
        import sys
        print(f"JSON decode error: {e}\nstdout: {proc.stdout if 'proc' in locals() else 'N/A'}", file=sys.stderr)
        raise HTTPException(status_code=500, detail=f"JSON decode error: {str(e)}")
    except Exception as e:
        import sys
        print(f"Patching error: {e}", file=sys.stderr)
        raise HTTPException(status_code=500, detail=f"Patching error: {str(e)}")

@app.post("/sinks/{app}/oracle-patch")
async def oracle_patch(app: str, sink_keys: list[str] = Body(...)):
    all_apps = db.get_all_apps()
    if app not in all_apps:
        raise HTTPException(status_code=404, detail=f"App not found: {app}")
    if len(sink_keys) > 500:
        raise HTTPException(status_code=400, detail="Too many sink keys (max 500)")

    name = get_target_name(app)
    if not name:
        raise HTTPException(status_code=404, detail=f"targets YAML not found for {app}")

    _default_base = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    base = os.environ.get("RESEARCH_DIR", _default_base)
    src_dir = os.path.join(base, "out", "targets", name, "src")
    if not os.path.isdir(os.path.join(src_dir, ".git")):
        raise HTTPException(status_code=404, detail=f"git repo not found at {src_dir}")

    if os.environ.get("REGRESSION_EVAL_MODE") == "true":
        reports_db_path = os.path.join(base, "out", "targets", name, "eval", "functionality", "reports.db")
    else:
        reports_db_path = os.path.join(base, "out", "targets", name, "reports.db")

    oracle_info_map: Dict[str, Dict] = {}
    verdict_map: Dict[str, str] = {}
    try:
        conn = sqlite3.connect(reports_db_path)
        if sink_keys:
            placeholders = ",".join("?" * len(sink_keys))
            rows = conn.execute(
                f"SELECT sink_key, oracle_verdict, patch_verdict, oracle_confidence, oracle_score, oracle_mixed"
                f" FROM oracle_verdicts WHERE sink_key IN ({placeholders})",
                sink_keys
            ).fetchall()
            oracle_info_map = {
                r[0]: {
                    "verdict": r[2] or r[1],
                    "confidence": r[3],
                    "score": r[4],
                    "mixed": bool(r[5])
                }
                for r in rows
            }
            verdict_map = {k: v["verdict"] for k, v in oracle_info_map.items()}
        conn.close()
    except Exception:
        raise HTTPException(status_code=500, detail="Failed to read oracle_verdicts")

    skipped = [
        {"sink_key": k, "status": "skipped", "message": "oracle_verdict not found"}
        for k in sink_keys if k not in verdict_map
    ]
    to_patch_keys = [k for k in sink_keys if k in verdict_map]

    if not to_patch_keys:
        return {"results": skipped, "branch": "", "commit": ""}

    sinks_db_path = db.get_db_path(app)
    rows_data = []
    try:
        scon = sqlite3.connect(sinks_db_path)
        scon.row_factory = sqlite3.Row
        placeholders = ",".join("?" * len(to_patch_keys))
        rows = scon.execute(
            f"SELECT id, file, line, col, refactor_suggestion, display_suggestion, original_snippet, sink_key,"
            f" node_start, node_end, arg_start, arg_end, patch_strategy, patch_wrapper, kind"
            f" FROM sinks WHERE sink_key IN ({placeholders})",
            to_patch_keys
        ).fetchall()
        rows_data = [(r["sink_key"], dict(r)) for r in rows]
        scon.close()
    except Exception:
        raise HTTPException(status_code=500, detail="Failed to read sinks")

    file_groups: Dict[str, List] = {}
    type1_file_groups: Dict[str, List] = {}
    type1_kind_map: Dict[int, str] = {}
    id_data_map: Dict[int, Dict] = {}
    _file_content_cache: Dict[str, str] = {}
    _file_offset_table_cache: Dict[str, object] = {}

    for sk, r in rows_data:
        patch_verdict = verdict_map[sk]

        refactor = _apply_oracle_refactor(r["original_snippet"], r["refactor_suggestion"], patch_verdict)

        if refactor is None and patch_verdict not in ("NO_VIOLATION", "TYPE1"):
            skipped.append({"sink_key": sk, "status": "skipped", "message": "no refactor_suggestion"})
            continue

        file_path = r["file"]
        if not os.path.isabs(file_path):
            file_path = os.path.abspath(os.path.join(src_dir, file_path))

        file_content = _file_content_cache.get(file_path)
        if file_content is None:
            try:
                with open(file_path, "r", encoding="utf-8", errors="replace") as fh:
                    file_content = fh.read()
                _file_content_cache[file_path] = file_content
                _file_offset_table_cache[file_path] = _build_js_to_py_table(file_content)
            except Exception:
                file_content = ""
                _file_offset_table_cache[file_path] = None

        js_to_py_table = _file_offset_table_cache.get(file_path)

        node_start_val, node_end_val = r.get("node_start"), r.get("node_end")
        if node_start_val is not None and node_end_val is not None:
            fc_len = len(file_content)
            py_ns = _js_to_py_idx(js_to_py_table, node_start_val, fc_len)
            py_ne = _js_to_py_idx(js_to_py_table, node_end_val, fc_len)
            node_text = file_content[py_ns:py_ne]
        else:
            node_text = ""

        patch_wrapper_str = r.get("patch_wrapper") or ""
        wrapper_re = _wrapper_to_regex(patch_wrapper_str) if patch_wrapper_str else None
        guarded_re = _guarded_wrapper_to_regex(patch_wrapper_str) if patch_wrapper_str else None

        def _policy_pattern_matches(text: str) -> bool:
            return bool((wrapper_re and re.search(wrapper_re, text)) or
                        (guarded_re and re.search(guarded_re, text)))

        policy_applied = _policy_pattern_matches(node_text)

        if not policy_applied and (wrapper_re or guarded_re):

            sink_parts = sk.split(':')
            sink_method = sink_parts[1] if len(sink_parts) > 1 else ""

            if sink_method and sink_method in file_content:

                lines = file_content.split('\n')
                for line_idx, line in enumerate(lines):
                    if sink_method in line:

                        if _policy_pattern_matches(line):
                            node_text = line
                            policy_applied = True
                            import sys as _sys
                            print(f"[oracle_patch] Fallback recovered {sk}: policy_applied=True at line {line_idx+1}", file=_sys.stderr)
                            break

        target_policy = _ORACLE_POLICY.get(patch_verdict, "classifyPolicy")

        if not policy_applied:
            raise RuntimeError(
                f"[oracle_patch] policy_applied=False for {sk} - "
                f"2_patch.py may not have executed (expected wrapper to be present)"
            )

        is_jquery_guard = str(r.get("kind") or "").startswith("jquery.") and\
            r.get("kind") not in ("jquery.attr.src", "jquery.prop.src")
        if patch_verdict == "NO_VIOLATION":
            action = "unpatch"
        elif patch_verdict == "TYPE1" and is_jquery_guard:
            action = "repatch"
            target_policy = "passThruPolicy"
        elif patch_verdict == "TYPE1":
            action = "unpatch"
        else:
            action = "repatch"

        oracle_patch_strategy = r["patch_strategy"]
        if patch_verdict == "NO_VIOLATION":

            if wrapper_re:

                inner_re = wrapper_re + r'(.+)\)'
                m = re.search(inner_re, node_text, re.DOTALL)
                inner = m.group(1) if m else node_text
            else:
                inner = node_text
            oracle_refactor = inner if inner != node_text else node_text
            oracle_patch_wrapper = patch_wrapper_str
            display = oracle_refactor
        elif patch_verdict == "TYPE1" and is_jquery_guard:
            oracle_patch_wrapper = target_policy
            oracle_refactor = re.sub(r'\b\w+Policy\b', target_policy, node_text)
            display = oracle_refactor
        elif patch_verdict == "TYPE1":

            oracle_refactor = r["refactor_suggestion"]
            oracle_patch_wrapper = patch_wrapper_str
            display = oracle_refactor
        else:

            oracle_wrapper = re.sub(r'\b\w+Policy\b', target_policy, patch_wrapper_str or "")
            oracle_refactor = re.sub(wrapper_re, oracle_wrapper, node_text, count=1) if wrapper_re else node_text
            oracle_patch_wrapper = oracle_wrapper
            display = oracle_refactor

        info = oracle_info_map.get(sk, {})
        oracle_reasons = [f"oracle:{info.get('verdict', patch_verdict)}"]
        if info.get("confidence"):
            oracle_reasons.append(f"confidence:{info['confidence']}")
        if info.get("score") is not None:
            oracle_reasons.append(f"score:{info['score']}")
        if info.get("mixed"):
            oracle_reasons.append("mixed:true")

        db_update_data = {
            "patch_verdict": patch_verdict,
            "refactor_suggestion": oracle_refactor,
            "display_suggestion": display,
            "patch_strategy": oracle_patch_strategy,
            "patch_wrapper": oracle_patch_wrapper,
            "verdict_reasons": json.dumps(oracle_reasons),
            "sink_key": sk,
        }
        id_data_map[r["id"]] = db_update_data

        finding_data = {
            "id": r["id"],
            "action": action,
            "line": r["line"],
            "col": r["col"],
            "refactor_suggestion": oracle_refactor,
            "display_suggestion": display,
            "original_snippet": r["original_snippet"],
            "sink_key": r["sink_key"],
            "kind": r["kind"],
        }
        if r["node_start"] is not None:
            finding_data.update({
                "node_start": r["node_start"],
                "node_end": r["node_end"],
                "arg_start": r["arg_start"],
                "arg_end": r["arg_end"],
                "patch_strategy": oracle_patch_strategy,
                "patch_wrapper": oracle_patch_wrapper,
            })
        if is_jquery_guard:
            finding_data["with_value_guard"] = "jquery"

        if patch_verdict == "TYPE1" and not is_jquery_guard:

            stage2_data = dict(finding_data)
            stage2_data["patch_strategy"] = oracle_patch_strategy
            type1_file_groups.setdefault(file_path, []).append(stage2_data)
            type1_kind_map[r["id"]] = r["kind"]
        else:

            file_groups.setdefault(file_path, []).append(finding_data)

    if not file_groups and not type1_file_groups:
        return {"results": skipped, "branch": "", "commit": ""}

    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    branch_name = f"ttgen-oracle-patch/{ts}"
    prepare_branch(src_dir, branch_name)

    patched_ids = []
    patch_results = []
    type1_unpatch_result_ids = set()
    patcher_path = os.path.join(base, "babel-sink-detector", "src", "patcher.js")

    def _run_patcher(file_groups_dict: Dict[str, List], stage_name: str) -> List[int]:

        if not file_groups_dict:
            return []
        payload = [
            {"file": f, "findings": finds}
            for f, finds in file_groups_dict.items()
        ]
        try:
            import sys as _sys
            print(f"[oracle_patch] {stage_name}: Payload files: {[p['file'] for p in payload]}", file=_sys.stderr)
            proc = subprocess.run(
                ["node", patcher_path],
                input=json.dumps(payload),
                capture_output=True,
                text=True,
                timeout=300
            )
            if proc.returncode != 0:
                print(f"[oracle_patch] {stage_name} error: {proc.stderr}", file=_sys.stderr)
                raise HTTPException(status_code=500, detail=f"{stage_name} failed")
            results = json.loads(proc.stdout)
            patch_results.extend(results)
            return [
                r["id"] for r in results

                if r.get("status") == "ok" and r.get("verified") is True
            ]
        except Exception as e:
            import sys as _sys
            if isinstance(e, HTTPException):
                raise
            print(f"[oracle_patch] {stage_name} exception: {e}", file=_sys.stderr)
            raise HTTPException(status_code=500, detail=f"{stage_name} exception: {e}")

    stage1_ids = _run_patcher(file_groups, "Stage 1 (NO_VIOLATION + TYPE2/4/5)")
    patched_ids.extend(stage1_ids)

    overlap_files = [f for f in file_groups if f in type1_file_groups]
    if overlap_files and stage1_ids:
        stage1_keys = {id_data_map[fid]["sink_key"] for fid in stage1_ids if fid in id_data_map}
        _update_node_offsets_after_patch(overlap_files, stage1_keys, sinks_db_path, base, src_dir)

        overlap_fids = [f["id"] for fp in overlap_files for f in type1_file_groups.get(fp, [])]
        if overlap_fids:
            _scon = sqlite3.connect(sinks_db_path, check_same_thread=False)
            _scon.row_factory = sqlite3.Row
            _ph = ','.join('?' * len(overlap_fids))
            _fresh = {
                r["id"]: dict(r)
                for r in _scon.execute(
                    f"SELECT id, node_start, node_end, arg_start, arg_end FROM sinks WHERE id IN ({_ph})",
                    overlap_fids
                ).fetchall()
            }
            _scon.close()
            for fp in overlap_files:
                for finding in type1_file_groups.get(fp, []):
                    if finding["id"] in _fresh:
                        finding.update(_fresh[finding["id"]])

    pre_stage2_len = len(patch_results)
    type1_unpatch_ids = _run_patcher(type1_file_groups, "Stage 2 (TYPE1 unpatch)")
    patched_ids.extend(type1_unpatch_ids)
    post_stage2_len = len(patch_results)
    _type1_stage2_obj_ids = frozenset(id(r) for r in patch_results[pre_stage2_len:post_stage2_len])

    if type1_unpatch_ids:
        mid_keys = {id_data_map[fid]["sink_key"] for fid in type1_unpatch_ids if fid in id_data_map}
        mid_files = list(set(list(file_groups.keys()) + list(type1_file_groups.keys())))
        if mid_keys and mid_files:
            _update_node_offsets_after_patch(mid_files, mid_keys, sinks_db_path, base, src_dir)

        refactor_payload = []
        fresh_offsets: Dict[int, Dict] = {}

        scon_f = sqlite3.connect(sinks_db_path, check_same_thread=False)
        scon_f.row_factory = sqlite3.Row
        try:
            for file_path, finds in type1_file_groups.items():
                for f in finds:
                    fid = f["id"]
                    upd = scon_f.execute(
                        "SELECT node_start, node_end, arg_start, arg_end FROM sinks WHERE id = ?", (fid,)
                    ).fetchone()
                    if not upd or upd["node_start"] is None:
                        continue
                    fresh_offsets[fid] = dict(upd)
                    try:
                        with open(file_path, "r", encoding="utf-8", errors="replace") as fh:
                            src = fh.read()
                        jt = _build_js_to_py_table(src)
                        ns = _js_to_py_idx(jt, upd["node_start"], len(src))
                        ne = _js_to_py_idx(jt, upd["node_end"], len(src))
                        node_txt = src[ns:ne].strip()
                    except Exception:
                        continue
                    eq_idx = node_txt.find(' = ')
                    if eq_idx == -1:
                        continue
                    lhs = node_txt[:eq_idx].strip()
                    argCode = node_txt[eq_idx + 3:].strip()
                    dot_idx = lhs.rfind('.')
                    receiverCode = lhs[:dot_idx] if dot_idx != -1 else lhs
                    refactor_payload.append({
                        "sink_key": f["sink_key"],
                        "fid": fid,
                        "kind": type1_kind_map.get(fid, ""),
                        "verdict": "TYPE1",
                        "argCode": argCode,
                        "receiverCode": receiverCode,
                        "sinkCode": f["sink_key"],
                    })
        finally:
            scon_f.close()

        type1_suggestions: Dict[int, str] = {}
        if refactor_payload:
            import sys as _sys
            compute_path = os.path.join(base, "babel-sink-detector", "src", "computeRefactorForOracle.js")
            payload_for_node = [{"sink_key": p["sink_key"], "kind": p["kind"], "verdict": p["verdict"],
                                  "argCode": p["argCode"], "receiverCode": p["receiverCode"],
                                  "sinkCode": p["sinkCode"]} for p in refactor_payload]
            try:
                proc = subprocess.run(
                    ["node", compute_path],
                    input=json.dumps(payload_for_node),
                    capture_output=True, text=True, timeout=300
                )
                if proc.returncode == 0:
                    suggestions_list = json.loads(proc.stdout)
                    sk_to_suggestion = {s["sink_key"]: s["refactor_suggestion"] for s in suggestions_list}
                    for p in refactor_payload:
                        sk = p["sink_key"]
                        if sk in sk_to_suggestion and sk_to_suggestion[sk]:
                            type1_suggestions[p["fid"]] = sk_to_suggestion[sk]
                else:
                    print(f"[oracle_patch] computeRefactorForOracle error: {proc.stderr}", file=_sys.stderr)
            except Exception as e:
                print(f"[oracle_patch] computeRefactorForOracle exception: {e}", file=_sys.stderr)

        type1_patch_groups_fresh: Dict[str, List] = {}
        type1_stage3_data: Dict[int, Dict] = {}
        for file_path, finds in type1_file_groups.items():
            fresh_finds = []
            for f in finds:
                fid = f["id"]
                suggestion = type1_suggestions.get(fid)
                offsets = fresh_offsets.get(fid)
                if not suggestion or not offsets:
                    continue
                type1_stage3_data[fid] = {
                    "refactor_suggestion": suggestion,
                    "display_suggestion": suggestion,
                    "patch_strategy": "replaceNode",
                }
                fresh_finds.append({
                    **f,
                    "action": "patch",
                    "patch_strategy": "replaceNode",
                    "refactor_suggestion": suggestion,
                    "display_suggestion": suggestion,
                    "node_start": offsets["node_start"],
                    "node_end": offsets["node_end"],
                    "arg_start": offsets["arg_start"],
                    "arg_end": offsets["arg_end"],
                })
            if fresh_finds:
                type1_patch_groups_fresh[file_path] = fresh_finds

        if type1_patch_groups_fresh:
            type1_patch_ids = _run_patcher(type1_patch_groups_fresh, "Stage 3 (TYPE1 replaceNode)")
            for fid in type1_patch_ids:
                if fid in type1_stage3_data and fid in id_data_map:
                    id_data_map[fid].update(type1_stage3_data[fid])
            patched_ids.extend(type1_patch_ids)
            patched_ids = list(set(patched_ids))

    commit_hash = ""
    if patched_ids:

        try:
            commit_hash = commit_patches(src_dir, len(patched_ids), msg_prefix="feat")
        except subprocess.CalledProcessError as e:
            raise HTTPException(status_code=500, detail=f"git commit failed: {e}")

        try:
            generate_runtime(app, name, src_dir, base)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"runtime generation failed: {e}")

    if patched_ids:
        con = None
        try:
            con = sqlite3.connect(sinks_db_path)
            updates = [
                (d["patch_verdict"], d["refactor_suggestion"], d["display_suggestion"],
                 d["patch_strategy"], d["patch_wrapper"], d["verdict_reasons"], fid)
                for fid in patched_ids
                if (d := id_data_map.get(fid))
            ]
            if updates:
                con.executemany(
                    "UPDATE sinks SET patch_count=patch_count+1, verdict=?, refactor_suggestion=?,"
                    " display_suggestion=?, patch_strategy=?, patch_wrapper=?, verdict_reasons=? WHERE id=?",
                    updates
                )
            con.commit()
        except Exception as e:
            if con:
                con.close()
            raise HTTPException(status_code=500, detail=f"sinks.db update failed: {e}")
        finally:
            if con:
                con.close()

        patched_sink_keys = [
            id_data_map[fid]["sink_key"]
            for fid in patched_ids
            if fid in id_data_map
        ]
        if patched_sink_keys:
            oracle_patched_sink_keys = set(patched_sink_keys)

            all_patched_files = list(set(
                list(file_groups.keys()) +
                list(type1_file_groups.keys())
            ))
            if all_patched_files:
                _update_node_offsets_after_patch(
                    all_patched_files, oracle_patched_sink_keys, sinks_db_path, base, src_dir
                )

    applied_map = {
        id_data_map[fid]["sink_key"]: id_data_map[fid]["patch_verdict"]
        for fid in patched_ids
        if fid in id_data_map
    }
    keys_to_mark_done = list(applied_map.keys())

    if keys_to_mark_done:
        import time
        try:

            os.chmod(reports_db_path, 0o666) if os.path.exists(reports_db_path) else None
        except (OSError, PermissionError):
            pass

        max_retries = 3
        success = False
        for attempt in range(max_retries):
            try:
                rcon = sqlite3.connect(reports_db_path, timeout=5.0)
                rcon.execute("PRAGMA journal_mode=WAL")
                now_ms = int(time.time() * 1000)
                rcon.executemany(
                    "UPDATE oracle_verdicts SET is_patch_target=2, applied_verdict=?, applied_at=?"
                    " WHERE sink_key=?",
                    [(applied_map[sk], now_ms, sk) for sk in keys_to_mark_done]
                )
                rcon.commit()
                rcon.close()
                import sys as _sys
                print(f"[oracle_patch] Updated is_patch_target=2/applied_verdict for {len(keys_to_mark_done)} successfully patched verdicts", file=_sys.stderr)
                success = True
                break
            except sqlite3.OperationalError as e:
                import sys as _sys
                if "readonly" in str(e).lower() or "attempt to write" in str(e).lower():
                    if attempt < max_retries - 1:
                        time.sleep(0.5 * (attempt + 1))
                        continue
                    print(f"[oracle_patch] reports.db is readonly (owned by {os.stat(reports_db_path).st_uid}, need write access). Attempt {attempt+1}/{max_retries}", file=_sys.stderr)
                else:
                    print(f"[oracle_patch] Database error: {e}", file=_sys.stderr)
                if attempt == max_retries - 1:

                    report_server = os.environ.get("REPORT_SERVER_URL", "http://localhost:9000").rstrip("/")
                    endpoint = f"{report_server}/api/oracle-verdicts/mark-applied"
                    body = json.dumps({
                        "entries": [
                            {"sinkKey": sk, "appliedVerdict": applied_map[sk]}
                            for sk in keys_to_mark_done
                        ]
                    }).encode("utf-8")
                    request = urllib.request.Request(
                        endpoint, data=body,
                        headers={"Content-Type": "application/json"}, method="POST"
                    )
                    try:
                        with urllib.request.urlopen(request, timeout=15) as response:
                            result = json.loads(response.read().decode("utf-8"))
                        print(
                            f"[oracle_patch] report-server marked {result.get('changes', 0)} verdicts applied",
                            file=_sys.stderr
                        )
                        success = True
                        break
                    except Exception as api_error:
                        raise HTTPException(
                            status_code=500,
                            detail=(
                                f"Failed to update is_patch_target directly after {max_retries} attempts: {e}; "
                                f"report-server fallback failed: {api_error}"
                            )
                        ) from api_error
            except Exception as e:
                import sys as _sys
                print(f"[oracle_patch] Unexpected error updating is_patch_target: {e}", file=_sys.stderr)
                raise HTTPException(status_code=500, detail=f"Failed to update is_patch_target: {e}")
    else:
        import sys as _sys
        print(f"[oracle_patch] No successful patches - is_patch_target remains at 1 for retry", file=_sys.stderr)

    result_items = skipped
    result_items.extend([
        {**_normalize_patch_result(r), "sink_key": id_data_map.get(r.get("id"), {}).get("sink_key", "")}
        for r in patch_results
        if id(r) not in _type1_stage2_obj_ids
    ])

    return {
        "results": result_items,
        "branch": branch_name if commit_hash else "",
        "commit": commit_hash
    }

@app.get("/findings", response_class=HTMLResponse)
async def findings_list(
    request: Request,
    app: list[str] = Query(default=[]),
    verdict: list[str] = Query(default=[]),
    sink_type: list[str] = Query(default=[]),
    status: list[str] = Query(default=[]),
    kind: list[str] = Query(default=[]),
    page: int = 1
):
    per_page = 50
    offset = (page - 1) * per_page
    app = [a for a in app if a]
    kind = [k for k in kind if k]
    if not status:
        status = ["RECEIVER_MATCH", "NO_RECEIVER"]
    findings = db.get_findings(
        apps=app,
        verdicts=verdict,
        sink_types=sink_type,
        statuses=status,
        kinds=kind,
        offset=offset,
        limit=per_page
    )
    total = db.get_findings_count(
        apps=app,
        verdicts=verdict,
        sink_types=sink_type,
        statuses=status,
        kinds=kind
    )
    all_apps = db.get_all_apps()
    stats = db.get_findings_stats()
    dashboard_stats = db.get_dashboard_stats()
    app_counts = {row["app"]: row["total"] for row in dashboard_stats}

    if request.headers.get("HX-Request"):
        return templates.TemplateResponse("partials/findings_table.html", {
            "request": request,
            "app": app,
            "findings": findings,
            "total": total,
            "page": page,
            "per_page": per_page,
            "expand_mode": True
        })

    return templates.TemplateResponse("findings.html", {
        "request": request,
        "app": app,
        "findings": findings,
        "total": total,
        "page": page,
        "per_page": per_page,
        "apps": all_apps,
        "app_counts": app_counts,
        "selected_apps": app,
        "selected_verdicts": verdict,
        "selected_sink_types": sink_type,
        "selected_statuses": status,
        "selected_kinds": kind,
        "verdict_counts": stats["verdicts"],
        "sink_type_counts": stats["sink_types"],
        "status_counts": stats["statuses"],
        "kind_counts": stats["kinds"],
        "expand_mode": True
    })

@app.get("/api/counts")
async def api_counts(
    app: list[str] = Query(default=[]),
    verdict: list[str] = Query(default=[]),
    sink_type: list[str] = Query(default=[]),
    status: list[str] = Query(default=[]),
    kind: list[str] = Query(default=[])
):
    app = [a for a in app if a]
    kind = [k for k in kind if k]
    counts = db.get_filtered_counts(
        apps=app,
        verdicts=verdict,
        sink_types=sink_type,
        statuses=status,
        kinds=kind
    )
    return JSONResponse(counts)

@app.get("/findings/{finding_id}", response_class=HTMLResponse)
async def finding_detail(request: Request, finding_id: int):
    row = db.get_finding_by_id(finding_id)
    if not row:
        raise HTTPException(status_code=404)

    finding = dict(row)
    finding["verdict_reasons_parsed"] = json.loads(row["verdict_reasons"] or "[]")
    finding["html_tags_parsed"] = json.loads(row["html_tags"] or "[]")

    return templates.TemplateResponse("finding_detail.html", {
        "request": request,
        "finding": finding
    })

@app.get("/sinks/{app}/findings/{finding_id}", response_class=HTMLResponse)
async def finding_detail_in_app(request: Request, app: str, finding_id: int):
    row = db.get_finding_in_app(app, finding_id)
    if not row:
        raise HTTPException(status_code=404)

    finding = dict(row)
    finding["verdict_reasons_parsed"] = json.loads(row["verdict_reasons"] or "[]")
    finding["html_tags_parsed"] = json.loads(row["html_tags"] or "[]")

    return templates.TemplateResponse("finding_detail.html", {
        "request": request,
        "finding": finding
    })

@app.get("/sinks/{app}/findings/{finding_id}/expand", response_class=HTMLResponse)
async def finding_expand(request: Request, app: str, finding_id: int):
    row = db.get_finding_in_app(app, finding_id)
    if not row:
        raise HTTPException(status_code=404)

    finding = dict(row)
    finding["verdict_reasons_parsed"] = json.loads(row["verdict_reasons"] or "[]")
    finding["html_tags_parsed"] = json.loads(row["html_tags"] or "[]")

    return templates.TemplateResponse("partials/finding_row.html", {
        "request": request,
        "finding": finding
    })

@app.get("/sinks/{app}/oracle-verdicts/{sink_key:path}/expand", response_class=HTMLResponse)
async def oracle_verdict_expand(request: Request, app: str, sink_key: str):
    name = get_target_name(app)
    if not name:
        raise HTTPException(status_code=404)

    _default_base = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    base = os.environ.get("RESEARCH_DIR", _default_base)

    if os.environ.get("REGRESSION_EVAL_MODE") == "true":
        reports_db_path = os.path.join(base, "out", "targets", name, "eval", "functionality", "reports.db")
    else:
        reports_db_path = os.path.join(base, "out", "targets", name, "reports.db")

    oracle_verdict = None
    patch_verdict = None
    try:
        conn = sqlite3.connect(reports_db_path)
        row = conn.execute(
            'SELECT oracle_verdict, patch_verdict FROM oracle_verdicts WHERE sink_key = ?',
            (sink_key,)
        ).fetchone()
        conn.close()
        if row:
            oracle_verdict, patch_verdict = row[0], row[1]
    except Exception:
        raise HTTPException(status_code=404)

    sinks_db_path = db.get_db_path(app)
    original_snippet = None
    left_code = None
    try:
        sinks_conn = sqlite3.connect(f"file:{sinks_db_path}?mode=ro", uri=True)
        row = sinks_conn.execute(
            'SELECT original_snippet, display_suggestion FROM sinks WHERE sink_key = ? LIMIT 1',
            (sink_key,)
        ).fetchone()
        sinks_conn.close()
        if row:
            original_snippet, left_code = row[0], row[1]
    except Exception:
        pass

    right_code = _apply_oracle_patch_preview(original_snippet, left_code, patch_verdict) if patch_verdict else original_snippet or ""

    return templates.TemplateResponse("partials/oracle_verdict_row.html", {
        "request": request,
        "sink_key": sink_key,
        "oracle_verdict": oracle_verdict,
        "patch_verdict": patch_verdict,
        "left_code": left_code or "(no code)",
        "right_code": right_code or "(no preview)",
    })

def get_language_from_path(file_path: str) -> str:
    ext = os.path.splitext(file_path)[1].lower()
    ext_map = {
        ".js": "javascript",
        ".ts": "typescript",
        ".jsx": "javascript",
        ".tsx": "typescript",
        ".py": "python",
        ".html": "html",
        ".htm": "html",
        ".css": "css",
        ".json": "json",
        ".xml": "xml",
        ".java": "java",
        ".cpp": "cpp",
        ".c": "c",
        ".cs": "csharp",
        ".php": "php",
        ".rb": "ruby",
        ".go": "go",
        ".rs": "rust",
        ".sh": "bash",
        ".sql": "sql",
    }
    return ext_map.get(ext, "plaintext")

@app.post("/api/{app}/report")
async def receive_report(app: str, payload: dict = Body(...)):

    name = get_target_name(app)
    if not name:
        raise HTTPException(status_code=404, detail=f"App {app} not found")

    _default_base = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    base = os.environ.get("RESEARCH_DIR", _default_base)

    if os.environ.get("REGRESSION_EVAL_MODE") == "true":
        report_db_path = os.path.join(base, "out", "targets", name, "eval", "functionality", "report.db")
    else:
        report_db_path = os.path.join(base, "out", "targets", name, "report.db")

    try:
        conn = sqlite3.connect(report_db_path)
        conn.execute("""CREATE TABLE IF NOT EXISTS reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            payload TEXT NOT NULL
        )""")
        conn.execute("INSERT INTO reports (payload) VALUES (?)", (json.dumps(payload),))
        conn.commit()
        conn.close()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    return {"status": "ok"}

@app.get("/raw", response_class=HTMLResponse)
async def raw_file(finding_id: int, app: str = Query(None)):
    row = db.get_finding_in_app(app, finding_id) if app else db.get_finding_by_id(finding_id)
    if not row:
        raise HTTPException(status_code=404)

    file_path = row["file"]
    try:
        with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
            content = f.read()

        lines = content.split("\n")
        target_line = int(row["line"])
        escaped_path = html_module.escape(file_path)

        try:
            lexer = get_lexer_for_filename(file_path)
        except:
            from pygments.lexers import get_lexer_by_name
            lexer = get_lexer_by_name("text")

        formatter = HtmlFormatter(style="friendly", noclasses=True, full=False, nowrap=True)

        highlighted_full = highlight(content, lexer, formatter)
        highlighted_lines = highlighted_full.split("\n")

        html_lines = []
        for i, line in enumerate(lines, 1):
            if i <= len(highlighted_lines):
                highlighted = highlighted_lines[i - 1]
            else:
                highlighted = html_module.escape(line)

            if i == target_line:
                html_lines.append(f"<span id='target-line' style='background: #ffeb3b; display: block;'>{i:6d}: {highlighted}</span>")
            else:
                html_lines.append(f"{i:6d}: {highlighted}")

        html_content = "\n".join(html_lines)

        return f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>{escaped_path}</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", monospace; margin: 20px; background: #ffffff; color: #333333; }}
    h1 {{ font-size: 1.2em; margin: 0 0 10px 0; word-break: break-all; }}
    .info {{ color: #7f8c8d; font-size: 0.9em; margin-bottom: 20px; }}
    pre {{ margin: 0; background: #f5f5f5; padding: 16px; border-radius: 4px; overflow-x: auto; }}
    code {{ font-family: 'Monaco', 'Menlo', 'Consolas', monospace; font-size: 0.9em; line-height: 1.6; }}
  </style>
</head>
<body>
  <h1>{escaped_path}</h1>
  <div class="info">Line {target_line} is highlighted</div>
  <pre><code>{html_content}</code></pre>
  <script>
    document.getElementById('target-line').scrollIntoView({{ block: 'center' }});
  </script>
</body>
</html>"""
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/sinks/{app}/patch-typeof")
async def patch_typeof_sinks(app: str):

    all_apps = db.get_all_apps()
    if app not in all_apps:
        raise HTTPException(status_code=404, detail=f"App not found: {app}")

    name = get_target_name(app)
    if not name:
        raise HTTPException(status_code=404, detail=f"targets YAML not found for {app}")

    _default_base = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    base = os.environ.get("RESEARCH_DIR", _default_base)
    src_dir = os.path.join(base, "out", "targets", name, "src")
    sinks_db_path = db.get_db_path(app)

    if not os.path.isdir(os.path.join(src_dir, ".git")):
        raise HTTPException(status_code=404, detail=f"git repo not found at {src_dir}")

    try:
        scon = sqlite3.connect(sinks_db_path, check_same_thread=False)
        scon.row_factory = sqlite3.Row
        rows = scon.execute(
            "SELECT id, file, line, col, node_start, node_end, arg_start, arg_end, "
            "patch_strategy, patch_wrapper, sink_key FROM sinks "
            "WHERE kind IN ('eval', 'setTimeout.string', 'setInterval.string') "
            "AND patch_strategy = 'wrapArgument' AND node_start IS NOT NULL"
        ).fetchall()
        rows_data = [dict(r) for r in rows]
        scon.close()
    except Exception:
        raise HTTPException(status_code=500, detail="Failed to read sinks")

    if not rows_data:
        return {"results": [], "message": "No eval/setTimeout/setInterval sinks found"}

    file_groups = {}
    for r in rows_data:
        file_path = r["file"]
        if not os.path.isabs(file_path):
            file_path = os.path.abspath(os.path.join(src_dir, file_path))
        if file_path not in file_groups:
            file_groups[file_path] = []
        finding_data = {
            "id": r["id"],
            "action": "repatch",
            "with_typeof": True,
            "node_start": r["node_start"],
            "node_end": r["node_end"],
            "arg_start": r["arg_start"],
            "arg_end": r["arg_end"],
            "patch_strategy": r["patch_strategy"],
            "patch_wrapper": r["patch_wrapper"],
            "sink_key": r["sink_key"],
        }
        file_groups[file_path].append(finding_data)

    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    branch_name = f"ttgen-patch-typeof/{ts}"
    try:
        prepare_branch(src_dir, branch_name)
    except subprocess.CalledProcessError:
        raise HTTPException(status_code=500, detail="git operation failed")

    patcher_path = os.path.join(base, "babel-sink-detector", "src", "patcher.js")
    payload = [
        {"file": f, "findings": finds}
        for f, finds in file_groups.items()
    ]

    try:
        proc = subprocess.run(
            ["node", patcher_path],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            timeout=300
        )
        if proc.returncode != 0:
            raise HTTPException(status_code=500, detail=f"patcher.js failed: {proc.stderr}")
        results = json.loads(proc.stdout)
    except Exception as e:
        if isinstance(e, HTTPException):
            raise
        raise HTTPException(status_code=500, detail=f"patcher.js exception: {str(e)}")

    patched_ids = [
        r["id"] for r in results
        if r.get("status") == "ok" and r.get("verified") is True and not r.get("note")
    ]
    if patched_ids:
        commit_msg = f"refactor: add typeof to eval/setTimeout/setInterval sinks ({len(patched_ids)} sinks)"
        try:
            commit_hash = commit_patches(src_dir, len(patched_ids), "typeof-injection")
        except Exception:
            commit_hash = ""

    return {
        "results": results,
        "branch": branch_name,
        "commit": commit_hash if patched_ids else "",
        "patched_count": len(patched_ids)
    }

@app.post("/sinks/{app}/regenerate-policy")
async def regenerate_policy(app: str):

    all_apps = db.get_all_apps()
    if app not in all_apps:
        raise HTTPException(status_code=404, detail=f"App not found: {app}")

    name = get_target_name(app)
    if not name:
        raise HTTPException(status_code=404, detail=f"targets YAML not found for {app}")

    _default_base = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    base = os.environ.get("RESEARCH_DIR", _default_base)
    src_dir = os.path.join(base, "out", "targets", name, "src")

    try:
        generate_runtime(app, name, src_dir, base)
        return {"status": "ok", "message": "tt-policy.js regenerated successfully"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to regenerate policy: {str(e)}")

@app.get("/reports", response_class=HTMLResponse)
async def report_dashboard(request: Request):

    all_apps = db.get_all_report_app_dbs()
    stats = []

    for app_id, db_path in all_apps:
        summary = db.get_report_summary(db_path)
        stats.append({
            "app_id": app_id,
            "classify_count": summary["classify_count"],
            "violation_count": summary["violation_count"],
            "unique_sinks": summary["unique_sinks"],
            "verdict_counts": summary["verdict_counts"]
        })

    return templates.TemplateResponse("report_dashboard.html", {
        "request": request,
        "apps": stats
    })

@app.get("/reports/{app}", response_class=HTMLResponse)
async def report_app_detail(
    app: str,
    request: Request,
    table: Literal["classify_reports", "violation_reports"] = "classify_reports",
    verdict: List[str] = Query(None),
    tt_type: List[str] = Query(None),
    kind: List[str] = Query(None),
    page: int = Query(1, ge=1)
):

    all_report_apps = [a for a, _ in db.get_all_report_app_dbs()]
    if app not in all_report_apps:
        raise HTTPException(status_code=404, detail=f"App not found: {app}")

    try:
        db_path = db.get_report_db_path(app)
    except Exception:
        raise HTTPException(status_code=404, detail=f"reports.db not found for {app}")

    verdict = verdict or []
    tt_type = tt_type or []
    kind = kind or []

    per_page = 50
    offset = (page - 1) * per_page

    rows = db.get_reports_grouped_by_sink(db_path, table, verdict, tt_type, kind, offset, per_page)
    total_count = db.get_reports_grouped_by_sink_count(db_path, table, verdict, tt_type, kind)
    total_pages = (total_count + per_page - 1) // per_page

    all_verdicts = db.get_report_distinct_values(db_path, table, "reclassified_verdict")
    all_tt_types = db.get_report_distinct_values(db_path, table, "tt_type")
    all_kinds = db.get_report_distinct_values(db_path, table, "sink_kind")

    return templates.TemplateResponse("report_app_detail.html", {
        "request": request,
        "app": app,
        "table": table,
        "rows": rows,
        "page": page,
        "total_pages": total_pages,
        "total_count": total_count,
        "per_page": per_page,
        "filters": {
            "verdict": verdict,
            "tt_type": tt_type,
            "kind": kind
        },
        "available_verdicts": all_verdicts,
        "available_tt_types": all_tt_types,
        "available_kinds": all_kinds
    })

@app.get("/reports/{app}/data", response_class=HTMLResponse)
async def report_app_data(
    app: str,
    request: Request,
    table: Literal["classify_reports", "violation_reports"] = "classify_reports",
    verdict: List[str] = Query(None),
    tt_type: List[str] = Query(None),
    kind: List[str] = Query(None),
    page: int = Query(1, ge=1)
):

    all_report_apps = [a for a, _ in db.get_all_report_app_dbs()]
    if app not in all_report_apps:
        raise HTTPException(status_code=404, detail=f"App not found: {app}")

    try:
        db_path = db.get_report_db_path(app)
    except Exception:
        raise HTTPException(status_code=404, detail=f"reports.db not found for {app}")

    verdict = verdict or []
    tt_type = tt_type or []
    kind = kind or []

    per_page = 50
    offset = (page - 1) * per_page

    rows = db.get_reports_grouped_by_sink(db_path, table, verdict, tt_type, kind, offset, per_page)
    total_count = db.get_reports_grouped_by_sink_count(db_path, table, verdict, tt_type, kind)
    total_pages = (total_count + per_page - 1) // per_page

    return templates.TemplateResponse("partials/report_table.html", {
        "request": request,
        "app": app,
        "table": table,
        "rows": rows,
        "page": page,
        "total_pages": total_pages,
        "total_count": total_count,
        "per_page": per_page,
        "filters": {
            "verdict": verdict,
            "tt_type": tt_type,
            "kind": kind
        }
    })

@app.get("/reports/{app}/details", response_class=HTMLResponse)
async def report_sink_details(
    app: str,
    request: Request,
    table: Literal["classify_reports", "violation_reports"] = "classify_reports",
    sink_key: str = Query("")
):

    if not sink_key:
        return "<div>No sink specified</div>"

    all_report_apps = [a for a, _ in db.get_all_report_app_dbs()]
    if app not in all_report_apps:
        raise HTTPException(status_code=404, detail=f"App not found: {app}")

    try:
        db_path = db.get_report_db_path(app)
    except Exception:
        raise HTTPException(status_code=404, detail=f"reports.db not found for {app}")

    if sink_key == "__NULL__":
        reports = db.get_reports_by_sink_null(db_path, table)
    else:
        reports = db.get_reports_by_sink(db_path, table, sink_key)

    html = '<div style="font-size: 0.9em;">'
    if not reports:
        html += '<p style="color: #999; padding: 8px;">No reports found</p>'
    else:
        html += '<table style="width: 100%; border-collapse: collapse; font-size: 0.85em; table-layout: fixed;">'
        html += '<thead><tr style="background: #fafafa; border-bottom: 1px solid #ddd;">'
        html += '<th style="text-align: left; padding: 8px; font-weight: 600; width: 80px;">Verdict</th>'
        html += '<th style="text-align: left; padding: 8px; font-weight: 600; width: 180px;">Value Preview</th>'
        html += '<th style="text-align: left; padding: 8px; font-weight: 600; width: 150px;">Page URL</th>'
        html += '<th style="text-align: left; padding: 8px; font-weight: 600; width: 150px;">Verdict Reasons</th>'
        html += '<th style="text-align: left; padding: 8px; font-weight: 600; width: 180px;">Source Values</th>'
        html += '<th style="text-align: left; padding: 8px; font-weight: 600; width: 100px;">Received</th>'
        html += '</tr></thead><tbody>'

        for report in reports:
            verdict = report.get('reclassified_verdict', '?')
            value_preview = report.get('value_preview', '')[:60]
            page_url = report.get('page_url', '')[:60]
            verdict_reasons = report.get('verdict_reasons', '')
            source_values = report.get('source_values', '')
            received_at = report.get('received_at', '')

            html += '<tr style="border-bottom: 1px solid #eee;">'
            html += f'<td style="padding: 8px; overflow: hidden; text-overflow: ellipsis;"><span class="badge badge-{verdict}">{verdict}</span></td>'
            html += f'<td style="padding: 8px; word-break: break-word; overflow: hidden;">{html_module.escape(value_preview)}</td>'
            html += f'<td style="padding: 8px; word-break: break-word; overflow: hidden;">{html_module.escape(page_url)}</td>'
            html += f'<td style="padding: 8px; word-break: break-word; overflow: hidden; font-size: 0.85em;">{html_module.escape(str(verdict_reasons)[:100])}</td>'
            html += f'<td style="padding: 8px; word-break: break-word; overflow: hidden; font-size: 0.85em;">{html_module.escape(str(source_values)[:100])}</td>'
            html += f'<td style="padding: 8px; overflow: hidden; text-overflow: ellipsis;">{received_at}</td>'
            html += '</tr>'

        html += '</tbody></table>'
    html += '</div>'

    return html
