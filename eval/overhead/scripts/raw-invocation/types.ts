export type Version = 'original' | 'patched'
export type CacheCondition = 'cold' | 'warm' | 'warm_cold'
export type CallType = 'policy_method' | 'policy_handler' | 'sink'
export type MeasurementWindow = 'page_load' | 'post_load' | 'crosses_load_boundary'

export interface NavigationRecord {
  application: string
  url: string
  version: Version
  cache_condition: CacheCondition
  run_id: number
  navigation_id: string
  pair_id: string
  measurement_order: number
  frame_count: number
  dcl_us: number
  load_us: number
  load_event_end_us: number
  completed: boolean
  error: string
}

export interface RawCallRecord {
  call_id: number
  call_type: CallType
  sink_type: string
  policy_name: string
  parent_call_id: number | null
  call_depth: number
  inside_policy_handler: boolean
  start_time_us: number
  end_time_us: number
  inclusive_cost_us: number
  exclusive_cost_us: number
  completed: boolean
  threw: boolean
  error_name: string
}

export interface CallRecord extends RawCallRecord {
  navigation_id: string
  frame_id: string
  measurement_window: MeasurementWindow
}

export interface Stats {
  count: number
  mean: number
  median: number
  p95: number
  stddev: number
}

export interface BaselineRow {
  operation: string
  stats: Stats
}
