'use strict';

function w(ttCallback, argCode, policyName, sinkCode, observationMode) {
  const meta = sinkCode != null ? `, ${JSON.stringify(sinkCode)}` : '';

  const mode = observationMode != null ? `, undefined, ${JSON.stringify(observationMode)}` : '';
  return `${policyName}.${ttCallback}(${argCode}${meta}${mode})`;
}

const HTML_ENTITY_PATTERN = /&(?:lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/;

const REFACTOR_TEMPLATES = {

  'element.innerHTML': {
    TYPE1: ({ argCode, receiverCode }) => HTML_ENTITY_PATTERN.test(argCode)
      ? `${receiverCode}.textContent = new DOMParser().parseFromString(${argCode}, 'text/html').body.textContent`
      : `${receiverCode}.textContent = ${argCode}`,
    default: ({ argCode, receiverCode, policyName, sinkCode, observationMode }) => `${receiverCode}.innerHTML = ${w('createHTML', argCode, policyName, sinkCode, observationMode)}`,
  },

  'element.outerHTML': {
    TYPE1:   ({ argCode, receiverCode })             => `${receiverCode}.replaceWith(${argCode})`,
    default: ({ argCode, receiverCode, policyName, sinkCode, observationMode }) => `${receiverCode}.outerHTML = ${w('createHTML', argCode, policyName, sinkCode, observationMode)}`,
  },

  'iframe.srcdoc': {
    default: ({ argCode, receiverCode, policyName, sinkCode, observationMode }) => `${receiverCode}.srcdoc = ${w('createHTML', argCode, policyName, sinkCode, observationMode)}`,
  },

  'element.insertAdjacentHTML': {
    TYPE1:   ({ argCode, receiverCode, extraArgs })  => `${receiverCode}.insertAdjacentText(${extraArgs[0]}, ${argCode})`,
    default: ({ argCode, receiverCode, policyName, extraArgs, sinkCode, observationMode }) => `${receiverCode}.insertAdjacentHTML(${extraArgs[0]}, ${w('createHTML', argCode, policyName, sinkCode, observationMode)})`,
  },

  'element.setHTMLUnsafe': {
    TYPE1:   ({ argCode, receiverCode })             => `${receiverCode}.setHTML(${argCode})`,
    default: ({ argCode, receiverCode, policyName, sinkCode, observationMode }) => `${receiverCode}.setHTMLUnsafe(${w('createHTML', argCode, policyName, sinkCode, observationMode)})`,
  },

  'shadowRoot.setHTMLUnsafe': {
    TYPE1:   ({ argCode, receiverCode })             => `${receiverCode}.setHTML(${argCode})`,
    default: ({ argCode, receiverCode, policyName, sinkCode, observationMode }) => `${receiverCode}.setHTMLUnsafe(${w('createHTML', argCode, policyName, sinkCode, observationMode)})`,
  },

  'document.write': {
    default: ({ argCode, policyName, sinkCode, observationMode })      => `document.write(${w('createHTML', argCode, policyName, sinkCode, observationMode)})`,
  },

  'document.writeln': {
    default: ({ argCode, policyName, sinkCode, observationMode })      => `document.writeln(${w('createHTML', argCode, policyName, sinkCode, observationMode)})`,
  },

  'document.parseHTMLUnsafe': {
    default: ({ argCode, policyName, sinkCode, observationMode })      => `Document.parseHTMLUnsafe(${w('createHTML', argCode, policyName, sinkCode, observationMode)})`,
  },

  'domParser.parseFromString': {
    default: ({ argCode, receiverCode, policyName, sinkCode, observationMode }) => `${receiverCode}.parseFromString(${w('createHTML', argCode, policyName, sinkCode, observationMode)}, 'text/html')`,
  },

  'range.createContextualFragment': {
    TYPE1:   ({ argCode })                           => `(() => { const f = new DocumentFragment(); f.append(${argCode}); return f; })()`,
    default: ({ argCode, receiverCode, policyName, sinkCode, observationMode }) => `${receiverCode}.createContextualFragment(${w('createHTML', argCode, policyName, sinkCode, observationMode)})`,
  },

  'react.dangerouslySetInnerHTML': {
    TYPE1:   ({ argCode })                           => `children={${argCode}}`,
    default: ({ argCode, policyName, sinkCode, observationMode })      => `dangerouslySetInnerHTML={{ __html: ${w('createHTML', argCode, policyName, sinkCode, observationMode)} }}`,
  },

  'jquery.html': {
    default: ({ argCode, receiverCode, policyName, sinkCode, observationMode }) => `${receiverCode}.html(${w('createHTML', argCode, policyName, sinkCode, observationMode)})`,
  },

  'jquery.append': {
    default: ({ argCode, receiverCode, policyName, sinkCode, observationMode }) => `${receiverCode}.append(${w('createHTML', argCode, policyName, sinkCode, observationMode)})`,
  },

  'jquery.prepend': {
    default: ({ argCode, receiverCode, policyName, sinkCode, observationMode }) => `${receiverCode}.prepend(${w('createHTML', argCode, policyName, sinkCode, observationMode)})`,
  },

  'jquery.after': {
    default: ({ argCode, receiverCode, policyName, sinkCode, observationMode }) => `${receiverCode}.after(${w('createHTML', argCode, policyName, sinkCode, observationMode)})`,
  },

  'jquery.before': {
    default: ({ argCode, receiverCode, policyName, sinkCode, observationMode }) => `${receiverCode}.before(${w('createHTML', argCode, policyName, sinkCode, observationMode)})`,
  },

  'jquery.replaceWith': {
    default: ({ argCode, receiverCode, policyName, sinkCode, observationMode }) => `${receiverCode}.replaceWith(${w('createHTML', argCode, policyName, sinkCode, observationMode)})`,
  },

  'jquery.wrap': {
    default: ({ argCode, receiverCode, policyName, sinkCode, observationMode }) => `${receiverCode}.wrap(${w('createHTML', argCode, policyName, sinkCode, observationMode)})`,
  },

  'jquery.wrapAll': {
    default: ({ argCode, receiverCode, policyName, sinkCode, observationMode }) => `${receiverCode}.wrapAll(${w('createHTML', argCode, policyName, sinkCode, observationMode)})`,
  },

  'jquery.wrapInner': {
    default: ({ argCode, receiverCode, policyName, sinkCode, observationMode }) => `${receiverCode}.wrapInner(${w('createHTML', argCode, policyName, sinkCode, observationMode)})`,
  },

  'document.execCommand.insertHTML': {
    default: ({ argCode, receiverCode, policyName, extraArgs, sinkCode, observationMode }) => `${receiverCode}.execCommand('insertHTML', ${extraArgs[0]}, ${w('createHTML', argCode, policyName, sinkCode, observationMode)})`,
  },

  'iframe.setAttribute.srcdoc': {
    default: ({ argCode, receiverCode, policyName, sinkCode, observationMode }) => `${receiverCode}.setAttribute('srcdoc', ${w('createHTML', argCode, policyName, sinkCode, observationMode)})`,
  },

  'iframe.setAttributeNS.srcdoc': {
    default: ({ argCode, receiverCode, policyName, extraArgs, sinkCode, observationMode }) => `${receiverCode}.setAttributeNS(${extraArgs[0]}, 'srcdoc', ${w('createHTML', argCode, policyName, sinkCode, observationMode)})`,
  },

  'eval': {

    default: ({ argCode, policyName, sinkCode, observationMode })      => `(eval(${w('createScript', argCode, policyName, sinkCode, observationMode)}))`,
  },

  'eval.call': {
    default: ({ argCode, policyName, sinkCode, extraArgs, observationMode }) =>
      `(eval.call(${extraArgs[0] ?? 'undefined'}, ${w('createScript', argCode, policyName, sinkCode, observationMode)}))`,
  },

  'eval.apply': {
    default: ({ argCode, policyName, sinkCode, extraArgs, observationMode }) =>
      `(eval.apply(${extraArgs[0] ?? 'undefined'}, [${w('createScript', argCode, policyName, sinkCode, observationMode)}]))`,
  },

  'setTimeout.string': {

    default: ({ argCode, policyName, extraArgs, sinkCode, observationMode }) => `(setTimeout(${w('createScript', argCode, policyName, sinkCode, observationMode)}${extraArgs.length ? ', ' + extraArgs.join(', ') : ''}))`,
  },

  'setInterval.string': {

    default: ({ argCode, policyName, extraArgs, sinkCode, observationMode }) => `(setInterval(${w('createScript', argCode, policyName, sinkCode, observationMode)}${extraArgs.length ? ', ' + extraArgs.join(', ') : ''}))`,
  },

  'location.href.javascript': {
    default: ({ argCode, policyName, sinkCode, observationMode })      => `location.href = ${w('createScript', argCode, policyName, sinkCode, observationMode)}`,
  },

  'location.assign.javascript': {
    default: ({ argCode, policyName, sinkCode, observationMode })      => `location.assign(${w('createScript', argCode, policyName, sinkCode, observationMode)})`,
  },

  'location.replace.javascript': {
    default: ({ argCode, policyName, sinkCode, observationMode })      => `location.replace(${w('createScript', argCode, policyName, sinkCode, observationMode)})`,
  },

  'window.open.javascript': {
    default: ({ argCode, policyName, extraArgs, sinkCode, observationMode }) => `window.open(${w('createScript', argCode, policyName, sinkCode, observationMode)}${extraArgs.length ? ', ' + extraArgs.join(', ') : ''})`,
  },

  'Function.ctor': {
    default: ({ argCode, policyName, extraArgs, sinkCode, observationMode }) => `(new Function(${[...extraArgs, w('createScript', argCode, policyName, sinkCode, observationMode)].join(', ')}))`,
  },

  'AsyncFunction.ctor': {
    default: ({ argCode, policyName, extraArgs, sinkCode, observationMode }) => `(new AsyncFunction(${[...extraArgs, w('createScript', argCode, policyName, sinkCode, observationMode)].join(', ')}))`,
  },

  'GeneratorFunction.ctor': {
    default: ({ argCode, policyName, extraArgs, sinkCode, observationMode }) => `(new GeneratorFunction(${[...extraArgs, w('createScript', argCode, policyName, sinkCode, observationMode)].join(', ')}))`,
  },

  'AsyncGeneratorFunction.ctor': {
    default: ({ argCode, policyName, extraArgs, sinkCode, observationMode }) => `(new AsyncGeneratorFunction(${[...extraArgs, w('createScript', argCode, policyName, sinkCode, observationMode)].join(', ')}))`,
  },

  'script.text': {
    default: ({ argCode, receiverCode, policyName, sinkCode, observationMode }) => `${receiverCode}.text = ${w('createScript', argCode, policyName, sinkCode, observationMode)}`,
  },

  'script.textContent': {
    default: ({ argCode, receiverCode, policyName, sinkCode, observationMode }) => `${receiverCode}.textContent = ${w('createScript', argCode, policyName, sinkCode, observationMode)}`,
  },

  'script.innerText': {
    default: ({ argCode, receiverCode, policyName, sinkCode, observationMode }) => `${receiverCode}.innerText = ${w('createScript', argCode, policyName, sinkCode, observationMode)}`,
  },

  'element.setAttribute.onEvent': {
    default: ({ argCode, receiverCode, policyName, extraArgs, sinkCode, observationMode }) => `${receiverCode}.setAttribute(${extraArgs[0]}, ${w('createScript', argCode, policyName, sinkCode, observationMode)})`,
  },

  'element.setAttributeNS.onEvent': {
    default: ({ argCode, receiverCode, policyName, extraArgs, sinkCode, observationMode }) => `${receiverCode}.setAttributeNS(${extraArgs[0]}, ${extraArgs[1]}, ${w('createScript', argCode, policyName, sinkCode, observationMode)})`,
  },

  'script.src': {
    default: ({ argCode, receiverCode, policyName, sinkCode, observationMode }) => `${receiverCode}.src = ${w('createScriptURL', argCode, policyName, sinkCode, observationMode)}`,
  },

  'svgScript.href': {
    default: ({ argCode, receiverCode, policyName, sinkCode, observationMode }) => `${receiverCode}.href = ${w('createScriptURL', argCode, policyName, sinkCode, observationMode)}`,
  },

  'svgScript.baseVal': {
    default: ({ argCode, receiverCode, policyName, sinkCode, observationMode }) => `${receiverCode}.baseVal = ${w('createScriptURL', argCode, policyName, sinkCode, observationMode)}`,
  },

  'Worker.ctor': {
    default: ({ argCode, policyName, extraArgs, sinkCode, observationMode }) => `new Worker(${w('createScriptURL', argCode, policyName, sinkCode, observationMode)}${extraArgs.length ? ', ' + extraArgs.join(', ') : ''})`,
  },

  'SharedWorker.ctor': {
    default: ({ argCode, policyName, extraArgs, sinkCode, observationMode }) => `new SharedWorker(${w('createScriptURL', argCode, policyName, sinkCode, observationMode)}${extraArgs.length ? ', ' + extraArgs.join(', ') : ''})`,
  },

  'importScripts': {
    default: ({ argCode, policyName, sinkCode, observationMode })      => `importScripts(${w('createScriptURL', argCode, policyName, sinkCode, observationMode)})`,
  },

  'serviceWorker.register': {
    default: ({ argCode, policyName, extraArgs, sinkCode, observationMode }) => `navigator.serviceWorker.register(${w('createScriptURL', argCode, policyName, sinkCode, observationMode)}${extraArgs.length ? ', ' + extraArgs.join(', ') : ''})`,
  },

  'script.setAttribute.src': {
    default: ({ argCode, receiverCode, policyName, sinkCode, observationMode }) => `${receiverCode}.setAttribute('src', ${w('createScriptURL', argCode, policyName, sinkCode, observationMode)})`,
  },

  'script.setAttributeNS.src': {
    default: ({ argCode, receiverCode, policyName, extraArgs, sinkCode, observationMode }) => `${receiverCode}.setAttributeNS(${extraArgs[0]}, 'src', ${w('createScriptURL', argCode, policyName, sinkCode, observationMode)})`,
  },

  'svgScript.setAttribute.href': {
    default: ({ argCode, receiverCode, policyName, sinkCode, observationMode }) => `${receiverCode}.setAttribute('href', ${w('createScriptURL', argCode, policyName, sinkCode, observationMode)})`,
  },

  'svgScript.setAttributeNS.href': {
    default: ({ argCode, receiverCode, policyName, extraArgs, sinkCode, observationMode }) => `${receiverCode}.setAttributeNS(${extraArgs[0]}, 'href', ${w('createScriptURL', argCode, policyName, sinkCode, observationMode)})`,
  },

  'jquery.attr.src': {
    default: ({ argCode, receiverCode, policyName, sinkCode, observationMode }) => `${receiverCode}.attr('src', ${w('createScriptURL', argCode, policyName, sinkCode, observationMode)})`,
  },

  'jquery.prop.src': {
    default: ({ argCode, receiverCode, policyName, sinkCode, observationMode }) => `${receiverCode}.prop('src', ${w('createScriptURL', argCode, policyName, sinkCode, observationMode)})`,
  },

  'element.setAttribute.dynamic': {
    default: ({ argCode, receiverCode, policyName, sinkCode, extraArgs, observationMode }) =>
      `((__el, __attr) => __el.setAttribute(__attr, __ttDispatchSetAttr(__attr, ${argCode}, ${JSON.stringify(sinkCode)}, __el, ${policyName}, typeof (${argCode})${observationMode != null ? `, ${JSON.stringify(observationMode)}` : ''})))(${receiverCode}, ${extraArgs?.[0] ?? 'dynamicAttr'})`,
  },

  'element.setAttributeNS.dynamic': {
    default: ({ argCode, receiverCode, policyName, sinkCode, extraArgs, observationMode }) =>
      `((__el, __attr) => __el.setAttributeNS(${extraArgs?.[0] ?? 'null'}, __attr, __ttDispatchSetAttr(__attr, ${argCode}, ${JSON.stringify(sinkCode)}, __el, ${policyName}, typeof (${argCode})${observationMode != null ? `, ${JSON.stringify(observationMode)}` : ''})))(${receiverCode}, ${extraArgs?.[1] ?? 'dynamicAttr'})`,
  },

  'document.execCommand.dynamic': {
    default: ({ argCode, policyName, sinkCode, extraArgs, observationMode }) =>
      `((__cmd) => document.execCommand(__cmd, ${extraArgs?.[1] ?? 'false'}, __ttDispatchExecCommand(__cmd, ${argCode}, ${JSON.stringify(sinkCode)}, ${policyName}, typeof (${argCode})${observationMode != null ? `, ${JSON.stringify(observationMode)}` : ''})))(${extraArgs?.[0] ?? 'dynamicCmd'})`,
  },

  'jquery.attr.dynamic': {
    default: ({ argCode, receiverCode, policyName, sinkCode, extraArgs, observationMode }) =>
      `((__jq, __attr) => __jq.attr(__attr, __ttDispatchJQueryAttr(__attr, ${argCode}, ${JSON.stringify(sinkCode)}, __jq, ${policyName}, typeof (${argCode})${observationMode != null ? `, ${JSON.stringify(observationMode)}` : ''})))(${receiverCode}, ${extraArgs?.[0] ?? 'dynamicAttr'})`,
  },

  'jquery.prop.dynamic': {
    default: ({ argCode, receiverCode, policyName, sinkCode, extraArgs, observationMode }) =>
      `((__jq, __prop) => __jq.prop(__prop, __ttDispatchJQueryProp(__prop, ${argCode}, ${JSON.stringify(sinkCode)}, ${policyName}, typeof (${argCode})${observationMode != null ? `, ${JSON.stringify(observationMode)}` : ''})))(${receiverCode}, ${extraArgs?.[0] ?? 'dynamicProp'})`,
  },
};

function getRefactorSuggestion(kind, verdict, ctx) {
  const t = REFACTOR_TEMPLATES[kind];
  if (!t) return null;
  const fn = t[verdict] ?? t.default;
  return fn ? fn(ctx) : null;
}

module.exports = { REFACTOR_TEMPLATES, getRefactorSuggestion };
