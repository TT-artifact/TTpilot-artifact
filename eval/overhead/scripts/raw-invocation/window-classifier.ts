import type { MeasurementWindow } from './types'

export function classifyMeasurementWindow(
  startUs: number,
  endUs: number,
  loadEventEndUs: number
): MeasurementWindow {
  if (startUs < loadEventEndUs && endUs > loadEventEndUs) return 'crosses_load_boundary'
  if (startUs >= loadEventEndUs) return 'post_load'
  return 'page_load'
}
