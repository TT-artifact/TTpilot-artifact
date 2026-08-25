'use strict';

const Database = require('better-sqlite3');
const { getRefactorSuggestion } = require('./refactorTemplates');
const { VERDICT_TO_POLICY } = require('./constants');

const SINKS = require('./sinks').SINKS;
const kindMeta = new Map(SINKS.map(s => [s.kind, s]));

function placeholderCtx(kind, verdict, sinkKey, observationMode) {
  const meta = kindMeta.get(kind);
  const policyName = VERDICT_TO_POLICY[verdict] || 'classifyPolicy';

  const sinkCode = sinkKey ?? null;

  if (!meta) return { argCode: 'value', receiverCode: 'target', policyName, sinkCode, extraArgs: [], observationMode };

  const argCode = 'value';
  let receiverCode = 'target';
  let extraArgs = [];

  if (meta.receiver) receiverCode = meta.receiver;
  if (meta.elementType) receiverCode = `${meta.elementType}El`;

  if (kind === 'element.insertAdjacentHTML') extraArgs = ["'beforeend'"];
  if (kind === 'document.execCommand.insertHTML') extraArgs = ['false'];
  if (kind.endsWith('.setAttributeNS.srcdoc') || kind.endsWith('.setAttributeNS.src') || kind.endsWith('.setAttributeNS.href') || kind.endsWith('.setAttributeNS.onEvent')) extraArgs = ['null'];
  if (kind === 'element.setAttribute.onEvent') extraArgs = ["'onclick'"];
  if (kind === 'element.setAttributeNS.onEvent') extraArgs = ['null', "'onclick'"];

  return { argCode, receiverCode, policyName, sinkCode, extraArgs, observationMode };
}

function backfill(dbPath) {
  const db = new Database(dbPath);

  const rows = db.prepare(
    "SELECT id, sink_key, kind, verdict, refactor_suggestion, observation_mode FROM sinks WHERE verdict IS NOT NULL"
  ).all();

  console.log(`Processing ${rows.length} rows...`);

  const update = db.prepare("UPDATE sinks SET refactor_suggestion = ? WHERE id = ?");

  const run = db.transaction(() => {
    let updated = 0;
    for (const row of rows) {
      let suggestion = row.refactor_suggestion;

      if (!suggestion) {
        const ctx = placeholderCtx(row.kind, row.verdict, row.sink_key, row.observation_mode);
        suggestion = getRefactorSuggestion(row.kind, row.verdict, ctx);
      } else if (row.sink_key) {

        const sinkCodeStr = row.sink_key;

        if (suggestion.includes('sinkId')) {

          suggestion = suggestion.replace(
            /,\s*\{\s*sinkId:\s*"[^"]*"\s*\}/,
            `, ${JSON.stringify(sinkCodeStr)}`
          );
        } else if (suggestion.includes('{ sinkKey:')) {

          suggestion = suggestion.replace(
            /,\s*\{\s*sinkKey:\s*"[^"]*"\s*\}/,
            `, ${JSON.stringify(sinkCodeStr)}`
          );
        } else if (!suggestion.includes(sinkCodeStr) && !suggestion.includes('"S-') && row.verdict !== 'TYPE1') {

          suggestion = suggestion.replace(
            /(\))(\s*)$/,
            `, ${JSON.stringify(sinkCodeStr)})`
          );
        }
      }

      if (suggestion && suggestion !== row.refactor_suggestion) {
        update.run(suggestion, row.id);
        updated++;
      }
    }
    return updated;
  });

  const updated = run();
  db.close();
  console.log(`Done. Updated ${updated} rows.`);
}

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('Usage: node backfillRefactor.js <db-path>');
  process.exit(1);
}
backfill(dbPath);
