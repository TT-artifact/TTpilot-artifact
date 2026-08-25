const fs = require('fs');
const Database = require('better-sqlite3');

function computeOracleVerdict(row) {
  const obs5 = row.obs_type5 || 0;
  const obs4 = row.obs_type4 || 0;
  const obs2 = row.obs_type2 || 0;
  const obs1 = row.obs_type1 || 0;
  const obsNv = row.obs_no_violation || 0;
  const total = row.total_count || 0;
  const hasXss = row.has_xss === 1;

  let D = 0;
  if (obs5 > 0 || hasXss) D = 60;
  else if (obs4 > 0) D = 40;
  else if (obs2 > 0) D = 15;

  const E = Math.min(15, Math.floor(Math.log2(total + 1) * 3));

  const nDistinct = [obs1, obs2, obs4, obs5].filter(x => x > 0).length;
  const C = nDistinct === 1 ? 5 : 0;

  const isMixed = (obs4 > 0 || obs5 > 0) && obs1 > 0;
  const P = isMixed ? -5 : 0;

  const score = D + (hasXss ? 20 : 0) + E + C + P;

  let verdict = null;
  let confidence = null;

  if (obs5 > 0 || hasXss) {
    verdict = 'TYPE5';
    confidence = 'HIGH';
  } else if (obs4 > 0) {
    verdict = 'TYPE4';
    confidence = 'HIGH';
  } else if (obs2 > 0 && obs1 === 0) {
    verdict = 'TYPE2';
    confidence = total >= 10 ? 'HIGH' : total >= 3 ? 'MEDIUM' : 'LOW';
  } else if (obs1 > 0 && obs2 === 0) {
    verdict = 'TYPE1';
    confidence = total >= 20 ? 'HIGH' : total >= 5 ? 'MEDIUM' : 'LOW';
  } else if (obs1 > 0 && obs2 > 0) {
    verdict = 'TYPE2';
    confidence = total >= 10 ? 'HIGH' : total >= 3 ? 'MEDIUM' : 'LOW';
  }

  if (!verdict && obsNv > 0) {
    verdict = 'NO_VIOLATION';
    confidence = obsNv >= 10 ? 'HIGH' : obsNv >= 3 ? 'MEDIUM' : 'LOW';
  }

  if (!verdict) return null;
  return { oracle_verdict: verdict, oracle_confidence: confidence, oracle_score: score, oracle_mixed: isMixed };
}

function makeStore(db, sinksDbPath) {
  const insertAgentEventStmt = db.prepare(`
    INSERT INTO agent_report_events (
      received_at, crawl_run_id, agent_run_id, sink_key, value_preview, page_url
    ) VALUES (
      @received_at, @crawl_run_id, @agent_run_id, @sink_key, @value_preview, @page_url
    )
  `);
  const upsertClassifyStmt = db.prepare(`
    INSERT INTO classify_reports (
      received_at, tt_type, sink_key, sink_kind,
      value_preview, value_length, page_url, client_timestamp, stack,
      reclassified_verdict, verdict_reasons, source_values, xss_source_values,
      js_signature, url_signature, caller_location, agent_run_id, count
    ) VALUES (
      @received_at, @tt_type, @sink_key, @sink_kind,
      @value_preview, @value_length, @page_url, @client_timestamp, @stack,
      @reclassified_verdict, @verdict_reasons, @source_values, @xss_source_values,
      @js_signature, @url_signature, @caller_location, @agent_run_id, 1
    )
    ON CONFLICT(tt_type, COALESCE(sink_key,''), COALESCE(reclassified_verdict,''), COALESCE(value_preview,''))
    DO UPDATE SET count = count + 1, received_at = excluded.received_at,
      verdict_reasons = COALESCE(excluded.verdict_reasons, verdict_reasons),
      source_values = excluded.source_values,
      xss_source_values = excluded.xss_source_values,
      js_signature  = COALESCE(excluded.js_signature,  js_signature),
      url_signature = COALESCE(excluded.url_signature, url_signature),
      caller_location = COALESCE(excluded.caller_location, caller_location),
      agent_run_id = COALESCE(excluded.agent_run_id, agent_run_id)
  `);

  const upsertViolationStmt = db.prepare(`
    INSERT INTO violation_reports (
      received_at, tt_type, sink_key, sink_kind,
      value_preview, value_length, page_url, client_timestamp, stack,
      reclassified_verdict, verdict_reasons, source_values, xss_source_values,
      js_signature, url_signature, sanitized_value_preview, caller_location, agent_run_id, count
    ) VALUES (
      @received_at, @tt_type, @sink_key, @sink_kind,
      @value_preview, @value_length, @page_url, @client_timestamp, @stack,
      @reclassified_verdict, @verdict_reasons, @source_values, @xss_source_values,
      @js_signature, @url_signature, @sanitized_value_preview, @caller_location, @agent_run_id, 1
    )
    ON CONFLICT(tt_type, COALESCE(sink_key,''), COALESCE(reclassified_verdict,''), COALESCE(value_preview,''))
    DO UPDATE SET count = count + 1, received_at = excluded.received_at,
      verdict_reasons = COALESCE(excluded.verdict_reasons, verdict_reasons),
      source_values = excluded.source_values,
      xss_source_values = excluded.xss_source_values,
      js_signature  = COALESCE(excluded.js_signature,  js_signature),
      url_signature = COALESCE(excluded.url_signature, url_signature),
      sanitized_value_preview = COALESCE(excluded.sanitized_value_preview, sanitized_value_preview),
      caller_location = COALESCE(excluded.caller_location, caller_location),
      agent_run_id = COALESCE(excluded.agent_run_id, agent_run_id)
  `);

  const bySinkStmt = db.prepare(`
    SELECT
      MAX(id) AS id,
      sink_key,
      sink_kind,
      tt_type,
      COUNT(*) AS unique_patterns,
      COUNT(*) AS total_count,
      MAX(received_at) AS last_seen,
      GROUP_CONCAT(DISTINCT reclassified_verdict) AS verdicts,
      COUNT(CASE WHEN reclassified_verdict='TYPE5' THEN 1 END) AS obs_type5,
      COUNT(CASE WHEN reclassified_verdict='TYPE4' THEN 1 END) AS obs_type4,
      COUNT(CASE WHEN reclassified_verdict='TYPE2' THEN 1 END) AS obs_type2,
      COUNT(CASE WHEN reclassified_verdict='TYPE1' THEN 1 END) AS obs_type1,
      COUNT(CASE WHEN reclassified_verdict='NO_VIOLATION' THEN 1 END) AS obs_no_violation,
      MAX(CASE WHEN xss_source_values IS NOT NULL AND xss_source_values != '[]' THEN 1 ELSE 0 END) AS has_xss
    FROM classify_reports
    WHERE sink_key IS NOT NULL OR caller_location IS NOT NULL
    GROUP BY COALESCE(sink_key, caller_location)
    ORDER BY MAX(received_at) DESC
  `);

  const violationBySinkStmt = db.prepare(`
    SELECT
      MAX(id) AS id,
      sink_key,
      sink_kind,
      tt_type,
      COUNT(*) AS unique_patterns,
      SUM(count) AS total_count,
      MAX(received_at) AS last_seen,
      GROUP_CONCAT(DISTINCT reclassified_verdict) AS verdicts
    FROM violation_reports
    GROUP BY sink_key
    ORDER BY MAX(received_at) DESC
  `);

  function _parseStackFrameLocation(line) {
    let m = line.match(/\((.+):(\d+):(\d+)\)\s*$/);
    if (!m) m = line.match(/^at\s+(.+):(\d+):(\d+)\s*$/);
    if (!m) return null;
    return { url: m[1], line: m[2], col: m[3] };
  }

  function _stackLocationKey(url, line, col, sinkKind) {
    try {
      const parsed = new URL(url);
      const path = parsed.pathname.replace(/^\//, '');
      return `${path}:${line}:${col}:${sinkKind}`;
    } catch {
      return null;
    }
  }

  function extractCallerLocation(stack, sinkKindHint) {
    if (!stack) return null;
    const POLICY = 'tt-bootstrap.js';

    let sinkKind = sinkKindHint || null;
    let bootstrapFrameLine = null;

    for (const line of String(stack).split('\n')) {
      const l = line.trim();
      if (!l.includes(POLICY)) continue;
      if (!sinkKind) {
        if (l.includes('createScript')) sinkKind = 'Script';
        else if (l.includes('createHTML')) sinkKind = 'HTML';
        else if (l.includes('createScriptURL')) sinkKind = 'ScriptURL';
      }
      if (l.includes('createScript') || l.includes('createHTML') || l.includes('createScriptURL')) {
        bootstrapFrameLine = l;
        break;
      }
    }
    if (!sinkKind) return null;

    for (const line of String(stack).split('\n')) {
      const l = line.trim();
      if (!l || l === 'Error' || l.includes(POLICY)) continue;
      const loc = _parseStackFrameLocation(l);
      if (!loc) continue;
      const key = _stackLocationKey(loc.url, loc.line, loc.col, sinkKind);
      if (key) return key;
      break;
    }

    if (bootstrapFrameLine) {
      const loc = _parseStackFrameLocation(bootstrapFrameLine);
      if (loc) {
        const key = _stackLocationKey(loc.url, loc.line, loc.col, sinkKind);
        if (key) return key;
      }
    }

    return null;
  }

  function extractCallerSinkKey(stack, sinkKind) {
    if (!stack || !sinkKind) return null;
    return extractCallerLocation(stack, sinkKind);
  }

  function querySinkInfo(sinkKeys) {
    if (!sinksDbPath || sinkKeys.length === 0) return new Map();
    let sinksDb;
    try {
      if (!fs.existsSync(sinksDbPath)) return new Map();
      sinksDb = new Database(sinksDbPath, { readonly: true });
      const placeholders = sinkKeys.map(() => '?').join(',');
      const rows = sinksDb.prepare(`
        SELECT id, sink_key, kind, sink_type, verdict, file, line, col, refactor_suggestion
        FROM sinks WHERE sink_key IN (${placeholders})
      `).all(sinkKeys);
      return new Map(rows.map(r => [r.sink_key, r]));
    } catch (_) {
      return new Map();
    } finally {
      if (sinksDb) sinksDb.close();
    }
  }

  function querySinkInfoByHash(hashes) {
    if (!sinksDbPath || hashes.length === 0) return new Map();
    let sinksDb;
    try {
      if (!fs.existsSync(sinksDbPath)) return new Map();
      sinksDb = new Database(sinksDbPath, { readonly: true });
      const placeholders = hashes.map(() => '?').join(',');
      const rows = sinksDb.prepare(`
        SELECT id, sink_key, kind, sink_type, verdict, file, line, col, refactor_suggestion, hash
        FROM sinks WHERE hash IN (${placeholders})
      `).all(hashes);
      return new Map(rows.map(r => [r.hash, r]));
    } catch (_) {
      return new Map();
    } finally {
      if (sinksDb) sinksDb.close();
    }
  }

  function getStats() {
    const classifyTotal = db.prepare("SELECT COUNT(*) AS total FROM classify_reports").get().total;
    const classifyHits = db.prepare("SELECT SUM(count) AS total_hits FROM classify_reports").get().total_hits ?? 0;
    const violationTotal = db.prepare("SELECT COUNT(*) AS total FROM violation_reports").get().total;
    const violationHits = db.prepare("SELECT SUM(count) AS total_hits FROM violation_reports").get().total_hits ?? 0;

    const uniqueSinks = db.prepare(`
      SELECT COUNT(DISTINCT identifier) AS cnt
      FROM (
        SELECT COALESCE(sink_key, caller_location) AS identifier
        FROM classify_reports
        WHERE sink_key IS NOT NULL OR caller_location IS NOT NULL
        UNION ALL
        SELECT COALESCE(sink_key, caller_location) AS identifier
        FROM violation_reports
        WHERE sink_key IS NOT NULL OR caller_location IS NOT NULL
      )
    `).get().cnt;

    const classifyByVerdict = db.prepare(
      "SELECT reclassified_verdict, COUNT(*) AS count FROM classify_reports WHERE reclassified_verdict IS NOT NULL GROUP BY reclassified_verdict"
    ).all();
    const violationByVerdict = db.prepare(
      "SELECT reclassified_verdict, COUNT(*) AS count FROM violation_reports WHERE reclassified_verdict IS NOT NULL GROUP BY reclassified_verdict"
    ).all();

    return {
      classify: {
        total: classifyTotal,
        total_hits: classifyHits,
        byVerdict: classifyByVerdict,
      },
      violation: {
        total: violationTotal,
        total_hits: violationHits,
        byVerdict: violationByVerdict,
      },
      unique_sinks: uniqueSinks,
    };
  }

  function getList({ limit = 50, offset = 0 } = {}) {
    const rows = db.prepare(`
      SELECT id, received_at, tt_type, sink_key, sink_kind,
             reclassified_verdict, verdict_reasons, value_preview, value_length, page_url, stack, count,
             js_signature, url_signature, NULL AS sanitized_value_preview, 'classify' AS source
      FROM classify_reports

      UNION ALL

      SELECT id, received_at, tt_type, sink_key, sink_kind,
             reclassified_verdict, verdict_reasons, value_preview, value_length, page_url, stack, count,
             js_signature, url_signature, sanitized_value_preview, 'violation' AS source
      FROM violation_reports

      ORDER BY received_at DESC
      LIMIT @limit OFFSET @offset
    `).all({ limit, offset });

    const sinkKeys = [...new Set(rows.map(r => r.sink_key).filter(k => k != null))];
    const sinkMap = querySinkInfo(sinkKeys);

    const enriched = rows.map(r => {
      const base = {
        ...r,
        verdict_reasons: r.verdict_reasons != null ? JSON.parse(r.verdict_reasons) : null,
        js_signature:  r.js_signature  != null ? JSON.parse(r.js_signature)  : null,
        url_signature: r.url_signature != null ? JSON.parse(r.url_signature) : null,
      };
      if (!r.sink_key) return base;
      const s = sinkMap.get(r.sink_key);
      if (!s) return base;
      return {
        ...base,
        sink_id: s.id,
        sink_kind: s.kind,
        sink_kind_resolved: s.kind,
        sink_type: s.sink_type,
        sink_verdict: s.verdict,
        sink_file: s.file,
        sink_line: s.line,
        sink_col: s.col,
        refactor_suggestion: s.refactor_suggestion,
      };
    });

    const total = db.prepare(
      "SELECT (SELECT COUNT(*) FROM classify_reports) + (SELECT COUNT(*) FROM violation_reports) AS total"
    ).get().total;
    return { total, offset, limit, rows: enriched };
  }

  const upsertOracleStmt = db.prepare(`
    INSERT INTO oracle_verdicts (sink_key, oracle_verdict, oracle_confidence, oracle_score, oracle_mixed, updated_at)
    VALUES (@sink_key, @oracle_verdict, @oracle_confidence, @oracle_score, @oracle_mixed, @updated_at)
    ON CONFLICT(sink_key) DO UPDATE SET
      oracle_verdict    = excluded.oracle_verdict,
      oracle_confidence = excluded.oracle_confidence,
      oracle_score      = excluded.oracle_score,
      oracle_mixed      = excluded.oracle_mixed,
      updated_at        = excluded.updated_at
  `);

  function getBySink() {
    const rows = bySinkStmt.all();
    const sinkKeys = rows.map(r => r.sink_key);
    const sinkMap = querySinkInfo(sinkKeys);
    const now = Date.now();

    const upsertAll = db.transaction(items => {
      for (const item of items) upsertOracleStmt.run(item);
    });

    const oracleRows = [];
    const enriched = rows.map(r => {
      const s = sinkMap.get(r.sink_key);
      const oracle = computeOracleVerdict(r);
      if (oracle) {
        oracleRows.push({
          sink_key: r.sink_key,
          oracle_verdict: oracle.oracle_verdict,
          oracle_confidence: oracle.oracle_confidence,
          oracle_score: oracle.oracle_score,
          oracle_mixed: oracle.oracle_mixed ? 1 : 0,
          updated_at: now,
        });
      }
      return {
        ...r,
        sink_id: s?.id ?? null,
        sink_kind: s?.kind ?? r.sink_kind,
        static_verdict: s?.verdict ?? null,
        sink_file: s?.file,
        sink_line: s?.line,
        sink_col: s?.col,
        refactor_suggestion: s?.refactor_suggestion,
        ...oracle,
      };
    });

    if (oracleRows.length > 0) upsertAll(oracleRows);
    return enriched;
  }

  function getReportsBySinkKey(sinkKey) {
    const rows = listBySinkKeyStmt.all({ sinkKey });
    const sinkMap = querySinkInfo([sinkKey]);

    return rows.map(r => {
      const base = {
        ...r,
        verdict_reasons: r.verdict_reasons != null ? JSON.parse(r.verdict_reasons) : null,
        source_values: r.source_values != null ? JSON.parse(r.source_values) : null,
        xss_source_values: r.xss_source_values != null ? JSON.parse(r.xss_source_values) : null,
        js_signature:  r.js_signature  != null ? JSON.parse(r.js_signature)  : null,
        url_signature: r.url_signature != null ? JSON.parse(r.url_signature) : null,
      };
      const s = sinkMap.get(r.sink_key);
      if (!s) return base;
      return {
        ...base,
        sink_id: s.id,
        sink_kind: s.kind,
        sink_kind_resolved: s.kind,
        sink_type: s.sink_type,
        sink_verdict: s.verdict,
        static_verdict: s.verdict,
        sink_file: s.file,
        sink_line: s.line,
        sink_col: s.col,
        refactor_suggestion: s.refactor_suggestion,
      };
    });
  }

  function insertClassifyReport(payload) {
    let sinkHash = null;
    let sinkKindFromCode = null;
    const sinkCode = payload.sinkCode != null ? String(payload.sinkCode) : null;

    if (sinkCode && sinkCode.startsWith('S-')) {
      const colonIdx = sinkCode.indexOf(':');
      if (colonIdx > 0) {
        sinkHash = sinkCode.slice(2, colonIdx);
        sinkKindFromCode = sinkCode.slice(colonIdx + 1);
      }
    }

    let sinkKey = payload.sinkKey != null ? String(payload.sinkKey) : null;

    if (sinkHash && sinksDbPath) {
      const sinkMap = querySinkInfoByHash([sinkHash]);
      const sinkInfo = sinkMap.get(sinkHash);
      if (sinkInfo) sinkKey = sinkInfo.sink_key;
    } else if (sinkKey && sinksDbPath) {
      const sinkMap = querySinkInfo([sinkKey]);
      const sinkInfo = sinkMap.get(sinkKey);
    }

    const sinkKindFallback = payload.sinkKind || sinkKindFromCode || payload.ttType;
    if (!sinkKey && payload.stack && sinkKindFallback) {
      sinkKey = extractCallerSinkKey(payload.stack, sinkKindFallback);
    }

    const callerLocation = payload.stack ? extractCallerLocation(payload.stack, sinkKindFallback) : null;

    const row = {
      received_at: Date.now(),
      tt_type: String(payload.ttType || ""),
      sink_key: sinkKey,
      sink_kind: sinkKindFromCode || (payload.sinkKind != null ? String(payload.sinkKind) : null),
      value_preview: payload.valuePreview != null ? String(payload.valuePreview) : null,
      value_length: typeof payload.valueLength === "number" ? payload.valueLength : null,
      page_url: payload.url != null ? String(payload.url) : null,
      client_timestamp: typeof payload.timestamp === "number" ? payload.timestamp : null,
      stack: payload.stack != null ? String(payload.stack) : null,
      reclassified_verdict: payload.reclassifiedVerdict != null ? String(payload.reclassifiedVerdict) : null,
      verdict_reasons: Array.isArray(payload.verdictReasons) && payload.verdictReasons.length > 0
        ? JSON.stringify(payload.verdictReasons) : null,
      source_values: Array.isArray(payload.sourceValues) && payload.sourceValues.length > 0
        ? JSON.stringify(payload.sourceValues) : null,
      xss_source_values: Array.isArray(payload.xssSourceValues) && payload.xssSourceValues.length > 0
        ? JSON.stringify(payload.xssSourceValues) : null,
      js_signature: payload.jsSignature != null ? JSON.stringify(payload.jsSignature) : null,
      url_signature: payload.urlSignature != null ? JSON.stringify(payload.urlSignature) : null,
      caller_location: callerLocation,
      agent_run_id: payload.agentRunId != null ? String(payload.agentRunId) : null,
    };
    let info;
    db.transaction(() => {
      info = upsertClassifyStmt.run(row);
      if (row.agent_run_id && row.agent_run_id.startsWith("agent-")) {
        insertAgentEventStmt.run({
          received_at: row.received_at,
          crawl_run_id: payload.agentCrawlRunId != null ? String(payload.agentCrawlRunId) : null,
          agent_run_id: row.agent_run_id,
          sink_key: row.sink_key,
          value_preview: row.value_preview,
          page_url: row.page_url,
        });
      }
    })();
    return info.lastInsertRowid;
  }

  function insertViolationReport(payload) {
    let sinkHash = null;
    let sinkKindFromCode = null;
    const sinkCode = payload.sinkCode != null ? String(payload.sinkCode) : null;

    if (sinkCode && sinkCode.startsWith('S-')) {
      const colonIdx = sinkCode.indexOf(':');
      if (colonIdx > 0) {
        sinkHash = sinkCode.slice(2, colonIdx);
        sinkKindFromCode = sinkCode.slice(colonIdx + 1);
      }
    }

    let sinkKey = payload.sinkKey != null ? String(payload.sinkKey) : null;

    if (sinkHash && sinksDbPath) {
      const sinkMap = querySinkInfoByHash([sinkHash]);
      const sinkInfo = sinkMap.get(sinkHash);
      if (sinkInfo) sinkKey = sinkInfo.sink_key;
    } else if (sinkKey && sinksDbPath) {
      const sinkMap = querySinkInfo([sinkKey]);
      const sinkInfo = sinkMap.get(sinkKey);
    }

    const sinkKindFallback = payload.sinkKind || sinkKindFromCode || payload.ttType;
    if (!sinkKey && payload.stack && sinkKindFallback) {
      sinkKey = extractCallerSinkKey(payload.stack, sinkKindFallback);
    }

    const callerLocation = payload.stack ? extractCallerLocation(payload.stack, sinkKindFallback) : null;

    const row = {
      received_at: Date.now(),
      tt_type: String(payload.ttType || ""),
      sink_key: sinkKey,
      sink_kind: sinkKindFromCode || (payload.sinkKind != null ? String(payload.sinkKind) : null),
      value_preview: payload.valuePreview != null ? String(payload.valuePreview) : null,
      value_length: typeof payload.valueLength === "number" ? payload.valueLength : null,
      page_url: payload.url != null ? String(payload.url) : null,
      client_timestamp: typeof payload.timestamp === "number" ? payload.timestamp : null,
      stack: payload.stack != null ? String(payload.stack) : null,
      reclassified_verdict: payload.reclassifiedVerdict != null ? String(payload.reclassifiedVerdict) : null,
      verdict_reasons: Array.isArray(payload.verdictReasons) && payload.verdictReasons.length > 0
        ? JSON.stringify(payload.verdictReasons) : null,
      source_values: Array.isArray(payload.sourceValues) && payload.sourceValues.length > 0
        ? JSON.stringify(payload.sourceValues) : null,
      xss_source_values: Array.isArray(payload.xssSourceValues) && payload.xssSourceValues.length > 0
        ? JSON.stringify(payload.xssSourceValues) : null,
      js_signature: payload.jsSignature != null ? JSON.stringify(payload.jsSignature) : null,
      url_signature: payload.urlSignature != null ? JSON.stringify(payload.urlSignature) : null,
      sanitized_value_preview: payload.sanitizedValuePreview != null ? String(payload.sanitizedValuePreview) : null,
      caller_location: callerLocation,
      agent_run_id: payload.agentRunId != null ? String(payload.agentRunId) : null,
    };
    const info = upsertViolationStmt.run(row);
    return info.lastInsertRowid;
  }

  function getReportsBySinkKey(sinkKey) {
    const rows = db.prepare(`
      SELECT id, received_at, tt_type, sink_key, sink_kind,
             reclassified_verdict, verdict_reasons, value_preview, value_length, page_url, stack, count,
             source_values, xss_source_values, js_signature, url_signature
      FROM classify_reports
      WHERE sink_key = @sinkKey
      ORDER BY id DESC
    `).all({ sinkKey });

    const sinkMap = querySinkInfo([sinkKey]);

    return rows.map(r => {
      const base = {
        ...r,
        verdict_reasons: r.verdict_reasons != null ? JSON.parse(r.verdict_reasons) : null,
        source_values: r.source_values != null ? JSON.parse(r.source_values) : null,
        xss_source_values: r.xss_source_values != null ? JSON.parse(r.xss_source_values) : null,
        js_signature:  r.js_signature  != null ? JSON.parse(r.js_signature)  : null,
        url_signature: r.url_signature != null ? JSON.parse(r.url_signature) : null,
      };
      const s = sinkMap.get(r.sink_key);
      if (!s) return base;
      return {
        ...base,
        sink_id: s.id,
        sink_kind: s.kind,
        sink_kind_resolved: s.kind,
        sink_type: s.sink_type,
        sink_verdict: s.verdict,
        sink_file: s.file,
        sink_line: s.line,
        sink_col: s.col,
        refactor_suggestion: s.refactor_suggestion,
      };
    });
  }

  function getViolationBySink() {
    const rows = violationBySinkStmt.all();
    const sinkKeys = rows.map(r => r.sink_key);
    const sinkMap = querySinkInfo(sinkKeys);

    return rows.map(r => {
      const s = sinkMap.get(r.sink_key);
      return {
        ...r,
        sink_id: s?.id ?? null,
        sink_kind: s?.kind ?? r.sink_kind,
        static_verdict: s?.verdict ?? null,
        verdicts: r.verdicts ? r.verdicts.split(',') : [],
      };
    });
  }

  function getViolationByUnknownSink() {
    const rows = db.prepare(`
      SELECT
        caller_location,
        tt_type,
        COUNT(*) AS unique_patterns,
        SUM(count) AS total_count,
        MAX(received_at) AS last_seen,
        GROUP_CONCAT(DISTINCT reclassified_verdict) AS verdicts,
        MAX(CASE WHEN xss_source_values IS NOT NULL AND xss_source_values != '[]' THEN 1 ELSE 0 END) AS has_xss
      FROM violation_reports
      WHERE sink_key IS NULL
      GROUP BY caller_location
      ORDER BY total_count DESC
    `).all();

    return rows.map(r => ({
      caller_location: r.caller_location || '(unknown)',
      tt_type: r.tt_type,
      unique_patterns: r.unique_patterns,
      total_count: r.total_count,
      last_seen: r.last_seen,
      verdicts: r.verdicts ? r.verdicts.split(',') : [],
      has_xss: r.has_xss === 1,
      sink_key: null,
      sink_kind: null,
      static_verdict: null,
    }));
  }

  function getViolationByCallerLocation(callerLocation) {
    const rows = db.prepare(`
      SELECT id, received_at, tt_type, sink_key, sink_kind,
             reclassified_verdict, verdict_reasons, value_preview, value_length, page_url, stack, count,
             source_values, xss_source_values, js_signature, url_signature, sanitized_value_preview, caller_location
      FROM violation_reports
      WHERE sink_key IS NULL AND caller_location = @callerLocation
      ORDER BY id DESC
    `).all({ callerLocation });

    return rows.map(r => ({
      ...r,
      verdict_reasons: r.verdict_reasons != null ? JSON.parse(r.verdict_reasons) : null,
      source_values: r.source_values != null ? JSON.parse(r.source_values) : null,
      xss_source_values: r.xss_source_values != null ? JSON.parse(r.xss_source_values) : null,
      js_signature: r.js_signature != null ? JSON.parse(r.js_signature) : null,
      url_signature: r.url_signature != null ? JSON.parse(r.url_signature) : null,
      sink_key: null,
      sink_kind: null,
      static_verdict: null,
    }));
  }

  function backfillCallerLocations() {
    const rows = db.prepare(`
      SELECT id, stack, tt_type
      FROM violation_reports
      WHERE caller_location IS NULL AND stack IS NOT NULL
    `).all();

    const updateStmt = db.prepare(`
      UPDATE violation_reports SET caller_location = ? WHERE id = ?
    `);

    let updated = 0;
    for (const row of rows) {
      const loc = extractCallerLocation(row.stack, row.tt_type);
      if (loc) {
        updateStmt.run(loc, row.id);
        updated++;
      }
    }
    return { total: rows.length, updated };
  }

  function backfillClassifyCallerLocations() {
    const rows = db.prepare(`
      SELECT id, stack, tt_type
      FROM classify_reports
      WHERE sink_key IS NULL AND stack IS NOT NULL
    `).all();

    const updateStmt = db.prepare(`
      UPDATE classify_reports SET sink_key = ?, caller_location = ? WHERE id = ?
    `);

    let updated = 0;
    let skipped = 0;
    for (const row of rows) {
      const loc = extractCallerLocation(row.stack, row.tt_type);
      if (!loc) continue;
      try {
        updateStmt.run(loc, loc, row.id);
        updated++;
      } catch {

        skipped++;
      }
    }
    return { total: rows.length, updated, skipped };
  }

  function getClassifyByUnknownSink() {
    const rows = db.prepare(`
      SELECT
        caller_location,
        tt_type,
        COUNT(*) AS unique_patterns,
        SUM(count) AS total_count,
        MAX(received_at) AS last_seen,
        GROUP_CONCAT(DISTINCT reclassified_verdict) AS verdicts,
        MAX(CASE WHEN xss_source_values IS NOT NULL AND xss_source_values != '[]' THEN 1 ELSE 0 END) AS has_xss
      FROM classify_reports
      WHERE sink_key IS NULL
      GROUP BY caller_location
      ORDER BY total_count DESC
    `).all();

    return rows.map(r => ({
      caller_location: r.caller_location || '(unknown)',
      tt_type: r.tt_type,
      unique_patterns: r.unique_patterns,
      total_count: r.total_count,
      last_seen: r.last_seen,
      verdicts: r.verdicts ? r.verdicts.split(',') : [],
      has_xss: r.has_xss === 1,
      sink_key: null,
      sink_kind: null,
      static_verdict: null,
    }));
  }

  function getClassifyByCallerLocation(callerLocation) {
    const rows = db.prepare(`
      SELECT id, received_at, tt_type, sink_key, sink_kind,
             reclassified_verdict, verdict_reasons, value_preview, value_length, page_url, stack, count,
             source_values, xss_source_values, js_signature, url_signature, caller_location
      FROM classify_reports
      WHERE sink_key IS NULL AND caller_location = @callerLocation
      ORDER BY id DESC
    `).all({ callerLocation });

    return rows.map(r => ({
      ...r,
      verdict_reasons: r.verdict_reasons != null ? JSON.parse(r.verdict_reasons) : null,
      source_values: r.source_values != null ? JSON.parse(r.source_values) : null,
      xss_source_values: r.xss_source_values != null ? JSON.parse(r.xss_source_values) : null,
      js_signature: r.js_signature != null ? JSON.parse(r.js_signature) : null,
      url_signature: r.url_signature != null ? JSON.parse(r.url_signature) : null,
      sink_key: null,
      sink_kind: null,
      static_verdict: null,
    }));
  }

  return { insertClassifyReport, insertViolationReport, getStats, getList, getBySink, getViolationBySink, getViolationByUnknownSink, getViolationByCallerLocation, getClassifyByUnknownSink, getClassifyByCallerLocation, getReportsBySinkKey, backfillCallerLocations, backfillClassifyCallerLocations };
}

function listJsSignatures(db) {
  return db.prepare(
    'SELECT id, signature, sink_key, sink_id, note, added_at FROM js_signatures ORDER BY added_at DESC'
  ).all();
}

function addJsSignature(db, signature, note, sinkKey = null, sinkId = null) {
  return db.prepare(
    'INSERT OR IGNORE INTO js_signatures (signature, sink_key, sink_id, note, added_at) VALUES (?, ?, ?, ?, ?)'
  ).run(signature, sinkKey, sinkId, note ?? null, Date.now());
}

function removeJsSignature(db, id) {
  return db.prepare('DELETE FROM js_signatures WHERE id = ?').run(id);
}

function listUrlSignatures(db) {
  return db.prepare(
    'SELECT id, url, sri, note, added_at FROM url_signatures ORDER BY added_at DESC'
  ).all();
}

function addUrlSignature(db, url, sri, note) {
  return db.prepare(
    'INSERT OR IGNORE INTO url_signatures (url, sri, note, added_at) VALUES (?, ?, ?, ?)'
  ).run(url, sri ?? null, note ?? null, Date.now());
}

function removeUrlSignature(db, id) {
  return db.prepare('DELETE FROM url_signatures WHERE id = ?').run(id);
}

function seedUrlSignatures(db, urlConfigPath) {
  if (!fs.existsSync(urlConfigPath)) return;
  try {
    const cfg = JSON.parse(fs.readFileSync(urlConfigPath, 'utf8'));
    const stmt = db.prepare(
      'INSERT OR IGNORE INTO url_signatures (url, sri, note, added_at) VALUES (?, ?, ?, ?)'
    );
    for (const entry of (cfg.allowedUrls ?? [])) {
      stmt.run(entry.url, entry.sri ?? null, 'seeded from url_config.json', Date.now());
    }
  } catch {  }
}

function approveReport(db, reportId) {
  const row = db.prepare(
    'SELECT js_signature, url_signature FROM classify_reports WHERE id = ?'
  ).get(reportId);
  if (!row) return { ok: false, error: 'not found' };

  const jsStmt  = db.prepare('INSERT OR IGNORE INTO js_signatures  (signature, note, added_at) VALUES (?, ?, ?)');
  const urlStmt = db.prepare('INSERT OR IGNORE INTO url_signatures (url, sri, note, added_at) VALUES (?, ?, ?, ?)');

  let inserted = 0;
  const note = `approved from report:${reportId}`;

  for (const sig of [].concat(row.js_signature  ? JSON.parse(row.js_signature)  : [])) {
    inserted += jsStmt.run(sig, note, Date.now()).changes;
  }
  for (const url of [].concat(row.url_signature ? JSON.parse(row.url_signature) : [])) {
    inserted += urlStmt.run(url, null, note, Date.now()).changes;
  }
  return { ok: true, inserted };
}

function getSinkDetails(sinksDbPath, sinkKey) {
  if (!sinksDbPath || !sinkKey) {
    console.warn(`getSinkDetails: missing params - dbPath: ${!!sinksDbPath}, key: ${!!sinkKey}`);
    return null;
  }
  let sinksDb;
  try {
    if (!fs.existsSync(sinksDbPath)) {
      console.warn(`getSinkDetails: sinks.db not found at ${sinksDbPath}`);
      return null;
    }
    sinksDb = new Database(sinksDbPath, { readonly: true });
    const row = sinksDb.prepare(`
      SELECT original_snippet, display_suggestion, patch_strategy, patch_wrapper,
             verdict, kind, file, line, patch_count
      FROM sinks WHERE sink_key = ?
    `).get(sinkKey);
    return row || null;
  } catch (err) {
    console.error(`getSinkDetails error for ${sinkKey}:`, err.message);
    return null;
  } finally {
    if (sinksDb) sinksDb.close();
  }
}

const ORACLE_POLICY = {
  TYPE5: 'sanitizePolicy',
  TYPE4: 'monitorPolicy',
  TYPE2: 'passThruPolicy',
};

function getOraclePatchPreview(sinksDbPath, sinkKey, oracleVerdict) {
  if (!sinksDbPath || !sinkKey || !oracleVerdict) {
    console.warn(`getOraclePatchPreview: missing params - dbPath: ${!!sinksDbPath}, key: ${!!sinkKey}, verdict: ${!!oracleVerdict}`);
    return null;
  }
  let sinksDb;
  try {
    if (!fs.existsSync(sinksDbPath)) {
      console.warn(`getOraclePatchPreview: sinks.db not found at ${sinksDbPath}`);
      return null;
    }
    sinksDb = new Database(sinksDbPath, { readonly: true });
    const row = sinksDb.prepare(`
      SELECT original_snippet, display_suggestion, patch_strategy, verdict
      FROM sinks WHERE sink_key = ?
    `).get(sinkKey);
    if (!row) {
      console.warn(`getOraclePatchPreview: sink not found for key ${sinkKey}`);
      return null;
    }

    const { original_snippet, display_suggestion } = row;

    if (oracleVerdict === 'NO_VIOLATION' || oracleVerdict === 'TYPE1') {
      return { display_suggestion: original_snippet };
    }

    const oraclePolicy = ORACLE_POLICY[oracleVerdict];
    if (!oraclePolicy || !display_suggestion) {
      return { display_suggestion: original_snippet };
    }

    const patched = display_suggestion.replace(/\b\w+Policy\b/g, oraclePolicy);
    return { display_suggestion: patched };
  } catch (err) {
    console.error(`getOraclePatchPreview error for ${sinkKey}:`, err.message);
    return null;
  } finally {
    if (sinksDb) sinksDb.close();
  }
}

function addOracleVerdict(db, sinkKey, oracleVerdict, oracleConfidence, oracleScore, oracleMixed, patchVerdict, isPatchTarget) {
  const stmt = db.prepare(`
    INSERT INTO oracle_verdicts (sink_key, oracle_verdict, oracle_confidence, oracle_score, oracle_mixed, patch_verdict, is_patch_target, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sink_key) DO UPDATE SET
      oracle_verdict = excluded.oracle_verdict,
      oracle_confidence = excluded.oracle_confidence,
      oracle_score = excluded.oracle_score,
      oracle_mixed = excluded.oracle_mixed,
      patch_verdict = excluded.patch_verdict,
      is_patch_target = excluded.is_patch_target,
      updated_at = excluded.updated_at
  `);
  const result = stmt.run(sinkKey, oracleVerdict, oracleConfidence, oracleScore, oracleMixed ? 1 : 0, patchVerdict, isPatchTarget ? 1 : 0, Date.now());
  return { ok: true, changes: result.changes };
}

function getOracleVerdict(db, sinkKey) {
  const stmt = db.prepare('SELECT * FROM oracle_verdicts WHERE sink_key = ?');
  return stmt.get(sinkKey);
}

function markOracleVerdictsApplied(db, entries) {
  const update = db.prepare(`
    UPDATE oracle_verdicts
    SET is_patch_target = 2, applied_verdict = ?, applied_at = ?, updated_at = ?
    WHERE sink_key = ?
  `);
  const applyAll = db.transaction((items) => {
    let changes = 0;
    const now = Date.now();
    for (const { sinkKey, appliedVerdict } of items) {
      changes += update.run(appliedVerdict ?? null, now, now, sinkKey).changes;
    }
    return changes;
  });
  return { ok: true, changes: applyAll(entries) };
}

module.exports = {
  makeStore,
  computeOracleVerdict,
  listJsSignatures,
  addJsSignature,
  removeJsSignature,
  listUrlSignatures,
  addUrlSignature,
  removeUrlSignature,
  seedUrlSignatures,
  approveReport,
  addOracleVerdict,
  markOracleVerdictsApplied,
  getOracleVerdict,
  getSinkDetails,
  getOraclePatchPreview,
};
