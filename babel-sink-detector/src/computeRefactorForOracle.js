const { getRefactorSuggestion } = require('./refactorTemplates');
const fs = require('fs');

const data = JSON.parse(fs.readFileSync('/dev/stdin', 'utf-8'));
const results = data.map(({ sink_key, kind, verdict, argCode, receiverCode, policyName, sinkCode, observationMode }) => {
  const ctx = {
    argCode,
    receiverCode,
    policyName: policyName || 'classifyPolicy',
    sinkCode: sinkCode || null,
    extraArgs: [],

    observationMode,
  };
  const suggestion = getRefactorSuggestion(kind, verdict, ctx);
  return { sink_key, refactor_suggestion: suggestion };
});
process.stdout.write(JSON.stringify(results));
