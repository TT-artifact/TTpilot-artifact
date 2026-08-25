import { chromium, type Browser, type BrowserContext } from '@playwright/test'
import { writeFileSync, mkdirSync, existsSync } from 'fs'

const PATCHED_BASE = (process.env.OVERHEAD_PATCHED_URL || 'http://localhost:8084/').replace(/\/$/, '')
const UNPATCHED_BASE = (process.env.OVERHEAD_UNPATCHED_URL || 'http://localhost:8085/').replace(/\/$/, '')
const SINK_URLS: string[] = JSON.parse(process.env.OVERHEAD_SINK_URLS || '[]')
const REPEAT = parseInt(process.env.OVERHEAD_REPEAT || '5', 10)
const TARGET_NAME = process.env.OVERHEAD_TARGET || 'unknown'
const OUTPUT_DIR = process.env.OVERHEAD_OUTPUT_DIR || '.'

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
    console.log('[auth] Missing credentials')
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
    if ((await page.locator(pwdSelector).count()) === 0) {
      await context.close()
      return null
    }
    await page.fill(pwdSelector, password)
    let clicked = false
    for (const text of ['Login', 'login', 'Sign In', 'sign in']) {
      const btn = page.getByRole('button', { name: text })
      if ((await btn.count()) > 0) {
        await btn.click()
        clicked = true
        break
      }
    }
    if (!clicked) {
      const submitBtn = page.locator('button[type="submit"]').first()
      if ((await submitBtn.count()) > 0) {
        await submitBtn.click()
      } else {
        await page.press(pwdSelector, 'Enter')
      }
    }
    await page.waitForNavigation({ timeout: 15000 }).catch(() => {})
    const storageState = await context.storageState()
    await context.close()
    console.log('[auth] Authentication succeeded')
    return JSON.stringify(storageState)
  } catch (error) {
    console.log(`[auth] Authentication failed: ${(error as Error).message}`)
    await context.close()
    return null
  }
}

async function newAuthContext(browser: Browser, storageState: string | null): Promise<BrowserContext> {
  if (storageState) {
    try {
      return await browser.newContext({ storageState: JSON.parse(storageState) })
    } catch (error) {
      return await browser.newContext()
    }
  }
  return await browser.newContext()
}

let patchedStorageState: string | null = null
let unpatchedStorageState: string | null = null

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

const UNPATCHED_INIT_SCRIPT = `(function() {
  window.__tt_stats = [];

  function hookSink(proto, prop, name) {
    var desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (!desc || !desc.set) return;
    var orig = desc.set;
    Object.defineProperty(proto, prop, Object.assign({}, desc, {
      set: function(v) {
        var t0 = performance.now(); orig.call(this, v); var t1 = performance.now();
        window.__tt_stats.push({ sink: name, policy_name: '', policy_cost: 0, sink_cost: t1 - t0, total_cost: t1 - t0 });
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
    var t0 = performance.now(); var r = origInsertAdjHTML.call(this, pos, html); var t1 = performance.now();
    window.__tt_stats.push({ sink: 'insertAdjacentHTML', policy_name: '', policy_cost: 0, sink_cost: t1 - t0, total_cost: t1 - t0 });
    return r;
  };

  var origWrite = Document.prototype.write;
  Document.prototype.write = function() {
    var t0 = performance.now(); var r = origWrite.apply(this, arguments); var t1 = performance.now();
    window.__tt_stats.push({ sink: 'document.write', policy_name: '', policy_cost: 0, sink_cost: t1 - t0, total_cost: t1 - t0 });
    return r;
  };

  var origWriteln = Document.prototype.writeln;
  Document.prototype.writeln = function() {
    var t0 = performance.now(); var r = origWriteln.apply(this, arguments); var t1 = performance.now();
    window.__tt_stats.push({ sink: 'document.writeln', policy_name: '', policy_cost: 0, sink_cost: t1 - t0, total_cost: t1 - t0 });
    return r;
  };

  var origParseFromString = DOMParser.prototype.parseFromString;
  DOMParser.prototype.parseFromString = function(str, type) {
    var t0 = performance.now(); var r = origParseFromString.call(this, str, type); var t1 = performance.now();
    window.__tt_stats.push({ sink: 'domParser.parseFromString', policy_name: '', policy_cost: 0, sink_cost: t1 - t0, total_cost: t1 - t0 });
    return r;
  };

  var origCreateContextualFragment = Range.prototype.createContextualFragment;
  Range.prototype.createContextualFragment = function(str) {
    var t0 = performance.now(); var r = origCreateContextualFragment.call(this, str); var t1 = performance.now();
    window.__tt_stats.push({ sink: 'range.createContextualFragment', policy_name: '', policy_cost: 0, sink_cost: t1 - t0, total_cost: t1 - t0 });
    return r;
  };

  var origSetTimeout = window.setTimeout;
  window.setTimeout = function(fn) {
    if (typeof fn === 'string') {
      var t0 = performance.now(); var id = origSetTimeout.apply(window, arguments); var t1 = performance.now();
      window.__tt_stats.push({ sink: 'setTimeout', policy_name: '', policy_cost: 0, sink_cost: t1 - t0, total_cost: t1 - t0 });
      return id;
    }
    return origSetTimeout.apply(window, arguments);
  };

  var origSetInterval = window.setInterval;
  window.setInterval = function(fn) {
    if (typeof fn === 'string') {
      var t0 = performance.now(); var id = origSetInterval.apply(window, arguments); var t1 = performance.now();
      window.__tt_stats.push({ sink: 'setInterval', policy_name: '', policy_cost: 0, sink_cost: t1 - t0, total_cost: t1 - t0 });
      return id;
    }
    return origSetInterval.apply(window, arguments);
  };
})();`

interface TtStat {
  sink: string
  policy_name: string
  policy_cost: number
  sink_cost: number
  total_cost: number
}

interface InvocationRecord extends TtStat {
  run_id: number
  invocation_id: number
}

interface PageTimings {
  dcl_ms: number
  load_ms: number
}

interface PageLoadGroup {
  avg_dcl_ms: number
  avg_load_ms: number
}

interface PageLoadStats {
  cold: PageLoadGroup
  warm_cold: PageLoadGroup
  warm: PageLoadGroup
}

interface SinkStats {
  count: number
  mean: number
  median: number
  p95: number
  stddev: number
}

function stats(values: number[]): SinkStats {
  if (values.length === 0) return { count: 0, mean: 0, median: 0, p95: 0, stddev: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  const mean = values.reduce((s, v) => s + v, 0) / n
  const median = n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)]
  const p95 = sorted[Math.min(Math.ceil(n * 0.95) - 1, n - 1)]
  const variance = n > 1 ? values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) : 0
  return {
    count: n,
    mean: parseFloat(mean.toFixed(6)),
    median: parseFloat(median.toFixed(6)),
    p95: parseFloat(p95.toFixed(6)),
    stddev: parseFloat(Math.sqrt(variance).toFixed(6)),
  }
}

let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null

async function measurePageLoad(
  url: string,
  repeat: number,
  storageState: string | null
): Promise<{ coldTimings: PageTimings[]; warmColdTimings: PageTimings[]; warmTimings: PageTimings[] }> {
  const coldTimings: PageTimings[] = []
  const warmColdTimings: PageTimings[] = []
  const warmTimings: PageTimings[] = []

  for (let i = 0; i < repeat; i++) {
    const ctx = await newAuthContext(browser!, storageState)
    const pg = await ctx.newPage()
    try {
      await pg.goto(url, { waitUntil: 'load', timeout: 30_000 })
      const timings = await pg.evaluate((): PageTimings => {
        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
        if (nav) return { dcl_ms: nav.domContentLoadedEventEnd - nav.startTime, load_ms: nav.loadEventEnd - nav.startTime }
        const t = window.performance.timing
        return { dcl_ms: t.domContentLoadedEventEnd - t.navigationStart, load_ms: t.loadEventEnd - t.navigationStart }
      })
      coldTimings.push(timings)
    } catch (e) {
    } finally {
      await ctx.close()
    }
  }

  {
    const ctx = await newAuthContext(browser!, storageState)
    const pg = await ctx.newPage()
    try {

      await pg.goto(url, { waitUntil: 'load', timeout: 30_000 })
      const timings1 = await pg.evaluate((): PageTimings => {
        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
        if (nav) return { dcl_ms: nav.domContentLoadedEventEnd - nav.startTime, load_ms: nav.loadEventEnd - nav.startTime }
        const t = window.performance.timing
        return { dcl_ms: t.domContentLoadedEventEnd - t.navigationStart, load_ms: t.loadEventEnd - t.navigationStart }
      })
      warmColdTimings.push(timings1)

      for (let i = 1; i < repeat; i++) {
        await pg.goto('about:blank')
        await pg.goto(url, { waitUntil: 'load', timeout: 30_000 })
        const timings = await pg.evaluate((): PageTimings => {
          const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
          if (nav) return { dcl_ms: nav.domContentLoadedEventEnd - nav.startTime, load_ms: nav.loadEventEnd - nav.startTime }
          const t = window.performance.timing
          return { dcl_ms: t.domContentLoadedEventEnd - t.navigationStart, load_ms: t.loadEventEnd - t.navigationStart }
        })
        warmTimings.push(timings)
      }
    } catch (e) {
    } finally {
      await ctx.close()
    }
  }

  return { coldTimings, warmColdTimings, warmTimings }
}

async function measureSinkCost(
  url: string,
  mode: 'patched' | 'unpatched',
  repeat: number
): Promise<{ warmColdTimings: PageTimings[]; warmTimings: PageTimings[]; sinkStats: TtStat[]; invocationRecords: InvocationRecord[]; policyInvocations: number }> {
  const script = mode === 'patched' ? PATCHED_INIT_SCRIPT : UNPATCHED_INIT_SCRIPT
  const storageState = mode === 'patched' ? patchedStorageState : unpatchedStorageState
  const warmColdTimings: PageTimings[] = []
  const warmTimings: PageTimings[] = []
  const sinkStats: TtStat[] = []
  const invocationRecords: InvocationRecord[] = []
  let totalPolicyInvocations = 0

  {
    const ctx = await newAuthContext(browser!, storageState)
    const pg = await ctx.newPage()
    await pg.addInitScript({ content: script })
    try {

      await pg.goto(url, { waitUntil: 'load', timeout: 30_000 })
      const timings1 = await pg.evaluate((): PageTimings => {
        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
        if (nav) return { dcl_ms: nav.domContentLoadedEventEnd - nav.startTime, load_ms: nav.loadEventEnd - nav.startTime }
        const t = window.performance.timing
        return { dcl_ms: t.domContentLoadedEventEnd - t.navigationStart, load_ms: t.loadEventEnd - t.navigationStart }
      })
      warmColdTimings.push(timings1)
      const raw1 = await pg.evaluate((): TtStat[] => (window as any).__tt_stats || [])
      sinkStats.push(...raw1)
      invocationRecords.push(...raw1.map((stat, index) => ({
        ...stat,
        run_id: 1,
        invocation_id: index + 1,
      })))
      let prevPolicyInvocations = 0
      if (mode === 'patched') {
        const pi1 = await pg.evaluate((): number => (window as any).__tt_policy_invocations || 0)
        totalPolicyInvocations += pi1
        prevPolicyInvocations = pi1
      }

      for (let i = 1; i < repeat; i++) {
        await pg.goto('about:blank')
        await pg.goto(url, { waitUntil: 'load', timeout: 30_000 })
        const timings = await pg.evaluate((): PageTimings => {
          const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
          if (nav) return { dcl_ms: nav.domContentLoadedEventEnd - nav.startTime, load_ms: nav.loadEventEnd - nav.startTime }
          const t = window.performance.timing
          return { dcl_ms: t.domContentLoadedEventEnd - t.navigationStart, load_ms: t.loadEventEnd - t.navigationStart }
        })
        warmTimings.push(timings)
        const raw = await pg.evaluate((): TtStat[] => (window as any).__tt_stats || [])
        sinkStats.push(...raw)
        invocationRecords.push(...raw.map((stat, index) => ({
          ...stat,
          run_id: i + 1,
          invocation_id: index + 1,
        })))
        if (mode === 'patched') {
          const cumPi = await pg.evaluate((): number => (window as any).__tt_policy_invocations || 0)
          const piDelta = cumPi - prevPolicyInvocations
          totalPolicyInvocations += piDelta
          prevPolicyInvocations = cumPi
        }
      }
    } catch (e) {
    } finally {
      await ctx.close()
    }
  }

  return { warmColdTimings, warmTimings, sinkStats, invocationRecords, policyInvocations: totalPolicyInvocations }
}

function csvCell(value: string | number): string {
  const text = String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function policyTypeForCsv(policyName: string): string {
  return policyName === 'pass-thru' ? 'pass-through' : policyName
}

function aggregateBySinkType(stats_list: TtStat[]): Record<string, {
  count: number
  policy_cost: SinkStats
  sink_cost: SinkStats
  total_cost: SinkStats
}> {
  const groups: Record<string, { policy: number[]; assign: number[]; total: number[] }> = {}
  for (const s of stats_list) {
    if (!groups[s.sink]) groups[s.sink] = { policy: [], assign: [], total: [] }
    groups[s.sink].policy.push(s.policy_cost)
    groups[s.sink].assign.push(s.sink_cost)
    groups[s.sink].total.push(s.total_cost)
  }
  const out: Record<string, any> = {}
  for (const [sink, g] of Object.entries(groups)) {
    out[sink] = { count: g.total.length, policy_cost: stats(g.policy), sink_cost: stats(g.assign), total_cost: stats(g.total) }
  }
  return out
}

function aggregateBySinkAndPolicy(stats_list: TtStat[]): Record<string, Record<string, {
  count: number
  policy_cost: SinkStats
  sink_cost: SinkStats
  total_cost: SinkStats
}>> {
  const groups: Record<string, Record<string, { policy: number[]; assign: number[]; total: number[] }>> = {}
  for (const s of stats_list) {
    if (!groups[s.sink]) groups[s.sink] = {}
    if (!groups[s.sink][s.policy_name]) groups[s.sink][s.policy_name] = { policy: [], assign: [], total: [] }
    groups[s.sink][s.policy_name].policy.push(s.policy_cost)
    groups[s.sink][s.policy_name].assign.push(s.sink_cost)
    groups[s.sink][s.policy_name].total.push(s.total_cost)
  }
  const out: Record<string, Record<string, any>> = {}
  for (const [sink, policyGroups] of Object.entries(groups)) {
    out[sink] = {}
    for (const [policyName, g] of Object.entries(policyGroups)) {
      out[sink][policyName] = { count: g.total.length, policy_cost: stats(g.policy), sink_cost: stats(g.assign), total_cost: stats(g.total) }
    }
  }
  return out
}

function patchedToUnpatchedUrl(url: string): string {
  if (url.startsWith(PATCHED_BASE)) return UNPATCHED_BASE + url.slice(PATCHED_BASE.length)
  return url
}

async function main(): Promise<void> {
  const urls = SINK_URLS.length > 0 ? SINK_URLS : [`${PATCHED_BASE}/`]

  console.log(`\n=== Real-world Overhead Benchmark: ${TARGET_NAME} ===`)
  console.log(`Patched base  : ${PATCHED_BASE}`)
  console.log(`Unpatched base: ${UNPATCHED_BASE}`)
  console.log(`URLs to test  : ${urls.length}`)
  console.log(`Repeat        : ${REPEAT} (+ 1 warm-up per URL)\n`)

  browser = await chromium.launch({ headless: true })

  const authCfg = loadAuthConfig()
  if (authCfg.enabled) {
    patchedStorageState = await performFormAuth(browser, authCfg, PATCHED_BASE)
    unpatchedStorageState = await performFormAuth(browser, authCfg, UNPATCHED_BASE)
  }

  const perUrlResults: Record<string, object> = {}
  const allPatchedStats: TtStat[] = []
  const allUnpatchedStats: TtStat[] = []
  const invocationCsvRows: Array<Array<string | number>> = []
  let urlsWithPolicyCalls = 0

  for (const patchedUrl of urls) {
    const unpatchedUrl = patchedToUnpatchedUrl(patchedUrl)
    console.log(`  [page load - no script]  ${patchedUrl}`)
    const pLoad = await measurePageLoad(patchedUrl, REPEAT, patchedStorageState)
    const uLoad = await measurePageLoad(unpatchedUrl, REPEAT, unpatchedStorageState)

    console.log(`  [policy cost - warm]     ${patchedUrl}`)
    const pCost = await measureSinkCost(patchedUrl, 'patched', REPEAT)
    const uCost = await measureSinkCost(unpatchedUrl, 'unpatched', REPEAT)

    for (const record of uCost.invocationRecords) {
      invocationCsvRows.push([
        TARGET_NAME,
        unpatchedUrl,
        record.run_id,
        'original',
        record.sink,
        '',
        record.invocation_id,
        0,
        record.sink_cost * 1000,
        record.sink_cost * 1000,
      ])
    }
    for (const record of pCost.invocationRecords) {
      invocationCsvRows.push([
        TARGET_NAME,
        patchedUrl,
        record.run_id,
        'patched',
        record.sink,
        policyTypeForCsv(record.policy_name),
        record.invocation_id,
        record.policy_cost * 1000,
        record.sink_cost * 1000,
        record.total_cost * 1000,
      ])
    }

    const pColdLoadAvg = pLoad.coldTimings.length > 0
      ? pLoad.coldTimings.reduce((s, t) => s + t.load_ms, 0) / pLoad.coldTimings.length : 0
    const uColdLoadAvg = uLoad.coldTimings.length > 0
      ? uLoad.coldTimings.reduce((s, t) => s + t.load_ms, 0) / uLoad.coldTimings.length : 0
    const pColdDclAvg = pLoad.coldTimings.length > 0
      ? pLoad.coldTimings.reduce((s, t) => s + t.dcl_ms, 0) / pLoad.coldTimings.length : 0
    const uColdDclAvg = uLoad.coldTimings.length > 0
      ? uLoad.coldTimings.reduce((s, t) => s + t.dcl_ms, 0) / uLoad.coldTimings.length : 0

    const pWarmColdLoadAvg = pLoad.warmColdTimings.length > 0
      ? pLoad.warmColdTimings.reduce((s, t) => s + t.load_ms, 0) / pLoad.warmColdTimings.length : 0
    const uWarmColdLoadAvg = uLoad.warmColdTimings.length > 0
      ? uLoad.warmColdTimings.reduce((s, t) => s + t.load_ms, 0) / uLoad.warmColdTimings.length : 0
    const pWarmColdDclAvg = pLoad.warmColdTimings.length > 0
      ? pLoad.warmColdTimings.reduce((s, t) => s + t.dcl_ms, 0) / pLoad.warmColdTimings.length : 0
    const uWarmColdDclAvg = uLoad.warmColdTimings.length > 0
      ? uLoad.warmColdTimings.reduce((s, t) => s + t.dcl_ms, 0) / uLoad.warmColdTimings.length : 0

    const pWarmLoadAvg = pLoad.warmTimings.length > 0
      ? pLoad.warmTimings.reduce((s, t) => s + t.load_ms, 0) / pLoad.warmTimings.length : 0
    const uWarmLoadAvg = uLoad.warmTimings.length > 0
      ? uLoad.warmTimings.reduce((s, t) => s + t.load_ms, 0) / uLoad.warmTimings.length : 0
    const pWarmDclAvg = pLoad.warmTimings.length > 0
      ? pLoad.warmTimings.reduce((s, t) => s + t.dcl_ms, 0) / pLoad.warmTimings.length : 0
    const uWarmDclAvg = uLoad.warmTimings.length > 0
      ? uLoad.warmTimings.reduce((s, t) => s + t.dcl_ms, 0) / uLoad.warmTimings.length : 0

    console.log(`    [cold]      load: patched=${pColdLoadAvg.toFixed(0)}ms  unpatched=${uColdLoadAvg.toFixed(0)}ms  diff=${(pColdLoadAvg - uColdLoadAvg >= 0 ? '+' : '') + (pColdLoadAvg - uColdLoadAvg).toFixed(0)}ms`)
    console.log(`    [warm_cold] load: patched=${pWarmColdLoadAvg.toFixed(0)}ms  unpatched=${uWarmColdLoadAvg.toFixed(0)}ms  diff=${(pWarmColdLoadAvg - uWarmColdLoadAvg >= 0 ? '+' : '') + (pWarmColdLoadAvg - uWarmColdLoadAvg).toFixed(0)}ms`)
    console.log(`    [warm]      load: patched=${pWarmLoadAvg.toFixed(0)}ms  unpatched=${uWarmLoadAvg.toFixed(0)}ms  diff=${(pWarmLoadAvg - uWarmLoadAvg >= 0 ? '+' : '') + (pWarmLoadAvg - uWarmLoadAvg).toFixed(0)}ms`)
    console.log(`    sink invocations: patched=${pCost.sinkStats.length}  unpatched=${uCost.sinkStats.length}\n`)

    if (pCost.policyInvocations > 0) {
      urlsWithPolicyCalls++
    }

    allPatchedStats.push(...pCost.sinkStats)
    allUnpatchedStats.push(...uCost.sinkStats)

    perUrlResults[patchedUrl] = {
      patched_page: {
        cold: { avg_dcl_ms: parseFloat(pColdDclAvg.toFixed(2)), avg_load_ms: parseFloat(pColdLoadAvg.toFixed(2)) },
        warm_cold: { avg_dcl_ms: parseFloat(pWarmColdDclAvg.toFixed(2)), avg_load_ms: parseFloat(pWarmColdLoadAvg.toFixed(2)) },
        warm: { avg_dcl_ms: parseFloat(pWarmDclAvg.toFixed(2)), avg_load_ms: parseFloat(pWarmLoadAvg.toFixed(2)) },
      },
      unpatched_page: {
        cold: { avg_dcl_ms: parseFloat(uColdDclAvg.toFixed(2)), avg_load_ms: parseFloat(uColdLoadAvg.toFixed(2)) },
        warm_cold: { avg_dcl_ms: parseFloat(uWarmColdDclAvg.toFixed(2)), avg_load_ms: parseFloat(uWarmColdLoadAvg.toFixed(2)) },
        warm: { avg_dcl_ms: parseFloat(uWarmDclAvg.toFixed(2)), avg_load_ms: parseFloat(uWarmLoadAvg.toFixed(2)) },
      },
      cold_overhead_ms: parseFloat((pColdLoadAvg - uColdLoadAvg).toFixed(2)),
      warm_cold_overhead_ms: parseFloat((pWarmColdLoadAvg - uWarmColdLoadAvg).toFixed(2)),
      warm_overhead_ms: parseFloat((pWarmLoadAvg - uWarmLoadAvg).toFixed(2)),
      page_overhead_ms: parseFloat((pColdLoadAvg - uColdLoadAvg).toFixed(2)),
      patched_sinks: aggregateBySinkType(pCost.sinkStats),
      patched_sinks_by_policy: aggregateBySinkAndPolicy(pCost.sinkStats),
      unpatched_sinks: aggregateBySinkType(uCost.sinkStats),
    }
  }

  await browser.close()

  const patchedAgg = aggregateBySinkType(allPatchedStats)
  const patchedAggByPolicy = aggregateBySinkAndPolicy(allPatchedStats)
  const unpatchedAgg = aggregateBySinkType(allUnpatchedStats)

  console.log('\n' + '='.repeat(90))
  console.log('AGGREGATE SINK STATS (all URLs, all repeats)')
  console.log('='.repeat(90))
  console.log(`URLs measured       : ${urls.length}`)
  console.log(`URLs with policy    : ${urlsWithPolicyCalls} / ${urls.length}`)
  console.log('')
  const allSinks = new Set([...Object.keys(patchedAgg), ...Object.keys(unpatchedAgg)])
  for (const sink of allSinks) {
    const p = patchedAgg[sink]
    const u = unpatchedAgg[sink]
    if (!p && !u) continue
    console.log(`\n[${sink}]`)
    const fmt = (n: number) => (n.toFixed(4) + 'ms').padStart(12)
    if (u) {
      console.log(`  Unpatched  raw  (n=${String(u.count).padStart(5)})  mean=${fmt(u.sink_cost.mean)}  median=${fmt(u.sink_cost.median)}  p95=${fmt(u.sink_cost.p95)}`)
    }
    if (p) {
      console.log(`  Patched    pol  (n=${String(p.count).padStart(5)})  mean=${fmt(p.policy_cost.mean)}  median=${fmt(p.policy_cost.median)}  p95=${fmt(p.policy_cost.p95)}`)
      console.log(`  Patched    asgn (n=${String(p.count).padStart(5)})  mean=${fmt(p.sink_cost.mean)}  median=${fmt(p.sink_cost.median)}  p95=${fmt(p.sink_cost.p95)}`)
      console.log(`  Patched    tot  (n=${String(p.count).padStart(5)})  mean=${fmt(p.total_cost.mean)}  median=${fmt(p.total_cost.median)}  p95=${fmt(p.total_cost.p95)}`)
    }
    if (p && u) {
      const overheadMean = p.total_cost.mean - u.sink_cost.mean
      const overheadMedian = p.total_cost.median - u.sink_cost.median
      const overheadP95 = p.total_cost.p95 - u.sink_cost.p95
      console.log(`  Overhead        mean=${(overheadMean >= 0 ? '+' : '') + overheadMean.toFixed(4) + 'ms'}  median=${(overheadMedian >= 0 ? '+' : '') + overheadMedian.toFixed(4) + 'ms'}  p95=${(overheadP95 >= 0 ? '+' : '') + overheadP95.toFixed(4) + 'ms'}`)
    }
  }

  const overheadPerSink: Record<string, object> = {}
  for (const sink of allSinks) {
    const p = patchedAgg[sink]; const u = unpatchedAgg[sink]
    if (!p || !u) continue
    overheadPerSink[sink] = {
      count: p.count,
      mean_ms: parseFloat((p.total_cost.mean - u.sink_cost.mean).toFixed(6)),
      median_ms: parseFloat((p.total_cost.median - u.sink_cost.median).toFixed(6)),
      p95_ms: parseFloat((p.total_cost.p95 - u.sink_cost.p95).toFixed(6)),
    }
  }

  const totalBrowsingOverheadMs = Object.values(perUrlResults).reduce((s: number, r: any) => s + (r.page_overhead_ms || 0), 0)

  const output = {
    target: TARGET_NAME,
    timestamp: new Date().toISOString(),
    patched_base: PATCHED_BASE,
    unpatched_base: UNPATCHED_BASE,
    urls_tested: urls.length,
    repeat: REPEAT,
    per_url: perUrlResults,
    aggregate: {
      urls_measured: urls.length,
      urls_with_policy_calls: urlsWithPolicyCalls,
      total_sink_invocations_patched: allPatchedStats.length,
      total_sink_invocations_unpatched: allUnpatchedStats.length,
      total_browsing_overhead_ms: parseFloat(totalBrowsingOverheadMs.toFixed(2)),
      patched_per_sink_type: patchedAgg,
      patched_per_sink_and_policy: patchedAggByPolicy,
      unpatched_per_sink_type: unpatchedAgg,
      overhead_per_sink_type: overheadPerSink,
    },
  }

  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outPath = `${OUTPUT_DIR}/realworld_${ts}.json`
  writeFileSync(outPath, JSON.stringify(output, null, 2))
  console.log(`\nJSON saved: ${outPath}`)

  const csvHeader = [
    'application', 'url', 'run_id', 'version', 'sink_type', 'policy_type',
    'invocation_id', 'policy_cost_us', 'sink_cost_us', 'total_cost_us',
  ]
  const csvPath = `${OUTPUT_DIR}/realworld_invocations_${ts}.csv`
  const csv = [csvHeader, ...invocationCsvRows]
    .map(row => row.map(csvCell).join(','))
    .join('\n') + '\n'
  writeFileSync(csvPath, csv)
  console.log(`Invocation CSV saved: ${csvPath}`)
}

main().catch(err => { console.error(err); process.exit(1) })
