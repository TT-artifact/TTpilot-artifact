import type { Page, Frame } from '@playwright/test'
import type { CallRecord, RawCallRecord } from './types'
import { RAW_CALLS_GLOBAL, RECORDS_DROPPED_GLOBAL } from './browser-instrumentation'
import { classifyMeasurementWindow } from './window-classifier'

export interface NavigationTiming {
  dcl_us: number
  load_us: number
  load_event_end_us: number
}

export async function readNavigationTiming(page: Page): Promise<NavigationTiming> {
  return page.evaluate((): NavigationTiming => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    if (nav) {
      return {
        dcl_us: nav.domContentLoadedEventEnd * 1000,
        load_us: nav.loadEventEnd * 1000,
        load_event_end_us: nav.loadEventEnd * 1000,
      }
    }
    const t = window.performance.timing
    return {
      dcl_us: (t.domContentLoadedEventEnd - t.navigationStart) * 1000,
      load_us: (t.loadEventEnd - t.navigationStart) * 1000,
      load_event_end_us: (t.loadEventEnd - t.navigationStart) * 1000,
    }
  })
}

interface FrameRawCalls {
  calls: RawCallRecord[]
  dropped: number
}

async function readFrameRawCalls(frame: Page | Frame): Promise<FrameRawCalls> {
  return frame.evaluate(
    ([callsKey, droppedKey]: [string, string]): FrameRawCalls => ({
      calls: (window as any)[callsKey] || [],
      dropped: (window as any)[droppedKey] || 0,
    }),
    [RAW_CALLS_GLOBAL, RECORDS_DROPPED_GLOBAL] as [string, string]
  )
}

export interface CollectedCalls {
  calls: CallRecord[]
  recordsDropped: number
  frameCount: number

  frameErrors: string[]
}

export async function collectCalls(page: Page, navigationId: string, loadEventEndUs: number): Promise<CollectedCalls> {
  const frames = page.frames()
  const mainFrame = page.mainFrame()
  const allCalls: CallRecord[] = []
  let recordsDropped = 0
  const frameErrors: string[] = []

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]
    const frameId = frame === mainFrame ? 'main' : `frame-${i}`
    let frameData: FrameRawCalls
    try {
      frameData = await readFrameRawCalls(frame)
    } catch (e) {
      frameErrors.push(`${frameId}: ${(e as Error).message}`)
      continue
    }
    recordsDropped += frameData.dropped
    for (const raw of frameData.calls) {
      allCalls.push({
        ...raw,
        navigation_id: navigationId,
        frame_id: frameId,
        measurement_window: classifyMeasurementWindow(raw.start_time_us, raw.end_time_us, loadEventEndUs),
      })
    }
  }

  return { calls: allCalls, recordsDropped, frameCount: frames.length, frameErrors }
}
