export const RAW_CALLS_GLOBAL = '__ttRawCalls'
export const RECORDS_DROPPED_GLOBAL = '__ttRecordsDropped'

const DEFAULT_MAX_RECORDS = 20000

export function buildInstrumentationScript(maxRecords: number = DEFAULT_MAX_RECORDS): string {
  return `(function() {
  var MAX_RECORDS = ${maxRecords};
  var MAX_STRING_LENGTH = 200;

  window.${RAW_CALLS_GLOBAL} = [];
  window.${RECORDS_DROPPED_GLOBAL} = 0;

  var nextCallId = 1;
  var stack = [];

  function truncate(str) {
    if (typeof str !== 'string') return '';
    return str.length > MAX_STRING_LENGTH ? str.slice(0, MAX_STRING_LENGTH) : str;
  }

  function recordCall(frame) {
    if (window.${RAW_CALLS_GLOBAL}.length >= MAX_RECORDS) {
      window.${RECORDS_DROPPED_GLOBAL}++;
      return;
    }
    window.${RAW_CALLS_GLOBAL}.push({
      call_id: frame.call_id,
      call_type: frame.call_type,
      sink_type: frame.sink_type,
      policy_name: frame.policy_name,
      parent_call_id: frame.parent_call_id,
      call_depth: frame.call_depth,
      inside_policy_handler: frame.inside_policy_handler,
      start_time_us: frame.start_time_us,
      end_time_us: frame.end_time_us,
      inclusive_cost_us: frame.inclusive_cost_us,
      exclusive_cost_us: frame.exclusive_cost_us,
      completed: frame.completed,
      threw: frame.threw,
      error_name: frame.error_name
    });
  }

  function wrapCall(fn, callType, meta) {
    var sinkType = (meta && meta.sink_type) || '';
    var policyName = (meta && meta.policy_name) || '';
    return function() {
      var parent = stack.length > 0 ? stack[stack.length - 1] : null;
      var insidePolicyHandler = false;
      for (var i = 0; i < stack.length; i++) {
        if (stack[i].call_type === 'policy_handler') { insidePolicyHandler = true; break; }
      }
      var frame = {
        call_id: nextCallId++,
        call_type: callType,
        sink_type: sinkType,
        policy_name: policyName,
        parent_call_id: parent ? parent.call_id : null,
        call_depth: stack.length,
        inside_policy_handler: insidePolicyHandler,
        start_time_us: performance.now() * 1000,
        end_time_us: 0,
        inclusive_cost_us: 0,
        exclusive_cost_us: 0,
        completed: false,
        threw: false,
        error_name: '',
        childInclusiveSum: 0
      };
      stack.push(frame);
      try {
        var result = fn.apply(this, arguments);
        frame.completed = true;
        return result;
      } catch (e) {
        frame.threw = true;
        frame.error_name = truncate((e && e.name) || 'Error');
        throw e;
      } finally {
        frame.end_time_us = performance.now() * 1000;
        frame.inclusive_cost_us = frame.end_time_us - frame.start_time_us;
        stack.pop();
        if (stack.length > 0) {
          stack[stack.length - 1].childInclusiveSum += frame.inclusive_cost_us;
        }
        frame.exclusive_cost_us = frame.inclusive_cost_us - frame.childInclusiveSum;
        recordCall(frame);
      }
    };
  }

  function hookSetter(proto, prop, sinkType) {
    var desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (!desc || !desc.set) return;
    var wrapped = wrapCall(desc.set, 'sink', { sink_type: sinkType });
    Object.defineProperty(proto, prop, Object.assign({}, desc, { set: wrapped }));
  }

  hookSetter(Element.prototype, 'innerHTML', 'innerHTML');
  hookSetter(Element.prototype, 'outerHTML', 'outerHTML');
  hookSetter(HTMLIFrameElement.prototype, 'srcdoc', 'iframe.srcdoc');
  hookSetter(HTMLScriptElement.prototype, 'text', 'script.text');
  hookSetter(HTMLScriptElement.prototype, 'src', 'script.src');

  Element.prototype.insertAdjacentHTML = wrapCall(Element.prototype.insertAdjacentHTML, 'sink', { sink_type: 'insertAdjacentHTML' });
  Document.prototype.write = wrapCall(Document.prototype.write, 'sink', { sink_type: 'document.write' });
  Document.prototype.writeln = wrapCall(Document.prototype.writeln, 'sink', { sink_type: 'document.writeln' });
  DOMParser.prototype.parseFromString = wrapCall(DOMParser.prototype.parseFromString, 'sink', { sink_type: 'domParser.parseFromString' });
  Range.prototype.createContextualFragment = wrapCall(Range.prototype.createContextualFragment, 'sink', { sink_type: 'range.createContextualFragment' });

  var origWindowOpen = window.open;
  window.open = wrapCall(function() {
    return origWindowOpen.apply(window, arguments);
  }, 'sink', { sink_type: 'window.open' });

  (function() {
    var _jQuery;
    var existing = Object.getOwnPropertyDescriptor(window, 'jQuery');
    if (existing && !existing.configurable) return;
    try {
      Object.defineProperty(window, 'jQuery', {
        configurable: true,
        enumerable: true,
        get: function() { return _jQuery; },
        set: function(v) {
          if (v && v.fn && typeof v.fn.append === 'function' && !v.fn.append.__ttWrapped) {
            var wrapped = wrapCall(v.fn.append, 'sink', { sink_type: 'jquery.append' });
            wrapped.__ttWrapped = true;
            v.fn.append = wrapped;
          }
          _jQuery = v;
        }
      });
    } catch (_) {}
  })();

  var origSetTimeout = window.setTimeout;
  window.setTimeout = function(fn) {
    if (typeof fn === 'string') {
      return wrapCall(origSetTimeout, 'sink', { sink_type: 'setTimeout' }).apply(window, arguments);
    }
    return origSetTimeout.apply(window, arguments);
  };

  var origSetInterval = window.setInterval;
  window.setInterval = function(fn) {
    if (typeof fn === 'string') {
      return wrapCall(origSetInterval, 'sink', { sink_type: 'setInterval' }).apply(window, arguments);
    }
    return origSetInterval.apply(window, arguments);
  };

  if (window.trustedTypes && trustedTypes.createPolicy) {
    var origCreate = trustedTypes.createPolicy.bind(trustedTypes);
    try {
      Object.defineProperty(trustedTypes, 'createPolicy', {
        configurable: true, writable: true,
        value: function(name, rules) {
          var wrappedRules = {};
          var keys = Object.keys(rules || {});
          for (var k = 0; k < keys.length; k++) {
            (function(key) {
              wrappedRules[key] = wrapCall(rules[key], 'policy_handler', { policy_name: name });
            })(keys[k]);
          }
          var realPolicy = origCreate(name, wrappedRules);
          var methodNames = ['createHTML', 'createScript', 'createScriptURL'];
          for (var m = 0; m < methodNames.length; m++) {
            (function(methodName) {
              if (typeof realPolicy[methodName] !== 'function') return;
              var origMethod = realPolicy[methodName].bind(realPolicy);
              try {
                Object.defineProperty(realPolicy, methodName, {
                  configurable: true, writable: true, enumerable: false,
                  value: wrapCall(origMethod, 'policy_method', { policy_name: name })
                });
              } catch (_) {}
            })(methodNames[m]);
          }
          return realPolicy;
        }
      });
    } catch (_) {}
  }
})();`
}
