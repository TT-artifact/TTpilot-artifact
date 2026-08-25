import { PageCapture } from './capture'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

export interface ComparisonResult {
  url: string
  actionJson: string
  hasRegression: boolean
  regressions: string[]
  statusCodes: { patched: number; unpatched: number }
  domTextSimilarity: number
  domStructureSimilarity: number
  domSimilarity: number
  consoleRegressions: string[]
  screenshotDiffRatio: number
  screenshotDiffBuffer: Buffer | null
  patchedScreenshot?: Buffer
  unpatchedScreenshot?: Buffer
  ttTriggeredCount: number
}

export function comparePageStates(
  patched: PageCapture,
  unpatched: PageCapture,
  description: string,
  actionIndex?: number
): ComparisonResult {
  const regressions: string[] = []

  if (unpatched.statusCode !== 0 && patched.statusCode !== unpatched.statusCode) {
    regressions.push(
      `HTTP status mismatch: patched=${patched.statusCode}, unpatched=${unpatched.statusCode}`
    )
  }

  const normalizedPatched = normalizeForComparison(patched.domText)
  const normalizedUnpatched = normalizeForComparison(unpatched.domText)
  const domTextSimilarity = calculateJaccardSimilarity(normalizedPatched, normalizedUnpatched)
  if (domTextSimilarity < 0.95) {
    regressions.push(`DOM text similarity too low: ${(domTextSimilarity * 100).toFixed(1)}%`)
  }

  const filteredPatchedStructure = filterPatchingArtifacts(patched.domStructure)
  const domStructureSimilarity = calculateJaccardSimilarity(filteredPatchedStructure, unpatched.domStructure)
  if (domStructureSimilarity < 0.95) {
    regressions.push(`DOM structure similarity too low: ${(domStructureSimilarity * 100).toFixed(1)}%`)
  }

  if (domTextSimilarity < 0.95 || domStructureSimilarity < 0.95) {
    const baseDebugDir = join(process.env.REGRESSION_RESULTS_DIR || 'results', 'debug')
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const actionPrefix = actionIndex !== undefined ? `action_${actionIndex}` : 'unknown'
    const filename = `${actionPrefix}-${timestamp}.txt`

    try {
      if (domTextSimilarity < 0.95) {
        const textDir = join(baseDebugDir, 'text')
        mkdirSync(textDir, { recursive: true })
        try {
          writeFileSync(join(textDir, `patched-${filename}`), patched.domText)
        } catch {}
        try {
          writeFileSync(join(textDir, `unpatched-${filename}`), unpatched.domText)
        } catch {}
        try {
          const diff = generateTextDiff(normalizeForComparison(patched.domText), normalizeForComparison(unpatched.domText))
          writeFileSync(join(textDir, `diff-${filename}`), diff)
        } catch {}
      }

      if (domStructureSimilarity < 0.95) {
        const structureDir = join(baseDebugDir, 'structure')
        mkdirSync(structureDir, { recursive: true })
        try {
          writeFileSync(join(structureDir, `patched-${filename}`), filteredPatchedStructure)
        } catch {}
        try {
          writeFileSync(join(structureDir, `unpatched-${filename}`), unpatched.domStructure)
        } catch {}
        try {
          const diff = generateTextDiff(filteredPatchedStructure, unpatched.domStructure)
          writeFileSync(join(structureDir, `diff-${filename}`), diff)
        } catch {}
      }
    } catch {
    }
  }

  const newErrors = findNewErrors(patched.consoleErrors, unpatched.consoleErrors)
  if (newErrors.length > 0) {
    regressions.push(`New console errors: ${newErrors.join('; ')}`)
  }

  const screenshotDiffResult = compareScreenshots(patched.screenshot, unpatched.screenshot)
  if (screenshotDiffResult.diffRatio > 0.05) {
    regressions.push(`Screenshot diff too high: ${(screenshotDiffResult.diffRatio * 100).toFixed(1)}%`)
  }

  return {
    url: patched.url || unpatched.url,
    actionJson: description,
    hasRegression: regressions.length > 0,
    regressions,
    statusCodes: { patched: patched.statusCode, unpatched: unpatched.statusCode },
    domTextSimilarity,
    domStructureSimilarity,
    domSimilarity: domStructureSimilarity,
    consoleRegressions: newErrors,
    screenshotDiffRatio: screenshotDiffResult.diffRatio,
    screenshotDiffBuffer: screenshotDiffResult.diffBuffer,
    patchedScreenshot: patched.screenshot && patched.screenshot.length > 0 ? patched.screenshot : undefined,
    unpatchedScreenshot: unpatched.screenshot && unpatched.screenshot.length > 0 ? unpatched.screenshot : undefined,
    ttTriggeredCount: patched.ttTriggered,
  }
}

function filterPatchingArtifacts(structure: string): string {
  let removedBase = false
  let removedScript = false
  return structure
    .split('\n')
    .filter(line => {
      const trimmed = line.trim()
      if (trimmed.endsWith('>head>base') && !removedBase) {
        removedBase = true
        return false
      }
      if (trimmed.endsWith('>head>script') && !removedScript) {
        removedScript = true
        return false
      }
      return true
    })
    .join('\n')
}

function normalizeForComparison(text: string): string {
  return text
    .replace(/localhost:\d+/g, '<LOCALHOST>')
    .replace(/\d{1,2}-[A-Za-z]{3}-\d{4}\s+\d{1,2}:\d{2}/g, '<DATETIME>')
    .replace(/\d{4}-\d{2}-\d{2}/g, '<DATE>')
    .replace(/\d{1,2}\/\d{1,2}\/\d{4}/g, '<DATE>')
    .replace(/\d{1,2}\.\d{1,2}\.\d{4}/g, '<DATE>')
    .replace(/\d{1,2}:\d{2}:\d{2}/g, '<TIME>')
    .replace(/\d{1,2}:\d{2}(?:\s*(?:AM|PM|am|pm))?/g, '<TIME>')
    .replace(/\d+(?:\.\d+)?\s*(?:milliseconds|ms)\b/gi, '<MS>')
    .replace(/\b\d{10,13}\b/g, '<TIMESTAMP>')
    .replace(/\b[a-f0-9]{8,40}\b/g, '<HASH>')
    .replace(/\d+\s+\d+(?=\s+\w)/g, '<SIZE>')
    .replace(/\d+/g, '<NUM>')
}

function calculateJaccardSimilarity(text1: string, text2: string): number {
  const freq = (text: string) => {
    const map = new Map<string, number>()
    for (const line of text.split('\n').filter((l) => l.trim())) {
      map.set(line, (map.get(line) ?? 0) + 1)
    }
    return map
  }

  const f1 = freq(text1)
  const f2 = freq(text2)
  const allKeys = new Set([...f1.keys(), ...f2.keys()])

  let intersection = 0
  let union = 0
  for (const k of allKeys) {
    const a = f1.get(k) ?? 0
    const b = f2.get(k) ?? 0
    intersection += Math.min(a, b)
    union += Math.max(a, b)
  }

  return union === 0 ? 1 : intersection / union
}

function normalizeError(msg: string): string {
  return msg
    .replace(/https?:\/\/[^\s]+/g, '<URL>')
    .replace(/:\d+:\d+/g, ':<LOC>')
    .toLowerCase()
}

function findNewErrors(pErrors: string[], uErrors: string[]): string[] {
  const normalizedUnpatched = new Set(uErrors.map(normalizeError))
  const newErrors = []

  for (const error of pErrors) {
    const normalized = normalizeError(error)
    if (!normalizedUnpatched.has(normalized)) {
      newErrors.push(error)
    }
  }

  return newErrors
}

function generateTextDiff(text1: string, text2: string): string {
  const lines1 = text1.split('\n')
  const lines2 = text2.split('\n')
  const maxLines = Math.max(lines1.length, lines2.length)
  const diffs: string[] = []

  for (let i = 0; i < maxLines; i++) {
    const line1 = lines1[i] ?? ''
    const line2 = lines2[i] ?? ''

    if (line1 === line2) {
      diffs.push(`  ${line1}`)
    } else {
      if (line1) diffs.push(`- ${line1}`)
      if (line2) diffs.push(`+ ${line2}`)
    }
  }

  return diffs.join('\n')
}

function compareScreenshots(
  buf1: Buffer,
  buf2: Buffer
): { diffRatio: number; diffBuffer: Buffer | null } {
  if (buf1.length === 0 || buf2.length === 0) {
    return { diffRatio: 0, diffBuffer: null }
  }

  try {
    const img1 = PNG.sync.read(buf1)
    const img2 = PNG.sync.read(buf2)

    const w = Math.min(img1.width, img2.width)
    const h = Math.min(img1.height, img2.height)

    const diff = new PNG({ width: w, height: h })
    const numPixels = pixelmatch(img1.data, img2.data, diff.data, w, h, {
      threshold: 0.1,
    })

    const diffRatio = numPixels / (w * h)

    return {
      diffRatio,
      diffBuffer: PNG.sync.write(diff),
    }
  } catch (error) {
    return { diffRatio: 0, diffBuffer: null }
  }
}
