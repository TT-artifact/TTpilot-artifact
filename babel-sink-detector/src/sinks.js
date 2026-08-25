const SINKS = [

  { kind: 'element.innerHTML',              sinkType: 'html',      pattern: 'propAssign',  argIndex: null, ttCallback: 'createHTML' },

  { kind: 'element.outerHTML',              sinkType: 'html',      pattern: 'propAssign',  argIndex: null, ttCallback: 'createHTML' },
  { kind: 'iframe.srcdoc',                  sinkType: 'html',      pattern: 'propAssign',  argIndex: null, ttCallback: 'createHTML',  elementType: 'iframe' },
  { kind: 'element.insertAdjacentHTML',     sinkType: 'html',      pattern: 'methodCall',  argIndex: 1,    ttCallback: 'createHTML' },
  { kind: 'element.setHTMLUnsafe',          sinkType: 'html',      pattern: 'methodCall',  argIndex: 0,    ttCallback: 'createHTML' },

  { kind: 'document.write',                 sinkType: 'html',      pattern: 'methodCall',  argIndex: 0,    ttCallback: 'createHTML',  receiver: 'document' },
  { kind: 'document.writeln',               sinkType: 'html',      pattern: 'methodCall',  argIndex: 0,    ttCallback: 'createHTML',  receiver: 'document' },
  { kind: 'document.parseHTMLUnsafe',       sinkType: 'html',      pattern: 'methodCall',  argIndex: 0,    ttCallback: 'createHTML',  receiver: 'document' },
  { kind: 'domParser.parseFromString',      sinkType: 'html',      pattern: 'methodCall',  argIndex: 0,    ttCallback: 'createHTML' },
  { kind: 'range.createContextualFragment', sinkType: 'html',      pattern: 'methodCall',  argIndex: 0,    ttCallback: 'createHTML' },
  { kind: 'document.execCommand.insertHTML',  sinkType: 'html',    pattern: 'methodCall',  argIndex: 2,    ttCallback: 'createHTML',  receiver: 'document' },

  { kind: 'iframe.setAttribute.srcdoc',       sinkType: 'html',    pattern: 'methodCall',  argIndex: 1,    ttCallback: 'createHTML',  elementType: 'iframe' },
  { kind: 'iframe.setAttributeNS.srcdoc',     sinkType: 'html',    pattern: 'methodCall',  argIndex: 2,    ttCallback: 'createHTML',  elementType: 'iframe' },

  { kind: 'eval',                            sinkType: 'script',    pattern: 'funcCall',    argIndex: 0,    ttCallback: 'createScript' },
  { kind: 'setTimeout.string',               sinkType: 'script',    pattern: 'funcCall',    argIndex: 0,    ttCallback: 'createScript' },
  { kind: 'setInterval.string',              sinkType: 'script',    pattern: 'funcCall',    argIndex: 0,    ttCallback: 'createScript' },
  { kind: 'location.href.javascript',        sinkType: 'script',    pattern: 'propAssign',  argIndex: null, ttCallback: 'createScript', receiver: 'location' },
  { kind: 'location.assign.javascript',      sinkType: 'script',    pattern: 'methodCall',  argIndex: 0,    ttCallback: 'createScript', receiver: 'location' },
  { kind: 'location.replace.javascript',     sinkType: 'script',    pattern: 'methodCall',  argIndex: 0,    ttCallback: 'createScript', receiver: 'location' },
  { kind: 'window.open.javascript',          sinkType: 'script',    pattern: 'methodCall',  argIndex: 0,    ttCallback: 'createScript', receiver: 'window' },

  { kind: 'Function.ctor',                   sinkType: 'script',    pattern: 'newExpr',     argIndex: 'last', ttCallback: 'createScript' },
  { kind: 'Function.ctor',                   sinkType: 'script',    pattern: 'funcCall',    argIndex: 'last', ttCallback: 'createScript' },
  { kind: 'AsyncFunction.ctor',              sinkType: 'script',    pattern: 'newExpr',     argIndex: 'last', ttCallback: 'createScript' },
  { kind: 'AsyncFunction.ctor',              sinkType: 'script',    pattern: 'funcCall',    argIndex: 'last', ttCallback: 'createScript' },
  { kind: 'GeneratorFunction.ctor',          sinkType: 'script',    pattern: 'newExpr',     argIndex: 'last', ttCallback: 'createScript' },
  { kind: 'GeneratorFunction.ctor',          sinkType: 'script',    pattern: 'funcCall',    argIndex: 'last', ttCallback: 'createScript' },
  { kind: 'AsyncGeneratorFunction.ctor',     sinkType: 'script',    pattern: 'newExpr',     argIndex: 'last', ttCallback: 'createScript' },
  { kind: 'AsyncGeneratorFunction.ctor',     sinkType: 'script',    pattern: 'funcCall',    argIndex: 'last', ttCallback: 'createScript' },

  { kind: 'script.text',                    sinkType: 'script',    pattern: 'propAssign',  argIndex: null, ttCallback: 'createScript',    elementType: 'script' },
  { kind: 'script.textContent',             sinkType: 'script',    pattern: 'propAssign',  argIndex: null, ttCallback: 'createScript',    elementType: 'script' },
  { kind: 'script.innerText',               sinkType: 'script',    pattern: 'propAssign',  argIndex: null, ttCallback: 'createScript',    elementType: 'script' },

  { kind: 'element.setAttribute.onEvent',    sinkType: 'script',    pattern: 'methodCall',  argIndex: 1,    ttCallback: 'createScript' },
  { kind: 'element.setAttributeNS.onEvent',  sinkType: 'script',    pattern: 'methodCall',  argIndex: 2,    ttCallback: 'createScript' },

  { kind: 'script.src',                      sinkType: 'scriptURL', pattern: 'propAssign',  argIndex: null, ttCallback: 'createScriptURL', elementType: 'script' },
  { kind: 'svgScript.href',                  sinkType: 'scriptURL', pattern: 'propAssign',  argIndex: null, ttCallback: 'createScriptURL', elementType: 'script' },
  { kind: 'svgScript.baseVal',               sinkType: 'scriptURL', pattern: 'propAssign',  argIndex: null, ttCallback: 'createScriptURL', elementType: 'script' },

  { kind: 'Worker.ctor',                     sinkType: 'scriptURL', pattern: 'newExpr',     argIndex: 0,    ttCallback: 'createScriptURL' },
  { kind: 'SharedWorker.ctor',               sinkType: 'scriptURL', pattern: 'newExpr',     argIndex: 0,    ttCallback: 'createScriptURL' },
  { kind: 'importScripts',                   sinkType: 'scriptURL', pattern: 'funcCall',    argIndex: 0,    ttCallback: 'createScriptURL' },
  { kind: 'serviceWorker.register',          sinkType: 'scriptURL', pattern: 'methodCall',  argIndex: 0,    ttCallback: 'createScriptURL', receiver: 'navigator.serviceWorker' },

  { kind: 'script.setAttribute.src',         sinkType: 'scriptURL', pattern: 'methodCall',  argIndex: 1,    ttCallback: 'createScriptURL', elementType: 'script' },
  { kind: 'script.setAttributeNS.src',       sinkType: 'scriptURL', pattern: 'methodCall',  argIndex: 2,    ttCallback: 'createScriptURL', elementType: 'script' },
  { kind: 'svgScript.setAttribute.href',     sinkType: 'scriptURL', pattern: 'methodCall',  argIndex: 1,    ttCallback: 'createScriptURL', elementType: 'script' },
  { kind: 'svgScript.setAttributeNS.href',   sinkType: 'scriptURL', pattern: 'methodCall',  argIndex: 2,    ttCallback: 'createScriptURL', elementType: 'script' },

  { kind: 'jquery.html',                    sinkType: 'html',       pattern: 'methodCall',  argIndex: 0,    ttCallback: 'createHTML',       receiverKind: 'jquery', valueGuard: 'jquery' },
  { kind: 'jquery.append',                  sinkType: 'html',       pattern: 'methodCall',  argIndex: 0,    ttCallback: 'createHTML',       receiverKind: 'jquery', valueGuard: 'jquery' },
  { kind: 'jquery.prepend',                 sinkType: 'html',       pattern: 'methodCall',  argIndex: 0,    ttCallback: 'createHTML',       receiverKind: 'jquery', valueGuard: 'jquery' },
  { kind: 'jquery.after',                   sinkType: 'html',       pattern: 'methodCall',  argIndex: 0,    ttCallback: 'createHTML',       receiverKind: 'jquery', valueGuard: 'jquery' },
  { kind: 'jquery.before',                  sinkType: 'html',       pattern: 'methodCall',  argIndex: 0,    ttCallback: 'createHTML',       receiverKind: 'jquery', valueGuard: 'jquery' },
  { kind: 'jquery.replaceWith',             sinkType: 'html',       pattern: 'methodCall',  argIndex: 0,    ttCallback: 'createHTML',       receiverKind: 'jquery', valueGuard: 'jquery' },
  { kind: 'jquery.wrap',                    sinkType: 'html',       pattern: 'methodCall',  argIndex: 0,    ttCallback: 'createHTML',       receiverKind: 'jquery', valueGuard: 'jquery' },
  { kind: 'jquery.wrapAll',                 sinkType: 'html',       pattern: 'methodCall',  argIndex: 0,    ttCallback: 'createHTML',       receiverKind: 'jquery', valueGuard: 'jquery' },
  { kind: 'jquery.wrapInner',               sinkType: 'html',       pattern: 'methodCall',  argIndex: 0,    ttCallback: 'createHTML',       receiverKind: 'jquery', valueGuard: 'jquery' },
  { kind: 'jquery.attr.src',                sinkType: 'scriptURL',  pattern: 'methodCall',  argIndex: 1,    ttCallback: 'createScriptURL',  receiverKind: 'jquery' },
  { kind: 'jquery.prop.src',                sinkType: 'scriptURL',  pattern: 'methodCall',  argIndex: 1,    ttCallback: 'createScriptURL',  receiverKind: 'jquery' },

  { kind: 'react.dangerouslySetInnerHTML',  sinkType: 'html',      pattern: 'JSXAttribute', argIndex: null, ttCallback: 'createHTML' },
];

module.exports = { SINKS };
