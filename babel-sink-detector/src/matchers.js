const t = require('@babel/types');
const { MAX_BINDING_DEPTH } = require('./constants');

const CTOR_TO_ELEMENT_TYPE = Object.freeze({
  'Image':             'img',
  'HTMLImageElement':  'img',
  'Audio':             'audio',
  'HTMLAudioElement':  'audio',
  'HTMLVideoElement':  'video',
  'HTMLScriptElement': 'script',
  'HTMLIFrameElement': 'iframe',
});

function extractAssignedPropName(node, scope = null) {
  if (!t.isAssignmentExpression(node) || !node.left) {
    return null;
  }

  const { left } = node;

  if (t.isMemberExpression(left)) {
    if (!left.computed && t.isIdentifier(left.property)) {
      return left.property.name;
    }
    if (left.computed) {
      if (t.isStringLiteral(left.property)) return left.property.value;
      if (t.isIdentifier(left.property) && scope) {
        return resolveIdentifierToString(left.property, scope);
      }
    }
  }

  return null;
}

function extractCalledMethodName(node, scope = null) {
  if (!t.isCallExpression(node) || !node.callee) {
    return null;
  }

  const { callee } = node;

  if (t.isMemberExpression(callee)) {
    if (!callee.computed && t.isIdentifier(callee.property)) {
      return callee.property.name;
    }
    if (callee.computed) {
      if (t.isStringLiteral(callee.property)) return callee.property.value;
      if (t.isIdentifier(callee.property) && scope) {
        return resolveIdentifierToString(callee.property, scope);
      }
    }
  }

  return null;
}

function extractCalledFuncName(node, scope = null) {
  if (!t.isCallExpression(node) || !node.callee) {
    return null;
  }

  const { callee } = node;

  if (t.isIdentifier(callee)) {
    return callee.name;
  }

  if (
    t.isMemberExpression(callee) &&
    !callee.computed &&
    t.isIdentifier(callee.object) &&
    callee.object.name === 'window' &&
    t.isIdentifier(callee.property)
  ) {
    return callee.property.name;
  }

  if (
    t.isMemberExpression(callee) &&
    callee.computed &&
    t.isIdentifier(callee.object) &&
    callee.object.name === 'window' &&
    t.isStringLiteral(callee.property)
  ) {
    return callee.property.value;
  }

  if (
    t.isMemberExpression(callee) &&
    callee.computed &&
    t.isIdentifier(callee.object) &&
    callee.object.name === 'window' &&
    t.isIdentifier(callee.property) &&
    scope
  ) {
    return resolveIdentifierToString(callee.property, scope);
  }

  return null;
}

function extractNewCtorName(node) {
  if (!t.isNewExpression(node) || !node.callee) {
    return null;
  }

  const { callee } = node;

  if (t.isIdentifier(callee)) {
    return callee.name;
  }

  return null;
}

function matchSetAttr(node, methodName, candidates, scope = null) {
  if (!t.isCallExpression(node) || !node.arguments) {
    return null;
  }

  const attrArgIdx = methodName === 'setAttributeNS' ? 1 : 0;
  const attrArg = node.arguments[attrArgIdx];

  if (!attrArg) {
    return null;
  }

  let attrName;
  if (t.isStringLiteral(attrArg)) {
    attrName = attrArg.value.toLowerCase();
  } else if (t.isIdentifier(attrArg) && scope) {
    const resolved = resolveIdentifierToString(attrArg, scope);
    if (resolved) {
      attrName = resolved.toLowerCase();
    } else {

      const dynamicKind = methodName === 'setAttributeNS'
        ? 'element.setAttributeNS.dynamic'
        : 'element.setAttribute.dynamic';
      const argIndex = methodName === 'setAttributeNS' ? 2 : 1;
      return { ...candidates[0], kind: dynamicKind, argIndex, sinkType: 'script', paramUnresolvable: true };
    }
  } else if (t.isAssignmentExpression(attrArg) && scope) {

    const resolved = resolveNodeToString(attrArg.right, scope);
    if (resolved) {
      attrName = resolved.toLowerCase();
    } else {

      const dynamicKind = methodName === 'setAttributeNS'
        ? 'element.setAttributeNS.dynamic'
        : 'element.setAttribute.dynamic';
      const argIndex = methodName === 'setAttributeNS' ? 2 : 1;
      return { ...candidates[0], kind: dynamicKind, argIndex, sinkType: 'script', paramUnresolvable: true };
    }
  } else {

    const dynamicKind = methodName === 'setAttributeNS'
      ? 'element.setAttributeNS.dynamic'
      : 'element.setAttribute.dynamic';
    const argIndex = methodName === 'setAttributeNS' ? 2 : 1;
    return { ...candidates[0], kind: dynamicKind, argIndex, sinkType: 'script', paramUnresolvable: true };
  }

  for (const def of candidates) {
    if (attrNameMatches(def, attrName)) {
      return def;
    }
  }

  return null;
}

function attrNameMatches(def, attrName) {
  const segs = def.kind.split('.');
  const expectedAttr = segs[segs.length - 1];

  if (expectedAttr === 'onEvent') {
    return /^on./.test(attrName);
  }

  return attrName === expectedAttr;
}

function matchExecCommand(node, candidates, scope = null) {
  if (!t.isCallExpression(node) || !node.arguments) {
    return null;
  }

  const firstArg = node.arguments[0];
  if (!firstArg) return null;

  let cmdName;
  if (t.isStringLiteral(firstArg)) {
    cmdName = firstArg.value.toLowerCase();
  } else if (t.isIdentifier(firstArg) && scope) {
    const resolved = resolveIdentifierToString(firstArg, scope);
    if (!resolved) {

      return { ...candidates[0], kind: 'document.execCommand.dynamic', paramUnresolvable: true };
    }
    cmdName = resolved.toLowerCase();
  } else {

    return { ...candidates[0], kind: 'document.execCommand.dynamic', paramUnresolvable: true };
  }

  for (const def of candidates) {
    const segs = def.kind.split('.');
    const expectedCmd = segs[segs.length - 1].toLowerCase();
    if (cmdName === expectedCmd) {
      return def;
    }
  }

  return null;
}

function matchJQueryAttr(node, methodName, candidates, scope = null) {
  if (!t.isCallExpression(node) || !node.arguments) {
    return null;
  }

  if (node.arguments.length < 2) {
    return null;
  }

  const firstArg = node.arguments[0];
  if (!firstArg) {
    return null;
  }

  let attrName;
  if (t.isStringLiteral(firstArg)) {
    attrName = firstArg.value.toLowerCase();
  } else if (t.isIdentifier(firstArg) && scope) {
    const resolved = resolveIdentifierToString(firstArg, scope);
    if (!resolved) {

      return { ...candidates[0], kind: `jquery.${methodName}.dynamic`, paramUnresolvable: true };
    }
    attrName = resolved.toLowerCase();
  } else {

    return { ...candidates[0], kind: `jquery.${methodName}.dynamic`, paramUnresolvable: true };
  }

  for (const def of candidates) {
    const segs = def.kind.split('.');
    const expectedAttr = segs[segs.length - 1].toLowerCase();
    if (attrName === expectedAttr) {
      return def;
    }
  }

  return null;
}

function extractReceiver(def, node) {
  if (def.pattern === 'methodCall' && t.isMemberExpression(node.callee)) {
    return node.callee.object;
  }
  if (def.pattern === 'propAssign' && t.isMemberExpression(node.left)) {
    return node.left.object;
  }
  return null;
}

function isLocationNode(node) {
  if (t.isIdentifier(node) && node.name === 'location') return true;
  if (
    t.isMemberExpression(node) &&
    !node.computed &&
    t.isIdentifier(node.property) &&
    node.property.name === 'location'
  ) return true;
  return false;
}

function isDocumentNode(node) {
  if (t.isIdentifier(node) && node.name === 'document') return true;
  if (
    t.isMemberExpression(node) &&
    !node.computed &&
    t.isIdentifier(node.property) &&
    node.property.name === 'document'
  ) return true;
  return false;
}

function resolveNode(node, scope, depth) {
  if (depth >= MAX_BINDING_DEPTH) return node;
  if (!scope) return node;

  if (t.isConditionalExpression(node)) {
    const consequent = node.consequent;
    const alternate = node.alternate;

    const alternateIsNullLike =
      t.isNullLiteral(alternate) ||
      (t.isIdentifier(alternate) && alternate.name === 'undefined') ||
      alternate === null;

    if (alternateIsNullLike && consequent) {
      return resolveNode(consequent, scope, depth + 1);
    }

    return node;
  }

  if (!t.isIdentifier(node)) return node;

  const binding = scope.getBinding(node.name);
  if (!binding) return node;

  if (binding.constantViolations.length > 0) return node;

  const declNode = binding.path.node;
  if (!t.isVariableDeclarator(declNode) || !declNode.init) return node;

  return resolveNode(declNode.init, scope, depth + 1);
}

function resolveNodeToString(node, scope, depth = 0) {
  if (depth > MAX_BINDING_DEPTH) return null;

  if (t.isStringLiteral(node)) return node.value;

  if (t.isIdentifier(node) && scope) {
    const binding = scope.getBinding(node.name);
    if (!binding || binding.constantViolations.length > 0) return null;
    const declNode = binding.path.node;
    if (!t.isVariableDeclarator(declNode) || !declNode.init) return null;
    return resolveNodeToString(declNode.init, scope, depth + 1);
  }

  if (t.isBinaryExpression(node) && node.operator === '+') {
    const left = resolveNodeToString(node.left, scope, depth);
    if (left === null) return null;
    const right = resolveNodeToString(node.right, scope, depth);
    if (right === null) return null;
    return left + right;
  }

  if (t.isTemplateLiteral(node)) {
    const parts = [];
    for (let i = 0; i < node.quasis.length; i++) {
      const cooked = node.quasis[i].value.cooked;
      if (cooked == null) return null;
      parts.push(cooked);
      if (i < node.expressions.length) {
        const val = resolveNodeToString(node.expressions[i], scope, depth);
        if (val === null) return null;
        parts.push(val);
      }
    }
    return parts.join('');
  }

  return null;
}

function resolveIdentifierToString(node, scope, depth = 0) {
  if (!t.isIdentifier(node) || !scope) return null;
  if (depth > MAX_BINDING_DEPTH) return null;

  const binding = scope.getBinding(node.name);
  if (!binding || binding.constantViolations.length > 0) return null;

  const declNode = binding.path.node;
  if (!t.isVariableDeclarator(declNode) || !declNode.init) return null;

  return resolveNodeToString(declNode.init, scope, depth + 1);
}

function matchJQueryReceiver(node, scope) {
  const resolved = resolveNode(node, scope, 0);

  if (t.isCallExpression(resolved) && t.isIdentifier(resolved.callee) &&
      (resolved.callee.name === '$' || resolved.callee.name === 'jQuery')) {
    return true;
  }

  if (t.isCallExpression(resolved) && t.isMemberExpression(resolved.callee)) {
    const obj = resolved.callee.object;
    if (t.isCallExpression(obj) && t.isIdentifier(obj.callee) &&
        (obj.callee.name === '$' || obj.callee.name === 'jQuery')) {
      return true;
    }
  }

  return null;
}

function matchElementReceiver(elementType, node, scope) {
  const resolved = resolveNode(node, scope, 0);

  if (t.isCallExpression(resolved) && t.isMemberExpression(resolved.callee) && !resolved.callee.computed) {
    const methodName = t.isIdentifier(resolved.callee.property) ? resolved.callee.property.name : null;
    if (methodName === 'createElement' && resolved.arguments.length >= 1 && t.isStringLiteral(resolved.arguments[0])) {
      return resolved.arguments[0].value.toLowerCase() === elementType ? true : false;
    }
    if (methodName === 'createElementNS' && resolved.arguments.length >= 2 && t.isStringLiteral(resolved.arguments[1])) {
      return resolved.arguments[1].value.toLowerCase() === elementType ? true : false;
    }
  }

  if (t.isNewExpression(resolved) && t.isIdentifier(resolved.callee)) {
    const mappedType = CTOR_TO_ELEMENT_TYPE[resolved.callee.name];
    if (mappedType !== undefined) {
      return mappedType === elementType ? true : false;
    }
    return null;
  }

  if (t.isIdentifier(resolved)) return null;

  return null;
}

function matchReceiver(receiverType, node, scope) {
  if (!receiverType || !node) return true;

  const resolved = resolveNode(node, scope, 0);

  switch (receiverType) {
    case 'location':
      if (isLocationNode(resolved)) return true;
      if (t.isIdentifier(resolved)) return null;
      return false;
    case 'window':
      if (t.isIdentifier(resolved) && resolved.name === 'window') return true;
      if (t.isIdentifier(resolved)) return null;
      return false;
    case 'document':
      if (isDocumentNode(resolved)) return true;
      if (t.isIdentifier(resolved)) return null;
      return false;
    case 'navigator.serviceWorker':
      if (
        t.isMemberExpression(resolved) &&
        !resolved.computed &&
        t.isIdentifier(resolved.object) &&
        resolved.object.name === 'navigator' &&
        t.isIdentifier(resolved.property) &&
        resolved.property.name === 'serviceWorker'
      ) return true;
      if (t.isIdentifier(resolved)) return null;
      return false;
    default:
      return true;
  }
}

module.exports = {
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
};
