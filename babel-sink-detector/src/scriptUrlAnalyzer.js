const fs = require('fs');
const path = require('path');
const { VERDICTS } = require('./constants');

const EXECUTABLE_DATA_MIMES = new Set([
  'text/html',
  'application/javascript',
  'application/x-javascript',
  'text/javascript',
  'application/xhtml+xml',
  'image/svg+xml',
]);

const CONFIG_PATH = path.join(__dirname, '..', 'url_config.json');

function loadConfig() {
  try {
    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[scriptUrlAnalyzer] Failed to load config: ${err.message}`);
    }
    return { trustedOrigins: [], whitelist: [] };
  }
}

const CONFIG = loadConfig();

function analyzeDataUri(value) {
  const mimeMatch = value.match(/^data:([^;,]+)/);
  const mime = mimeMatch ? mimeMatch[1].toLowerCase().trim() : '';

  if (!mime) {
    return {
      verdict: VERDICTS.TYPE4,
      verdictReasons: ['data-uri:no-mime'],
    };
  }

  if (EXECUTABLE_DATA_MIMES.has(mime)) {
    return {
      verdict: VERDICTS.TYPE4,
      verdictReasons: [`data-uri:executable:${mime}`],
    };
  }

  return {
    verdict: VERDICTS.TYPE2,
    verdictReasons: [`data-uri:safe:${mime || 'unknown'}`],
  };
}

function analyzeHttpsUrl(value, config) {
  let urlObj;
  try {
    urlObj = new URL(value);
  } catch {
    return { verdict: VERDICTS.TYPE4, verdictReasons: ['invalid-url'] };
  }

  const origin = urlObj.origin;

  if (config.trustedOrigins.includes(origin)) {
    return { verdict: VERDICTS.TYPE2, verdictReasons: ['trusted-origin'] };
  }

  const allowedUrls = config.allowedUrls || [];
  for (const entry of allowedUrls) {
    if (value === entry.url) {
      return { verdict: VERDICTS.TYPE2, verdictReasons: ['whitelist'] };
    }
  }

  return { verdict: VERDICTS.TYPE4, verdictReasons: ['https:external'] };
}

function analyzeScriptUrl(value) {
  if (!value || typeof value !== 'string' || value === '') {
    return { verdict: VERDICTS.TYPE2, verdictReasons: ['empty-url'] };
  }

  const trimmedValue = value.trim();
  const lowerValue = value.toLowerCase().trim();
  if (lowerValue.startsWith('javascript:')) {
    return { verdict: VERDICTS.TYPE4, verdictReasons: ['protocol:javascript'] };
  }

  if (lowerValue.startsWith('data:')) {
    return analyzeDataUri(trimmedValue);
  }

  if (lowerValue.startsWith('http://')) {
    return { verdict: VERDICTS.TYPE4, verdictReasons: ['protocol:http'] };
  }

  const isRelativeProtocol = lowerValue.startsWith('//');

  if (lowerValue.startsWith('https://') || isRelativeProtocol) {
    const urlToAnalyze = isRelativeProtocol ? `https:${trimmedValue}` : trimmedValue;
    const result = analyzeHttpsUrl(urlToAnalyze, CONFIG);

    if (isRelativeProtocol) {
      return {
        verdict: result.verdict,
        verdictReasons: [...result.verdictReasons, 'protocol:relative-upgrade'],
      };
    }
    return result;
  }

  return { verdict: VERDICTS.TYPE2, verdictReasons: ['relative-path'] };
}

module.exports = { analyzeScriptUrl };
