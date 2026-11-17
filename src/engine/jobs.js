import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { all, get, run, transaction } from '../db.js';
import { hashJson, newId, nowIso, clampInt } from '../lib/util.js';
import { getDatasetVersion } from './dataset.js';
import { getDimensionVersion } from './dimension.js';
import { getRuleVersion } from './rules.js';
import { parse } from '../expr/parser.js';
import { loadPinnedResolvers } from './dimension.js';
import { getCompiled } from './compile-cache.js';
import { deserializeExact } from '../lib/exact.js';

/**
 * Job lifecycle, task ledger and result directory.
 *
 * Isolation model
 * ---------------
 *  * The control-plane process (server) owns the database and the result
 *    directory and never evaluates an expression itself.
 *  * Worker processes own the compute loop. Multiple workers can compete for
 *    one job: tasks are claimed with an expiring lease in a single
 *    BEGIN IMMEDIATE transaction, so a crashed worker's leases simply expire
 *    and another worker may redo those tasks.
 *  * Task outputs are written to `<resultDir>/tasks/<n>.json` atomically
 *    (write + rename). The ledger row is the commit point; a result file
 *    without a committed ledger row is an orphan and is overwritten.
 *  * Finalizing writes the merged output and manifest, then flips job status.
 *    If the process dies before the flip, finalization is re-run from the
 *    immutable task outputs, which is why it is safe to repeat.
 *
 * "Frozen at creation" means: dataset version, every dimension version and
 * every rule expression/AST are copied into the job at create time. Nothing
 * the worker reads at execution time points at the live tables.
 */

export const DEFAULT_BATCH_SIZE = 200;
export const DEFAULT_LEASE_MS = 30_000;
export const MAX_BATCH_SIZE = 5000;

const ACTIVE_STATUSES = new Set(['pending', 'running']);

export function createJob(db, { name, datasetVersionId, mode, groupKeys = [], rules, dimensions = [], batchSize, runLabel = '', resumedFrom = null }) {
  if (!datasetVersionId) {
    throw coded('E_VALIDATION', 'datasetVersionId is required');
  }
  if (mode !== 'row' && mode !== 'group') {
    throw coded('E_VALIDATION', 'mode must be "row" or "group"');
  }
  const datasetVersion = getDatasetVersion(db, datasetVersionId);
  if (!datasetVersion) throw coded('E_NOT_FOUND', `dataset version ${datasetVersionId} not found`);
  if (!Array.isArray(rules) || rules.length === 0) {
    throw coded('E_VALIDATION', 'at least one output rule is required');
  }

  const compiledRules = [];
  const seen = new Set();
  for (const item of rules) {
    let expression;
    let astJson;
    let kind = 'value';
    let ruleVersionId = null;
    let ast;
    if (item.ruleVersionId) {
      const rv = getRuleVersion(db, item.ruleVersionId);
      if (!rv) throw coded('E_NOT_FOUND', `rule version ${item.ruleVersionId} not found`);
      expression = rv.expression;
      astJson = rv.ast_json;
      ast = JSON.parse(rv.ast_json);
      ruleVersionId = rv.id;
    } else {
      expression = String(item.expression ?? '');
      if (item.astJson) {
        ast = JSON.parse(item.astJson);
      } else {
        // Parse server-side so clients never have to ship an AST. The AST is
        // snapshotted into the job below and is what the worker executes.
        ast = parsePinned(expression, `output "${item.outputName}"`);
      }
      astJson = JSON.stringify(ast);
    }
    const outputName = item.outputName;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(outputName ?? '')) {
      throw coded('E_VALIDATION', `output name ${JSON.stringify(outputName)} is not allowed`);
    }
    if (seen.has(outputName)) throw coded('E_DUPLICATE_OUTPUT', `duplicate output name "${outputName}"`);
    seen.add(outputName);
    compiledRules.push({
      outputName,
      ruleVersionId,
      expression,
      astJson: JSON.stringify(ast),
      kind,
      ast,
    });
  }

  // Group keys may be given as raw expressions (ad-hoc) or rule versions.
  const keys = [];
  if (mode === 'group') {
    if (!Array.isArray(groupKeys) || groupKeys.length === 0) {
      throw coded('E_VALIDATION', 'group mode requires at least one group key');
    }
    for (const key of groupKeys) {
      const keyName = key.name;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyName ?? '')) {
        throw coded('E_VALIDATION', `group key name ${JSON.stringify(keyName)} is not allowed`);
      }
      let expression;
      let ast;
      if (key.ruleVersionId) {
        const rv = getRuleVersion(db, key.ruleVersionId);
        if (!rv) throw coded('E_NOT_FOUND', `rule version ${key.ruleVersionId} not found`);
        expression = rv.expression;
        ast = JSON.parse(rv.ast_json);
      } else {
        expression = String(key.expression ?? '');
        ast = key.astJson ? JSON.parse(key.astJson) : parsePinned(expression, `group key "${keyName}"`);
      }
      keys.push({ name: keyName, expression, ast, astJson: JSON.stringify(ast), normalized: key.normalized !== false });
    }
  }
  for (const r of compiledRules) {
    if (keys.some((k) => k.name === r.outputName)) {
      throw coded('E_DUPLICATE_OUTPUT', `"${r.outputName}" is used both as a group key and an output`);
    }
  }

  const pins = [];
  const seenDims = new Set();
  for (const dim of dimensions) {
    const version = getDimensionVersion(db, dim.dimensionVersionId);
    if (!version) throw coded('E_NOT_FOUND', `dimension version ${dim.dimensionVersionId} not found`);
    if (seenDims.has(version.name)) {
      throw coded('E_VALIDATION', `dimension "${version.name}" is pinned twice`);
    }
    seenDims.add(version.name);
    pins.push({ name: version.name, dimensionVersionId: version.id, versionNo: version.version_no });
  }

  const size = clampInt(batchSize, 1, MAX_BATCH_SIZE, DEFAULT_BATCH_SIZE);
  const jobId = newId('job_');
  const resultDir = path.resolve(path.join(resultsRoot(), jobId));
  const totalRows = datasetVersion.row_count;
  const totalGroups = mode === 'group' ? totalRows : 0;
  const tasks = [];
  for (let start = 1, n = 0; start <= totalRows; start += size, n += 1) {
    tasks.push({ taskNo: n, rowStart: start, rowEnd: Math.min(totalRows, start + size - 1) });
  }

  transaction(db, () => {
    run(
      db,
      `INSERT INTO jobs
        (id, name, dataset_version_id, mode, group_keys_json, status, total_rows, total_groups,
         processed_rows, failed_rows, batch_size, created_at, result_dir, run_label, resumed_from)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, 0, 0, ?, ?, ?, ?, ?)`,
      jobId,
      name || newId('job'),
      datasetVersion.id,
      mode,
      JSON.stringify(keys.map((k) => ({ name: k.name, expression: k.expression, ast: k.ast, normalized: k.normalized }))),
      totalRows,
      totalGroups,
      size,
      nowIso(),
      resultDir,
      runLabel,
      resumedFrom,
    );
    compiledRules.forEach((r, position) => {
      run(
        db,
        `INSERT INTO job_rules
          (job_id, output_name, rule_version_id, expression, ast_json, output_type, kind, position)
         VALUES (?, ?, ?, ?, ?, 'unknown', ?, ?)`,
        jobId,
        r.outputName,
        r.ruleVersionId,
        r.expression,
        r.astJson,
        r.kind,
        position,
      );
    });
    for (const pin of pins) {
      run(db, 'INSERT INTO job_dimensions (job_id, name, dimension_version_id) VALUES (?, ?, ?)', jobId, pin.name, pin.dimensionVersionId);
    }
    const insertTask = db.prepare(
      `INSERT INTO job_tasks (job_id, task_no, status, row_start, row_end, attempts, updated_at)
       VALUES (?, ?, 'pending', ?, ?, 0, ?)`,
    );
    for (const t of tasks) insertTask.run(jobId, t.taskNo, t.rowStart, t.rowEnd, nowIso());
    run(
      db,
      'INSERT INTO job_events (job_id, at, level, kind, message, data_json) VALUES (?, ?, ?, ?, ?, ?)',
      jobId,
      nowIso(),
      'info',
      'created',
      `job created: ${compiledRules.length} output(s), ${tasks.length} task(s), ${totalRows} input row(s)`,
      JSON.stringify({
        datasetVersionId: datasetVersion.id,
        datasetContentHash: datasetVersion.content_hash,
        dimensionPins: pins,
        resultDir,
      }),
    );
  });

  ensureResultDir(jobId, resultDir);
  return getJob(db, jobId);
}

function coded(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** Parse an ad-hoc expression at job-creation time so it can be snapshotted. */
function parsePinned(expression, label) {
  try {
    return parse(expression);
  } catch (err) {
    const wrapped = new Error(`${label}: ${err.message}`);
    wrapped.code = err.code ?? 'E_EXPRESSION';
    wrapped.line = err.line;
    wrapped.col = err.col;
    wrapped.status = 422;
    throw wrapped;
  }
}

function resultsRoot() {
  return process.env.RESULTS_DIR || path.resolve(process.cwd(), 'data', 'results');
}

export function ensureResultDir(jobId, resultDir) {
  const dir = path.resolve(resultDir);
  const root = path.resolve(resultsRoot());
  if (dir !== path.join(root, jobId)) {
    throw coded('E_RESULT_DIR', 'result directory escaped the configured results root');
  }
  fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'previews'), { recursive: true });
  return dir;
}

/** Atomic write: full file then rename, so readers never see a partial file. */
export function writeFileAtomic(file, contents) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${newId()}.tmp`);
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}

export function getJob(db, id) {
  const job = get(db, 'SELECT * FROM jobs WHERE id = ?', id);
  if (!job) return undefined;
  const rules = all(db, 'SELECT * FROM job_rules WHERE job_id = ? ORDER BY position', id);
  const dims = all(
    db,
    `SELECT d.name, d.dimension_version_id, v.version_no, v.content_hash, v.row_count
     FROM job_dimensions d JOIN dimension_versions v ON v.id = d.dimension_version_id
     WHERE d.job_id = ? ORDER BY d.name`,
    id,
  );
  return {
    ...job,
    group_keys: JSON.parse(job.group_keys_json),
    rules: rules.map((r) => ({ ...r, ast: JSON.parse(r.ast_json) })),
    dimensions: dims,
  };
}

export function listJobs(db, limit = 50) {
  return all(
    db,
    `SELECT j.*, d.name AS dataset_name, d.version_no AS dataset_version_no
     FROM jobs j JOIN dataset_versions d ON d.id = j.dataset_version_id
     ORDER BY j.created_at DESC LIMIT ?`,
    limit,
  );
}

export function listTasks(db, jobId) {
  return all(db, 'SELECT * FROM job_tasks WHERE job_id = ? ORDER BY task_no', jobId);
}

export function jobEvents(db, jobId, limit = 200) {
  return all(
    db,
    'SELECT * FROM job_events WHERE job_id = ? ORDER BY at DESC LIMIT ?',
    jobId,
    limit,
  ).reverse();
}

export function logEvent(db, jobId, level, kind, message, data = null) {
  run(
    db,
    'INSERT INTO job_events (job_id, at, level, kind, message, data_json) VALUES (?, ?, ?, ?, ?, ?)',
    jobId,
    nowIso(),
    level,
    kind,
    message,
    data ? JSON.stringify(data) : null,
  );
}

/**
 * Claim a batch of pending/expired tasks for a worker.
 *
 * The UPDATE ... WHERE selects rows whose lease is absent, expired, or held by
 * this worker (idempotent re-claim after a partial batch). Because SQLite runs
 * the whole statement under the BEGIN IMMEDIATE write lock, two workers cannot
 * claim the same task.
 */
export function claimTasks(db, jobId, workerId, limit = 1, leaseMs = DEFAULT_LEASE_MS) {
  const now = nowIso();
  const leaseUntil = new Date(Date.now() + leaseMs).toISOString();
  return transaction(db, () => {
    const job = get(db, 'SELECT * FROM jobs WHERE id = ?', jobId);
    if (!job) throw coded('E_NOT_FOUND', `job ${jobId} not found`);
    if (!ACTIVE_STATUSES.has(job.status)) return [];
    if (job.status === 'pending') {
      run(db, "UPDATE jobs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?", now, jobId);
    }
    const candidates = all(
      db,
      `SELECT task_no FROM job_tasks
       WHERE job_id = ?
         AND (status = 'pending'
              OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < ?)))
       ORDER BY task_no LIMIT ?`,
      jobId,
      now,
      limit,
    );
    const claimed = [];
    for (const c of candidates) {
      const stale = get(db, 'SELECT status, attempts FROM job_tasks WHERE job_id = ? AND task_no = ?', jobId, c.task_no);
      const res = run(
        db,
        `UPDATE job_tasks
         SET status = 'running', owner = ?, lease_expires_at = ?, attempts = attempts + 1, updated_at = ?, error = NULL
         WHERE job_id = ? AND task_no = ?
           AND (status = 'pending' OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < ?)))`,
        workerId,
        leaseUntil,
        now,
        jobId,
        c.task_no,
        now,
      );
      if (res.changes === 1) {
        if (stale && stale.attempts > 0) {
          logEvent(db, jobId, 'warn', 'task-retry', `task ${c.task_no} reclaimed after lease expiry (attempt ${stale.attempts + 1})`);
        }
        claimed.push(c.task_no);
      }
    }
    run(db, 'UPDATE jobs SET heartbeat_at = ? WHERE id = ?', now, jobId);
    return claimed;
  });
}

export function renewLease(db, jobId, workerId, taskNos, leaseMs = DEFAULT_LEASE_MS) {
  const leaseUntil = new Date(Date.now() + leaseMs).toISOString();
  const now = nowIso();
  transaction(db, () => {
    for (const taskNo of taskNos) {
      run(
        db,
        `UPDATE job_tasks SET lease_expires_at = ?, updated_at = ?
         WHERE job_id = ? AND task_no = ? AND status = 'running' AND owner = ?`,
        leaseUntil,
        now,
        jobId,
        taskNo,
        workerId,
      );
    }
    run(db, 'UPDATE jobs SET heartbeat_at = ? WHERE id = ?', now, jobId);
  });
}

export function taskStatus(db, jobId, taskNo) {
  return get(db, 'SELECT * FROM job_tasks WHERE job_id = ? AND task_no = ?', jobId, taskNo);
}

/** Mark a task done and persist its output atomically. */
export function commitTask(db, jobId, taskNo, workerId, output) {
  const job = get(db, 'SELECT result_dir FROM jobs WHERE id = ?', jobId);
  if (!job) throw coded('E_NOT_FOUND', `job ${jobId} not found`);
  const taskFile = path.join(job.result_dir, 'tasks', `${String(taskNo).padStart(6, '0')}.json`);
  const payload = JSON.stringify(output);
  const inputHash = hashJson({
    rows: output.rowCount,
    outputs: output.outputsHash ?? null,
    groups: output.groups ?? null,
  });
  transaction(db, () => {
    const current = get(db, 'SELECT status, owner FROM job_tasks WHERE job_id = ? AND task_no = ?', jobId, taskNo);
    if (!current || current.status !== 'running' || current.owner !== workerId) {
      throw coded('E_LEASE_LOST', `task ${taskNo} is no longer owned by ${workerId}`);
    }
    writeFileAtomic(taskFile, payload);
    run(
      db,
      `UPDATE job_tasks
       SET status = 'done', output_json = ?, input_hash = ?, lease_expires_at = NULL, updated_at = ?, error = NULL
       WHERE job_id = ? AND task_no = ?`,
      payload,
      inputHash,
      nowIso(),
      jobId,
      taskNo,
    );
    run(
      db,
      `UPDATE jobs SET
         processed_rows = (SELECT COALESCE(SUM(row_end - row_start + 1), 0) FROM job_tasks WHERE job_id = ? AND status = 'done'),
         heartbeat_at = ?
       WHERE id = ?`,
      jobId,
      nowIso(),
      jobId,
    );
  });
}

export function failTask(db, jobId, taskNo, workerId, error) {
  const message = `${error.code ?? 'E_TASK'}: ${error.message}`;
  transaction(db, () => {
    run(
      db,
      `UPDATE job_tasks SET status = 'pending', owner = NULL, lease_expires_at = NULL, error = ?, updated_at = ?
       WHERE job_id = ? AND task_no = ? AND owner = ?`,
      message,
      nowIso(),
      jobId,
      taskNo,
      workerId,
    );
    logEvent(db, jobId, 'error', 'task-failed', `task ${taskNo} failed: ${message}`);
  });
}

/**
 * If every task is done, finalize the job: merge per-task outputs in task
 * order into result.jsonl, write a manifest that records every pinned
 * version, and mark the job done. Idempotent: safe to call from several
 * workers at once (transaction + status check) and safe after a crash.
 */
export function tryFinalizeJob(db, jobId, { mode, groupKeys, ruleNames }) {
  const snapshot = get(db, 'SELECT * FROM jobs WHERE id = ?', jobId);
  if (!snapshot) throw coded('E_NOT_FOUND', `job ${jobId} not found`);
  if (snapshot.status === 'done' || snapshot.status === 'cancelled') return { finalized: false, job: snapshot };

  const counts = get(
    db,
    `SELECT
       SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       COUNT(*) AS total
     FROM job_tasks WHERE job_id = ?`,
    jobId,
  );
  if (Number(counts.done) !== Number(counts.total)) {
    return { finalized: false, job: snapshot, pending: Number(counts.total) - Number(counts.done) };
  }

  // Build outputs outside the lock (can be large), then commit status.
  const taskIds = all(db, 'SELECT task_no FROM job_tasks WHERE job_id = ? ORDER BY task_no', jobId);
  const resultPath = path.join(snapshot.result_dir, 'result.jsonl');
  const tmp = path.join(snapshot.result_dir, `.result.jsonl.${process.pid}.${newId()}.tmp`);
  const fd = fs.openSync(tmp, 'w');
  let lineCount = 0;
  // Hash the actual output rows, not the per-task payloads: the content hash
  // must identify the result, and the result must not change with batching.
  const contentHasher = createHash('sha256');
  try {
    if (snapshot.mode === 'group') {
      const merged = mergeGroupTaskOutputs(db, jobId, taskIds);
      for (const row of merged.rows) {
        const line = `${JSON.stringify(row)}\n`;
        fs.writeSync(fd, line);
        contentHasher.update(line);
        lineCount += 1;
      }
    } else {
      for (const t of taskIds) {
        const task = get(db, 'SELECT output_json FROM job_tasks WHERE job_id = ? AND task_no = ?', jobId, t.task_no);
        const payload = JSON.parse(task.output_json);
        for (const row of payload.rows) {
          const line = `${JSON.stringify(row)}\n`;
          fs.writeSync(fd, line);
          contentHasher.update(line);
          lineCount += 1;
        }
      }
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, resultPath);

  const job = getJob(db, jobId);
  const datasetVersion = getDatasetVersion(db, job.dataset_version_id);
  const dataset = get(db, 'SELECT name FROM datasets WHERE id = ?', datasetVersion.dataset_id);
  const manifest = {
    jobId,
    name: job.name,
    createdAt: job.created_at,
    finishedAt: nowIso(),
    mode: job.mode,
    groupKeys: job.mode === 'group' ? job.group_keys.map((k) => k.name) : [],
    input: {
      datasetId: datasetVersion.dataset_id,
      datasetName: dataset?.name ?? null,
      datasetVersionId: datasetVersion.id,
      versionNo: datasetVersion.version_no,
      contentHash: datasetVersion.content_hash,
      rows: datasetVersion.row_count,
    },
    dimensions: job.dimensions.map((d) => ({
      name: d.name,
      versionId: d.dimension_version_id,
      versionNo: d.version_no,
      contentHash: d.content_hash,
      rows: d.row_count,
    })),
    rules: job.rules.map((r) => {
      const version = r.rule_version_id ? getRuleVersion(db, r.rule_version_id) : null;
      return {
        outputName: r.output_name,
        ruleName: version?.name ?? null,
        ruleVersionId: r.rule_version_id,
        versionNo: version?.version_no ?? null,
        expression: r.expression,
        kind: r.kind,
      };
    }),
    expressionHashes: job.rules.map((r) => hashJson(r.expression)),
    outputContentHash: contentHasher.digest('hex'),
    rows: lineCount,
    engine: 'pointwise-rules/1',
    taskTotal: Number(counts.total),
    taskFailed: Number(counts.failed),
  };
  const manifestJson = JSON.stringify(manifest, null, 2);
  writeFileAtomic(path.join(snapshot.result_dir, 'manifest.json'), manifestJson);
  const manifestHash = hashJson(manifest);

  const finalized = transaction(db, () => {
    const fresh = get(db, 'SELECT status FROM jobs WHERE id = ?', jobId);
    if (fresh.status === 'done' || fresh.status === 'cancelled') return false;
    run(
      db,
      `UPDATE jobs SET status = 'done', finished_at = ?, heartbeat_at = ?, manifest_hash = ?,
         processed_rows = total_rows, failed_rows = 0 WHERE id = ?`,
      nowIso(),
      nowIso(),
      manifestHash,
      jobId,
    );
    logEvent(db, jobId, 'info', 'finalized', `job finalized: ${lineCount} output row(s)`, {
      manifestHash,
      outputContentHash: manifest.outputContentHash,
    });
    return true;
  });
  return { finalized, job: getJob(db, jobId), manifest, manifestHash, rows: lineCount };
}

/**
 * Merge partial group states across all tasks and evaluate the final output
 * expressions. Rebuilds the compiled rule set from the job snapshot (same
 * pinned ASTs, same pinned dimension maps) rather than from the live tables.
 */
function mergeGroupTaskOutputs(db, jobId, taskIds) {
  const job = getJob(db, jobId);
  const pins = job.dimensions.map((d) => ({
    name: d.name,
    dimension_version_id: d.dimension_version_id,
    version_no: d.version_no,
  }));
  const dimResolver = loadPinnedResolvers(db, pins);
  const compiled = getCompiled(job, dimResolver);

  const groups = new Map();
  for (const t of taskIds) {
    const task = get(db, 'SELECT output_json FROM job_tasks WHERE job_id = ? AND task_no = ?', jobId, t.task_no);
    const payload = JSON.parse(task.output_json);
    for (const g of payload.groups) {
      const existing = groups.get(g.key);
      if (!existing) {
        groups.set(g.key, { ...g, state: g.state });
        continue;
      }
      existing.count += g.count;
      existing.state = mergeStateObjects(existing.state, g.state);
      if (g.rowNo < existing.rowNo) existing.rowNo = g.rowNo;
    }
  }

  const sorted = [...groups.values()].sort((a, b) => a.rowNo - b.rowNo);
  const rows = [];
  for (const g of sorted) {
    const keyValues = JSON.parse(g.key);
    const state = deserializeMergedState(g.state);
    let outputs;
    try {
      outputs = compiled.finalizeGroup(Object.fromEntries(keyValues), state);
    } catch (err) {
      const wrapped = new Error(`group ${g.key}: ${err.message}`);
      wrapped.code = err.code ?? 'E_RULE';
      wrapped.rowNo = g.rowNo;
      wrapped.ruleName = err.ruleName ?? null;
      throw wrapped;
    }
    rows.push({ ...outputs, __group_rows: g.count });
  }
  return {
    rows,
    hash: hashJson(rows),
    groupCount: sorted.length,
  };
}

/** Turn verified JSON state back into the in-memory accumulator shape. */
function deserializeMergedState(state) {
  const slots = {};
  for (const [sig, slot] of Object.entries(state.slots ?? {})) {
    if (slot.fn === 'count_distinct') slots[sig] = { fn: slot.fn, seen: new Set(slot.values) };
    else if (slot.fn === 'sum' || slot.fn === 'avg') slots[sig] = { fn: slot.fn, exact: deserializeExact(slot.exact), n: slot.n };
    else slots[sig] = { ...slot };
  }
  return { slots };
}

function mergeStateObjects(a, b) {
  if (!a) return b;
  if (!b) return a;
  const slots = {};
  for (const sig of new Set([...Object.keys(a.slots ?? {}), ...Object.keys(b.slots ?? {})])) {
    const sa = a.slots?.[sig];
    const sb = b.slots?.[sig];
    slots[sig] = mergeSlots(sa, sb);
  }
  return { slots };
}

function mergeSlots(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.fn !== b.fn) throw coded('E_STATE_MISMATCH', 'aggregate slot type mismatch while merging tasks');
  switch (a.fn) {
    case 'sum':
    case 'avg':
      return { fn: a.fn, exact: deserializeExact(a.exact) + deserializeExact(b.exact), n: a.n + b.n };
    case 'count':
      return { fn: 'count', n: a.n + b.n };
    case 'count_distinct':
      return { fn: a.fn, values: [...new Set([...(a.values ?? []), ...(b.values ?? [])])] };
    case 'min': {
      const values = [a.value, b.value].filter((v) => v !== undefined && v !== null);
      return { fn: 'min', value: values.length ? Math.min(...values) : undefined };
    }
    case 'max': {
      const values = [a.value, b.value].filter((v) => v !== undefined && v !== null);
      return { fn: 'max', value: values.length ? Math.max(...values) : undefined };
    }
    default:
      return a;
  }
}

/** Recover interrupted jobs: leases that outlived their holder are re-queued. */
export function recoverStaleJobs(db, { leaseMs = DEFAULT_LEASE_MS } = {}) {
  const cutoff = new Date(Date.now() - leaseMs).toISOString();
  const stale = all(
    db,
    `SELECT job_id, task_no FROM job_tasks WHERE status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < ?)`,
    cutoff,
  );
  for (const t of stale) {
    run(
      db,
      `UPDATE job_tasks SET status = 'pending', owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE job_id = ? AND task_no = ? AND status = 'running'`,
      nowIso(),
      t.job_id,
      t.task_no,
    );
    logEvent(db, t.job_id, 'warn', 'task-recovered', `task ${t.task_no} returned to queue (lease expired)`);
  }
  const stuck = all(db, "SELECT id FROM jobs WHERE status = 'running'");
  for (const j of stuck) {
    const remaining = get(db, "SELECT COUNT(*) AS n FROM job_tasks WHERE job_id = ? AND status != 'done'", j.id);
    if (remaining.n === 0) logEvent(db, j.id, 'info', 'ready-to-finalize', 'all tasks done; finalization pending');
  }
  return stale.length;
}

export function cancelJob(db, jobId) {
  return transaction(db, () => {
    const job = get(db, 'SELECT status FROM jobs WHERE id = ?', jobId);
    if (!job) throw coded('E_NOT_FOUND', `job ${jobId} not found`);
    if (job.status === 'done') throw coded('E_INVALID_STATE', 'cannot cancel a finished job');
    run(db, "UPDATE jobs SET status = 'cancelled', finished_at = ?, heartbeat_at = ? WHERE id = ?", nowIso(), nowIso(), jobId);
    logEvent(db, jobId, 'warn', 'cancelled', 'job cancelled by operator');
    return getJob(db, jobId);
  });
}

export function jobResultFiles(db, jobId) {
  const job = get(db, 'SELECT result_dir FROM jobs WHERE id = ?', jobId);
  if (!job) return null;
  return {
    dir: job.result_dir,
    manifest: path.join(job.result_dir, 'manifest.json'),
    result: path.join(job.result_dir, 'result.jsonl'),
    tasks: path.join(job.result_dir, 'tasks'),
  };
}

/**
 * Fork a finished/incomplete job onto a new rule set while keeping the input
 * and dimension pins. Used by the "run old vs new in parallel" workflow.
 */
export function forkJob(db, sourceJobId, { rules, name, runLabel }) {
  const source = getJob(db, sourceJobId);
  if (!source) throw coded('E_NOT_FOUND', `job ${sourceJobId} not found`);
  return createJob(db, {
    name: name || `${source.name} (variant)`,
    datasetVersionId: source.dataset_version_id,
    mode: source.mode,
    groupKeys: source.group_keys.map((k) => ({ name: k.name, expression: k.expression, astJson: JSON.stringify(k.ast) })),
    rules,
    dimensions: source.dimensions.map((d) => ({ dimensionVersionId: d.dimension_version_id })),
    batchSize: source.batch_size,
    runLabel,
    resumedFrom: sourceJobId,
  });
}
