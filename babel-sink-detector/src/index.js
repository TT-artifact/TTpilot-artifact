#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { Command } = require('commander');
const { loadCatalog } = require('./catalog');
const { detectSinks, buildSinkLookupKey } = require('./detector');
const { extractScripts } = require('./htmlExtractor');
const { report } = require('./reporter');
const { openDb, writeFindings, clearApp, clearFile } = require('./dbWriter');

const HTML_EXTENSIONS = new Set(['.html', '.htm']);

const EXCLUDED_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.next', 'coverage', 'out', 'ThirdParty', 'Specs']);

function loadTaintedSinks(dbPath, sourceRoot) {
  try {
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare(
      'SELECT sink_file, sink_line, sink_col, sink_kind FROM dataflow_paths'
    ).all();
    db.close();

    const taintedSet = new Set();
    for (const row of rows) {

      const relFile = row.sink_file;

      let babelKind;
      if (row.sink_kind.startsWith('html.') || row.sink_kind.startsWith('scriptURL.')) {
        babelKind = row.sink_kind.split('.').slice(1).join('.');
      } else if (row.sink_kind.startsWith('script.')) {
        babelKind = row.sink_kind.slice(7);
      } else {
        babelKind = row.sink_kind;
      }

      const key = buildSinkLookupKey(relFile, row.sink_line, row.sink_col, babelKind);
      taintedSet.add(key);
    }
    return taintedSet;
  } catch (err) {
    console.warn(`Warning: Could not load tainted sinks from ${dbPath}: ${err.message}`);
    return new Set();
  }
}

const BUILD_TOOL_FILENAME_PATTERN = new RegExp(
  '^(?:' +
    '(?:gulpfile|gruntfile)(?:\\.\\w+)?' +
    '|(?:webpack|rollup|vite|vitest|jest|karma|babel|postcss|tailwind|next|metro|esbuild|rspack|rolldown)(?:[.\\-][\\w.-]*)?\\.config' +
    '|\\.(?:babelrc|eslintrc)' +
    '|eslint\\.config' +
  ')\\.[cm]?jsx?$',
  'i'
);

function isJsFile(filePath, extensions) {
  if (filePath.endsWith('.min.js') || filePath.endsWith('.min.mjs') || filePath.endsWith('.min.cjs')) return false;
  if (BUILD_TOOL_FILENAME_PATTERN.test(path.basename(filePath))) return false;
  const ext = path.extname(filePath);
  return extensions.has(ext);
}

function walkDir(dir, extensions, excludedDirs = EXCLUDED_DIRS, files = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!excludedDirs.has(entry.name) && !entry.name.startsWith('.')) {
        walkDir(fullPath, extensions, excludedDirs, files);
      }
    } else if (entry.isFile()) {
      if (isJsFile(fullPath, extensions)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function main(target, options) {
  const index = loadCatalog();

  const extensions = new Set(options.ext.split(','));

  const extraExcludes = (options.excludeDirs || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const excludedDirs = new Set([...EXCLUDED_DIRS, ...extraExcludes]);
  if (extraExcludes.length && !options.quiet) {
    console.error(`Extra excluded dirs: ${extraExcludes.join(', ')}`);
  }

  let files = [];
  const absTarget = path.resolve(target);

  try {
    const stats = fs.statSync(absTarget);
    if (stats.isDirectory()) {
      files = walkDir(absTarget, extensions, excludedDirs);
    } else if (stats.isFile()) {
      files = isJsFile(absTarget, extensions) ? [absTarget] : [];
    } else {
      console.error(`Not a file or directory: ${target}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`Cannot access target: ${err.message}`);
    process.exit(1);
  }

  if (!options.quiet) {
    console.error(`Scanning ${files.length} file(s)...`);
  }

  const sinkTypeFilter = options.sinkType ? new Set(options.sinkType.split(',')) : null;

  const taintedSinkSet = options.taintDb ? loadTaintedSinks(options.taintDb, absTarget) : new Set();

  const allFindings = [];

  for (const file of files) {
    try {
      const source = fs.readFileSync(file, 'utf-8');
      const isHtml = HTML_EXTENSIONS.has(path.extname(file));

      const blocks = isHtml
        ? extractScripts(source)
        : [{ source, lineOffset: 0 }];

      let fileCount = 0;
      for (const block of blocks) {
        const innerOffset = block.innerStart || 0;
        const sourceRoot = options.sourceRoot ? path.resolve(options.sourceRoot) : absTarget;
        const findings = detectSinks(block.source, file, index, block.lineOffset, sourceRoot, taintedSinkSet, null, innerOffset);
        for (const f of findings) {
          if (sinkTypeFilter && !sinkTypeFilter.has(f.sinkType)) continue;
          allFindings.push(f);
          fileCount++;
        }
      }

      if (!options.quiet && fileCount > 0) {
        console.error(`  ${file}: ${fileCount} sink(s)`);
      }
    } catch (err) {
      if (!options.quiet) {
        console.error(`Error reading ${file}: ${err.message}`);
      }
    }
  }

  try {
    report(allFindings, options.format, {
      outputFile: options.output,
      quiet: options.quiet,
    });
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  if (options.db) {
    try {
      const app = options.app || path.basename(absTarget);
      const db = openDb(options.db);
      let preservedRows = [];
      if (!options.rescanFile) {
        clearApp(db, app);
      } else {

        const selectPreserved = db.prepare(`
          SELECT sink_key, verdict, verdict_reasons, original_snippet, patch_count
          FROM sinks WHERE app = ? AND file = ?
        `);
        for (const file of files) {
          preservedRows.push(...selectPreserved.all(app, file));
          clearFile(db, app, file);
        }
      }
      const count = writeFindings(db, app, allFindings);
      if (preservedRows.length > 0) {
        const restore = db.prepare(`
          UPDATE sinks
          SET verdict = ?, verdict_reasons = ?, original_snippet = ?, patch_count = ?
          WHERE app = ? AND sink_key = ?
        `);
        const restoreAll = db.transaction(rows => {
          for (const row of rows) {
            restore.run(row.verdict, row.verdict_reasons, row.original_snippet,
              row.patch_count, app, row.sink_key);
          }
        });
        restoreAll(preservedRows);
      }
      db.close();
      if (!options.quiet) {
        console.error(`Saved ${count} findings to ${options.db} (app=${app})`);
      }
    } catch (err) {
      console.error(`Error writing to database: ${err.message}`);
      process.exit(1);
    }
  }
}

const program = new Command();

program
  .name('tt-detect-sinks')
  .description('Babel AST-based DOM XSS sink detector')
  .argument('<target>', 'JS/TS/JSX file or directory to scan')
  .option('-f, --format <fmt>', 'Output format: json | text', 'text')
  .option('-o, --output <file>', 'Write output to file')
  .option('--sink-type <types>', 'Comma-separated sinkType filter: html,script,scriptURL')
  .option('--ext <exts>', 'Comma-separated extensions to scan', '.js,.mjs,.cjs,.jsx,.ts,.tsx,.html,.htm')
  .option('--exclude-dirs <list>', 'Extra directory names to exclude, comma-separated (per-app vendor/build dirs)')
  .option('--db <path>', 'SQLite database path to write findings')
  .option('--app <name>', 'Application name for DB grouping (default: target basename)')
  .option('--rescan-file', 'Replace only rows for this file (used after patching a single file)')
  .option('--source-root <dir>', 'Override source root for relative file path computation in sink_key')
  .option('--taint-db <path>', 'CodeQL unified.db path for TYPE5 verdict assignment')
  .option('-q, --quiet', 'Suppress stderr progress messages')
  .action(main)
  .parseAsync(process.argv)
  .catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
