const path = require('path');
const crypto = require('crypto');
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const generate = require('@babel/generator').default;
const { parseSource } = require('./parser');
const { analyzeHtmlArg } = require('./argAnalyzer');
const { analyzeScriptUrl } = require('./scriptUrlAnalyzer');
const { analyzeScriptCode } = require('./scriptCodeAnalyzer');
const { getRefactorSuggestion } = require('./refactorTemplates');
const {
  extractAssignedPropName,
  extractCalledMethodName,
  extractCalledFuncName,
  extractNewCtorName,
  matchSetAttr,
  matchExecCommand,
  matchJQueryAttr,
  extractReceiver,
  matchJQueryReceiver,
  matchElementReceiver,
  matchReceiver,
} = require('./matchers');
const { MAX_BINDING_DEPTH, SINK_STATUSES, VERDICTS, VERDICT_TO_POLICY } = require('./constants');
const { resolveObservationMode } = require('./observationMode');

const TT_CALLBACK = {
  html: 'createHTML',
  script: 'createScript',
  scriptURL: 'createScriptURL',
};

const TYPEOF_SCRIPT_KINDS = new Set(['eval', 'eval.call', 'eval.apply', 'setTimeout.string', 'setInterval.string']);

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'PATCH', 'CONNECT', 'TRACE']);

function isFunction(node) {
  return (
    t.isFunctionExpression(node) ||
    t.isArrowFunctionExpression(node) ||
    t.isClassExpression(node)
  );
}

function resolvesToFunction(node, scope, depth = 0) {
  if (!node) return false;
  if (isFunction(node)) return true;
  if (t.isFunctionDeclaration(node)) return true;

  if (t.isIdentifier(node) && scope && depth < MAX_BINDING_DEPTH) {
    const binding = scope.getBinding(node.name);
    if (!binding || binding.constantViolations.length > 0) return false;
    const bindingNode = binding.path.node;
    if (t.isFunctionDeclaration(bindingNode)) return true;
    if (t.isVariableDeclarator(bindingNode) && bindingNode.init) {
      return resolvesToFunction(bindingNode.init, scope, depth + 1);
    }
  }

  return false;
}

function isNotString(node) {
  return (
    t.isFunctionExpression(node) ||
    t.isArrowFunctionExpression(node) ||
    t.isClassExpression(node) ||
    t.isObjectExpression(node) ||
    t.isArrayExpression(node) ||
    t.isNumericLiteral(node) ||
    t.isBooleanLiteral(node) ||
    t.isNullLiteral(node) ||
    t.isNewExpression(node)
  );
}

const SETTIMEOUT_KINDS = new Set(['setTimeout.string', 'setInterval.string']);

const JQUERY_NODE_FACTORIES = new Set([
  'createElement', 'createElementNS', 'createTextNode', 'createDocumentFragment',
]);
const JQUERY_NODE_CONSTRUCTORS = new Set(['Text', 'DocumentFragment', 'Image', 'Option']);
const KNOWN_TT_POLICIES = new Set([
  'passThruPolicy', 'classifyPolicy', 'monitorPolicy', 'sanitizePolicy',
]);

function isDirectJQueryCall(node) {
  return t.isCallExpression(node) && t.isIdentifier(node.callee) &&
    (node.callee.name === '$' || node.callee.name === 'jQuery');
}

const JQUERY_CHAIN_ALWAYS_RETURNS_JQUERY = new Set([
  'clone', 'addClass', 'removeClass', 'toggleClass',
  'append', 'prepend', 'before', 'after', 'replaceWith',
  'wrap', 'wrapAll', 'wrapInner', 'empty', 'detach', 'remove',
]);
const JQUERY_CHAIN_SETTER_WITH_ARG = new Set(['html', 'text', 'val']);
const JQUERY_CHAIN_SETTER = new Set(['attr', 'prop', 'css', 'data']);

function isProvenJQueryObject(node, scope, depth = 0) {
  if (!node || depth > MAX_BINDING_DEPTH) return false;
  if (t.isIdentifier(node) && scope) {
    const binding = scope.getBinding(node.name);
    if (!binding || binding.constantViolations.length > 0) return false;
    const bindingNode = binding.path.node;
    return t.isVariableDeclarator(bindingNode) && bindingNode.init
      ? isProvenJQueryObject(bindingNode.init, scope, depth + 1)
      : false;
  }
  if (isDirectJQueryCall(node)) return true;
  if (!t.isCallExpression(node) || !t.isMemberExpression(node.callee) || node.callee.computed ||
      !t.isIdentifier(node.callee.property)) return false;
  if (!isProvenJQueryObject(node.callee.object, scope, depth + 1)) return false;

  const method = node.callee.property.name;
  if (JQUERY_CHAIN_ALWAYS_RETURNS_JQUERY.has(method)) return true;
  if (JQUERY_CHAIN_SETTER_WITH_ARG.has(method)) return node.arguments.length >= 1;
  if (JQUERY_CHAIN_SETTER.has(method)) {
    return node.arguments.length >= 2 ||
      (node.arguments.length === 1 && t.isObjectExpression(node.arguments[0]));
  }
  return false;
}

function isKnownTrustedHTMLCall(node) {
  if (!t.isCallExpression(node) || !t.isMemberExpression(node.callee) || node.callee.computed) return false;
  return t.isIdentifier(node.callee.property, { name: 'createHTML' }) &&
    t.isIdentifier(node.callee.object) && KNOWN_TT_POLICIES.has(node.callee.object.name);
}

function functionReturnsOnlyJQueryNoViolation(node, scope, depth) {
  if (t.isArrowFunctionExpression(node) && !t.isBlockStatement(node.body)) {
    return isProvenJQueryNoViolation(node.body, scope, depth + 1);
  }

  const body = node.body;
  if (!t.isBlockStatement(body)) return false;
  let safe = true;
  const visit = current => {
    if (!current || !safe) return;
    if (current !== node && (t.isFunction(current) || t.isClass(current))) return;
    if (t.isReturnStatement(current)) {
      if (current.argument && !isProvenJQueryNoViolation(current.argument, scope, depth + 1)) safe = false;
      return;
    }
    const keys = t.VISITOR_KEYS[current.type] || [];
    for (const key of keys) {
      const child = current[key];
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  };
  visit(body);
  return safe;
}

function isProvenJQueryNodeValue(node, scope, depth = 0) {
  if (!node || depth > MAX_BINDING_DEPTH) return false;
  if (t.isIdentifier(node) && scope) {
    const binding = scope.getBinding(node.name);
    if (!binding || binding.constantViolations.length > 0) return false;
    const bindingNode = binding.path.node;
    return t.isVariableDeclarator(bindingNode) && bindingNode.init
      ? isProvenJQueryNodeValue(bindingNode.init, scope, depth + 1)
      : false;
  }
  if (t.isCallExpression(node) && t.isMemberExpression(node.callee) && !node.callee.computed &&
      t.isIdentifier(node.callee.object, { name: 'document' }) &&
      t.isIdentifier(node.callee.property) && JQUERY_NODE_FACTORIES.has(node.callee.property.name)) return true;
  if (t.isNewExpression(node) && t.isIdentifier(node.callee) &&
      JQUERY_NODE_CONSTRUCTORS.has(node.callee.name)) return true;
  if (t.isArrayExpression(node)) return node.elements.every(element =>
    element && !t.isSpreadElement(element) && isProvenJQueryNodeValue(element, scope, depth + 1));
  return false;
}

function isProvenJQueryNoViolation(node, scope, depth = 0) {
  if (!node || depth > MAX_BINDING_DEPTH) return false;
  if (t.isNullLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node)) return true;
  if (t.isUnaryExpression(node, { operator: 'void' })) return true;

  if (t.isIdentifier(node)) {
    if (node.name === 'undefined') return true;
    if (!scope) return false;
    const binding = scope.getBinding(node.name);
    if (!binding || binding.constantViolations.length > 0) return false;
    const bindingNode = binding.path.node;
    if (t.isVariableDeclarator(bindingNode) && bindingNode.init) {
      return isProvenJQueryNoViolation(bindingNode.init, scope, depth + 1);
    }
    if (t.isFunctionDeclaration(bindingNode)) {
      return functionReturnsOnlyJQueryNoViolation(bindingNode, binding.path.scope || scope, depth + 1);
    }
    return false;
  }

  if (isProvenJQueryObject(node, scope, depth + 1) || isKnownTrustedHTMLCall(node)) return true;

  if (t.isCallExpression(node) && t.isMemberExpression(node.callee) && !node.callee.computed &&
      t.isIdentifier(node.callee.object, { name: 'document' }) &&
      t.isIdentifier(node.callee.property) && JQUERY_NODE_FACTORIES.has(node.callee.property.name)) {
    return true;
  }

  if (t.isNewExpression(node) && t.isIdentifier(node.callee) &&
      JQUERY_NODE_CONSTRUCTORS.has(node.callee.name)) return true;

  if (t.isArrayExpression(node)) {
    return isProvenJQueryNodeValue(node, scope, depth + 1);
  }

  if (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) {
    return functionReturnsOnlyJQueryNoViolation(node, scope, depth + 1);
  }

  return false;
}

function tryStaticString(node, scope, identDepth = 0) {
  if (!node) return null;

  if (t.isStringLiteral(node)) {
    if (node.value.includes('{{')) return null;
    return node.value;
  }
  if (t.isNumericLiteral(node)) return String(node.value);
  if (t.isBooleanLiteral(node)) return String(node.value);

  if (t.isIdentifier(node) && scope) {
    if (identDepth >= MAX_BINDING_DEPTH) return null;
    const binding = scope.getBinding(node.name);
    if (!binding) return null;
    if (binding.constantViolations.length > 0) return null;
    const decl = binding.path.node;
    if (!t.isVariableDeclarator(decl) || !decl.init) return null;
    return tryStaticString(decl.init, scope, identDepth + 1);
  }

  if (t.isTemplateLiteral(node)) {
    const parts = [];
    for (let i = 0; i < node.quasis.length; i++) {
      const cooked = node.quasis[i].value.cooked;
      if (cooked == null) return null;
      parts.push(cooked);
      if (i < node.expressions.length) {
        const val = tryStaticString(node.expressions[i], scope, identDepth);
        if (val === null) return null;
        parts.push(val);
      }
    }
    return parts.join('');
  }

  if (t.isBinaryExpression(node) && node.operator === '+') {
    const left = tryStaticString(node.left, scope, identDepth);
    if (left === null) return null;
    const right = tryStaticString(node.right, scope, identDepth);
    if (right === null) return null;
    return left + right;
  }

  return null;
}

function computeStatus(def, node, scope) {

  if (def.pattern === 'methodCall' || def.pattern === 'funcCall' || def.pattern === 'newExpr') {
    if (!node.arguments || node.arguments.length === 0) return 'NO_VIOLATION';
  }

  if (typeof def.argIndex === 'number' && node.arguments && node.arguments.length <= def.argIndex) {
    return 'NO_VIOLATION';
  }

  if (def.paramUnresolvable) return 'PARAM_UNRESOLVABLE';

  if ((def.kind === 'location.replace.javascript' || def.kind === 'location.assign.javascript')
      && node.arguments.length !== 1) {
    return 'NO_VIOLATION';
  }

  if (def.kind === 'window.open.javascript') {
    const firstArg = node.arguments[0];
    const staticFirst = firstArg ? tryStaticString(firstArg, scope) : null;
    if (staticFirst !== null && HTTP_METHODS.has(staticFirst.toUpperCase())) {
      return 'NO_VIOLATION';
    }
  }

  if (def.receiver) {
    const receiver = extractReceiver(def, node);
    if (!receiver) return 'RECEIVER_EXTRACTION_FAILED';
    const receiverMatch = matchReceiver(def.receiver, receiver, scope);
    if (receiverMatch === null) return 'RECEIVER_UNRESOLVABLE';
    if (!receiverMatch) return 'RECEIVER_MISMATCH';
  }

  if (def.elementType) {
    const receiver = extractReceiver(def, node);
    if (!receiver) return 'RECEIVER_EXTRACTION_FAILED';
    const receiverMatch = matchElementReceiver(def.elementType, receiver, scope);
    if (receiverMatch === null) return 'RECEIVER_UNRESOLVABLE';
    if (!receiverMatch) return 'RECEIVER_MISMATCH';
  }

  if (def.receiverKind === 'jquery') {
    const receiver = extractReceiver(def, node);
    if (!receiver) return 'RECEIVER_EXTRACTION_FAILED';
    const receiverMatch = matchJQueryReceiver(receiver, scope);
    if (receiverMatch === null) return 'RECEIVER_UNRESOLVABLE';
  }

  if (def.valueGuard === 'jquery' && def.argIndex != null) {
    const arg = node.arguments?.[def.argIndex];
    if (arg && isProvenJQueryNoViolation(arg, scope)) return 'NO_VIOLATION';
  }

  if (SETTIMEOUT_KINDS.has(def.kind) && def.argIndex != null) {
    const arg = node.arguments?.[def.argIndex];
    if (arg && resolvesToFunction(arg, scope)) return 'NO_VIOLATION';
  }

  if (def.kind === 'eval' && def.argIndex != null) {
    const arg = node.arguments?.[def.argIndex];
    if (arg && isNotString(arg)) return 'NO_VIOLATION';
  }

  if (def.kind === 'eval.call' && def.argIndex != null) {
    const arg = node.arguments?.[def.argIndex];
    if (arg && isNotString(arg)) return 'NO_VIOLATION';
  }

  if (def.kind === 'eval.apply' && def.argIndex != null) {
    const arrArg = node.arguments?.[def.argIndex];
    const arg = t.isArrayExpression(arrArg) ? arrArg.elements?.[0] : arrArg;
    if (arg && isNotString(arg)) return 'NO_VIOLATION';
  }

  if (def.kind.endsWith('.javascript') && def.pattern === 'methodCall' && def.argIndex != null) {
    const arg = node.arguments?.[def.argIndex];
    const staticVal = arg ? tryStaticString(arg, scope) : null;

    if (staticVal !== null && !staticVal.startsWith('javascript:')) {
      return 'NO_VIOLATION';
    }

    if (staticVal === null && arg && t.isBinaryExpression(arg) && arg.operator === '+') {
      const leftStatic = tryStaticString(arg.left, scope);
      if (leftStatic !== null && !leftStatic.startsWith('javascript:')) {
        return 'NO_VIOLATION';
      }
    }

    if (staticVal === null && arg && t.isTemplateLiteral(arg)) {

      if (arg.expressions && arg.expressions.length > 0) {
        const prefixStatic = arg.quasis[0].value.cooked;

        if (prefixStatic && !prefixStatic.startsWith('javascript:')) {
          return 'NO_VIOLATION';
        }

      } else if (arg.quasis.length > 0) {

        const prefixStatic = arg.quasis[0].value.cooked;
        if (prefixStatic != null && !prefixStatic.startsWith('javascript:')) {
          return 'NO_VIOLATION';
        }
      }
    }
  }

  if (def.kind.endsWith('.javascript') && def.pattern === 'propAssign') {
    const rhs = node.right;
    const staticVal = rhs ? tryStaticString(rhs, scope) : null;

    if (staticVal !== null && !staticVal.startsWith('javascript:')) {
      return 'NO_VIOLATION';
    }

    if (staticVal === null && rhs && t.isBinaryExpression(rhs) && rhs.operator === '+') {
      const leftStatic = tryStaticString(rhs.left, scope);
      if (leftStatic !== null && !leftStatic.startsWith('javascript:')) {
        return 'NO_VIOLATION';
      }
    }

    if (staticVal === null && rhs && t.isTemplateLiteral(rhs)) {

      if (rhs.expressions && rhs.expressions.length > 0) {
        const prefixStatic = rhs.quasis[0].value.cooked;

        if (prefixStatic && !prefixStatic.startsWith('javascript:')) {
          return 'NO_VIOLATION';
        }

      } else if (rhs.quasis.length > 0) {

        const prefixStatic = rhs.quasis[0].value.cooked;
        if (prefixStatic != null && !prefixStatic.startsWith('javascript:')) {
          return 'NO_VIOLATION';
        }
      }
    }
  }

  if (def.receiver || def.elementType || def.receiverKind) return 'RECEIVER_MATCH';
  return 'NO_RECEIVER';
}

function extractArgNode(def, node) {
  switch (def.pattern) {
    case 'propAssign':
      return node.right ?? null;
    case 'methodCall':
    case 'funcCall': {
      if (def.argIndex == null || !node.arguments) return null;
      if (def.argIndex === 'last') return node.arguments[node.arguments.length - 1] ?? null;
      const arg = node.arguments[def.argIndex] ?? null;

      if (def.kind === 'eval.apply' && arg && t.isArrayExpression(arg)) {
        return arg.elements?.[0] ?? null;
      }
      return arg;
    }
    case 'newExpr': {
      if (!node.arguments || node.arguments.length === 0) return null;
      if (def.argIndex === 'last') return node.arguments[node.arguments.length - 1];
      return node.arguments[def.argIndex] ?? null;
    }
    case 'JSXAttribute': {
      const val = node.value ?? null;
      if (!val) return null;

      const expr = t.isJSXExpressionContainer(val) ? val.expression : val;

      if (t.isObjectExpression(expr)) {
        const htmlProp = expr.properties.find(
          p => t.isObjectProperty(p) && !p.computed &&
               t.isIdentifier(p.key) && p.key.name === '__html'
        );
        return htmlProp ? htmlProp.value : null;
      }
      return expr;
    }
    default:
      return null;
  }
}

const SNIPPET_MAX_CHARS = 300;

function extractSnippet(lines, startLine, endLine) {
  const start = startLine - 1;
  const end = Math.min((endLine ?? startLine) - 1, start + 9);
  const slice = lines.slice(start, end + 1);
  if (!slice.length) return '';
  const joined = slice.map(l => l.trim()).join(' ');
  return joined.substring(0, SNIPPET_MAX_CHARS);
}

function nodeToCode(node) {
  if (!node) return null;
  try {
    return generate(node, { concise: true }).code;
  } catch {
    return null;
  }
}

function locateReceiverNode(pattern, node) {
  if (pattern === 'propAssign') {
    const left = node.left;
    return t.isMemberExpression(left) ? left.object : left;
  }
  if (pattern === 'methodCall' || pattern === 'funcCall') {
    const callee = node.callee ?? node.func;
    return t.isMemberExpression(callee) ? callee.object : callee;
  }
  if (pattern === 'newExpr') {
    return node.callee;
  }
  return null;
}

function findReceiverBounds(pattern, node, source) {
  const receiverNode = locateReceiverNode(pattern, node);
  if (!receiverNode || receiverNode.start == null || receiverNode.end == null) return null;

  let [start, end] = [receiverNode.start, receiverNode.end];
  if (receiverNode.extra?.parenthesized && source) {
    let ps = start - 1;
    while (ps >= 0 && /\s/.test(source[ps])) ps--;
    if (source[ps] === '(') {
      let pe = end;
      while (pe < source.length && /\s/.test(source[pe])) pe++;
      if (source[pe] === ')') {
        start = ps;
        end = pe + 1;
      }
    }
  }
  return { start, end, node: receiverNode };
}

function extractReceiverCode(def, node, source) {
  const bounds = findReceiverBounds(def.pattern, node, source);
  if (!bounds) return null;
  if (source) {
    try {
      return source.slice(bounds.start, bounds.end);
    } catch {
      return nodeToCode(bounds.node);
    }
  }
  return nodeToCode(bounds.node);
}

function extractExtraArgs(def, node, source) {
  if (!node.arguments || node.arguments.length === 0) return [];
  const args = [];
  for (let i = 0; i < node.arguments.length; i++) {
    if (i === def.argIndex || (def.argIndex === 'last' && i === node.arguments.length - 1)) {
      continue;
    }
    const arg = node.arguments[i];
    let code;
    if (source && arg.start != null && arg.end != null) {
      try {
        code = source.slice(arg.start, arg.end);
      } catch {
        code = nodeToCode(arg);
      }
    } else {
      code = nodeToCode(arg);
    }
    if (code) args.push(code);
  }
  return args;
}

function makeSourceRefactor(node, argNode, source, ttCallback, policyName, sinkCode, includeTypeof = false, receiverCode = null, receiverCheckCode = null, observationMode = null) {
  try {
    const nodeSource = source.slice(node.start, node.end);
    const argOffset = argNode.start - node.start;
    const argEnd = argNode.end - node.start;
    const argOriginal = nodeSource.slice(argOffset, argEnd);
    const metaArg = sinkCode != null ? `, ${JSON.stringify(sinkCode)}` : '';

    const modeArg = observationMode != null ? `, ${JSON.stringify(observationMode)}` : '';

    if (receiverCode) {

      const wrapped = includeTypeof
        ? `((__ts) => __ttGuardedPolicyCall(${policyName}, ${JSON.stringify(ttCallback)}, __ts${metaArg}, typeof __ts, ${receiverCheckCode}${modeArg}))(${argOriginal})`
        : `__ttGuardedPolicyCall(${policyName}, ${JSON.stringify(ttCallback)}, ${argOriginal}${metaArg}, undefined, ${receiverCheckCode}${modeArg})`;
      const rest = nodeSource.slice(receiverCode.length, argOffset) + wrapped + nodeSource.slice(argEnd);
      return `((__r) => __r${rest})(${receiverCode})`;
    }

    const wrapped = includeTypeof
      ? `((__ts) => typeof __ts !== 'string' ? __ts : ${policyName}.${ttCallback}(__ts${metaArg}, typeof __ts${modeArg}))(${argOriginal})`
      : `${policyName}.${ttCallback}(${argOriginal}${metaArg}${modeArg ? `, undefined${modeArg}` : ''})`;
    const result = nodeSource.slice(0, argOffset) + wrapped + nodeSource.slice(argEnd);

    return `(${result})`;
  } catch {
    return null;
  }
}

function makeJQueryGuardRefactor(node, argNode, source, policyName, sinkCode, sinkKind, receiverCode = null, receiverCheckCode = null, observationMode = null) {
  try {
    const nodeSource = source.slice(node.start, node.end);
    const argOffset = argNode.start - node.start;
    const argEnd = argNode.end - node.start;
    const argOriginal = nodeSource.slice(argOffset, argEnd);

    const modeArg = observationMode != null ? `, ${JSON.stringify(observationMode)}` : '';

    if (receiverCode) {

      const wrapped = `((__v) => __ttJQueryArg(__v, ${JSON.stringify(sinkCode)}, ${JSON.stringify(sinkKind)}, ${policyName}, ${receiverCheckCode}${modeArg}))(${argOriginal})`;
      const rest = nodeSource.slice(receiverCode.length, argOffset) + wrapped + nodeSource.slice(argEnd);
      return `((__r) => __r${rest})(${receiverCode})`;
    }

    const wrapped = `((__v) => __ttJQueryArg(__v, ${JSON.stringify(sinkCode)}, ${JSON.stringify(sinkKind)}, ${policyName}${modeArg ? `, undefined${modeArg}` : ''}))(${argOriginal})`;
    return `(${nodeSource.slice(0, argOffset)}${wrapped}${nodeSource.slice(argEnd)})`;
  } catch {
    return null;
  }
}

function makeCompoundAssignRefactor(node, source, ttCallback, policyName, sinkCode, observationMode = null, receiverCode = null, receiverCheckCode = null) {
  try {
    const leftSrc = source.slice(node.left.start, node.left.end);
    const rightSrc = source.slice(node.right.start, node.right.end);
    const metaArg = sinkCode != null ? `, ${JSON.stringify(sinkCode)}` : '';
    const modeArg = observationMode != null ? `, undefined, ${JSON.stringify(observationMode)}` : '';

    if (receiverCode) {

      const propSuffix = leftSrc.slice(receiverCode.length);
      const lhsViaR = `__r${propSuffix}`;
      const wrapped = `__ttGuardedPolicyCall(${policyName}, ${JSON.stringify(ttCallback)}, ${lhsViaR} + ${rightSrc}${metaArg}, undefined, ${receiverCheckCode}${modeArg})`;
      return `((__r) => ${lhsViaR} = ${wrapped})(${receiverCode})`;
    }

    const wrapped = `${policyName}.${ttCallback}(${leftSrc} + ${rightSrc}${metaArg}${modeArg})`;
    return `${leftSrc} = ${wrapped}`;
  } catch {
    return null;
  }
}

const DYNAMIC_PARAM_ARG_INDEX = {
  'element.setAttribute.dynamic': 0,
  'element.setAttributeNS.dynamic': 1,
  'document.execCommand.dynamic': 0,
  'jquery.attr.dynamic': 0,
  'jquery.prop.dynamic': 0,
};

const DYNAMIC_DISPATCH_FN = {
  'element.setAttribute.dynamic': '__ttDispatchSetAttr',
  'element.setAttributeNS.dynamic': '__ttDispatchSetAttr',
  'document.execCommand.dynamic': '__ttDispatchExecCommand',
  'jquery.attr.dynamic': '__ttDispatchJQueryAttr',
  'jquery.prop.dynamic': '__ttDispatchJQueryProp',
};

function extractDynamicParamNode(def, node) {
  const idx = DYNAMIC_PARAM_ARG_INDEX[def.kind];
  if (idx == null || !node.arguments) return null;
  return node.arguments[idx] ?? null;
}

function makeDynamicDispatchRefactor(node, argNode, paramNode, source, policyName, sinkCode, receiverCode, dispatchFnName, observationMode = null) {
  try {
    const nodeSource = source.slice(node.start, node.end);
    const paramOffset = paramNode.start - node.start;
    const paramEnd = paramNode.end - node.start;
    const argOffset = argNode.start - node.start;
    const argEnd = argNode.end - node.start;
    const argOriginal = nodeSource.slice(argOffset, argEnd);
    const metaArg = sinkCode != null ? `, ${JSON.stringify(sinkCode)}` : '';
    const modeArg = observationMode != null ? `, ${JSON.stringify(observationMode)}` : '';

    if (receiverCode) {

      const dispatchCall = `${dispatchFnName}(__attr, __ts${metaArg}, __el, ${policyName}, typeof __ts${modeArg})`;
      const between = nodeSource.slice(paramEnd, argOffset);
      const before = nodeSource.slice(receiverCode.length, paramOffset);
      const after = nodeSource.slice(argEnd);
      return `((__el, __attr, __ts) => __el${before}__attr${between}${dispatchCall}${after})(${receiverCode}, ${nodeSource.slice(paramOffset, paramEnd)}, ${argOriginal})`;
    }

    const dispatchCall = `${dispatchFnName}(__cmd, __ts${metaArg}, ${policyName}, typeof __ts${modeArg})`;
    const before = nodeSource.slice(0, paramOffset);
    const between = nodeSource.slice(paramEnd, argOffset);
    const after = nodeSource.slice(argEnd);
    return `((__cmd, __ts) => ${before}__cmd${between}${dispatchCall}${after})(${nodeSource.slice(paramOffset, paramEnd)}, ${argOriginal})`;
  } catch {
    return null;
  }
}

const MINIFIED_SCORE_THRESHOLD = 0.6;

const MINIFIED_LINE_LENGTH_HARD = 600;

function isMinifiedLine(line) {
  if (!line || line.length === 0) return false;

  if (line.length > MINIFIED_LINE_LENGTH_HARD) return true;

  const lengthScore = line.length / MINIFIED_LINE_LENGTH_HARD;

  const wsRatio = (line.match(/\s/g) || []).length / line.length;
  const whitespaceScore = Math.max(0, 1 - wsRatio / 0.10);

  const semiPer100 = (line.match(/;/g) || []).length / (line.length / 100);
  const semicolonScore = Math.min(semiPer100 / 5, 1.0);

  const score = 0.4 * lengthScore + 0.5 * whitespaceScore + 0.1 * semicolonScore;
  return score >= MINIFIED_SCORE_THRESHOLD;
}

function buildSinkLookupKey(relFile, line, col, kind) {
  return `${relFile}:${line}:${col}:${kind}`;
}

function emitFinding(def, node, file, lines, lineOffset, findings, scope, source, sourceRoot = null, taintedSinkSet = null, innerOffset = 0, argNodeOverride = null) {
  if (!node.loc) return;

  const { line, column } = node.loc.start;

  if (isMinifiedLine(lines[line - 1] || '')) return;

  const relFile = sourceRoot ? path.relative(sourceRoot, file) : file;
  const sinkKey = buildSinkLookupKey(relFile, line + lineOffset, column + 1, def.kind);
  const sinkHash = crypto.createHash('sha256').update(sinkKey).digest('hex').slice(0, 8);
  const sinkCode = `S-${sinkHash}:${def.kind}`;

  const status = computeStatus(def, node, scope);

  if (!SINK_STATUSES.has(status)) {
    findings.push(
      Object.freeze({
        file,
        line: line + lineOffset,
        col: column + 1,
        kind: def.kind,
        pattern: def.pattern,
        sinkType: def.sinkType,
        status,
        sinkKey,
        sinkHash,
        argType: null,
        argConstant: false,
        argValue: null,
        verdict: null,
        verdictReasons: null,
        htmlTags: null,
        node_start: null,
        node_end: null,
        arg_start: null,
        arg_end: null,
        patch_strategy: null,
        patch_wrapper: null,
        original_snippet: extractSnippet(lines, line, node.loc.end.line),
      })
    );
    return;
  }

  const argNode = argNodeOverride ?? extractArgNode(def, node);
  const argType = argNode?.type ?? null;

  let verdict = null;
  let htmlTags = null;
  let verdictReasons = null;
  const staticVal = argNode ? tryStaticString(argNode, scope) : null;

  if (status === 'RECEIVER_UNRESOLVABLE') {

    verdict = VERDICTS.TYPE3;
  } else if (status === 'PARAM_UNRESOLVABLE') {

    verdict = VERDICTS.TYPE3;
  } else if (def.sinkType === 'html' && staticVal !== null) {
    const analysis = analyzeHtmlArg(staticVal);
    verdict = analysis.verdict;
    htmlTags = analysis.htmlTags;
    verdictReasons = analysis.verdictReasons;
  } else if (def.sinkType === 'scriptURL' && staticVal !== null) {
    const analysis = analyzeScriptUrl(staticVal);
    verdict = analysis.verdict;
    verdictReasons = analysis.verdictReasons;
  } else if (def.sinkType === 'script' && !def.kind.endsWith('.javascript') && staticVal !== null) {
    const analysis = analyzeScriptCode(staticVal);
    verdict = analysis.verdict;
    verdictReasons = analysis.verdictReasons;
  } else if (def.kind.endsWith('.javascript')) {

    if (staticVal !== null && staticVal.startsWith('javascript:')) {
      verdict = VERDICTS.TYPE4;
      verdictReasons = [staticVal];
    }

    else if (staticVal === null && argNode && t.isBinaryExpression(argNode) && argNode.operator === '+') {
      const leftStatic = tryStaticString(argNode.left, scope);
      if (leftStatic !== null && leftStatic.startsWith('javascript:')) {
        verdict = VERDICTS.TYPE4;
        verdictReasons = ['javascript:' + ' (prefix confirmed)'];
      }
    }
  }

  if (verdict === null) verdict = VERDICTS.TYPE3;

  const isForcedType3 = status === 'RECEIVER_UNRESOLVABLE' || status === 'PARAM_UNRESOLVABLE';
  if (!isForcedType3 && taintedSinkSet && taintedSinkSet.has(sinkKey) && verdict === VERDICTS.TYPE3) {
    verdict = VERDICTS.TYPE5;
    verdictReasons = ['tainted-by-codeql'];
  }

  const policyName = VERDICT_TO_POLICY[verdict] || VERDICT_TO_POLICY[VERDICTS.TYPE3];

  const observationMode = resolveObservationMode(verdict, staticVal !== null);

  const node_start = node.start != null ? node.start + innerOffset : null;
  const node_end = node.end != null ? node.end + innerOffset : null;
  const arg_start = argNode && argNode.start != null ? argNode.start + innerOffset : null;
  const arg_end = argNode && argNode.end != null ? argNode.end + innerOffset : null;

  let patch_strategy = null;
  let patch_wrapper = null;
  if (def.valueGuard === 'jquery') {
    patch_strategy = 'wrapArgument';
    patch_wrapper = policyName;
  } else if (def.paramUnresolvable && DYNAMIC_DISPATCH_FN[def.kind]) {

    patch_strategy = 'dispatchDynamic';
    patch_wrapper = DYNAMIC_DISPATCH_FN[def.kind];
  } else if (verdict === VERDICTS.TYPE1) {
    patch_strategy = 'replaceNode';
  } else if (verdict !== null) {
    patch_strategy = def.pattern === 'propAssign'
      ? (node.operator === '+=' ? 'wrapRHS2' : 'wrapRHS')
      : 'wrapArgument';
    const ttCallback = TT_CALLBACK[def.sinkType];
    if (ttCallback && policyName) {
      patch_wrapper = `${policyName}.${ttCallback}`;
    }
  }

  let refactorSuggestion = null;

  if (def.valueGuard === 'jquery') {
    if (argNode && node.start != null && node.end != null && source) {

      const jqueryReceiverCode = status === 'RECEIVER_UNRESOLVABLE'
        ? extractReceiverCode(def, node, source)
        : null;
      const jqueryReceiverCheckCode = jqueryReceiverCode
        ? '__r && typeof __r.jquery === "string" && typeof __r.toArray === "function"'
        : null;
      refactorSuggestion = makeJQueryGuardRefactor(
        node, argNode, source, policyName, sinkCode, def.kind, jqueryReceiverCode, jqueryReceiverCheckCode, observationMode
      );
    }
  } else if (verdict === VERDICTS.TYPE1) {

    const argCode = source && argNode && argNode.start != null && argNode.end != null
      ? source.slice(argNode.start, argNode.end)
      : nodeToCode(argNode);
    const receiverCode = extractReceiverCode(def, node, source);
    const extraArgs = extractExtraArgs(def, node, source);

    refactorSuggestion = getRefactorSuggestion(def.kind, verdict, {
      argCode: argCode || 'value',
      receiverCode: receiverCode || 'target',
      policyName,
      sinkCode,
      extraArgs,
    });
  } else if (def.paramUnresolvable && DYNAMIC_DISPATCH_FN[def.kind] && argNode && node.start != null && node.end != null && source) {

    try {
      const paramNode = extractDynamicParamNode(def, node);
      const dispatchFnName = DYNAMIC_DISPATCH_FN[def.kind];

      const receiverCode = def.kind !== 'document.execCommand.dynamic'
        ? extractReceiverCode(def, node, source)
        : null;
      refactorSuggestion = (paramNode && dispatchFnName)
        ? makeDynamicDispatchRefactor(node, argNode, paramNode, source, policyName, sinkCode, receiverCode, dispatchFnName, observationMode)
        : null;
    } catch {
      refactorSuggestion = null;
    }
  } else {

    const ttCallback = TT_CALLBACK[def.sinkType];
    if (ttCallback && argNode && node.start != null && node.end != null && source) {
      try {

        const isReceiverUnresolvable = status === 'RECEIVER_UNRESOLVABLE';
        const receiverCode = isReceiverUnresolvable && (def.elementType || def.receiver)
          ? extractReceiverCode(def, node, source)
          : null;
        const receiverCheckCode = def.elementType
          ? '__r && __r.tagName'
          : (def.receiver ? `__r === ${def.receiver}` : null);
        const raw = node.operator === '+='
          ? makeCompoundAssignRefactor(node, source, ttCallback, policyName, sinkCode, observationMode, receiverCode, receiverCheckCode)
          : makeSourceRefactor(node, argNode, source, ttCallback, policyName, sinkCode,
              TYPEOF_SCRIPT_KINDS.has(def.kind), receiverCode, receiverCheckCode, observationMode);
        refactorSuggestion = raw ?? null;
      } catch {
        refactorSuggestion = null;
      }
    }
  }

  let displaySuggestion = null;
  if (refactorSuggestion && source && node.start != null && node.end != null) {
    try {
      const lineStart = source.lastIndexOf('\n', node.start - 1) + 1;
      const lineEndRaw = source.indexOf('\n', node.end);
      const lineSource = source.slice(lineStart, lineEndRaw === -1 ? source.length : lineEndRaw);
      const refactorOneLine = refactorSuggestion.replace(/\s+/g, ' ');
      displaySuggestion = lineSource.slice(0, node.start - lineStart)
        + refactorOneLine
        + lineSource.slice(node.end - lineStart);
    } catch {
      displaySuggestion = null;
    }
  }

  findings.push(
    Object.freeze({
      file,
      line: line + lineOffset,
      col: column + 1,
      kind: def.kind,
      pattern: def.pattern,
      sinkType: def.sinkType,
      status,
      sinkKey,
      sinkHash,
      sinkCode,
      argType,
      argConstant: staticVal !== null,
      argValue: staticVal,
      verdict,
      verdictReasons,
      htmlTags,
      nodeType: node.type,
      node_start,
      node_end,
      arg_start,
      arg_end,
      patch_strategy,
      patch_wrapper,
      observationMode,
      refactorSuggestion,
      displaySuggestion,
      original_snippet: extractSnippet(lines, line, node.loc.end.line),
    })
  );
}

function emitJQueryAttrObjectFindings(defs, objectNode, node, file, lines, lineOffset, findings, scope, source, sourceRoot, taintedSinkSet, innerOffset) {
  const matches = [];
  for (const prop of objectNode.properties) {
    if (!t.isObjectProperty(prop) || prop.computed) continue;
    let keyName = null;
    if (t.isIdentifier(prop.key)) keyName = prop.key.name;
    else if (t.isStringLiteral(prop.key)) keyName = prop.key.value;
    if (keyName == null) continue;
    const lowerKey = keyName.toLowerCase();
    const matchedDef = defs.find(d => d.kind.split('.').pop() === lowerKey);
    if (matchedDef) matches.push({ def: matchedDef, valueNode: prop.value });
  }

  if (matches.length !== 1) return;
  const { def, valueNode } = matches[0];

  const syntheticDef = { ...def, argIndex: null };
  emitFinding(syntheticDef, node, file, lines, lineOffset, findings, scope, source, sourceRoot, taintedSinkSet, innerOffset, valueNode);
}

function emitFindings(defs, node, file, lines, lineOffset, findings, scope, source, sourceRoot = null, taintedSinkSet = null, innerOffset = 0) {
  const statuses = defs.map(def => computeStatus(def, node, scope));
  const hasMatch = statuses.some(s => s === 'RECEIVER_MATCH');

  for (let i = 0; i < defs.length; i++) {
    if (hasMatch && statuses[i] === 'RECEIVER_UNRESOLVABLE') continue;
    emitFinding(defs[i], node, file, lines, lineOffset, findings, scope, source, sourceRoot, taintedSinkSet, innerOffset);
  }
}

function detectSinks(source, filePath, index, lineOffset = 0, sourceRoot = null, taintedSinkSet = null, unknown = null, innerOffset = 0) {
  const { ast, error } = parseSource(source, filePath);

  if (error) {
    console.error(`Parse error in ${filePath}:`, error.message);
    return [];
  }

  const lines = source.split('\n');
  const findings = [];

  traverse(ast, {
    AssignmentExpression(babelPath) {
      const propName = extractAssignedPropName(babelPath.node, babelPath.scope);
      if (!propName) return;

      const defs = index.byProp.get(propName);
      if (!defs) return;

      emitFindings(defs, babelPath.node, filePath, lines, lineOffset, findings, babelPath.scope, source, sourceRoot, taintedSinkSet, innerOffset);
    },

    JSXAttribute(babelPath) {
      const node = babelPath.node;
      if (!t.isJSXIdentifier(node.name)) return;

      const defs = index.byJSXAttr.get(node.name.name);
      if (!defs || !node.value) return;

      emitFindings(defs, node, filePath, lines, lineOffset, findings, babelPath.scope, source, sourceRoot, taintedSinkSet, innerOffset);
    },

    CallExpression(babelPath) {
      const node = babelPath.node;
      const scope = babelPath.scope;

      const methName = extractCalledMethodName(node, scope);
      if (methName) {
        if (methName === 'setAttribute') {
          const def = matchSetAttr(node, 'setAttribute', index.setAttr, scope);
          if (def) emitFinding(def, node, filePath, lines, lineOffset, findings, scope, source, sourceRoot, taintedSinkSet, innerOffset);
          return;
        }

        if (methName === 'setAttributeNS') {
          const def = matchSetAttr(node, 'setAttributeNS', index.setAttrNS, scope);
          if (def) emitFinding(def, node, filePath, lines, lineOffset, findings, scope, source, sourceRoot, taintedSinkSet, innerOffset);
          return;
        }

        if (methName === 'execCommand') {
          const def = matchExecCommand(node, index.execCommand, scope);
          if (def) emitFinding(def, node, filePath, lines, lineOffset, findings, scope, source, sourceRoot, taintedSinkSet, innerOffset);
          return;
        }

        if (methName === 'call' || methName === 'apply') {
          const callee = node.callee;

          if (
            t.isMemberExpression(callee) && !callee.computed &&
            t.isIdentifier(callee.object) && callee.object.name === 'eval'
          ) {
            const evalDefs = index.byFunc.get('eval');
            if (evalDefs && evalDefs.length > 0) {
              const syntheticDef = Object.freeze({
                ...evalDefs[0],
                kind: methName === 'call' ? 'eval.call' : 'eval.apply',
                argIndex: 1,
              });
              emitFinding(syntheticDef, node, filePath, lines, lineOffset, findings, scope, source, sourceRoot, taintedSinkSet, innerOffset);
            }
            return;
          }

          if (
            t.isMemberExpression(callee) && !callee.computed &&
            t.isMemberExpression(callee.object) && callee.object.computed &&
            t.isIdentifier(callee.object.object) && callee.object.object.name === 'window' &&
            t.isStringLiteral(callee.object.property) && callee.object.property.value === 'eval'
          ) {
            const evalDefs = index.byFunc.get('eval');
            if (evalDefs && evalDefs.length > 0) {
              const syntheticDef = Object.freeze({
                ...evalDefs[0],
                kind: methName === 'call' ? 'eval.call' : 'eval.apply',
                argIndex: 1,
              });
              emitFinding(syntheticDef, node, filePath, lines, lineOffset, findings, scope, source, sourceRoot, taintedSinkSet, innerOffset);
            }
            return;
          }
        }

        if (methName === 'attr' || methName === 'prop') {
          const defs = index.byMethod.get(methName);
          if (defs) {
            const firstArg = node.arguments?.[0];
            if (t.isObjectExpression(firstArg)) {

              emitJQueryAttrObjectFindings(defs, firstArg, node, filePath, lines, lineOffset, findings, scope, source, sourceRoot, taintedSinkSet, innerOffset);
              return;
            }
            const def = matchJQueryAttr(node, methName, defs, scope);
            if (def) emitFinding(def, node, filePath, lines, lineOffset, findings, scope, source, sourceRoot, taintedSinkSet, innerOffset);
          }
          return;
        }

        const defs = index.byMethod.get(methName);
        if (defs) { emitFindings(defs, node, filePath, lines, lineOffset, findings, scope, source, sourceRoot, taintedSinkSet, innerOffset); return; }
      }

      const funcName = extractCalledFuncName(node, scope);
      if (funcName) {
        const defs = index.byFunc.get(funcName);
        if (defs) {

          if (node.callee && t.isMemberExpression(node.callee) && t.isCallExpression(node.callee.object)) {
            return;
          }

          for (const def of defs) {
            emitFinding(def, node, filePath, lines, lineOffset, findings, scope, source, sourceRoot, taintedSinkSet, innerOffset);
          }
        }
      }
    },

    NewExpression(babelPath) {
      const ctorName = extractNewCtorName(babelPath.node);
      if (!ctorName) return;

      const defs = index.byNew.get(ctorName);
      if (defs) {
        for (const def of defs) {
          emitFinding(def, babelPath.node, filePath, lines, lineOffset, findings, babelPath.scope, source, sourceRoot, taintedSinkSet, innerOffset);
        }
      }
    },
  });

  const occurrences = new Map();
  return findings.map(finding => {
    const collisionBase = finding.sinkKey;
    const occurrence = (occurrences.get(collisionBase) || 0) + 1;
    occurrences.set(collisionBase, occurrence);
    if (occurrence === 1) return { ...finding, collisionBase, occurrence };

    const lookupKey = `${collisionBase}:occurrence:${occurrence}`;
    const sinkHash = crypto.createHash('sha256').update(lookupKey).digest('hex').slice(0, 8);
    const sinkCode = `S-${sinkHash}:${finding.kind}`;
    const replaceCode = value => typeof value === 'string'
      ? value.split(finding.sinkCode).join(sinkCode)
      : value;
    return {
      ...finding,
      sinkKey: lookupKey,
      sinkHash,
      sinkCode,
      collisionBase,
      occurrence,
      refactorSuggestion: replaceCode(finding.refactorSuggestion),
      displaySuggestion: replaceCode(finding.displaySuggestion),
    };
  });
}

module.exports = { detectSinks, buildSinkLookupKey, findReceiverBounds };
