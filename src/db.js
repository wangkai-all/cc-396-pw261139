import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Single SQLite database holding control-plane state: datasets, their
 * immutable versions, dimension tables + versions, rule versions, jobs and
 * task checkpoints. Result rows live in the result directory instead, so a
 * job's output is a plain file tree that can be archived or re-read without
 * the database.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS datasets (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  description   TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dataset_versions (
  id            TEXT PRIMARY KEY,
  dataset_id    TEXT NOT NULL REFERENCES datasets(id),
  version_no    INTEGER NOT NULL,
  columns_json  TEXT NOT NULL,
  row_count     INTEGER NOT NULL,
  content_hash  TEXT NOT NULL,
  source        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE (dataset_id, version_no)
);

CREATE TABLE IF NOT EXISTS dataset_rows (
  dataset_version_id TEXT NOT NULL REFERENCES dataset_versions(id),
  row_no             INTEGER NOT NULL,
  data_json          TEXT NOT NULL,
  PRIMARY KEY (dataset_version_id, row_no)
);

CREATE TABLE IF NOT EXISTS dimension_versions (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  version_no    INTEGER NOT NULL,
  columns_json  TEXT NOT NULL,
  row_count     INTEGER NOT NULL,
  content_hash  TEXT NOT NULL,
  source        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE (name, version_no)
);

CREATE TABLE IF NOT EXISTS dimension_rows (
  dimension_version_id TEXT NOT NULL REFERENCES dimension_versions(id),
  key                  TEXT NOT NULL,
  key_type             TEXT NOT NULL,
  value_json           TEXT NOT NULL,
  PRIMARY KEY (dimension_version_id, key_type, key)
);

CREATE TABLE IF NOT EXISTS rule_versions (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  version_no    INTEGER NOT NULL,
  expression    TEXT NOT NULL,
  ast_json      TEXT NOT NULL,
  output_type   TEXT NOT NULL,
  columns_json  TEXT NOT NULL,
  functions_json TEXT NOT NULL,
  dimensions_json TEXT NOT NULL,
  source        TEXT NOT NULL,
  note          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  UNIQUE (name, version_no)
);

CREATE TABLE IF NOT EXISTS jobs (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  dataset_version_id TEXT NOT NULL REFERENCES dataset_versions(id),
  mode               TEXT NOT NULL,
  group_keys_json    TEXT NOT NULL,
  status             TEXT NOT NULL,
  total_rows         INTEGER NOT NULL,
  total_groups       INTEGER NOT NULL DEFAULT 0,
  processed_rows     INTEGER NOT NULL DEFAULT 0,
  failed_rows        INTEGER NOT NULL DEFAULT 0,
  batch_size         INTEGER NOT NULL,
  created_at         TEXT NOT NULL,
  started_at         TEXT,
  finished_at        TEXT,
  heartbeat_at       TEXT,
  error              TEXT,
  result_dir         TEXT NOT NULL,
  manifest_hash      TEXT,
  run_label          TEXT NOT NULL DEFAULT '',
  resumed_from       TEXT
);

CREATE TABLE IF NOT EXISTS job_rules (
  job_id            TEXT NOT NULL REFERENCES jobs(id),
  output_name       TEXT NOT NULL,
  rule_version_id   TEXT REFERENCES rule_versions(id),
  expression        TEXT NOT NULL,
  ast_json          TEXT NOT NULL,
  output_type       TEXT NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'value',
  position          INTEGER NOT NULL,
  PRIMARY KEY (job_id, output_name)
);

CREATE TABLE IF NOT EXISTS job_dimensions (
  job_id                TEXT NOT NULL REFERENCES jobs(id),
  name                  TEXT NOT NULL,
  dimension_version_id  TEXT NOT NULL REFERENCES dimension_versions(id),
  PRIMARY KEY (job_id, name)
);

CREATE TABLE IF NOT EXISTS job_tasks (
  job_id           TEXT NOT NULL REFERENCES jobs(id),
  task_no          INTEGER NOT NULL,
  status           TEXT NOT NULL,
  row_start        INTEGER NOT NULL,
  row_end          INTEGER NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 0,
  owner            TEXT,
  lease_expires_at TEXT,
  input_hash       TEXT,
  output_json      TEXT,
  error            TEXT,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (job_id, task_no)
);

CREATE TABLE IF NOT EXISTS job_events (
  job_id      TEXT NOT NULL REFERENCES jobs(id),
  at          TEXT NOT NULL,
  level       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  message     TEXT NOT NULL,
  data_json   TEXT
);

CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id, at);
CREATE INDEX IF NOT EXISTS idx_job_tasks_status ON job_tasks(job_id, status);
CREATE INDEX IF NOT EXISTS idx_rule_versions_name ON rule_versions(name, version_no);
`;

export function openDatabase(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file, { timeout: 10_000 });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 10000');
  db.exec(SCHEMA);
  return db;
}

/**
 * Run a function inside BEGIN IMMEDIATE ... COMMIT. Using IMMEDIATE means the
 * write lock is taken up front, so read-modify-write sequences (claiming a
 * task, promoting a version) cannot interleave with another connection.
 */
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* connection may already be rolled back */
    }
    throw err;
  }
}

export function all(db, sql, ...params) {
  return db.prepare(sql).all(...params).map(plain);
}

export function get(db, sql, ...params) {
  const row = db.prepare(sql).get(...params);
  return row === undefined ? undefined : plain(row);
}

export function run(db, sql, ...params) {
  return db.prepare(sql).run(...params);
}

/** node:sqlite returns null-prototype objects; normalise for JSON and tests. */
function plain(row) {
  return { ...row };
}
