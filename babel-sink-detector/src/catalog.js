const { SINKS } = require('./sinks');

const NON_METHOD_KIND_SUFFIXES = new Set(['javascript', 'srcdoc', 'src', 'href', 'onEvent', 'insertHTML']);

function extractNameFromKind(kind, pattern) {
  const segs = kind.split('.');

  if (pattern === 'propAssign' || pattern === 'JSXAttribute') {
    const last = segs[segs.length - 1];
    return last === 'javascript' ? segs[segs.length - 2] : last;
  }

  if (pattern === 'methodCall') {
    const last = segs[segs.length - 1];
    return NON_METHOD_KIND_SUFFIXES.has(last) ? segs[segs.length - 2] : last;
  }

  if (pattern === 'funcCall') {
    return segs[0];
  }
  if (pattern === 'newExpr') {
    return segs[0];
  }

  return null;
}

function pushToMap(map, key, value) {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

function buildIndex(sinks) {
  const byProp = new Map();
  const byJSXAttr = new Map();
  const byMethod = new Map();
  const byFunc = new Map();
  const byNew = new Map();
  const setAttr = [];
  const setAttrNS = [];
  const execCommand = [];

  for (const sink of sinks) {
    const def = Object.freeze({ ...sink });
    const name = extractNameFromKind(sink.kind, sink.pattern);

    if (!name) continue;

    if (sink.pattern === 'JSXAttribute') {
      pushToMap(byJSXAttr, name, def);
    } else if (sink.pattern === 'propAssign') {
      pushToMap(byProp, name, def);
    } else if (sink.pattern === 'methodCall') {
      if (name === 'setAttribute')        setAttr.push(def);
      else if (name === 'setAttributeNS') setAttrNS.push(def);
      else if (name === 'execCommand')    execCommand.push(def);
      else pushToMap(byMethod, name, def);
    } else if (sink.pattern === 'funcCall') {
      pushToMap(byFunc, name, def);
    } else if (sink.pattern === 'newExpr') {
      pushToMap(byNew, name, def);
    }
  }

  return Object.freeze({ byProp, byJSXAttr, byMethod, byFunc, byNew, setAttr, setAttrNS, execCommand });
}

const DEFAULT_INDEX = buildIndex(SINKS);

function loadCatalog() {
  return DEFAULT_INDEX;
}

module.exports = { loadCatalog };
