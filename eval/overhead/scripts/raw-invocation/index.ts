import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { writeFileSync, mkdirSync, existsSync, appendFileSync } from 'fs'
import { join } from 'path'
import { buildInstrumentationScript } from './browser-instrumentation'
import { collectCalls, readNavigationTiming } from './collector'
import { measureBaseline } from './baseline'
import { balancedCrossoverOrder, buildNavigationId, buildPairId, urlHash } from './pairing'
import { writeCsv } from './csv'
import { performFormAuth, loadAuthConfig, newAuthContext, type AuthConfig } from './auth'
import type { CacheCondition, CallRecord, NavigationRecord, Version } from './types'

const PATCHED_BASE = (process.env.OVERHEAD_PATCHED_URL || 'http://localhost:8084/').replace(/\/$/, '')
const UNPATCHED_BASE = (process.env.OVERHEAD_UNPATCHED_URL || 'http://localhost:8085/').replace(/\/$/, '')
const SINK_URLS: string[] = JSON.parse(process.env.OVERHEAD_SINK_URLS || '[]')
const REPEAT = parseInt(process.env.OVERHEAD_REPEAT || '5', 10)
const TARGET_NAME = process.env.OVERHEAD_TARGET || 'unknown'
const OUTPUT_DIR = process.env.OVERHEAD_OUTPUT_DIR || '.'
const GRACE_PERIOD_MS = 500

function patchedToUnpatchedUrl(url: string): string {
  if (url.startsWith(PATCHED_BASE)) return UNPATCHED_BASE + url.slice(PATCHED_BASE.length)
  return url
}

function normalizedUrlPath(url: string): string {
  try {
    const u = new URL(url)
    return `${u.pathname}${u.search}${u.hash}`
  } catch {
    return url
  }
}

interface NavigationOutcome {
  navigation: NavigationRecord
  calls: CallRecord[]
}

async function navigateAndCollect(
  page: Page,
  url: string,
  version: Version,
  cacheCondition: CacheCondition,
  runId: number,
  measurementOrder: number,
  navUrlHash: string
): Promise<NavigationOutcome> {
  const navigationId = buildNavigationId(TARGET_NAME, navUrlHash, version, cacheCondition, runId)
  const pairId = buildPairId(TARGET_NAME, navUrlHash, cacheCondition, runId)

  let completed = false
  let error = ''
  let timing = { dcl_us: 0, load_us: 0, load_event_end_us: 0 }
  let calls: CallRecord[] = []
  let frameCount = 0

  try {
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 })
    completed = true
    await page.waitForTimeout(GRACE_PERIOD_MS)
    timing = await readNavigationTiming(page)
    const collected = await collectCalls(page, navigationId, timing.load_event_end_us)
    calls = collected.calls
    frameCount = collected.frameCount
  } catch (e) {
    error = (e as Error).message
  }

  const navigation: NavigationRecord = {
    application: TARGET_NAME,
    url,
    version,
    cache_condition: cacheCondition,
    run_id: runId,
    navigation_id: navigationId,
    pair_id: pairId,
    measurement_order: measurementOrder,
    frame_count: frameCount,
    dcl_us: timing.dcl_us,
    load_us: timing.load_us,
    load_event_end_us: timing.load_event_end_us,
    completed,
    error,
  }

  return { navigation, calls }
}

async function runColdCondition(
  browser: Browser,
  urlPair: { patched: string; unpatched: string },
  navUrlHash: string,
  auth: { patched: string | null; unpatched: string | null },
  outcomes: NavigationOutcome[]
): Promise<void> {
  const order = balancedCrossoverOrder(REPEAT)
  let measurementOrder = 0
  for (const run of order) {
    for (const version of run.order) {
      measurementOrder++
      const url = version === 'patched' ? urlPair.patched : urlPair.unpatched
      const storageState = version === 'patched' ? auth.patched : auth.unpatched
      const context = await newAuthContext(browser, storageState)
      const page = await context.newPage()
      await page.addInitScript({ content: buildInstrumentationScript() })
      outcomes.push(await navigateAndCollect(page, url, version, 'cold', run.runId, measurementOrder, navUrlHash))
      await context.close()
    }
  }
}

async function runWarmConditionForVersion(
  browser: Browser,
  version: Version,
  url: string,
  navUrlHash: string,
  storageState: string | null,
  outcomes: NavigationOutcome[]
): Promise<void> {
  const context = await newAuthContext(browser, storageState)
  const page = await context.newPage()
  await page.addInitScript({ content: buildInstrumentationScript() })

  outcomes.push(await navigateAndCollect(page, url, version, 'warm_cold', 1, 1, navUrlHash))

  for (let runId = 2; runId <= REPEAT; runId++) {
    await page.goto('about:blank').catch(() => {})
    outcomes.push(await navigateAndCollect(page, url, version, 'warm', runId, runId, navUrlHash))
  }

  await context.close()
}

async function measureUrl(browser: Browser, patchedUrl: string, auth: { patched: string | null; unpatched: string | null }): Promise<NavigationOutcome[]> {
  const unpatchedUrl = patchedToUnpatchedUrl(patchedUrl)
  const navUrlHash = urlHash(normalizedUrlPath(patchedUrl))
  const outcomes: NavigationOutcome[] = []

  console.log(`  [cold, crossover]  ${patchedUrl}`)
  await runColdCondition(browser, { patched: patchedUrl, unpatched: unpatchedUrl }, navUrlHash, auth, outcomes)

  console.log(`  [warm/warm_cold]   ${patchedUrl}`)
  await runWarmConditionForVersion(browser, 'original', unpatchedUrl, navUrlHash, auth.unpatched, outcomes)
  await runWarmConditionForVersion(browser, 'patched', patchedUrl, navUrlHash, auth.patched, outcomes)

  return outcomes
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

function navigationRow(n: NavigationRecord): Array<string | number | boolean> {
  return [
    n.application, n.url, n.version, n.cache_condition, n.run_id, n.navigation_id, n.pair_id,
    n.measurement_order, n.frame_count, n.dcl_us, n.load_us, n.load_event_end_us, n.completed, n.error,
  ]
}

function callRow(c: CallRecord): Array<string | number | boolean> {
  return [
    c.navigation_id, c.frame_id, c.call_id, c.call_type, c.sink_type, c.policy_name,
    c.parent_call_id === null ? '' : c.parent_call_id, c.call_depth, c.inside_policy_handler, c.measurement_window,
    c.start_time_us, c.end_time_us, c.inclusive_cost_us, c.exclusive_cost_us,
    c.completed, c.threw, c.error_name,
  ]
}

async function main(): Promise<void> {
  const urls = SINK_URLS.length > 0 ? SINK_URLS : [`${PATCHED_BASE}/`]

  console.log(`\n=== Raw Invocation Overhead Measurement: ${TARGET_NAME} ===`)
  console.log(`Patched base  : ${PATCHED_BASE}`)
  console.log(`Unpatched base: ${UNPATCHED_BASE}`)
  console.log(`URLs to test  : ${urls.length}`)
  console.log(`Repeat        : ${REPEAT}\n`)

  const browser = await chromium.launch({ headless: true })

  const authCfg: AuthConfig = loadAuthConfig()
  const auth = {
    patched: authCfg.enabled ? await performFormAuth(browser, authCfg, PATCHED_BASE) : null,
    unpatched: authCfg.enabled ? await performFormAuth(browser, authCfg, UNPATCHED_BASE) : null,
  }

  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true })
  const ts = timestampSlug()
  const jsonlPath = join(OUTPUT_DIR, `overhead_raw_${ts}.jsonl`)

  const allNavigations: NavigationRecord[] = []
  const allCalls: CallRecord[] = []

  for (const url of urls) {
    const outcomes = await measureUrl(browser, url, auth)
    for (const outcome of outcomes) {
      allNavigations.push(outcome.navigation)
      allCalls.push(...outcome.calls)
      appendFileSync(jsonlPath, JSON.stringify({ type: 'navigation', ...outcome.navigation }) + '\n')
      for (const call of outcome.calls) {
        appendFileSync(jsonlPath, JSON.stringify({ type: 'call', ...call }) + '\n')
      }
    }
    const failed = outcomes.filter(o => !o.navigation.completed).length
    console.log(`    navigations=${outcomes.length} failed=${failed} calls=${outcomes.reduce((s, o) => s + o.calls.length, 0)}\n`)
  }

  console.log('  [instrumentation baseline]')
  const baseline = await measureBaseline(browser)
  for (const row of baseline) {
    console.log(`    ${row.operation.padEnd(28)} mean=${row.stats.mean}us median=${row.stats.median}us p95=${row.stats.p95}us`)
  }

  await browser.close()

  const navHeader = [
    'application', 'url', 'version', 'cache_condition', 'run_id', 'navigation_id', 'pair_id',
    'measurement_order', 'frame_count', 'dcl_us', 'load_us', 'load_event_end_us', 'completed', 'error',
  ]
  const callHeader = [
    'navigation_id', 'frame_id', 'call_id', 'call_type', 'sink_type', 'policy_name',
    'parent_call_id', 'call_depth', 'inside_policy_handler', 'measurement_window',
    'start_time_us', 'end_time_us', 'inclusive_cost_us', 'exclusive_cost_us',
    'completed', 'threw', 'error_name',
  ]
  const baselineHeader = ['operation', 'count', 'mean_us', 'median_us', 'p95_us', 'stddev_us']

  writeCsv(join(OUTPUT_DIR, `overhead_navigations_${ts}.csv`), navHeader, allNavigations.map(navigationRow))
  writeCsv(join(OUTPUT_DIR, `overhead_calls_${ts}.csv`), callHeader, allCalls.map(callRow))
  writeCsv(
    join(OUTPUT_DIR, `overhead_baseline_${ts}.csv`),
    baselineHeader,
    baseline.map(b => [b.operation, b.stats.count, b.stats.mean, b.stats.median, b.stats.p95, b.stats.stddev])
  )

  console.log(`\nWrote overhead_navigations_${ts}.csv (${allNavigations.length} rows)`)
  console.log(`Wrote overhead_calls_${ts}.csv (${allCalls.length} rows)`)
  console.log(`Wrote overhead_baseline_${ts}.csv (${baseline.length} rows)`)
  console.log(`Wrote overhead_raw_${ts}.jsonl`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
