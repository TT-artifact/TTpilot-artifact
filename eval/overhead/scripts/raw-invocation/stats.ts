import type { Stats } from './types'

export function computeStats(values: number[]): Stats {
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
