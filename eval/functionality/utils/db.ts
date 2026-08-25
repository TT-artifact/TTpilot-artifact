import sqlite3 from 'sqlite3'
import { open, Database } from 'sqlite'
import { ComparisonResult } from './compare'
import { mkdir, chmod } from 'fs/promises'
import { dirname } from 'path'

export interface TestRun {
  id?: number
  app: string
  timestamp?: string
  total_tests: number
  passed: number
  failed: number
  regressions: number
  tt_violations_blocked: number
  duration_ms: number
}

export interface TestResult {
  id?: number
  run_id: number
  url: string
  status: string
  http_status_patched: number
  http_status_unpatched: number
  dom_text_similarity: number
  dom_structure_similarity: number
  dom_similarity: number
  console_errors: string
  tt_triggered: number
  screenshot_diff_ratio: number
}

let db: Database | null = null

async function initDb(dbPath: string): Promise<Database> {
  if (db) return db

  const dbDir = dirname(dbPath)
  await mkdir(dbDir, { recursive: true })

  db = await open({
    filename: dbPath,
    driver: sqlite3.Database,
  })

  try {
    await chmod(dbPath, 0o666)
  } catch {}

  await db.exec(`
    CREATE TABLE IF NOT EXISTS test_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      total_tests INTEGER NOT NULL,
      passed INTEGER NOT NULL,
      failed INTEGER NOT NULL,
      regressions INTEGER NOT NULL,
      tt_violations_blocked INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS test_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      url TEXT,
      status TEXT,
      http_status_patched INTEGER,
      http_status_unpatched INTEGER,
      dom_text_similarity REAL,
      dom_structure_similarity REAL,
      dom_similarity REAL,
      console_errors TEXT,
      tt_triggered INTEGER,
      screenshot_diff_ratio REAL,
      FOREIGN KEY(run_id) REFERENCES test_runs(id)
    );

    CREATE INDEX IF NOT EXISTS idx_test_runs_app ON test_runs(app);
    CREATE INDEX IF NOT EXISTS idx_test_results_run_id ON test_results(run_id);
  `)

  return db
}

export async function saveTestRun(
  dbPath: string,
  testRun: TestRun,
  results: ComparisonResult[]
): Promise<number> {
  const database = await initDb(dbPath)

  const runResult = await database.run(
    `INSERT INTO test_runs (app, total_tests, passed, failed, regressions, tt_violations_blocked, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      testRun.app,
      testRun.total_tests,
      testRun.passed,
      testRun.failed,
      testRun.regressions,
      testRun.tt_violations_blocked,
      testRun.duration_ms,
    ]
  )

  const runId = runResult.lastID as number

  for (const result of results) {
    await database.run(
      `INSERT INTO test_results
       (run_id, url, status, http_status_patched, http_status_unpatched, dom_text_similarity, dom_structure_similarity, dom_similarity, console_errors, tt_triggered, screenshot_diff_ratio)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        runId,
        result.url,
        result.hasRegression ? 'REGRESSION' : 'PASS',
        result.statusCodes.patched,
        result.statusCodes.unpatched,
        result.domTextSimilarity,
        result.domStructureSimilarity,
        result.domSimilarity,
        result.consoleRegressions.join('; '),
        result.ttTriggeredCount,
        result.screenshotDiffRatio,
      ]
    )
  }

  return runId
}

export async function getTestRuns(dbPath: string, app: string): Promise<TestRun[]> {
  const database = await initDb(dbPath)
  return database.all('SELECT * FROM test_runs WHERE app = ? ORDER BY timestamp DESC', [app])
}

export async function closeDb(): Promise<void> {
  if (db) {
    await db.close()
    db = null
  }
}
