const traverse = require('@babel/traverse').default;
const { parseSource } = require('./parser');
const { VERDICTS } = require('./constants');

const STRUCTURAL_TYPES = new Set(['File', 'Program']);

const ALLOWED_AST_TYPES = new Set([

  'StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'NullLiteral',

  'ArrayExpression', 'ObjectProperty', 'ObjectExpression',

  'BinaryExpression', 'UnaryExpression', 'LogicalExpression',

  'ExpressionStatement', 'BlockStatement', 'ParenthesizedExpression',
]);

function collectNodeTypes(source) {
  const { ast, error } = parseSource(source, '<script-arg>');
  if (error) return null;

  const types = new Set();
  traverse(ast, {
    enter(path) {
      const type = path.node.type;
      if (!STRUCTURAL_TYPES.has(type)) {
        types.add(type);
      }
    },
  });
  return types;
}

function analyzeScriptCode(value) {
  if (!value || !value.trim()) {
    return { verdict: VERDICTS.TYPE2, verdictReasons: ['empty'] };
  }

  const types = collectNodeTypes(value);
  if (!types) {
    return { verdict: VERDICTS.TYPE4, verdictReasons: ['parse-error'] };
  }

  const sortedTypes = [...types].sort();

  if (sortedTypes.every(t => ALLOWED_AST_TYPES.has(t))) {
    return { verdict: VERDICTS.TYPE2, verdictReasons: sortedTypes };
  }

  const unmatched = sortedTypes.filter(t => !ALLOWED_AST_TYPES.has(t));
  return { verdict: VERDICTS.TYPE4, verdictReasons: unmatched.length > 0 ? unmatched : sortedTypes };
}

module.exports = { analyzeScriptCode };
