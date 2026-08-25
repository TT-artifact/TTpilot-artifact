const fs = require('fs');

function formatText(findings) {
  const grouped = new Map();

  for (const finding of findings) {
    if (!grouped.has(finding.file)) {
      grouped.set(finding.file, []);
    }
    grouped.get(finding.file).push(finding);
  }

  const files = Array.from(grouped.keys()).sort();
  const lines = [];

  for (const file of files) {
    const fileFindings = [...grouped.get(file)].sort((a, b) => {
      if (a.line !== b.line) return a.line - b.line;
      return a.col - b.col;
    });

    for (const f of fileFindings) {
      const mainLine = `${f.file}:${f.line}:${f.col}  [${f.kind}]  ` +
        `sinkType=${f.sinkType}  status=${f.status}  verdict=${f.verdict || 'null'}`;
      lines.push(mainLine);

      if (f.verdictReasons && f.verdictReasons.length > 0) {
        lines.push(`  reasons: ${f.verdictReasons.join(', ')}`);
      }

      if (f.snippet) {
        lines.push(`  snippet: ${f.snippet}`);
      }
    }
  }

  return lines.join('\n');
}

function formatJson(findings) {
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      totalFindings: findings.length,
      findings,
    },
    null,
    2
  );
}

function report(findings, format = 'text', options = {}) {
  if (!['json', 'text'].includes(format)) {
    throw new Error(`Invalid format: ${format}. Must be 'json' or 'text'.`);
  }

  const output = format === 'json' ? formatJson(findings) : formatText(findings);

  if (options.outputFile) {
    try {
      fs.writeFileSync(options.outputFile, output, 'utf-8');
      if (!options.quiet) {
        console.error(`Results written to ${options.outputFile}`);
      }
    } catch (err) {
      throw new Error(`Failed to write output file: ${err.message}`);
    }
  } else {
    console.log(output);
  }
}

module.exports = { report, formatText, formatJson };
