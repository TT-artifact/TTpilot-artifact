const babelParser = require('@babel/parser');

const PARSER_OPTIONS = Object.freeze({
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
});

function parseSource(source, filename) {
  try {
    const ast = babelParser.parse(source, {
      ...PARSER_OPTIONS,
      sourceFilename: filename,
    });
    return { ast, error: null };
  } catch (err) {
    return { ast: null, error: err };
  }
}

module.exports = { parseSource };
