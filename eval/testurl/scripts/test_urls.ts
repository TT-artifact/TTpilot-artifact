import { chromium, type Browser, type BrowserContext } from '@playwright/test'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import * as fs from 'fs'
import * as yaml from 'js-yaml'

const TARGET = process.env.TESTURL_TARGET || 'unknown'
const PATCHED_URL = (process.env.TESTURL_PATCHED_URL || 'http://localhost:8080/').replace(/\/$/, '')
const URLS_FILE = process.env.TESTURL_URLS_FILE || ''
const OUTPUT_DIR = process.env.TESTURL_OUTPUT_DIR || '.'

interface AuthConfig {
  enabled: boolean
  type: string
  credentials: { login_url?: string; email?: string; password?: string }
}

function loadAuthConfig(): AuthConfig {
  const enabled = process.env.TT_AUTH_ENABLED === 'true'
  const type = process.env.TT_AUTH_TYPE || 'form'
  const credentials = {
    login_url: process.env.TT_AUTH_LOGIN_URL || '',
    email: process.env.TT_AUTH_EMAIL || '',
    password: process.env.TT_AUTH_PASSWORD || '',
  }
  return { enabled, type, credentials }
}

function remapHost(url: string, baseUrl: string): string {
  const urlObj = new URL(url)
  const baseUrlObj = new URL(baseUrl)
  urlObj.host = baseUrlObj.host
  return urlObj.toString()
}

async function performFormAuth(browser: Browser, cfg: AuthConfig, baseUrl: string): Promise<string | null> {
  if (!cfg.enabled || cfg.type !== 'form') return null
  const { login_url, email, password } = cfg.credentials
  if (!login_url || !email || !password) {
    console.log('[auth] Missing credentials (login_url, email, password)')
    return null
  }

  const resolvedLoginUrl = remapHost(login_url, baseUrl)
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    console.log(`[auth] Attempting form authentication against ${resolvedLoginUrl}...`)
    await page.goto(resolvedLoginUrl, { waitUntil: 'networkidle', timeout: 15000 })
    let usernameSelector: string | null = null
    for (const selector of ['input[name="log"]', 'input[id="user_login"]', 'input[name="username"]', 'input[type="email"]', 'input[name="email"]']) {
      if (await page.locator(selector).count() > 0) {
        usernameSelector = selector
        break
      }
    }
    if (!usernameSelector) {
      console.log('[auth] Could not find username field')
      await context.close()
      return null
    }
    await page.fill(usernameSelector, email)
    let pwdSelector: string | null = null
    for (const selector of ['input[name="password"][id="umb-passwordTwo"]', 'input[name="password"]', 'input[type="password"]:first-of-type']) {
      if (await page.locator(selector).count() > 0) {
        pwdSelector = selector
        break
      }
    }
    if (!pwdSelector) {
      console.log('[auth] Could not find password field')
      await context.close()
      return null
    }
    await page.fill(pwdSelector, password)
    let submitBtn = null
    for (const selector of ['button[ng-if="vm.type === \'submit\'"]', 'button:has-text("Login")', 'button[type="submit"]:first-of-type', 'button[type="submit"]']) {
      const count = await page.locator(selector).count()
      if (count === 1) {
        submitBtn = page.locator(selector)
        break
      } else if (count > 1 && selector === 'button[type="submit"]') {
        const firstBtn = page.locator('button[type="submit"]').first()
        if (firstBtn) submitBtn = firstBtn
        break
      }
    }
    if (submitBtn) {
      await submitBtn.click()
    } else {
      await page.press(pwdSelector, 'Enter')
    }
    await page.waitForNavigation({ timeout: 15000 }).catch(() => {})
    const storageState = await context.storageState()
    await context.close()
    console.log('[auth] Form authentication succeeded')
    return JSON.stringify(storageState)
  } catch (error) {
    console.log(`[auth] Form authentication failed: ${(error as Error).message}`)
    await context.close()
    return null
  }
}

async function newAuthContext(browser: Browser, storageState: string | null): Promise<BrowserContext> {
  if (storageState) {
    try {
      return await browser.newContext({ storageState: JSON.parse(storageState) })
    } catch (error) {
      console.log(`[auth] Failed to restore storage state: ${(error as Error).message}`)
      return await browser.newContext()
    }
  }
  return await browser.newContext()
}

interface TtStat {
  sink: string
  policy_name: string
  policy_cost: number
  sink_cost: number
  total_cost: number
}

interface UrlResult {
  url: string
  status: number | null
  content_type: string | null
  content_length: number | null
  is_page: boolean
  policy_invocations: number
  policy_calls_by_name: Record<string, number>
  sink_calls: number
  sinks_by_name: Record<string, number>
  error?: string
}

interface TestOutput {
  app: string
  timestamp: string
  patched_url: string
  per_url: UrlResult[]
  summary: {
    total_urls: number
    pages: number
    non_pages: number
    urls_with_policy: number
    total_policy_invocations: number
  }
}

const PATCHED_INIT_SCRIPT = `(function() {
  window.__tt_stats = [];
  window.__tt_policy_invocations = 0;
  var _pending = 0;
  var _pendingPolicyName = '';

  if (window.trustedTypes) {
    var origCreate = trustedTypes.createPolicy.bind(trustedTypes);
    try {
      Object.defineProperty(trustedTypes, 'createPolicy', {
        configurable: true, writable: true,
        value: function(name, rules) {
          var wrapped = {};
          var keys = Object.keys(rules || {});
          for (var i = 0; i < keys.length; i++) {
            (function(key) {
              var fn = rules[key];
              wrapped[key] = function() {
                var t0 = performance.now();
                var result = fn.apply(this, arguments);
                _pending = performance.now() - t0;
                _pendingPolicyName = name;
                return result;
              };
            })(keys[i]);
          }
          return origCreate(name, wrapped);
        }
      });
    } catch(_) {}
  }

  function hookSink(proto, prop, name) {
    var desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (!desc || !desc.set) return;
    var orig = desc.set;
    Object.defineProperty(proto, prop, Object.assign({}, desc, {
      set: function(v) {
        var t1 = performance.now();
        orig.call(this, v);
        var t2 = performance.now();
        var pc = _pending; _pending = 0;
        var pn = _pendingPolicyName; _pendingPolicyName = '';
        if (pn) window.__tt_policy_invocations++;
        window.__tt_stats.push({ sink: name, policy_name: pn, policy_cost: pc, sink_cost: t2 - t1, total_cost: pc + (t2 - t1) });
      }
    }));
  }

  hookSink(Element.prototype, 'innerHTML', 'innerHTML');
  hookSink(Element.prototype, 'outerHTML', 'outerHTML');
  hookSink(HTMLIFrameElement.prototype, 'srcdoc', 'iframe.srcdoc');
  hookSink(HTMLScriptElement.prototype, 'text', 'script.text');
  hookSink(HTMLScriptElement.prototype, 'src', 'script.src');

  var origInsertAdjHTML = Element.prototype.insertAdjacentHTML;
  Element.prototype.insertAdjacentHTML = function(pos, html) {
    var t1 = performance.now();
    var r = origInsertAdjHTML.call(this, pos, html);
    var t2 = performance.now();
    var pc = _pending; _pending = 0;
    var pn = _pendingPolicyName; _pendingPolicyName = '';
    if (pn) window.__tt_policy_invocations++;
    window.__tt_stats.push({ sink: 'insertAdjacentHTML', policy_name: pn, policy_cost: pc, sink_cost: t2 - t1, total_cost: pc + (t2 - t1) });
    return r;
  };

  var origWrite = Document.prototype.write;
  Document.prototype.write = function() {
    var t1 = performance.now();
    var r = origWrite.apply(this, arguments);
    var t2 = performance.now();
    var pc = _pending; _pending = 0;
    var pn = _pendingPolicyName; _pendingPolicyName = '';
    if (pn) window.__tt_policy_invocations++;
    window.__tt_stats.push({ sink: 'document.write', policy_name: pn, policy_cost: pc, sink_cost: t2 - t1, total_cost: pc + (t2 - t1) });
    return r;
  };

  var origWriteln = Document.prototype.writeln;
  Document.prototype.writeln = function() {
    var t1 = performance.now();
    var r = origWriteln.apply(this, arguments);
    var t2 = performance.now();
    var pc = _pending; _pending = 0;
    var pn = _pendingPolicyName; _pendingPolicyName = '';
    if (pn) window.__tt_policy_invocations++;
    window.__tt_stats.push({ sink: 'document.writeln', policy_name: pn, policy_cost: pc, sink_cost: t2 - t1, total_cost: pc + (t2 - t1) });
    return r;
  };

  var origParseFromString = DOMParser.prototype.parseFromString;
  DOMParser.prototype.parseFromString = function(str, type) {
    var t1 = performance.now();
    var r = origParseFromString.call(this, str, type);
    var t2 = performance.now();
    var pc = _pending; _pending = 0;
    var pn = _pendingPolicyName; _pendingPolicyName = '';
    if (pn) window.__tt_policy_invocations++;
    window.__tt_stats.push({ sink: 'domParser.parseFromString', policy_name: pn, policy_cost: pc, sink_cost: t2 - t1, total_cost: pc + (t2 - t1) });
    return r;
  };

  var origCreateContextualFragment = Range.prototype.createContextualFragment;
  Range.prototype.createContextualFragment = function(str) {
    var t1 = performance.now();
    var r = origCreateContextualFragment.call(this, str);
    var t2 = performance.now();
    var pc = _pending; _pending = 0;
    var pn = _pendingPolicyName; _pendingPolicyName = '';
    if (pn) window.__tt_policy_invocations++;
    window.__tt_stats.push({ sink: 'range.createContextualFragment', policy_name: pn, policy_cost: pc, sink_cost: t2 - t1, total_cost: pc + (t2 - t1) });
    return r;
  };

  var origEval = window.eval;
  window.eval = function(code) {
    var t1 = performance.now();
    var r = origEval(code);
    var t2 = performance.now();
    var pc = _pending; _pending = 0;
    var pn = _pendingPolicyName; _pendingPolicyName = '';
    if (pn) window.__tt_policy_invocations++;
    window.__tt_stats.push({ sink: 'eval', policy_name: pn, policy_cost: pc, sink_cost: t2 - t1, total_cost: pc + (t2 - t1) });
    return r;
  };

  var origSetTimeout = window.setTimeout;
  window.setTimeout = function(fn) {
    if (_pending > 0) {
      var t1 = performance.now();
      var id = origSetTimeout.apply(window, arguments);
      var t2 = performance.now();
      var pc = _pending; _pending = 0;
      var pn = _pendingPolicyName; _pendingPolicyName = '';
      if (pn) window.__tt_policy_invocations++;
      window.__tt_stats.push({ sink: 'setTimeout', policy_name: pn, policy_cost: pc, sink_cost: t2 - t1, total_cost: pc + (t2 - t1) });
      return id;
    }
    _pendingPolicyName = '';
    return origSetTimeout.apply(window, arguments);
  };

  var origSetInterval = window.setInterval;
  window.setInterval = function(fn) {
    if (_pending > 0) {
      var t1 = performance.now();
      var id = origSetInterval.apply(window, arguments);
      var t2 = performance.now();
      var pc = _pending; _pending = 0;
      var pn = _pendingPolicyName; _pendingPolicyName = '';
      if (pn) window.__tt_policy_invocations++;
      window.__tt_stats.push({ sink: 'setInterval', policy_name: pn, policy_cost: pc, sink_cost: t2 - t1, total_cost: pc + (t2 - t1) });
      return id;
    }
    _pendingPolicyName = '';
    return origSetInterval.apply(window, arguments);
  };
})();`

async function testUrl(browser: any, url: string, storageState: string | null): Promise<UrlResult> {
  const result: UrlResult = {
    url,
    status: null,
    content_type: null,
    content_length: null,
    is_page: false,
    policy_invocations: 0,
    policy_calls_by_name: {},
    sink_calls: 0,
    sinks_by_name: {},
  }

  if (storageState) {
    result.is_page = true
  } else {
    try {
      const response = await fetch(url, { method: 'HEAD', redirect: 'follow' })
      result.status = response.status
      result.content_type = response.headers.get('content-type') || null
      const contentLengthStr = response.headers.get('content-length')
      result.content_length = contentLengthStr ? parseInt(contentLengthStr, 10) : null
      result.is_page = (result.content_type || '').includes('text/html')
    } catch (e) {
      result.error = `HEAD request failed: ${String(e).substring(0, 100)}`
      return result
    }

    if (!result.is_page) {
      return result
    }
  }

  const context = await newAuthContext(browser, storageState)
  const page = await context.newPage()
  await page.addInitScript({ content: PATCHED_INIT_SCRIPT })

  try {
    const response = await page.goto(url, { waitUntil: 'load', timeout: 30_000 })

    if (response) {
      result.status = response.status()
      const headers = response.headers()
      result.content_type = headers['content-type'] || null
      const contentLength = headers['content-length']
      result.content_length = contentLength ? parseInt(contentLength, 10) : null
    }

    result.policy_invocations = await page.evaluate((): number => (window as any).__tt_policy_invocations || 0)

    const stats = await page.evaluate((): TtStat[] => (window as any).__tt_stats || [])
    result.sink_calls = stats.length

    const policyMap: Record<string, number> = {}
    const sinkMap: Record<string, number> = {}
    for (const stat of stats) {
      if (stat.policy_name) {
        policyMap[stat.policy_name] = (policyMap[stat.policy_name] || 0) + 1
      }
      sinkMap[stat.sink] = (sinkMap[stat.sink] || 0) + 1
    }
    result.policy_calls_by_name = policyMap
    result.sinks_by_name = sinkMap
  } catch (e) {
    result.error = `Playwright test failed: ${String(e).substring(0, 100)}`
  } finally {
    await context.close()
  }

  return result
}

async function main(): Promise<void> {
  if (!URLS_FILE || !existsSync(URLS_FILE)) {
    console.error(`Error: URLS_FILE not found: ${URLS_FILE}`)
    process.exit(1)
  }

  const fileContent = fs.readFileSync(URLS_FILE, 'utf-8')
  const data = yaml.load(fileContent) as any
  const urls: string[] = data?.urls || []

  if (!urls.length) {
    console.error('Error: No URLs found in YAML file')
    process.exit(1)
  }

  console.log(`\n=== Testing ${urls.length} URLs for ${TARGET} ===`)
  console.log(`Patched URL: ${PATCHED_URL}`)
  console.log(`Output dir: ${OUTPUT_DIR}\n`)

  const browser = await chromium.launch({ headless: true })

  const authCfg = loadAuthConfig()
  const storageState = authCfg.enabled ? await performFormAuth(browser, authCfg, PATCHED_URL) : null

  const results: UrlResult[] = []

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]
    console.log(`[${i + 1}/${urls.length}] Testing ${url}...`)
    const result = await testUrl(browser, url, storageState)
    results.push(result)

    const status = result.error ? `ERROR: ${result.error.substring(0, 50)}` : `${result.status} ${result.is_page ? 'HTML' : result.content_type || 'UNKNOWN'}`
    const policy = result.policy_invocations > 0 ? ` policy=${result.policy_invocations}` : ''
    console.log(`  -> ${status}${policy}`)
  }

  await browser.close()

  const summary = {
    total_urls: urls.length,
    pages: results.filter(r => r.is_page).length,
    non_pages: results.filter(r => !r.is_page).length,
    urls_with_policy: results.filter(r => r.policy_invocations > 0).length,
    total_policy_invocations: results.reduce((s, r) => s + r.policy_invocations, 0),
  }

  const output: TestOutput = {
    app: TARGET,
    timestamp: new Date().toISOString(),
    patched_url: PATCHED_URL,
    per_url: results,
    summary,
  }

  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outPath = `${OUTPUT_DIR}/testurl_${ts}.json`
  writeFileSync(outPath, JSON.stringify(output, null, 2))

  console.log(`\nResults saved: ${outPath}`)
  console.log(`  Pages: ${summary.pages}/${summary.total_urls}`)
  console.log(`  With policy: ${summary.urls_with_policy}`)
  console.log(`  Total policy invocations: ${summary.total_policy_invocations}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
