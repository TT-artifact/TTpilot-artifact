# TTpilot Artifact

This artifact contains the configurations and scripts required to run
TTpilot on all benchmark applications evaluated in the paper.

For an end-to-end validation, this README demonstrates the complete workflow
using `beep.js`. Reproducing the full benchmark requires substantially more
time and computational resources.

The examples below use `targets/beep.js.yml`. The complete quick-start
workflow, including both crawler passes and all three evaluations, takes
approximately 30 minutes in our environment.

## 1. Environment Setup

### System requirements

- Linux with Bash
- Python 3.12 or later
- Node.js and npm
- Docker with Docker Compose
- Git, `curl`, and `lsof`

### Python and Node.js dependencies

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
playwright install chromium
npm ci --prefix babel-sink-detector
npm ci --prefix eval/testurl
```

Activate the virtual environment again before continuing in a new shell:

```bash
source .venv/bin/activate
```

### CodeQL

```bash
mkdir -p tools
curl -L https://github.com/github/codeql-action/releases/download/codeql-bundle-v2.25.1/codeql-bundle-linux64.tar.gz -o tools/codeql-bundle-linux64.tar.gz
tar -xzf tools/codeql-bundle-linux64.tar.gz -C tools
./tools/codeql/codeql version
```

## 2. Analysis and Patching

Run the following steps in order.

### Step 1: Detect sinks

```bash
./scripts/1_run-detect.sh targets/beep.js.yml
```

### Step 2: Apply patches

```bash
python3 scripts/2_patch.py targets/beep.js.yml
```

### Step 3: Build the patched application

```bash
./scripts/3_run-app.sh targets/beep.js.yml
```

This step prepares the patched runtime under
`out/targets/beep.js/runtime/`. Stop its containers before running an
evaluation if ports `8080`, `8081`, or `9000` remain occupied.

## 3. Crawling and URL Preparation

### Step 4: Generate seed URLs

```bash
python3 scripts/4_gen_sink_urls.py targets/beep.js.yml
```

### Steps 5--6: Crawl and Update Detected Sinks

Steps 5 and 6 form one crawling pass:

1. run a crawler; and
2. process its runtime reports to update the detected sink classifications
   and patches.

Run the ZAP pass first. The subsequent agent pass targets sinks that remain
unresolved after the ZAP pass and may be skipped when an authenticated Claude
CLI installation is unavailable.

#### ZAP Pass

##### Step 5: Run the ZAP hybrid crawler

```bash
python3 scripts/5_crawl_zap_hybrid.py targets/beep.js.yml
```

##### Step 6: Process the ZAP reports

```bash
python3 scripts/6_update_sinks.py targets/beep.js.yml
```

The update regenerates the patched runtime. Restart the application before
starting another crawling pass:

```bash
./scripts/3_run-app.sh stop targets/beep.js.yml
./scripts/3_run-app.sh targets/beep.js.yml
```

#### Agent Pass (Optional)

The agent pass may be skipped for a shorter validation of the artifact.
It is required to reproduce the complete crawling workflow evaluated in
the paper.

##### Step 5: Run the agent crawler

The agent crawler requires an authenticated Claude CLI installation. It reads
the target source and sink metadata and sends the task context to Claude. Run
it only when this external transmission is acceptable:

```bash
python3 scripts/5_crawl_agent.py targets/beep.js.yml
```

Crawler state is stored in `out/targets/beep.js/agent_crawl.db`, and per-run
results are stored under `out/targets/beep.js/agent_runs/`. By default, an
interrupted run resumes from its saved state. Use `--no-resume` to start a new
run.

##### Step 6: Process the agent-crawler reports

Apply the reports produced by the agent crawler using the same update step:

```bash
python3 scripts/6_update_sinks.py targets/beep.js.yml
```

### Step 7: Generate evaluation URLs

Generate the union of crawler URLs and URLs recorded in `reports.db`:

```bash
python3 eval/0_gen_combined_urls.py
```

The generated file is:

```text
out/targets/beep.js/eval/combined_urls.yaml
```

Stop the application containers before starting the evaluations, which use
the same ports:

```bash
./scripts/3_run-app.sh stop targets/beep.js.yml
```

The patching command in Step 2 also starts the sink viewer in background
mode. Stop the viewer before running the evaluations:

```bash
./scripts/0_run-viewer.sh stop
```

### Step 8: Validate evaluation URLs

Run the patched and unpatched applications, validate the URLs in
`combined_urls.yaml`, and select the HTML pages used by subsequent evaluations:

```bash
eval/testurl/run.sh targets/beep.js.yml
```

This step writes the detailed URL test results to
`out/targets/beep.js/eval/testurl/results/testurl_*.json` and generates:

```text
out/targets/beep.js/eval/target_urls.yaml
```

Use `--keep-containers` only when the test containers need to remain available
for debugging. Otherwise, the script removes them after the run.

## 4. Evaluation

### Functionality

Run the patched and unpatched applications side by side and replay the
collected URLs:

```bash
eval/functionality/run.sh targets/beep.js.yml
```

The wrapper generates reports even when Playwright detects a regression.
Inspect the JSON summary or HTML report for the actual verdict.

### Runtime overhead

Measure the page-load and policy-execution overhead of the patched application:

```bash
eval/overhead/run.sh targets/beep.js.yml
```

### Security

```bash
eval/security/run.sh \
  targets/beep.js.yml \
  eval/security/poc/CVE-2024-26465.yml
```

### Evaluation outputs

| Evaluation | Output directory |
| --- | --- |
| Functionality | `out/targets/beep.js/eval/functionality/results/` |
| Runtime overhead | `out/targets/beep.js/eval/overhead/results/` |
| Security | `out/targets/beep.js/eval/security/results/` |

Evaluation containers are removed after each run unless
`--keep-containers` is specified.

## 5. Sink Viewer

To inspect and manage detected sinks independently, start the viewer in
the foreground:

```bash
./scripts/0_run-viewer.sh
```

Open `http://localhost:8000` in a browser.

```bash
./scripts/0_run-viewer.sh 8001
./scripts/0_run-viewer.sh start -b
./scripts/0_run-viewer.sh stop
./scripts/0_run-viewer.sh restart -b
```

The first command selects another port. The remaining commands start, stop,
or restart the viewer in background mode.



## 6. Running Other Benchmark Applications

Configuration files for all benchmark applications are available under
`targets/`. To evaluate another application, replace
`targets/beep.js.yml` in Steps 1--8 with the corresponding configuration:

```bash
ls targets/*.yml
```

Then follow the same analysis, patching, crawling, URL-preparation, and
evaluation steps described above. Application-specific settings, including
repository revisions, ports, authentication requirements, and seed URLs, are
defined in the corresponding target configuration.