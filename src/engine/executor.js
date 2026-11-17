import fs from 'node:fs';
import { all, get } from '../db.js';
import { evaluate } from '../expr/evaluator.js';
import { hashJson } from '../lib/util.js';
import { serializeExact } from '../lib/exact.js';
import { getJob, commitTask, failTask } from './jobs.js';
import { getCompiled } from './compile-cache.js';
import { loadPinnedResolvers } from './dimension.js';
import { parseStored } from './rules.js';

/**
 * Execute one claimed task. A task is a half-open row range of one dataset
 * version. The worker:
 *   1. loads its own compiled rule set from the job snapshot (cache),
 *   2. loads the pinned dimension versions into frozen in-memory maps,
 *   3. evaluates rows,
 *   4. writes the output file and commits the ledger row.
 *
 * Output shape
 *   row mode:   { taskNo, rows: [{...input, ...outputs}], rowsHash }
 *   group mode: { taskNo, groups: [{key, rowNo, count, state, outputs}], ... }
 *
 * In group mode each task computes *partial* aggregation states. Group keys
 * may span tasks (rows of a key are not contiguous), so the finalizer merges
 * states with exact, associative accumulators (see compiler.js).
 */

export function runTask(db, jobId, taskNo, workerId, { previewOnly = false } = {}) {
  const job = getJob(db, jobId);
  if (!job) {
    const err = new Error(`job ${jobId} not found`);
    err.code = 'E_NOT_FOUND';
    throw err;
  }
  const task = get(db, 'SELECT * FROM job_tasks WHERE job_id = ? AND task_no = ?', jobId, taskNo);
  if (!task) {
    const err = new Error(`task ${taskNo} not found`);
    err.code = 'E_NOT_FOUND';
    throw err;
  }

  const pins = job.dimensions.map((d) => ({
    name: d.name,
    dimension_version_id: d.dimension_version_id,
    version_no: d.version_no,
  }));
  const dimResolver = job.rules.some((r) => usesLookup(r)) ? loadPinnedResolvers(db, pins) : loadPinnedResolvers(db, pins);
  const compiled = getCompiled(job, dimResolver);

  const rows = all(
    db,
    `SELECT row_no, data_json FROM dataset_rows
     WHERE dataset_version_id = ? AND row_no BETWEEN ? AND ? ORDER BY row_no`,
    job.dataset_version_id,
    task.row_start,
    task.row_end,
  );

  if (job.mode === 'group') {
    return executeGroupTask({ job, task, rows, compiled, dimResolver, workerId });
  }
  return executeRowTask({ job, task, rows, compiled, dimResolver, workerId });
}

function usesLookup(rule) {
  return typeof rule.ast_json === 'string' && rule.ast_json.includes('"lookup"');
}

function executeRowTask({ job, task, rows, compiled, dimResolver, workerId }) {
  const out = [];
  let failed = 0;
  const errors = [];
  for (const r of rows) {
    const row = JSON.parse(r.data_json);
    row.__row_no = r.row_no;
    try {
      const values = compiled.evaluateRow(row);
      const merged = { ...row };
      for (const [k, v] of Object.entries(values)) merged[k] = v;
      merged.__row_no = r.row_no;
      out.push(merged);
    } catch (err) {
      failed += 1;
      errors.push({
        rowNo: r.row_no,
        rule: err.ruleName ?? null,
        code: err.code ?? 'E_RULE',
        message: err.message,
        line: err.line ?? null,
        col: err.col ?? null,
      });
      if (errors.length >= 20) break;
    }
  }
  if (failed > 0) {
    const first = errors[0];
    const err = new Error(
      `task ${task.task_no}: ${failed} row(s) failed; first at input row ${first.rowNo}` +
        (first.rule ? `, output "${first.rule}"` : '') +
        `: ${first.message}`,
    );
    err.code = first.code;
    err.rowNo = first.rowNo;
    err.ruleName = first.rule;
    err.errors = errors;
    err.partialCount = out.length;
    throw err;
  }
  const rowsHash = hashJson(out.map((r) => [r.__row_no, ...Object.keys(r).filter((k) => k !== '__row_no').sort().map((k) => r[k])]));
  return {
    taskNo: task.task_no,
    mode: 'row',
    rowStart: task.row_start,
    rowEnd: task.row_end,
    rowCount: out.length,
    rows: out,
    rowsHash,
    dimensionPins: job.dimensions.map((d) => ({ name: d.name, versionId: d.dimension_version_id, versionNo: d.version_no })),
  };
}

function executeGroupTask({ job, task, rows, compiled, dimResolver, workerId }) {
  const groups = new Map();
  const errors = [];
  for (const r of rows) {
    const row = JSON.parse(r.data_json);
    row.__row_no = r.row_no;
    let keyValues;
    try {
      keyValues = compiled.evaluateKey(row);
    } catch (err) {
      errors.push({ rowNo: r.row_no, code: err.code ?? 'E_RULE', message: err.message, line: err.line ?? null, col: err.col ?? null });
      if (errors.length >= 20) break;
      continue;
    }
    for (const [name, value] of Object.entries(keyValues)) {
      if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        errors.push({ rowNo: r.row_no, code: 'E_GROUP_KEY', message: `group key "${name}" produced a non-scalar value` });
      }
    }
    const normKey = JSON.stringify(Object.keys(keyValues).sort().map((k) => [k, keyValues[k]]));
    let group = groups.get(normKey);
    if (!group) {
      group = { key: normKey, keyValues, rowNo: r.row_no, count: 0, state: compiled.newGroupState() };
      groups.set(normKey, group);
    }
    group.count += 1;
    try {
      const computed = compiled.rowRules.length > 0 ? compiled.evaluateRow(row) : null;
      compiled.accumulate(group.state, row, computed);
    } catch (err) {
      errors.push({ rowNo: r.row_no, rule: err.ruleName ?? null, code: err.code ?? 'E_RULE', message: err.message, line: err.line ?? null, col: err.col ?? null });
      if (errors.length >= 20) break;
    }
  }
  if (errors.length > 0) {
    const first = errors[0];
    const err = new Error(
      `task ${task.task_no}: ${errors.length} row(s) failed; first at input row ${first.rowNo}: ${first.message}`,
    );
    err.code = first.code;
    err.rowNo = first.rowNo;
    err.ruleName = first.rule ?? null;
    err.errors = errors;
    throw err;
  }

  // Serialise the partial states; these are merged by the finalizer.
  const serialised = [...groups.values()].map((g) => ({
    key: g.key,
    rowNo: g.rowNo,
    count: g.count,
    state: serialiseState(g.state),
  }));
  const groupsHash = hashJson(serialised.map((g) => [g.key, g.count]));
  return {
    taskNo: task.task_no,
    mode: 'group',
    rowStart: task.row_start,
    rowEnd: task.row_end,
    rowCount: rows.length,
    groups: serialised,
    groupsHash,
    dimensionPins: job.dimensions.map((d) => ({ name: d.name, versionId: d.dimension_version_id, versionNo: d.version_no })),
  };
}

function serialiseState(state) {
  const slots = {};
  for (const [sig, slot] of Object.entries(state.slots)) {
    if (slot.fn === 'count_distinct') slots[sig] = { fn: slot.fn, values: [...slot.seen] };
    else if (slot.fn === 'sum' || slot.fn === 'avg') slots[sig] = { fn: slot.fn, exact: serializeExact(slot.exact), n: slot.n };
    else slots[sig] = { ...slot };
  }
  return { slots };
}
