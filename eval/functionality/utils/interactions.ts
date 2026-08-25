import { Page } from '@playwright/test'

export type Action =
  | { type: 'navigate'; url: string }
  | { type: 'click'; selector: string; description: string }
  | { type: 'fill'; selector: string; value: string; description: string }
  | { type: 'select'; selector: string; value: string; description: string }
  | { type: 'submit'; selector: string; description: string }
  | { type: 'snapshot'; description: string }

export const BENIGN_VALUES: Record<string, string> = {
  email: 'test@example.com',
  password: 'TestPass123!',
  text: 'sample input',
  search: 'test query',
  tel: '010-1234-5678',
  url: 'https://example.com',
  number: '42',
  date: '2026-05-08',
  default: 'test',
}

export function getBenignValue(inputType: string): string {
  return BENIGN_VALUES[inputType.toLowerCase()] || BENIGN_VALUES.default
}

export async function playAction(
  page: Page,
  action: Action,
  baseUrl: string,
  opts: { filterTtNoise?: boolean } = {}
): Promise<void> {
  switch (action.type) {
    case 'navigate':
      let url = action.url

      if (url.startsWith('http://') || url.startsWith('https://')) {
        const actionUrlObj = new URL(action.url)
        const baseUrlObj = new URL(baseUrl)
        actionUrlObj.host = baseUrlObj.host
        url = actionUrlObj.toString()
      } else {

        url = new URL(action.url, baseUrl).toString()
      }

      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
      break

    case 'click':
      await page
        .locator(action.selector)
        .first()
        .click({ timeout: 5000 })
        .catch(() => {})
      break

    case 'fill':
      await page
        .locator(action.selector)
        .first()
        .fill(action.value, { timeout: 5000 })
        .catch(() => {})
      break

    case 'select':
      await page
        .locator(action.selector)
        .first()
        .selectOption(action.value, { timeout: 5000 })
        .catch(() => {})
      break

    case 'submit':
      await page
        .locator(action.selector)
        .first()
        .evaluate((f: HTMLFormElement) => f?.submit?.())
        .catch(() => {})
      break

    case 'snapshot':
      break
  }

  await page.waitForTimeout(500)
}

export function shouldCapture(action: Action): boolean {
  return (
    action.type === 'navigate' ||
    action.type === 'submit' ||
    action.type === 'snapshot'
  )
}
