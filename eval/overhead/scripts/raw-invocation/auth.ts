import type { Browser, BrowserContext } from '@playwright/test'

export interface AuthConfig {
  enabled: boolean
  type: string
  credentials: { login_url?: string; email?: string; password?: string }
}

export function loadAuthConfig(): AuthConfig {
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

export async function performFormAuth(browser: Browser, cfg: AuthConfig, baseUrl: string): Promise<string | null> {
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
      if ((await page.locator(selector).count()) > 0) {
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
      if ((await page.locator(selector).count()) > 0) {
        pwdSelector = selector
        break
      }
    }
    if (!pwdSelector || (await page.locator(pwdSelector).count()) === 0) {
      console.log('[auth] Could not find password field')
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

export async function newAuthContext(browser: Browser, storageState: string | null): Promise<BrowserContext> {
  if (storageState) {
    try {
      return await browser.newContext({ storageState: JSON.parse(storageState) })
    } catch {
      return await browser.newContext()
    }
  }
  return await browser.newContext()
}
