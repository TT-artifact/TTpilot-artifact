const fs = require('fs');
const traverse = require('@babel/traverse').default;
const babelParser = require('@babel/parser');
const recast = require('recast');
const { parseSource } = require('./parser');
const { extractScripts } = require('./htmlExtractor');
const { findReceiverBounds } = require('./detector');

const BABEL_OPTIONS = {
  sourceType: 'unambiguous',
  errorRecovery: true,
  allowReturnOutsideFunction: true,
  allowImportExportEverywhere: true,
  plugins: [
    'jsx',
    'typescript',
    'classProperties',
    'objectRestSpread',
    'optionalChaining',
    'exportDefaultFrom',
    'exportNamespaceFrom',
    'logicalAssignment',
  ],
};

const RECAST_OPTIONS = {
  tabWidth: 1,
  parser: { parse: src => babelParser.parse(src, BABEL_OPTIONS) },
};

const STRATEGY_NODE_TYPES = {
  wrapRHS:         new Set(['AssignmentExpression', 'CallExpression']),
  wrapRHS2:        new Set(['AssignmentExpression']),
  wrapArgument:    new Set(['CallExpression', 'NewExpression']),
  dispatchDynamic: new Set(['CallExpression']),
  replaceNode:     new Set(['AssignmentExpression', 'CallExpression', 'NewExpression',
                            'MemberExpression', 'Identifier', 'JSXAttribute']),
};

function matchesStrategyType(nodeType, strategy) {
  const allowed = STRATEGY_NODE_TYPES[strategy];
  return allowed ? allowed.has(nodeType) : true;
}

const AST_METADATA_KEYS = new Set([
  'loc', 'start', 'end', 'range', 'extra',
  'leadingComments', 'trailingComments', 'innerComments', 'tokens',
]);

function forEachChildNode(node, visit) {
  for (const key of Object.keys(node)) {
    if (AST_METADATA_KEYS.has(key)) continue;
    const val = node[key];
    if (!val || typeof val !== 'object') continue;
    if (Array.isArray(val)) {
      for (const child of val) {
        if (child && typeof child === 'object') visit(child);
      }
    } else {
      visit(val);
    }
  }
}

function findWrappedCall(node, sinkKey) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'CallExpression' &&
      (node.arguments || []).some(a => a.type === 'StringLiteral' && a.value === sinkKey)) {
    return node;
  }
  let found = null;
  forEachChildNode(node, child => {
    if (found) return;
    found = findWrappedCall(child, sinkKey);
  });
  return found;
}

function isAlreadyWrapped(node, sinkKey) {
  return findWrappedCall(node, sinkKey) !== null;
}

function isJQueryGuardCall(node) {
  return node?.type === 'CallExpression' &&
    node.callee?.type === 'Identifier' && node.callee.name === '__ttJQueryArg';
}

function findValueWrapper(node, sinkKey) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'CallExpression' && node.callee?.type === 'ArrowFunctionExpression' &&
      node.callee.params?.length === 1 && node.arguments?.length === 1 &&
      findWrappedCall(node.callee.body, sinkKey)) {
    return node;
  }
  let found = null;
  forEachChildNode(node, child => {
    if (found) return;
    found = findValueWrapper(child, sinkKey);
  });
  return found;
}

function isGuardedDispatchCall(callNode) {
  return callNode?.callee?.type === 'Identifier' && callNode.callee.name === '__ttGuardedPolicyCall';
}

function wrappedCallValueArg(callNode) {
  return callNode?.arguments?.[isGuardedDispatchCall(callNode) ? 2 : 0];
}

function unwrapReceiverIIFE(iifeNode, sinkKey, code) {
  const arrowFn = iifeNode.callee;
  if (arrowFn?.type !== 'ArrowFunctionExpression') return null;
  const receiverArg = iifeNode.arguments?.[0];
  const paramName = arrowFn.params?.[0]?.name;
  const bodyNode = arrowFn.body;
  if (!receiverArg || !paramName || !bodyNode) return null;
  if (code.slice(bodyNode.start, bodyNode.start + paramName.length) !== paramName) return null;

  const valueNode = findValueWrapper(bodyNode, sinkKey) || findWrappedCall(bodyNode, sinkKey);
  const innerArg = valueNode && wrappedCallValueArg(valueNode);
  if (!valueNode || !innerArg) return null;

  const receiverText = code.slice(receiverArg.start, receiverArg.end);
  return receiverText
    + code.slice(bodyNode.start + paramName.length, valueNode.start)
    + code.slice(innerArg.start, innerArg.end)
    + code.slice(valueNode.end, bodyNode.end);
}

function unwrapReceiverCompoundAssignIIFE(path, sinkKey, code) {
  const arrowPath = path.parentPath;
  const iifePath = arrowPath?.parentPath;
  const arrowFn = arrowPath?.node;
  const iifeNode = iifePath?.node;
  if (arrowFn?.type !== 'ArrowFunctionExpression' || arrowFn.body !== path.node) return null;
  if (iifeNode?.type !== 'CallExpression' || iifeNode.callee !== arrowFn) return null;

  const paramName = arrowFn.params?.[0]?.type === 'Identifier' ? arrowFn.params[0].name : null;
  const receiverArg = iifeNode.arguments?.[0];
  const assignment = path.node;
  if (!paramName || !receiverArg || assignment.type !== 'AssignmentExpression' || assignment.operator !== '=') return null;

  const wrappedCall = assignment.right;
  if (!isGuardedDispatchCall(wrappedCall)) return null;
  const keyArg = wrappedCall.arguments?.[3];
  if (keyArg?.type !== 'StringLiteral' || keyArg.value !== sinkKey) return null;

  const combinedValue = wrappedCallValueArg(wrappedCall);
  if (combinedValue?.type !== 'BinaryExpression' || combinedValue.operator !== '+') return null;

  const lhsText = code.slice(assignment.left.start, assignment.left.end);

  let repeatedLhs = combinedValue;
  while (repeatedLhs?.type === 'BinaryExpression' && repeatedLhs.operator === '+') {
    repeatedLhs = repeatedLhs.left;
  }
  if (!repeatedLhs) return null;
  const repeatedLhsText = code.slice(repeatedLhs.start, repeatedLhs.end);
  if (lhsText !== repeatedLhsText || !lhsText.startsWith(paramName)) return null;
  const lhsSuffix = lhsText.slice(paramName.length);
  if (!lhsSuffix || !/^\s*[?.\[]/.test(lhsSuffix)) return null;

  const receiverText = code.slice(receiverArg.start, receiverArg.end);
  const remainder = code.slice(repeatedLhs.end, combinedValue.end);
  const plusMatch = remainder.match(/^\s*\+\s*/);
  if (!plusMatch) return null;
  const rhsText = remainder.slice(plusMatch[0].length);
  if (!receiverText || !rhsText) return null;
  return {
    start: iifeNode.start,
    end: iifeNode.end,
    replacement: `${receiverText}${lhsSuffix} += ${rhsText}`,
  };
}

function isNodeAlreadyPatched(node, finding) {
  return isAlreadyWrapped(node, finding.sink_key);
}

function parseWithRecast(source, startLine) {
  const opts = startLine != null
    ? { ...RECAST_OPTIONS, parser: { parse: src => babelParser.parse(src, { ...BABEL_OPTIONS, startLine }) } }
    : RECAST_OPTIONS;
  try {
    return { ast: recast.parse(source, opts), useRecast: true };
  } catch {
    const babelOpts = startLine != null ? { ...BABEL_OPTIONS, startLine } : BABEL_OPTIONS;
    try {
      return { ast: babelParser.parse(source, babelOpts), useRecast: false };
    } catch {
      return { ast: null, useRecast: false };
    }
  }
}

function findNodesForFindings(ast, findings, offset) {
  const result = new Map();
  const pending = findings.filter(f => f.node_start != null);

  const hasNestedPending = (finding, nodeStart, nodeEnd) => pending.some(other =>
    other.id !== finding.id &&
    !result.has(other.id) &&
    other.node_start != null && other.node_end != null &&
    (other.node_start - offset) >= nodeStart &&
    (other.node_end - offset) <= nodeEnd &&
    ((other.node_start - offset) > nodeStart || (other.node_end - offset) < nodeEnd)
  );

  const tentativeFresh = new Map();
  traverse(ast, {
    enter(path) {
      if (path.node.start == null) return;
      for (const f of pending) {
        if (result.has(f.id) || tentativeFresh.has(f.id)) continue;
        if (!matchesStrategyType(path.node.type, f.patch_strategy)) continue;
        if (path.node.start === (f.node_start - offset) &&
            path.node.end   === (f.node_end   - offset)) {

          const alreadyPatched = isNodeAlreadyPatched(path.node, f);
          if (alreadyPatched) {
            result.set(f.id, { path, alreadyPatched: true });

            if (!hasNestedPending(f, path.node.start, path.node.end)) path.skip();
          } else {
            tentativeFresh.set(f.id, { path, alreadyPatched: false });
          }
          return;
        }
      }
    },
  });

  const stillPending = pending.filter(f => !result.has(f.id));
  if (stillPending.length === 0) {
    for (const [id, entry] of tentativeFresh) result.set(id, entry);
    return result;
  }

  traverse(ast, {
    enter(path) {
      if (path.node.start == null) return;
      for (const f of stillPending) {
        if (result.has(f.id)) continue;
        if (!matchesStrategyType(path.node.type, f.patch_strategy)) continue;
        if (path.node.start !== (f.node_start - offset)) continue;
        if (isNodeAlreadyPatched(path.node, f)) {
          result.set(f.id, { path, alreadyPatched: true });
          if (!hasNestedPending(f, path.node.start, path.node.end)) path.skip();
          return;
        }
      }
    },
  });

  const markerPending = stillPending.filter(f => !result.has(f.id));
  if (markerPending.length > 0) {
    traverse(ast, {
      enter(path) {
        for (const f of markerPending) {
          if (result.has(f.id)) continue;
          if (!matchesStrategyType(path.node.type, f.patch_strategy)) continue;
          if (isNodeAlreadyPatched(path.node, f)) {
            result.set(f.id, { path, alreadyPatched: true, recoveredByMarker: true });
            return;
          }
        }
      },
    });
  }

  for (const [id, entry] of tentativeFresh) {
    if (!result.has(id)) result.set(id, entry);
  }

  return result;
}

function hasOuterParens(s) {
  if (!s.startsWith('(') || !s.endsWith(')')) return false;
  try {
    const expr = babelParser.parseExpression(s, BABEL_OPTIONS);

    return expr.start > 0 || expr.end < s.length;
  } catch {

    return false;
  }
}

function isStatementLevelReplacement(path) {
  const stmtPath = path.parentPath;
  const parent = stmtPath && stmtPath.node;
  if (!parent || parent.type !== 'ExpressionStatement' || parent.expression !== path.node) return false;

  return !!stmtPath.inList;
}

function applyFullNodeSuggestion(path, finding, code) {
  let suggestion = finding.refactor_suggestion;
  if (!suggestion) {
    return { id: finding.id, status: 'error', message: `${finding.patch_strategy} requires refactor_suggestion` };
  }

  if (hasOuterParens(suggestion)) suggestion = suggestion.slice(1, -1);
  if (isStatementLevelReplacement(path)) suggestion = ';' + suggestion;

  const origText = code.slice(path.node.start, path.node.end);
  const origLines = (origText.match(/\n/g) || []).length;
  const replLines = (suggestion.match(/\n/g) || []).length;
  if (origLines > replLines) suggestion += '\n'.repeat(origLines - replLines);
  return {
    id: finding.id, status: 'ok',
    textPatch: { start: path.node.start, end: path.node.end, replacement: suggestion }
  };
}

function applyComposableSuggestion(path, finding, code, offset) {
  const suggestion = finding.refactor_suggestion;
  if (!suggestion) {
    return { id: finding.id, status: 'error', message: `${finding.patch_strategy} requires refactor_suggestion` };
  }
  if (finding.arg_start == null || finding.arg_end == null) {
    return applyFullNodeSuggestion(path, finding, code);
  }
  const argStart = finding.arg_start - offset;
  const argEnd = finding.arg_end - offset;
  const argText = code.slice(argStart, argEnd);
  let body = suggestion;
  if (hasOuterParens(body)) body = body.slice(1, -1);
  const idx = argText ? body.indexOf(argText) : -1;
  if (idx === -1) {

    return applyFullNodeSuggestion(path, finding, code);
  }

  const nodeStart = path.node.start;
  let prefixText = body.slice(0, idx);
  let suffixText = body.slice(idx + argText.length);
  const parts = [];
  if (isStatementLevelReplacement(path)) parts.push({ type: 'static', text: ';' });

  const originalLead = code.slice(nodeStart, argStart);
  if (originalLead && prefixText.startsWith(originalLead)) {
    parts.push({ type: 'live', from: nodeStart, to: argStart });
    prefixText = prefixText.slice(originalLead.length);
  }
  parts.push({ type: 'static', text: prefixText });
  parts.push({ type: 'live', from: argStart, to: argEnd });

  const strategyPattern = path.node.type === 'AssignmentExpression' ? 'propAssign' : 'methodCall';
  const receiverBounds = findReceiverBounds(strategyPattern, path.node, code);
  let matchedTail = false;
  if (receiverBounds) {
    const receiverText = code.slice(receiverBounds.start, receiverBounds.end);
    const tailMarker = `(${receiverText})`;
    if (receiverText && suffixText.endsWith(tailMarker)) {
      parts.push({ type: 'static', text: suffixText.slice(0, suffixText.length - tailMarker.length) + '(' });
      parts.push({ type: 'live', from: receiverBounds.start, to: receiverBounds.end });
      parts.push({ type: 'static', text: ')' });
      matchedTail = true;
    }
  }
  if (!matchedTail) {
    parts.push({ type: 'static', text: suffixText });
  }

  return {
    id: finding.id, status: 'ok',
    textPatch: { start: path.node.start, end: path.node.end, parts }
  };
}

function applyAction(path, finding, alreadyPatched, offset, code) {
  const action = finding.action || 'patch';
  const { patch_strategy, patch_wrapper, sink_key } = finding;

  if (patch_strategy === 'wrapRHS') {

    if (!alreadyPatched) {
      if (action === 'unpatch') return { id: finding.id, status: 'ok', note: 'not_patched' };
      return applyComposableSuggestion(path, finding, code, offset);
    }

    const wrappedCall = findWrappedCall(path.node, sink_key);
    if (!wrappedCall) return { id: finding.id, status: 'error', message: 'wrapped call not found' };

    if (action === 'unpatch') {
      const isReceiverIIFE = path.node.type === 'CallExpression' && path.node.callee?.type === 'ArrowFunctionExpression';
      if (isReceiverIIFE) {
        const reconstructed = unwrapReceiverIIFE(path.node, sink_key, code);
        if (!reconstructed) return { id: finding.id, status: 'error', message: 'cannot unwrap receiver-checked patch' };
        return {
          id: finding.id, status: 'ok',
          textPatch: { start: path.node.start, end: path.node.end, replacement: reconstructed }
        };
      }

      const innerExpr = wrappedCallValueArg(wrappedCall);
      if (!innerExpr) return { id: finding.id, status: 'error', message: 'wrapped call value argument not found' };
      return {
        id: finding.id, status: 'ok',
        textPatch: { start: wrappedCall.start, end: wrappedCall.end,
                     replacement: code.slice(innerExpr.start, innerExpr.end) }
      };
    }

    if (action === 'patch') {
      return { id: finding.id, status: 'ok', note: 'already_patched' };
    }

    if (isGuardedDispatchCall(wrappedCall)) {
      const policyArg = wrappedCall.arguments?.[0];
      if (policyArg?.start == null) return { id: finding.id, status: 'error', message: 'guarded dispatch policy argument not found' };
      return {
        id: finding.id, status: 'ok',
        textPatch: { start: policyArg.start, end: policyArg.end, replacement: patch_wrapper.split('.')[0] }
      };
    }
    if (wrappedCall.callee?.start == null) return { id: finding.id, status: 'error', message: 'wrapped policy callee not found' };
    return {
      id: finding.id, status: 'ok',
      textPatch: { start: wrappedCall.callee.start, end: wrappedCall.callee.end, replacement: patch_wrapper }
    };

  } else if (patch_strategy === 'wrapRHS2') {

    if (action === 'patch' && alreadyPatched) {
      return { id: finding.id, status: 'ok', note: 'already_patched' };
    }

    if (action === 'unpatch') {
      if (!alreadyPatched) return { id: finding.id, status: 'ok', note: 'not_patched' };
      const receiverCompound = unwrapReceiverCompoundAssignIIFE(path, sink_key, code);
      if (receiverCompound) {
        return { id: finding.id, status: 'ok', textPatch: receiverCompound };
      }
      if (path.node.type !== 'AssignmentExpression') {
        return { id: finding.id, status: 'error', message: 'unsupported compound-assign patch shape' };
      }
      const wrapCall = path.node.right;
      if (isGuardedDispatchCall(wrapCall)) {
        return { id: finding.id, status: 'error', message: 'cannot safely unwrap receiver-checked compound assignment' };
      }
      if (wrapCall?.type !== 'CallExpression') {
        return { id: finding.id, status: 'error', message: 'compound-assign wrapper call not found' };
      }
      const binExpr  = wrapCall.arguments[0];
      if (binExpr?.type !== 'BinaryExpression' || binExpr.operator !== '+' || !binExpr.right) {
        return { id: finding.id, status: 'error', message: 'compound-assign wrapped value has unexpected shape' };
      }
      const origRhs  = binExpr.right;
      const lhsSrc   = code.slice(path.node.left.start, path.node.left.end);
      const rhsSrc   = code.slice(origRhs.start, origRhs.end);
      return {
        id: finding.id, status: 'ok',
        textPatch: { start: path.node.start, end: path.node.end,
                     replacement: `${lhsSrc} += ${rhsSrc}` }
      };
    }

    if (alreadyPatched) {

      const wrappedCall = findWrappedCall(path.node, sink_key);
      if (!wrappedCall) return { id: finding.id, status: 'error', message: 'wrapped call not found' };
      if (isGuardedDispatchCall(wrappedCall)) {
        const policyArg = wrappedCall.arguments?.[0];
        if (policyArg?.start == null) return { id: finding.id, status: 'error', message: 'guarded dispatch policy argument not found' };
        return {
          id: finding.id, status: 'ok',
          textPatch: { start: policyArg.start, end: policyArg.end, replacement: patch_wrapper.split('.')[0] }
        };
      }
      if (wrappedCall.callee?.start == null) return { id: finding.id, status: 'error', message: 'wrapped policy callee not found' };
      return {
        id: finding.id, status: 'ok',
        textPatch: { start: wrappedCall.callee.start, end: wrappedCall.callee.end, replacement: patch_wrapper }
      };
    }

    return applyFullNodeSuggestion(path, finding, code);

  } else if (patch_strategy === 'wrapArgument') {

    if (!alreadyPatched) {
      if (action === 'unpatch') return { id: finding.id, status: 'ok', note: 'not_patched' };
      return applyComposableSuggestion(path, finding, code, offset);
    }

    const wrappedCall = findWrappedCall(path.node, sink_key);
    if (!wrappedCall) return { id: finding.id, status: 'error', message: 'wrapped call not found' };

    if (action === 'unpatch') {
      const isReceiverIIFE = path.node.callee?.type === 'ArrowFunctionExpression';
      if (isReceiverIIFE) {
        const reconstructed = unwrapReceiverIIFE(path.node, sink_key, code);
        if (!reconstructed) return { id: finding.id, status: 'error', message: 'cannot unwrap receiver-checked patch' };
        return {
          id: finding.id, status: 'ok',
          textPatch: { start: path.node.start, end: path.node.end, replacement: reconstructed }
        };
      }

      const valueNode = findValueWrapper(path.node, sink_key) || wrappedCall;
      const innerArg = wrappedCallValueArg(valueNode);
      if (!innerArg) return { id: finding.id, status: 'error', message: 'wrapped call value argument not found' };
      return {
        id: finding.id, status: 'ok',
        textPatch: { start: valueNode.start, end: valueNode.end,
                     replacement: code.slice(innerArg.start, innerArg.end) }
      };
    }

    if (action === 'patch') {

      const isCorrectlyPatched = finding.with_value_guard === 'jquery' ? isJQueryGuardCall(wrappedCall) : true;
      if (isCorrectlyPatched) {
        return { id: finding.id, status: 'ok', note: 'already_patched' };
      }
      return applyFullNodeSuggestion(path, finding, code);
    }

    if (isJQueryGuardCall(wrappedCall)) {
      const policyArg = wrappedCall.arguments[3];
      if (policyArg?.start == null || policyArg.end == null) {
        return { id: finding.id, status: 'error', message: 'jquery guard policy argument not found' };
      }
      return {
        id: finding.id, status: 'ok',
        textPatch: { start: policyArg.start, end: policyArg.end, replacement: patch_wrapper }
      };
    }

    if (isGuardedDispatchCall(wrappedCall)) {
      const policyArg = wrappedCall.arguments?.[0];
      if (policyArg?.start == null) return { id: finding.id, status: 'error', message: 'guarded dispatch policy argument not found' };
      return {
        id: finding.id, status: 'ok',
        textPatch: { start: policyArg.start, end: policyArg.end, replacement: patch_wrapper.split('.')[0] }
      };
    }
    if (wrappedCall.callee?.start == null) return { id: finding.id, status: 'error', message: 'wrapped policy callee not found' };
    return {
      id: finding.id, status: 'ok',
      textPatch: { start: wrappedCall.callee.start, end: wrappedCall.callee.end, replacement: patch_wrapper }
    };

  } else if (patch_strategy === 'dispatchDynamic') {

    if (action === 'unpatch') {
      return { id: finding.id, status: 'error', message: 'unpatch not supported for dispatchDynamic strategy' };
    }
    if (alreadyPatched) {
      return { id: finding.id, status: 'ok', note: 'already_patched' };
    }
    return applyFullNodeSuggestion(path, finding, code);

  } else if (patch_strategy === 'replaceNode') {
    if (action === 'unpatch') {
      return { id: finding.id, status: 'error', message: 'unpatch not supported for replaceNode strategy' };
    }
    return applyFullNodeSuggestion(path, finding, code);

  } else {
    return { id: finding.id, status: 'error', message: `unknown patch_strategy: ${patch_strategy}` };
  }
}

function nestedDepth(finding, findings) {
  if (finding.node_start == null || finding.node_end == null) return 0;
  return findings.filter(other => other.id !== finding.id &&
    other.node_start != null && other.node_end != null &&
    other.node_start <= finding.node_start && other.node_end >= finding.node_end &&
    (other.node_start < finding.node_start || other.node_end > finding.node_end)).length;
}

function findFixedReplacementConflict(results) {
  const patches = results.filter(result => result.status === 'ok' && !result.note && result.textPatch);
  for (const outer of patches) {
    const { start, end, parts, replacement } = outer.textPatch;
    if (replacement !== undefined) {

      const inner = patches.find(candidate => candidate.id !== outer.id &&
        candidate.textPatch.start >= start && candidate.textPatch.end <= end &&
        (candidate.textPatch.start > start || candidate.textPatch.end < end));
      if (inner) return { outer: outer.id, inner: inner.id };
      continue;
    }
    if (!parts) continue;

    const liveWindows = parts.filter(p => p.type === 'live');
    const inner = patches.find(candidate => candidate.id !== outer.id &&
      candidate.textPatch.start >= start && candidate.textPatch.end <= end &&
      (candidate.textPatch.start > start || candidate.textPatch.end < end) &&
      !liveWindows.some(w => candidate.textPatch.start >= w.from && candidate.textPatch.end <= w.to));
    if (inner) return { outer: outer.id, inner: inner.id };
  }
  return null;
}

function expressionName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression' && !node.computed) {
    const object = expressionName(node.object);
    const property = expressionName(node.property);
    return object && property ? `${object}.${property}` : null;
  }
  return null;
}

function buildMarkerVerificationIndex(source) {
  const { ast } = parseWithRecast(source);
  if (!ast) return null;
  const index = new Map();
  traverse(ast, {
    StringLiteral(path) {
      if (!/^S-[^:]+:/.test(path.node.value)) return;
      const call = path.parentPath?.node;
      if (call?.type !== 'CallExpression') return;
      let callee = expressionName(call.callee);

      if (callee === '__ttGuardedPolicyCall') {
        const policyArg = expressionName(call.arguments?.[0]);
        const methodArg = call.arguments?.[1];
        const methodName = methodArg?.type === 'StringLiteral' ? methodArg.value : null;
        if (policyArg && methodName) callee = `${policyArg}.${methodName}`;
      }
      const entry = { callee, jqueryGuard: callee === '__ttJQueryArg', jqueryPolicy: null };
      if (entry.jqueryGuard) entry.jqueryPolicy = expressionName(call.arguments?.[3]);
      index.set(path.node.value, entry);
    },
  });
  return index;
}

function verifyFinding(source, finding, verificationIndex) {
  const action = finding.action || 'patch';
  const quotedDouble = `"${finding.sink_key}"`;
  const quotedSingle = `'${finding.sink_key}'`;
  const markerIndex = Math.max(source.indexOf(quotedDouble), source.indexOf(quotedSingle));

  if (action === 'unpatch') {
    return markerIndex === -1
      ? null
      : `sink marker remains after unpatch: ${finding.sink_key}`;
  }

  if (finding.patch_strategy === 'replaceNode') return null;
  if (markerIndex === -1) return `sink marker missing after patch: ${finding.sink_key}`;

  const structural = verificationIndex?.get?.(finding.sink_key);
  if (structural) {
    if (finding.with_value_guard === 'jquery') {
      if (!structural.jqueryGuard) return `jQuery guard missing for ${finding.sink_key}`;
      if (finding.patch_wrapper && structural.jqueryPolicy !== finding.patch_wrapper) {
        return `expected policy ${finding.patch_wrapper} missing for ${finding.sink_key}`;
      }
      return null;
    }
    if (finding.patch_wrapper && structural.callee !== finding.patch_wrapper) {
      return `expected policy ${finding.patch_wrapper} missing for ${finding.sink_key}`;
    }
    return null;
  }

  const verificationRadius = Math.max(
    300,
    ((finding.node_end ?? 0) - (finding.node_start ?? 0)) + 256
  );
  const context = source.slice(
    Math.max(0, markerIndex - verificationRadius),
    markerIndex + verificationRadius
  );
  if (finding.with_value_guard === 'jquery' && !context.includes('__ttJQueryArg')) {
    return `jQuery guard missing for ${finding.sink_key}`;
  }

  if (finding.patch_wrapper) {
    const [policyName, methodName] = finding.patch_wrapper.split('.');
    const guardedPattern = methodName
      ? new RegExp(`__ttGuardedPolicyCall\\(\\s*${policyName}\\s*,\\s*["']${methodName}["']`)
      : null;
    const matched = context.includes(finding.patch_wrapper) || (guardedPattern && guardedPattern.test(context));
    if (!matched) return `expected policy ${finding.patch_wrapper} missing for ${finding.sink_key}`;
  }
  return null;
}

function finalizeFileResults(results, findings, patchedSource) {
  const byId = new Map(findings.map(finding => [finding.id, finding]));
  const verificationIndex = buildMarkerVerificationIndex(patchedSource);
  const verificationErrors = [];
  const finalized = results.map(result => {
    const finding = byId.get(result.id);
    const depth = finding ? nestedDepth(finding, findings) : 0;
    if (result.status !== 'ok' || !finding) return { ...result, verified: false, nested_depth: depth };
    const error = verifyFinding(patchedSource, finding, verificationIndex);
    if (error) verificationErrors.push({ id: result.id, error });
    return error
      ? { ...result, status: 'error', message: error, verified: false, nested_depth: depth }
      : { ...result, verified: true, nested_depth: depth };
  });
  const valid = verificationErrors.length === 0 &&
    finalized.every(result => result.status === 'ok');
  if (valid) return { results: finalized, valid: true };
  return {
    valid: false,
    results: finalized.map(result => result.status === 'ok'
      ? {
          ...result,
          status: 'error',
          verified: false,
          message: 'file patch aborted because a sibling finding failed',
        }
      : result),
  };
}

async function patchFiles(input) {
  const results = [];
  for (const { file, findings } of input) {
    const seenKeys = new Set();
    const duplicateKeys = new Set();
    for (const finding of findings) {
      if (seenKeys.has(finding.sink_key)) duplicateKeys.add(finding.sink_key);
      seenKeys.add(finding.sink_key);
    }
    if (duplicateKeys.size > 0) {
      const keys = [...duplicateKeys].join(', ');
      findings.forEach(finding => results.push({
        id: finding.id,
        status: 'error',
        verified: false,
        conflict_reason: `duplicate sink identity in file payload: ${keys}`,
        message: 'rerun detection to allocate occurrence-specific sink keys',
      }));
      continue;
    }
    try {
      const source = fs.readFileSync(file, 'utf-8');
      const ext = file.toLowerCase().match(/\.\w+$/)?.[0] || '';
      const isHtml = ['.html', '.htm'].includes(ext);
      results.push(...(isHtml ? patchHtmlFile(file, source, findings) : patchJsFile(file, source, findings)));
    } catch (err) {
      findings.forEach(f => results.push({ id: f.id, status: 'error', message: String(err) }));
    }
  }
  return results;
}

function sortTextPatchesBackToFront(textPatches) {
  textPatches.sort((a, b) =>
    (b.textPatch.start - a.textPatch.start) || (a.textPatch.end - b.textPatch.end));
}

function resolveReplacement(textPatch, patchedClean, applied) {
  const { replacement, parts } = textPatch;
  if (replacement !== undefined) return replacement;

  return parts.map(part => {
    if (part.type === 'static') return part.text;

    let { from, to } = part;
    for (const adj of applied) {
      if (adj.origStart < from) {

        from += adj.delta;
        to += adj.delta;
      } else if (adj.origStart < to) {

        to += adj.delta;
      }
    }
    return patchedClean.slice(from, to);
  }).join('');
}

function patchJsFile(file, source, findings) {
  const bomOffset = source.charCodeAt(0) === 0xFEFF ? 1 : 0;
  const cleanSource = bomOffset ? source.slice(1) : source;
  const { ast } = parseWithRecast(cleanSource);
  if (!ast) return findings.map(f => ({ id: f.id, status: 'error', message: 'parse failed' }));

  const nodeMap = findNodesForFindings(ast, findings, bomOffset);
  const results = findings.map(f => {
    if (f.node_start == null) return { id: f.id, status: 'error', message: 'no offset information' };
    const resolved = nodeMap.get(f.id);
    if (!resolved) return { id: f.id, status: 'error', message: `node not found at offset ${f.node_start}-${f.node_end}` };
    return applyAction(resolved.path, f, resolved.alreadyPatched, bomOffset, cleanSource);
  });

  const anyOk = results.some(r => r.status === 'ok' && !r.note);
  if (!anyOk) return results;

  const conflict = findFixedReplacementConflict(results);
  if (conflict) {
    return results.map(result => result.status === 'ok'
      ? {
          ...result,
          status: 'error',
          verified: false,
          conflict_reason: `fixed replacement ${conflict.outer} contains nested patch ${conflict.inner}`,
          message: 'non-composable nested patch conflict',
        }
      : result);
  }

  const textPatches = results.filter(r => r.status === 'ok' && !r.note && r.textPatch);
  sortTextPatchesBackToFront(textPatches);

  let patchedClean = cleanSource;
  const applied = [];
  for (const r of textPatches) {
    const { start, end } = r.textPatch;

    let adjustedEnd = end;
    for (const adj of applied) {
      if (adj.origStart >= start && adj.origStart < end) adjustedEnd += adj.delta;
    }
    const rep = resolveReplacement(r.textPatch, patchedClean, applied);
    applied.push({ origStart: start, delta: rep.length - (adjustedEnd - start) });
    patchedClean = patchedClean.slice(0, start) + rep + patchedClean.slice(adjustedEnd);
  }
  const patched = (bomOffset ? '﻿' : '') + patchedClean;

  const { ast: originalAst } = parseSource(cleanSource, file);
  const originalErrors = originalAst?.errors?.length ?? 0;
  const { ast: reparsedAst } = parseSource(patched, file);
  const patchedErrors = reparsedAst?.errors?.length ?? 0;

  if (!reparsedAst || patchedErrors > originalErrors) {
    return results.map(r =>
      r.status === 'ok' && !r.note
        ? { id: r.id, status: 'error', message: 'invalid syntax after patching' }
        : r
    );
  }

  const finalized = finalizeFileResults(results, findings, patched);
  if (!finalized.valid) return finalized.results;

  try {
    fs.writeFileSync(file, patched, 'utf-8');
  } catch (writeErr) {
    return results.map(r =>
      r.status === 'ok' && !r.note
        ? { id: r.id, status: 'error', message: 'failed to write file' }
        : r
    );
  }

  return finalized.results;
}

function patchHtmlFile(file, source, findings) {

  const allBlocks = extractScripts(source);

  const blocks = [...allBlocks].sort((a, b) => b.innerStart - a.innerStart);

  let patched = source;
  const blockResults = new Map();
  const unhandled = new Set(findings.map(f => f.id));
  let fileConflict = null;

  for (const block of blocks) {
    const blockFindings = findings.filter(f =>
      unhandled.has(f.id) && f.node_start != null &&
      f.node_start >= block.innerStart &&
      f.node_start < block.innerStart + block.source.length
    );
    if (blockFindings.length === 0) continue;

    const blockBomOffset = block.source.charCodeAt(0) === 0xFEFF ? 1 : 0;
    const cleanBlockContent = blockBomOffset ? block.source.slice(1) : block.source;
    const { ast } = parseWithRecast(cleanBlockContent);
    if (!ast) {
      blockFindings.forEach(f => {
        blockResults.set(f.id, { id: f.id, status: 'error', message: 'parse failed' });
        unhandled.delete(f.id);
      });
      continue;
    }

    const nodeMap = findNodesForFindings(ast, blockFindings, block.innerStart + blockBomOffset);
    let localResults = blockFindings.map(f => {
      const resolved = nodeMap.get(f.id);
      if (!resolved) return { id: f.id, status: 'error', message: `node not found at line ${f.line} col ${f.col}` };
      return applyAction(resolved.path, f, resolved.alreadyPatched, block.innerStart + blockBomOffset, cleanBlockContent);
    });

    const conflict = findFixedReplacementConflict(localResults);
    if (conflict) {
      fileConflict = conflict;
      localResults = localResults.map(result => result.status === 'ok'
        ? {
            ...result,
            status: 'error',
            verified: false,
            conflict_reason: `fixed replacement ${conflict.outer} contains nested patch ${conflict.inner}`,
            message: 'non-composable nested patch conflict',
          }
        : result);
    }

    const anyOk = localResults.some(r => r.status === 'ok' && !r.note);
    if (anyOk) {
      const textPatches = localResults.filter(r => r.status === 'ok' && !r.note && r.textPatch);
      sortTextPatchesBackToFront(textPatches);
      let patchedBlockClean = cleanBlockContent;
      const appliedBlock = [];
      for (const r of textPatches) {
        const { start, end } = r.textPatch;
        let adjustedEnd = end;
        for (const adj of appliedBlock) {
          if (adj.origStart >= start && adj.origStart < end) adjustedEnd += adj.delta;
        }
        const rep = resolveReplacement(r.textPatch, patchedBlockClean, appliedBlock);
        appliedBlock.push({ origStart: start, delta: rep.length - (adjustedEnd - start) });
        patchedBlockClean = patchedBlockClean.slice(0, start) + rep + patchedBlockClean.slice(adjustedEnd);
      }
      const patchedBlock = (blockBomOffset ? '﻿' : '') + patchedBlockClean;

      const hasCdata = patched.slice(block.innerStart, block.innerStart + 9) === '<![CDATA[';
      const startOffset = hasCdata ? 9 : 0;
      const replaceStart = block.innerStart + startOffset;
      patched = patched.slice(0, replaceStart) + patchedBlock + patched.slice(replaceStart + block.source.length);
    }

    localResults.forEach(r => {
      blockResults.set(r.id, r);
      unhandled.delete(r.id);
    });
  }

  unhandled.forEach(id => {
    const f = findings.find(f => f.id === id);
    blockResults.set(id, { id, status: 'error', message: `node not found at line ${f.line} col ${f.col}` });
  });

  if (fileConflict) {
    return findings.map(finding => ({
      id: finding.id,
      status: 'error',
      verified: false,
      nested_depth: nestedDepth(finding, findings),
      conflict_reason: `fixed replacement ${fileConflict.outer} contains nested patch ${fileConflict.inner}`,
      message: 'non-composable nested patch conflict',
    }));
  }

  const anyOk = [...blockResults.values()].some(r => r.status === 'ok' && !r.note);
  if (anyOk) {
    const orderedResults = findings.map(f => blockResults.get(f.id) ||
      { id: f.id, status: 'error', message: 'unhandled' });
    const finalized = finalizeFileResults(orderedResults, findings, patched);
    if (!finalized.valid) return finalized.results;
    try {
      fs.writeFileSync(file, patched, 'utf-8');
    } catch {
      return findings.map(f => {
        const r = blockResults.get(f.id) || { id: f.id, status: 'error', message: 'unknown' };
        return r.status === 'ok' && !r.note ? { id: f.id, status: 'error', message: 'failed to write file' } : r;
      });
    }
  }

  const orderedResults = findings.map(f => blockResults.get(f.id) ||
    { id: f.id, status: 'error', message: 'unhandled' });
  return finalizeFileResults(orderedResults, findings, patched).results;
}

module.exports = { patchFiles };

if (require.main === module) {
  (async () => {
    try {
      const data = fs.readFileSync('/dev/stdin', 'utf-8');
      const input = JSON.parse(data);
      const results = await patchFiles(input);
      process.stdout.write(JSON.stringify(results));
    } catch (err) {
      process.stdout.write(JSON.stringify([{ status: 'error', message: String(err) }]));
      process.exit(1);
    }
  })();
}
