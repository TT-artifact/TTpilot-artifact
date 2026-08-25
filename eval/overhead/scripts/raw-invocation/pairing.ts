import { createHash } from 'crypto'
import type { CacheCondition, Version } from './types'

export interface RunOrder {
  runId: number
  order: [Version, Version]
}

export function balancedCrossoverOrder(repeat: number): RunOrder[] {
  const out: RunOrder[] = []
  for (let i = 1; i <= repeat; i++) {
    out.push({ runId: i, order: i % 2 === 1 ? ['original', 'patched'] : ['patched', 'original'] })
  }
  return out
}

export function urlHash(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 12)
}

function escapeIdField(field: string): string {
  return field.replace(/\|/g, '\\|')
}

export function buildNavigationId(
  application: string,
  urlHashValue: string,
  version: Version,
  cacheCondition: CacheCondition,
  runId: number
): string {
  return [application, urlHashValue, version, cacheCondition, String(runId)].map(escapeIdField).join('|')
}

export function buildPairId(
  application: string,
  urlHashValue: string,
  cacheCondition: CacheCondition,
  runId: number
): string {
  return [application, urlHashValue, cacheCondition, String(runId)].map(escapeIdField).join('|')
}
