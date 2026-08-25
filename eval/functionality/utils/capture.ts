import { Page } from '@playwright/test'

export interface NetworkRequest {
  url: string
  method: string
  statusCode: number
  resourceType: string
}

export interface PageCapture {
  url: string
  statusCode: number
  domText: string
  domStructure: string
  consoleErrors: string[]
  ttTriggered: number
  screenshot: Buffer
  loadTimeMs: number
  rawHtml: string
  networkRequests: NetworkRequest[]
}

const TT_CONSOLE_PATTERNS = [
  /Refused to create a TrustedHTML/i,
  /Refused to set a TrustedScript/i,
  /Refused to set a TrustedScriptURL/i,
  /require-trusted-types/i,
  /tt-bootstrap\.js/i,
  /TrustedTypes/i,
  /Refused to create.*trusted/i,
]

function isTtNoise(message: string): boolean {
  return TT_CONSOLE_PATTERNS.some((pattern) => pattern.test(message))
}

function filterTtNoise(errors: string[]): string[] {
  return errors.filter((msg) => !isTtNoise(msg))
}

interface ListenerState {
  statusCode: number
  ttTriggered: number
  originalHtml: string
}

export interface PageListeners {
  consoleHandler: (msg: any) => void
  responseHandler: (response: any) => void
  errors: string[]
  networkRequests: NetworkRequest[]
  state: ListenerState
  startTime: number
}

export function setupPageListeners(page: Page): PageListeners {
  const errors: string[] = []
  const networkRequests: NetworkRequest[] = []
  const state: ListenerState = { statusCode: 0, ttTriggered: 0, originalHtml: '' }
  const startTime = Date.now()

  const consoleHandler = (msg: any) => {
    if (msg.type() === 'error') {
      const text = msg.text()
      errors.push(text)

      if (isTtNoise(text)) {
        state.ttTriggered++
      }
    }
  }

  const responseHandler = async (response: any) => {
    const request = response.request()
    const resourceType = request.resourceType()

    if (resourceType === 'document' && state.statusCode === 0) {
      state.statusCode = response.status()

      try {
        state.originalHtml = await response.text()
      } catch (_) {

      }
    }

    networkRequests.push({
      url: request.url(),
      method: request.method(),
      statusCode: response.status(),
      resourceType,
    })
  }

  page.on('console', consoleHandler)
  page.on('response', responseHandler)

  return {
    consoleHandler,
    responseHandler,
    errors,
    networkRequests,
    state,
    startTime,
  }
}

async function extractDomStructure(page: Page): Promise<string> {
  return await page
    .evaluate(() => {
      const DYNAMIC_CLASS_RE = /^(tt-|js-|is-|has-|ng-|v-|react-)|^__|\d{5,}/
      const SKIP_CHILDREN = new Set(['script', 'style', 'noscript', 'template'])
      const MAX_DEPTH = 20
      const lines: string[] = []

      function walk(el: Element, parentPath: string, depth: number) {
        if (depth > MAX_DEPTH) return
        const tag = el.tagName.toLowerCase()
        const stableClasses = Array.from(el.classList)
          .filter((cls) => !DYNAMIC_CLASS_RE.test(cls))
          .sort()
          .join('.')
        const segment = tag + (stableClasses ? '.' + stableClasses : '')
        const currentPath = parentPath ? `${parentPath}>${segment}` : segment
        lines.push(currentPath)
        if (!SKIP_CHILDREN.has(tag)) {
          for (const child of Array.from(el.children)) {
            walk(child, currentPath, depth + 1)
          }
        }
      }

      const root = document.documentElement
      if (root) walk(root, '', 0)
      return lines.join('\n')
    })
    .catch(() => '')
}

export async function capturePageState(
  page: Page,
  listeners: PageListeners,
  opts: { filterTtNoise?: boolean } = {}
): Promise<PageCapture> {
  const { consoleHandler, responseHandler, errors, state, startTime, networkRequests } = listeners

  await page.waitForTimeout(2000)

  page.off('console', consoleHandler)
  page.off('response', responseHandler)

  const url = page.url()
  const domText = await page
    .evaluate(() => document.body?.innerText || '')
    .catch(() => '')
  const domStructure = await extractDomStructure(page)

  let rawHtml = state.originalHtml
  if (!rawHtml) {
    rawHtml = await page
      .content()
      .catch(() => '')
  }

  const screenshot = await page
    .screenshot({ fullPage: true })
    .catch(() => Buffer.alloc(0))

  const loadTimeMs = Date.now() - startTime

  const processedErrors = opts.filterTtNoise ? filterTtNoise(errors) : errors

  return {
    url,
    statusCode: state.statusCode || 200,
    domText: normalizeText(domText),
    domStructure,
    consoleErrors: processedErrors,
    ttTriggered: state.ttTriggered,
    screenshot,
    loadTimeMs,
    rawHtml,
    networkRequests,
  }
}

export function normalizeText(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n')
}
