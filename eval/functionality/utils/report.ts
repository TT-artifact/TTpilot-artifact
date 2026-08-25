import { ComparisonResult } from './compare'

export interface ReportData {
  appName: string
  appId: string
  timestamp: string
  results: ComparisonResult[]
  totalTests: number
  passCount: number
  regressionCount: number
  totalTtTriggered?: number
}

export function generateHtmlReport(data: ReportData): string {
  const passPercentage = ((data.passCount / data.totalTests) * 100).toFixed(1)

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Regression Test Report - ${data.appName}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f5f5; padding: 20px; }
    .container { max-width: 1400px; margin: 0 auto; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); overflow: hidden; }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 40px; text-align: center; }
    .header h1 { font-size: 32px; margin-bottom: 10px; }
    .header p { font-size: 14px; opacity: 0.9; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; padding: 30px; border-bottom: 1px solid #e0e0e0; }
    .stat { text-align: center; }
    .stat-value { font-size: 36px; font-weight: bold; color: #667eea; }
    .stat-label { font-size: 12px; color: #666; text-transform: uppercase; margin-top: 5px; }
    .stat.pass .stat-value { color: #4caf50; }
    .stat.fail .stat-value { color: #f44336; }
    .results { padding: 30px; }
    .result-item { border: 1px solid #e0e0e0; border-radius: 6px; margin-bottom: 20px; overflow: hidden; }
    .result-header { background: #fafafa; padding: 15px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #e0e0e0; }
    .result-url { font-family: monospace; font-size: 12px; color: #333; flex: 1; }
    .badge { padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; }
    .badge.pass { background: #c8e6c9; color: #2e7d32; }
    .badge.fail { background: #ffcdd2; color: #c62828; }
    .result-body { padding: 15px; display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 15px; }
    .metric { }
    .metric-label { font-size: 12px; font-weight: 600; color: #666; text-transform: uppercase; margin-bottom: 5px; }
    .metric-value { font-size: 14px; color: #333; }
    .metric-value.good { color: #4caf50; }
    .metric-value.bad { color: #f44336; }
    .metric-list { list-style: none; }
    .metric-list li { padding: 4px 0; font-size: 13px; color: #d32f2f; }
    .screenshots { padding: 15px; border-top: 1px solid #e0e0e0; display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; }
    .screenshot-col { text-align: center; }
    .screenshot-label { font-size: 11px; font-weight: 600; color: #666; margin-bottom: 8px; text-transform: uppercase; }
    .screenshot { max-width: 100%; border: 1px solid #e0e0e0; border-radius: 4px; display: block; }
    .footer { text-align: center; padding: 20px; color: #999; font-size: 12px; border-top: 1px solid #e0e0e0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${escapeHtml(data.appName)}</h1>
      <p>Functionality Regression Test Report</p>
      <p>${new Date(data.timestamp).toLocaleString()}</p>
    </div>

    <div class="stats">
      <div class="stat">
        <div class="stat-value">${data.totalTests}</div>
        <div class="stat-label">Total Tests</div>
      </div>
      <div class="stat pass">
        <div class="stat-value">${data.passCount}</div>
        <div class="stat-label">Passed</div>
      </div>
      <div class="stat fail">
        <div class="stat-value">${data.regressionCount}</div>
        <div class="stat-label">Regressions</div>
      </div>
      <div class="stat">
        <div class="stat-value">${data.totalTtTriggered || 0}</div>
        <div class="stat-label">TT Violations Blocked</div>
      </div>
      <div class="stat">
        <div class="stat-value">${passPercentage}%</div>
        <div class="stat-label">Pass Rate</div>
      </div>
    </div>

    <div class="results">
      ${data.results
        .map(
          (result) => `
        <div class="result-item">
          <div class="result-header">
            <div class="result-url">${escapeHtml(result.url || '(no url)')}</div>
            <span class="badge ${result.hasRegression ? 'fail' : 'pass'}">
              ${result.hasRegression ? 'REGRESSION' : 'PASS'}
            </span>
          </div>
          <div class="result-body">
            <div class="metric">
              <div class="metric-label">HTTP Status</div>
              <div class="metric-value">
                Patched: <strong>${result.statusCodes.patched}</strong> | Unpatched: <strong>${result.statusCodes.unpatched}</strong>
              </div>
            </div>
            <div class="metric">
              <div class="metric-label">DOM Similarity</div>
              <div class="metric-value ${result.domSimilarity >= 0.95 ? 'good' : 'bad'}">
                ${(result.domSimilarity * 100).toFixed(1)}%
              </div>
            </div>
            <div class="metric">
              <div class="metric-label">TT Violations Blocked</div>
              <div class="metric-value good">
                ${result.ttTriggeredCount} policy violations
              </div>
            </div>
            <div class="metric">
              <div class="metric-label">Screenshot Diff</div>
              <div class="metric-value ${result.screenshotDiffRatio <= 0.05 ? 'good' : 'bad'}">
                ${(result.screenshotDiffRatio * 100).toFixed(1)}%
              </div>
            </div>
          </div>
          ${
            result.consoleRegressions.length > 0
              ? `
            <div class="result-body">
              <div class="metric">
                <div class="metric-label">New Console Errors</div>
                <ul class="metric-list">
                  ${result.consoleRegressions
                    .map((err) => `<li>${escapeHtml(err.substring(0, 100))}</li>`)
                    .join('')}
                </ul>
              </div>
            </div>
          `
              : ''
          }
          ${
            result.screenshotDiffBuffer
              ? `
            <div class="screenshots">
              <div class="screenshot-col">
                <div class="screenshot-label">Unpatched</div>
                <img class="screenshot" src="data:image/png;base64,${result.unpatchedScreenshot ? Buffer.from(result.unpatchedScreenshot).toString('base64') : 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='}" alt="unpatched">
              </div>
              <div class="screenshot-col">
                <div class="screenshot-label">Patched</div>
                <img class="screenshot" src="data:image/png;base64,${result.patchedScreenshot ? Buffer.from(result.patchedScreenshot).toString('base64') : 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='}" alt="patched">
              </div>
              <div class="screenshot-col">
                <div class="screenshot-label">Diff</div>
                <img class="screenshot" src="data:image/png;base64,${Buffer.from(result.screenshotDiffBuffer).toString('base64')}" alt="diff">
              </div>
            </div>
          `
              : ''
          }
        </div>
      `
        )
        .join('')}
    </div>

    <div class="footer">
      Generated on ${new Date(data.timestamp).toISOString()} | App ID: ${escapeHtml(data.appId)}
    </div>
  </div>
</body>
</html>`
}

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  }
  return text.replace(/[&<>"']/g, (m) => map[m])
}
