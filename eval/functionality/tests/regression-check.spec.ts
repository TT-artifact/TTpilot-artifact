import { test, expect, chromium, type Browser, type BrowserContext } from '@playwright/test'
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { Action, playAction, shouldCapture } from '../utils/interactions'
import { capturePageState, setupPageListeners } from '../utils/capture'
import { comparePageStates, ComparisonResult } from '../utils/compare'
import { generateHtmlReport, ReportData } from '../utils/report'
import { saveTestRun, closeDb, TestRun } from '../utils/db'

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
  page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}))
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

async function performPopupAuth(browser: Browser, cfg: AuthConfig, baseUrl: string): Promise<string | null> {
  if (!cfg.enabled || cfg.type !== 'oauth_popup') return null
  const { login_url, email, password } = cfg.credentials
  if (!login_url || !email || !password) {
    console.log('[auth] Missing credentials')
    return null
  }
  const resolvedLoginUrl = remapHost(login_url, baseUrl)
  const context = await browser.newContext()
  const page = await context.newPage()
  page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}))
  try {
    console.log(`[auth] Attempting popup authentication against ${resolvedLoginUrl}...`)
    await page.goto(resolvedLoginUrl, { waitUntil: 'networkidle', timeout: 15000 })

    let loginClicked = false
    let popup: import('@playwright/test').Page | null = null
    for (const text of ['Login', 'login', 'Sign In', 'sign in', 'Log in']) {

      const btn = page.getByRole('button', { name: text })
      if ((await btn.count()) > 0) {
        const popupPromise = context.waitForEvent('page', { timeout: 15000 })
        await btn.click()
        popup = await popupPromise.catch(() => null)
        loginClicked = true
        break
      }
    }
    if (!loginClicked || !popup) {
      console.log('[auth] Could not open login popup')
      await context.close()
      return null
    }

    await popup.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})

    let usernameSelector: string | null = null
    for (const selector of ['input[name="Input.Email"]', 'input[name="Email"]', 'input[type="email"]', 'input[name="username"]', 'input[name="email"]', '#Input_Email']) {
      if ((await popup.locator(selector).count()) > 0) {
        usernameSelector = selector
        break
      }
    }
    if (!usernameSelector) {
      console.log('[auth] Could not find username field in popup')
      await context.close()
      return null
    }
    await popup.fill(usernameSelector, email)

    let pwdSelector: string | null = null
    for (const selector of ['input[name="Input.Password"]', 'input[name="Password"]', 'input[type="password"]', '#Input_Password']) {
      if ((await popup.locator(selector).count()) > 0) {
        pwdSelector = selector
        break
      }
    }
    if (!pwdSelector) {
      console.log('[auth] Could not find password field in popup')
      await context.close()
      return null
    }
    await popup.fill(pwdSelector, password)

    let submitted = false
    for (const text of ['Login', 'login', 'Sign In', 'sign in', 'Log in']) {

      const btn = popup.getByRole('button', { name: text, exact: true })
      if ((await btn.count()) > 0) {
        await btn.click()
        submitted = true
        break
      }
    }
    if (!submitted) {
      const submitBtn = popup.locator('button[type="submit"]').first()
      if ((await submitBtn.count()) > 0) {
        await submitBtn.click()
      } else {
        await popup.press(pwdSelector, 'Enter')
      }
    }

    await popup.waitForEvent('close', { timeout: 15000 }).catch(() => {})
    await page.waitForTimeout(1000)

    const storageState = await context.storageState()
    await context.close()
    console.log('[auth] Popup authentication succeeded')
    return JSON.stringify(storageState)
  } catch (error) {
    console.log(`[auth] Popup authentication failed: ${(error as Error).message}`)
    await context.close()
    return null
  }
}

async function performAuth(browser: Browser, cfg: AuthConfig, baseUrl: string): Promise<string | null> {
  if (!cfg.enabled) return null
  if (cfg.type === 'oauth_popup') return performPopupAuth(browser, cfg, baseUrl)
  return performFormAuth(browser, cfg, baseUrl)
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

const PATCHED_BASE = process.env.REGRESSION_PATCHED_URL || 'http://localhost:8080'
const UNPATCHED_BASE = process.env.REGRESSION_UNPATCHED_URL || 'http://localhost:8081'
const ACTIONS_FILE = process.env.REGRESSION_ACTIONS_FILE || 'artifacts/actions.json'
const ARTIFACTS_DIR = process.env.REGRESSION_RESULTS_DIR || 'results'
const APP_NAME = process.env.REGRESSION_APP || 'unknown'
const APP_ID = process.env.REGRESSION_APP_ID || 'unknown'
const DB_PATH = process.env.REGRESSION_DB_PATH || 'results/regression_results.db'

test('regression check: patched vs unpatched', async () => {
  if (!existsSync(ACTIONS_FILE)) {
    throw new Error(`Actions file not found: ${ACTIONS_FILE}`)
  }

  try {
    if (existsSync(DB_PATH)) {
      unlinkSync(DB_PATH)
    }
  } catch (_) {}

  const actions: Action[] = JSON.parse(readFileSync(ACTIONS_FILE, 'utf-8'))
  console.log(`Loaded ${actions.length} actions from ${ACTIONS_FILE}`)

  const pBrowser = await chromium.launch({ headless: true })
  const uBrowser = await chromium.launch({ headless: true })

  const authCfg = loadAuthConfig()
  const pStorageState = await performAuth(pBrowser, authCfg, PATCHED_BASE)
  const uStorageState = await performAuth(uBrowser, authCfg, UNPATCHED_BASE)

  const pContext = await newAuthContext(pBrowser, pStorageState)
  const uContext = await newAuthContext(uBrowser, uStorageState)

  const pPage = await pContext.newPage()
  const uPage = await uContext.newPage()

  pPage.on('dialog', (dialog) => dialog.dismiss().catch(() => {}))
  uPage.on('dialog', (dialog) => dialog.dismiss().catch(() => {}))

  const results: ComparisonResult[] = []

  try {
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i]
      console.log(`[${i + 1}/${actions.length}] ${action.type}: ${JSON.stringify(action).substring(0, 80)}`)

      const [pListeners, uListeners] = await Promise.all([
        Promise.resolve(setupPageListeners(pPage)),
        Promise.resolve(setupPageListeners(uPage)),
      ])

      await Promise.all([
        playAction(pPage, action, PATCHED_BASE, { filterTtNoise: true }),
        playAction(uPage, action, UNPATCHED_BASE, { filterTtNoise: false }),
      ])

      if (shouldCapture(action)) {
        const [pState, uState] = await Promise.all([
          capturePageState(pPage, pListeners, { filterTtNoise: true }),
          capturePageState(uPage, uListeners, { filterTtNoise: false }),
        ])

        const result = comparePageStates(pState, uState, JSON.stringify(action), i)
        results.push(result)

        const actionDir = join(ARTIFACTS_DIR, `action_${i}_${action.type}`)
        mkdirSync(actionDir, { recursive: true })

        const patchedData = {
          url: pState.url,
          statusCode: pState.statusCode,
          domText: pState.domText,
          domStructure: pState.domStructure,
          consoleErrors: pState.consoleErrors,
          ttTriggered: pState.ttTriggered,
          loadTimeMs: pState.loadTimeMs,
          rawHtml: pState.rawHtml,
          networkRequests: pState.networkRequests,
        }
        writeFileSync(join(actionDir, 'patched.json'), JSON.stringify(patchedData, null, 2))
        if (pState.screenshot && pState.screenshot.length > 0) {
          writeFileSync(join(actionDir, 'patched.png'), pState.screenshot)
        }

        const unpatchedData = {
          url: uState.url,
          statusCode: uState.statusCode,
          domText: uState.domText,
          domStructure: uState.domStructure,
          consoleErrors: uState.consoleErrors,
          ttTriggered: uState.ttTriggered,
          loadTimeMs: uState.loadTimeMs,
          rawHtml: uState.rawHtml,
          networkRequests: uState.networkRequests,
        }
        writeFileSync(join(actionDir, 'unpatched.json'), JSON.stringify(unpatchedData, null, 2))
        if (uState.screenshot && uState.screenshot.length > 0) {
          writeFileSync(join(actionDir, 'unpatched.png'), uState.screenshot)
        }

        const comparisonData = {
          action: JSON.parse(result.actionJson),
          hasRegression: result.hasRegression,
          regressions: result.regressions,
          statusCodes: result.statusCodes,
          domTextSimilarity: result.domTextSimilarity,
          domStructureSimilarity: result.domStructureSimilarity,
          domSimilarity: result.domSimilarity,
          consoleRegressions: result.consoleRegressions,
          screenshotDiffRatio: result.screenshotDiffRatio,
          ttTriggeredCount: result.ttTriggeredCount,
        }
        writeFileSync(join(actionDir, 'comparison.json'), JSON.stringify(comparisonData, null, 2))
        if (result.screenshotDiffBuffer) {
          writeFileSync(join(actionDir, 'screenshot_diff.png'), result.screenshotDiffBuffer)
        }

        if (result.hasRegression) {
          console.log(`  REGRESSION: ${result.regressions.join('; ')}`)
        } else {
          console.log(`  OK`)
        }
      } else {

        pPage.off('console', pListeners.consoleHandler)
        pPage.off('response', pListeners.responseHandler)
        uPage.off('console', uListeners.consoleHandler)
        uPage.off('response', uListeners.responseHandler)
      }
    }
  } finally {
    await pContext.close()
    await uContext.close()
    await pBrowser.close()
    await uBrowser.close()
  }

  const totalTtTriggered = results.reduce((sum, r) => sum + r.ttTriggeredCount, 0)

  const reportData: ReportData = {
    appName: APP_NAME,
    appId: APP_ID,
    timestamp: new Date().toISOString(),
    results,
    totalTests: results.length,
    passCount: results.filter((r) => !r.hasRegression).length,
    regressionCount: results.filter((r) => r.hasRegression).length,
    totalTtTriggered,
  }

  const now = new Date()
  const dateStr = now.toISOString().split('T')[0]
  const timeStr = now.toISOString().split('T')[1].split('.')[0].replace(/:/g, '')
  const timestamp = `${dateStr}_${timeStr}`

  mkdirSync(ARTIFACTS_DIR, { recursive: true })

  const reportPath = join(ARTIFACTS_DIR, `regression-${APP_ID}-${timestamp}.html`)
  writeFileSync(reportPath, generateHtmlReport(reportData))
  console.log(`\nHTML Report saved: ${reportPath}`)

  const summaryPath = join(ARTIFACTS_DIR, `regression-summary-${APP_ID}-${timestamp}.json`)
  const summary = {
    target: APP_ID,
    timestamp: new Date().toISOString(),
    patched_url: PATCHED_BASE,
    unpatched_url: UNPATCHED_BASE,
    discovery: {
      total_actions_discovered: actions.length,
      actions_captured: results.length,
      breakdown: {
        navigate: results.filter((r) => r.actionJson?.includes('"type":"navigate')).length,
        click: results.filter((r) => r.actionJson?.includes('"type":"click')).length,
        input: results.filter((r) => r.actionJson?.includes('"type":"input')).length,
        submit: results.filter((r) => r.actionJson?.includes('"type":"submit')).length,
        snapshot: results.filter((r) => r.actionJson?.includes('"type":"snapshot')).length,
      },
    },
    regression_test: {
      total_actions_tested: results.length,
      passed: reportData.passCount,
      failed: reportData.regressionCount,
      pass_rate: results.length > 0 ? parseFloat(((reportData.passCount / results.length) * 100).toFixed(2)) : 0,
      tt_violations_triggered: totalTtTriggered || 0,
    },
    validation_details: {
      http_code_failures: results.filter((r) => r.regressions.some((reg) => reg.includes('HTTP status code'))).length,
      dom_text_similarity_failures: results.filter((r) => r.regressions.some((reg) => reg.includes('DOM text similarity'))).length,
      dom_structure_similarity_failures: results.filter((r) => r.regressions.some((reg) => reg.includes('DOM structure similarity'))).length,
      console_error_failures: results.filter((r) => r.regressions.some((reg) => reg.includes('JS console error') || reg.includes('console'))).length,
      screenshot_failures: results.filter((r) => r.regressions.some((reg) => reg.includes('Screenshot'))).length,
    },
    failure_details: results
      .filter((r) => r.hasRegression)
      .map((r) => ({
        action_index: results.indexOf(r),
        action: r.actionJson,
        failures: r.regressions,
      })),
  }

  writeFileSync(summaryPath, JSON.stringify(summary, null, 2))
  console.log(`JSON Summary saved: ${summaryPath}`)

  const regressions = results.filter((r) => r.hasRegression)
  if (regressions.length > 0) {
    console.log(`\nRegressions found: ${regressions.length}/${results.length}`)
    for (const reg of regressions) {
      console.log(`  - ${reg.url}: ${reg.regressions.join(', ')}`)
    }
  }

  try {
    const testRun: TestRun = {
      app: APP_NAME,
      total_tests: results.length,
      passed: reportData.passCount,
      failed: reportData.regressionCount,
      regressions: reportData.regressionCount,
      tt_violations_blocked: reportData.totalTtTriggered || 0,
      duration_ms: Math.round(new Date().getTime() - new Date(reportData.timestamp).getTime()),
    }
    const runId = await saveTestRun(DB_PATH, testRun, results)
    console.log(`\nTest results saved to database (run_id: ${runId})`)
    console.log(`  Database: ${DB_PATH}`)
  } catch (err) {
    console.error('Failed to save test results to database:', err)
  } finally {
    await closeDb()
  }

  expect(regressions).toHaveLength(0)
})
