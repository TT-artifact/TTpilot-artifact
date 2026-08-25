import type { Browser } from '@playwright/test'
import type { BaselineRow, Stats } from './types'
import { computeStats } from './stats'

const BASELINE_ITERATIONS = 5000

const BASELINE_SCRIPT = `(function() {
  function nowUs() { return performance.now() * 1000; }
  var N = ${BASELINE_ITERATIONS};
  var results = {};

  function bench(name, fn) {
    var samples = [];
    for (var i = 0; i < N; i++) {
      var t0 = nowUs();
      fn(i);
      var t1 = nowUs();
      samples.push(t1 - t0);
    }
    results[name] = samples;
  }

  bench('performance_now_pair', function() { nowUs(); });

  function noop() {}
  function callWithTryFinally(fn) {
    try { fn(); } finally {}
  }
  bench('enter_exit_call', function() { callWithTryFinally(noop); });

  var arr = [];
  bench('array_record_push', function(i) { arr.push({ a: i, b: 'x', c: true }); });

  var wm = new WeakMap();
  bench('weakmap_set_get', function() {
    var key = {};
    wm.set(key, { v: 1 });
    wm.get(key);
  });

  var stack1 = [];
  var recorded1 = [];
  function emptyWrappedSink() {
    var frame = { start_time_us: nowUs(), childInclusiveSum: 0 };
    stack1.push(frame);
    try {

    } finally {
      frame.end_time_us = nowUs();
      frame.inclusive_cost_us = frame.end_time_us - frame.start_time_us;
      stack1.pop();
      frame.exclusive_cost_us = frame.inclusive_cost_us - frame.childInclusiveSum;
      recorded1.push(frame);
    }
  }
  bench('empty_sink_wrapper', emptyWrappedSink);

  var stack2 = [];
  function nestedStackBookkeeping() {
    var outer = { start_time_us: nowUs(), childInclusiveSum: 0 };
    stack2.push(outer);
    try {
      var inner = { start_time_us: nowUs(), childInclusiveSum: 0 };
      stack2.push(inner);
      try {

      } finally {
        inner.end_time_us = nowUs();
        inner.inclusive_cost_us = inner.end_time_us - inner.start_time_us;
        stack2.pop();
        outer.childInclusiveSum += inner.inclusive_cost_us;
      }
    } finally {
      outer.end_time_us = nowUs();
      outer.inclusive_cost_us = outer.end_time_us - outer.start_time_us;
      stack2.pop();
      outer.exclusive_cost_us = outer.inclusive_cost_us - outer.childInclusiveSum;
    }
  }
  bench('nested_stack_bookkeeping', nestedStackBookkeeping);

  var sampleRecord = {
    call_id: 1, call_type: 'sink', sink_type: 'innerHTML', policy_name: '',
    parent_call_id: null, call_depth: 0, inside_policy_handler: false,
    start_time_us: 1.234, end_time_us: 2.345, inclusive_cost_us: 1.111,
    exclusive_cost_us: 1.111, completed: true, threw: false, error_name: ''
  };
  bench('json_serialization', function() { JSON.stringify(sampleRecord); });

  window.__ttBaselineResults = results;
})();`

export async function measureBaseline(browser: Browser): Promise<BaselineRow[]> {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.setContent('<!doctype html><html><body></body></html>')
  await page.evaluate(BASELINE_SCRIPT)
  const results = await page.evaluate((): Record<string, number[]> => (window as any).__ttBaselineResults || {})
  await context.close()

  return Object.entries(results).map(([operation, samples]) => ({
    operation,
    stats: computeStats(samples) as Stats,
  }))
}
