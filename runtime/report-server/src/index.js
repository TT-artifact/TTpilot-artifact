#!/usr/bin/env node

const path = require("path");
const fs = require("fs");
const { Command } = require("commander");
const Database = require("better-sqlite3");
const Fastify = require("fastify");

const { initSchema } = require("./schema");
const {
  makeStore,
  listJsSignatures, addJsSignature, removeJsSignature,
  listUrlSignatures, addUrlSignature, removeUrlSignature,
  seedUrlSignatures, approveReport, addOracleVerdict, markOracleVerdictsApplied, getOracleVerdict,
  getSinkDetails, getOraclePatchPreview,
} = require("./store");

const REPORTS_HTML = fs.readFileSync(path.join(__dirname, "reports.html"), "utf-8");

function parseStackLocation(stack) {
  if (!stack) return null;
  for (const line of stack.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("at ") || t.includes("tt-bootstrap.js")) continue;
    const m = t.match(/\(?(https?:\/\/[^)\s]+)\)?$/);
    if (!m) continue;
    const raw = m[1];
    const loc = raw.match(/:(\d+):(\d+)$/);
    const filePath = raw.replace(/:(\d+):(\d+)$/, "").replace(/^https?:\/\/[^/]+/, "");
    if (filePath && loc) return filePath + ":" + loc[1];
  }
  return null;
}

function validateReport(body) {
  if (!body || typeof body !== "object") return "body must be a JSON object";
  if (typeof body.source !== "string" || body.source.length === 0)
    return "source is required";
  if (!["classify", "violation"].includes(body.source))
    return 'source must be "classify" or "violation"';
  if (typeof body.ttType !== "string") return "ttType is required";
  return null;
}

async function buildServer(opts) {
  const dbPath = path.resolve(opts.db);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath, { readonly: false });

  db.pragma('busy_timeout = 30000');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  initSchema(db);

  try {
    fs.chmodSync(dbPath, 0o666);
  } catch (e) {

  }

  const urlConfigPath = path.join(__dirname, "../../../babel-sink-detector/url_config.json");
  seedUrlSignatures(db, urlConfigPath);

  const sinksDbPath = path.join(path.dirname(dbPath), "sinks.db");
  const store = makeStore(db, sinksDbPath);

  const fastify = Fastify({ logger: { level: "info" } });

  const parseJSON = (_req, body, done) => {
    try { done(null, JSON.parse(body)); } catch (e) { done(e); }
  };
  fastify.addContentTypeParser("application/json", { parseAs: "string" }, parseJSON);
  fastify.addContentTypeParser("text/plain",       { parseAs: "string" }, parseJSON);

  fastify.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin || "*";
    reply.header("Access-Control-Allow-Origin",  origin);
    reply.header("Access-Control-Allow-Credentials", "true");
    reply.header("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    reply.header("Access-Control-Allow-Headers", "Content-Type");
  });
  fastify.options("/*", async (_req, reply) => reply.code(204).send());

  fastify.get("/health", async () => ({ ok: true }));

  function insertOneReport(body) {
    const error = validateReport(body);
    if (error) return error;
    if (body.source === 'classify') {
      store.insertClassifyReport(body);
    } else {
      store.insertViolationReport(body);
    }
    return null;
  }

  fastify.post("/tt-report", async (req, reply) => {

    const batch = Array.isArray(req.body?.reports) ? req.body.reports : [req.body];

    const sharedSourceValues = req.body?.sourceValues;
    try {
      for (const report of batch) {
        const withSourceValues = sharedSourceValues !== undefined && report.sourceValues === undefined
          ? { ...report, sourceValues: sharedSourceValues }
          : report;
        const error = insertOneReport(withSourceValues);
        if (error) { reply.code(400); return { error }; }
      }
      reply.code(204);
      return null;
    } catch (err) {
      req.log.error({ err }, "insert failed");
      reply.code(500);
      return { error: "insert failed" };
    }
  });

  fastify.get("/tt-report/stats", async () => store.getStats());

  fastify.get("/tt-report/list", async (req) => {
    const limit  = Math.min(parseInt(req.query.limit  ?? "50", 10) || 50,  500);
    const offset = Math.max(parseInt(req.query.offset ?? "0",  10) || 0,   0);
    const result = store.getList({ limit, offset });
    result.rows = result.rows.map(r => ({ ...r, location: parseStackLocation(r.stack) }));
    return result;
  });

  fastify.get("/tt-report/by-sink", async () => store.getBySink());

  fastify.get("/classify-reports/by-sink", async () => store.getBySink());

  fastify.get("/violation-reports/by-sink", async () => store.getViolationBySink());

  fastify.get("/tt-report/by-sink/:sinkKey", async (req) => {
    const result = store.getReportsBySinkKey(req.params.sinkKey);
    return result.map(r => ({ ...r, location: parseStackLocation(r.stack) }));
  });

  fastify.get("/violation-reports/by-sink/:sinkKey", async (req) => {
    const rows = db.prepare(`
      SELECT id, received_at, tt_type, sink_key, sink_kind,
             reclassified_verdict, verdict_reasons, value_preview, value_length, page_url, stack, count,
             source_values, xss_source_values, js_signature, url_signature, sanitized_value_preview
      FROM violation_reports
      WHERE sink_key = @sinkKey
      ORDER BY id DESC
    `).all({ sinkKey: req.params.sinkKey });

    return rows.map(r => ({
      ...r,
      verdict_reasons: r.verdict_reasons != null ? JSON.parse(r.verdict_reasons) : null,
      source_values: r.source_values != null ? JSON.parse(r.source_values) : null,
      xss_source_values: r.xss_source_values != null ? JSON.parse(r.xss_source_values) : null,
      js_signature:  r.js_signature  != null ? JSON.parse(r.js_signature)  : null,
      url_signature: r.url_signature != null ? JSON.parse(r.url_signature) : null,
      location: parseStackLocation(r.stack),
    }));
  });

  fastify.get("/violation-reports/unknown-sink", async () => {
    return store.getViolationByUnknownSink();
  });

  fastify.get("/violation-reports/unknown-sink/:callerLocation", async (req) => {
    const rows = store.getViolationByCallerLocation(req.params.callerLocation);
    return rows.map(r => ({ ...r, location: parseStackLocation(r.stack) }));
  });

  fastify.get("/classify-reports/unknown-sink", async () => {
    return store.getClassifyByUnknownSink();
  });

  fastify.get("/classify-reports/unknown-sink/:callerLocation", async (req) => {
    const rows = store.getClassifyByCallerLocation(req.params.callerLocation);
    return rows.map(r => ({ ...r, location: parseStackLocation(r.stack) }));
  });

  fastify.post("/admin/backfill-caller-locations", async (req, reply) => {
    try {
      const violations = store.backfillCallerLocations();
      const classify = store.backfillClassifyCallerLocations();
      return { violations, classify };
    } catch (err) {
      req.log.error({ err }, "backfill failed");
      reply.code(500);
      return { error: "backfill failed" };
    }
  });

  fastify.get("/reports", async (_req, reply) =>
    reply.type("text/html; charset=utf-8").send(REPORTS_HTML)
  );

  fastify.get("/api/js-signatures", async () => listJsSignatures(db));

  fastify.post("/api/js-signatures", async (req, reply) => {
    const { signature, note } = req.body ?? {};
    if (!signature || typeof signature !== "string")
      return reply.code(400).send({ error: "signature required" });
    const result = addJsSignature(db, signature, note);
    return { ok: true, changes: result.changes };
  });

  fastify.delete("/api/js-signatures/:id", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "invalid id" });
    const result = removeJsSignature(db, id);
    return { ok: true, changes: result.changes };
  });

  fastify.get("/api/url-signatures", async () => listUrlSignatures(db));

  fastify.post("/api/url-signatures", async (req, reply) => {
    const { url, sri, note } = req.body ?? {};
    if (!url || typeof url !== "string")
      return reply.code(400).send({ error: "url required" });
    const result = addUrlSignature(db, url, sri, note);
    return { ok: true, changes: result.changes };
  });

  fastify.delete("/api/url-signatures/:id", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "invalid id" });
    const result = removeUrlSignature(db, id);
    return { ok: true, changes: result.changes };
  });

  fastify.post("/api/approve-report/:id", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "invalid id" });
    const result = approveReport(db, id);
    if (!result.ok) return reply.code(404).send({ error: result.error });
    return result;
  });

  fastify.post("/api/oracle-verdicts", async (req, reply) => {
    const { sinkKey, oracle_verdict, oracle_confidence, oracle_score, oracle_mixed, patch_verdict, is_patch_target } = req.body ?? {};
    if (!sinkKey || typeof sinkKey !== "string")
      return reply.code(400).send({ error: "sinkKey required" });
    if (!oracle_verdict || typeof oracle_verdict !== "string")
      return reply.code(400).send({ error: "oracle_verdict required" });
    const result = addOracleVerdict(db, sinkKey, oracle_verdict, oracle_confidence, oracle_score, oracle_mixed, patch_verdict, is_patch_target);
    return result;
  });

  fastify.post("/api/oracle-verdicts/mark-applied", async (req, reply) => {

    const { entries } = req.body ?? {};
    if (!Array.isArray(entries) || entries.length === 0)
      return reply.code(400).send({ error: "non-empty entries array required" });
    if (entries.length > 500 ||
        entries.some(e => !e || typeof e.sinkKey !== "string" || !e.sinkKey ||
          (e.appliedVerdict != null && typeof e.appliedVerdict !== "string")))
      return reply.code(400).send({ error: "invalid entries" });
    const dedupedByKey = [...new Map(entries.map(e => [e.sinkKey, e])).values()];
    return markOracleVerdictsApplied(db, dedupedByKey);
  });

  fastify.get("/api/oracle-verdicts/:sinkKey", async (req, reply) => {
    const result = getOracleVerdict(db, req.params.sinkKey);
    if (!result) return reply.code(404).send({ error: "not found" });
    return result;
  });

  fastify.get("/api/sink-details/:sinkKey", async (req, reply) => {
    const result = getSinkDetails(sinksDbPath, req.params.sinkKey);
    if (!result) return reply.code(404).send({ error: "not found" });
    return result;
  });

  fastify.get("/api/oracle-patch-preview/:sinkKey/:verdict", async (req, reply) => {
    const result = getOraclePatchPreview(sinksDbPath, req.params.sinkKey, req.params.verdict);
    if (!result) return reply.code(404).send({ error: "not found" });
    return result;
  });

  fastify.addHook("onClose", async () => db.close());
  return fastify;
}

async function main() {
  const program = new Command();
  program
    .name("tt-report-server")
    .option("--port <n>",   "HTTP port",      "8787")
    .option("--db <path>",  "SQLite db path", "packages/report-server/data/reports.db")
    .parse(process.argv);

  const fastify = await buildServer(program.opts());
  try {
    await fastify.listen({ port: Number(program.opts().port), host: "0.0.0.0" });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { buildServer };
