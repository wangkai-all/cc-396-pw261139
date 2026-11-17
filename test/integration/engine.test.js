import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/db.js';
import { ingestDataset, verifyDatasetVersion } from '../../src/engine/dataset.js';
import { ingestDimension, loadDimensionResolver, loadPinnedResolvers } from '../../src/engine/dimension.js';
import { saveRule, staticCheck } from '../../src/engine/rules.js';
import {
  createJob,
  getJob,
  claimTasks,
  commitTask,
  runTaskVia,
  tryFinalizeJob,
  recoverStaleJobs,
  listTasks,
} from './helpers.js';

let counter = 0;
function tempDb() {
  counter += 1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pw-test-${counter}-`));
  process.env.RESULTS_DIR = path.join(dir, 'results');
  const db = openDatabase(path.join(dir, 'test.db'));
  return { db, dir };
}

const ROWS = Array.from({ length: 53 }, (_, i) => ({
  id: `r${i + 1}`,
  amount: (i + 1) * 1.1,
  qty: (i % 4) + 1,
  status: i % 7 === 0 ? 'refunded' : 'paid',
  region: ['us', 'eu', 'apac'][i % 3],
}));

function setup() {
  const { db, dir } = tempDb();
  const ds = ingestDataset(db, { name: 'orders', source: 'test', records: ROWS });
  const dim = ingestDimension(db, {
    name: 'region_label',
    source: 'test',
    entries: [
      { key: 'us', value: 'United States' },
      { key: 'eu', value: 'Europe' },
      { key: 'apac', value: 'Asia Pacific' },
    ],
  });
  return { db, dir, ds, dim };
}

test('dataset versions are immutable and identical content is reused', () => {
  const { db } = setup();
  const again = ingestDataset(db, { name: 'orders', source: 'test', records: ROWS });
  assert.equal(again.reused, true);
  assert.equal(again.version.version_no, 1);

  const changed = ingestDataset(db, {
    name: 'orders',
    source: 'test',
    records: [...ROWS, { id: 'r54', amount: 1, qty: 1, status: 'paid', region: 'us' }],
  });
  assert.equal(changed.reused, false);
  assert.equal(changed.version.version_no, 2);
  assert.equal(changed.version.id !== again.version.id, true);
});

test('dataset content hash verifies and detects tampering', () => {
  const { db, ds } = setup();
  const ok = verifyDatasetVersion(db, ds.version.id);
  assert.equal(ok.ok, true);

  db.prepare('UPDATE dataset_rows SET data_json = ? WHERE dataset_version_id = ? AND row_no = 1').run(
    JSON.stringify({ ...ROWS[0], amount: 999 }),
    ds.version.id,
  );
  const bad = verifyDatasetVersion(db, ds.version.id);
  assert.equal(bad.ok, false);
});

test('a saved rule pins its own compiled version', () => {
  const { db, ds } = setup();
  const columns = ROWS.length ? Object.keys(ROWS[0]) : [];
  const v1 = saveRule(db, { name: 'net', expression: 'amount * 2', knownColumns: columns });
  const v2 = saveRule(db, { name: 'net', expression: 'amount * 3', knownColumns: columns });
  assert.equal(v1.reused, false);
  assert.equal(v2.version.version_no, 2);

  const third = saveRule(db, { name: 'net', expression: 'amount * 3', knownColumns: columns });
  assert.equal(third.reused, true, 'unchanged rule is reused, not versioned again');

  const job = createJob(db, {
    datasetVersionId: ds.version.id,
    mode: 'row',
    rules: [{ outputName: 'net', ruleVersionId: v1.version.id }],
  });
  const pinned = getJob(db, job.id);
  assert.equal(pinned.rules[0].expression, 'amount * 2', 'job keeps the expression it was created with');
});

test('editing a rule while a job runs does not change that job', () => {
  const { db, ds } = setup();
  const columns = Object.keys(ROWS[0]);
  const v1 = saveRule(db, { name: 'net', expression: 'amount * 2', knownColumns: columns });
  const job = createJob(db, {
    datasetVersionId: ds.version.id,
    mode: 'row',
    batchSize: 10,
    rules: [{ outputName: 'net', ruleVersionId: v1.version.id }],
  });

  // Process the first half of the tasks.
  const workerA = 'A';
  const claimed = claimTasks(db, job.id, workerA, 3);
  for (const taskNo of claimed) {
    const out = runTaskVia(db, job.id, taskNo, workerA);
    commitTask(db, job.id, taskNo, workerA, out);
  }

  // Publish a new rule version mid-flight. The running job must not see it.
  const v2 = saveRule(db, { name: 'net', expression: 'amount * 1000', knownColumns: columns });
  assert.equal(v2.version.version_no, 2);

  for (;;) {
    const more = claimTasks(db, job.id, workerA, 5);
    if (more.length === 0) break;
    for (const taskNo of more) commitTask(db, job.id, taskNo, workerA, runTaskVia(db, job.id, taskNo, workerA));
  }
  const result = tryFinalizeJob(db, job.id, { mode: 'row' });
  assert.equal(result.finalized, true);

  const lines = fs
    .readFileSync(path.join(result.job.result_dir, 'result.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.equal(lines.length, ROWS.length);
  assert.equal(lines[0].net, ROWS[0].amount * 2, 'first row used the pinned v1 expression');
  assert.equal(lines.at(-1).net, ROWS.at(-1).amount * 2, 'last row also used the pinned v1 expression');
});

test('output is identical for every batch size (reproducible partition)', () => {
  const { db, ds } = setup();
  const columns = Object.keys(ROWS[0]);
  const v = saveRule(db, { name: 'net', expression: 'round(amount * qty, 2)', knownColumns: columns });
  const hashes = [];
  for (const batchSize of [1, 4, 17, 53]) {
    const job = createJob(db, {
      datasetVersionId: ds.version.id,
      mode: 'row',
      batchSize,
      rules: [{ outputName: 'net', ruleVersionId: v.version.id }],
    });
    const worker = `w-${batchSize}`;
    for (;;) {
      const claimed = claimTasks(db, job.id, worker, 1);
      if (claimed.length === 0) break;
      for (const taskNo of claimed) commitTask(db, job.id, taskNo, worker, runTaskVia(db, job.id, taskNo, worker));
    }
    const result = tryFinalizeJob(db, job.id, { mode: 'row' });
    hashes.push(result.manifest.outputContentHash);
  }
  assert.equal(new Set(hashes).size, 1, `expected one hash, got ${hashes.join(', ')}`);
});

test('group sums are exact and partition independent', () => {
  const { db, ds } = setup();
  const columns = Object.keys(ROWS[0]);
  const amount = saveRule(db, { name: 'amount_out', expression: 'amount', knownColumns: columns });
  const total = saveRule(db, { name: 'total', expression: 'sum(amount_out)', mode: 'group' });
  const hashes = [];
  let sample;
  for (const batchSize of [1, 5, 53]) {
    const job = createJob(db, {
      datasetVersionId: ds.version.id,
      mode: 'group',
      batchSize,
      groupKeys: [{ name: 'region', expression: 'region' }],
      rules: [
        { outputName: 'amount_out', ruleVersionId: amount.version.id },
        { outputName: 'total', ruleVersionId: total.version.id },
      ],
    });
    const worker = `g-${batchSize}`;
    for (;;) {
      const claimed = claimTasks(db, job.id, worker, 1);
      if (claimed.length === 0) break;
      for (const taskNo of claimed) commitTask(db, job.id, taskNo, worker, runTaskVia(db, job.id, taskNo, worker));
    }
    const result = tryFinalizeJob(db, job.id, { mode: 'group' });
    hashes.push(result.manifest.outputContentHash);
    sample = fs.readFileSync(path.join(result.job.result_dir, 'result.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  }
  assert.equal(new Set(hashes).size, 1, 'batch size must not change the result');

  const expected = new Map();
  for (const r of ROWS) expected.set(r.region, (expected.get(r.region) ?? 0) + r.amount);
  for (const row of sample) {
    const want = Math.fround ? expected.get(row.region) : null;
    assert.ok(Math.abs(row.total - expected.get(row.region)) < 1e-9, `group ${row.region}`);
  }
});

test('dimension versions are pinned per job', () => {
  const { db, ds, dim } = setup();
  const columns = Object.keys(ROWS[0]);
  const v = saveRule(db, {
    name: 'label',
    expression: 'lookup("region_label", region)',
    knownColumns: columns,
    knownDimensions: ['region_label'],
  });
  const job = createJob(db, {
    datasetVersionId: ds.version.id,
    mode: 'row',
    batchSize: 10,
    rules: [{ outputName: 'label', ruleVersionId: v.version.id }],
    dimensions: [{ dimensionVersionId: dim.version.id }],
  });

  const worker = 'dim-w';
  for (;;) {
    const claimed = claimTasks(db, job.id, worker, 1);
    if (claimed.length === 0) break;
    for (const taskNo of claimed) commitTask(db, job.id, taskNo, worker, runTaskVia(db, job.id, taskNo, worker));
  }
  const result = tryFinalizeJob(db, job.id, { mode: 'row' });
  const first = JSON.parse(fs.readFileSync(path.join(result.job.result_dir, 'result.jsonl'), 'utf8').split('\n')[0]);
  assert.equal(first.label, 'United States');
});

test('crash mid-job: committed tasks survive, leases expire, work resumes', () => {
  const { db, ds } = setup();
  const columns = Object.keys(ROWS[0]);
  const v = saveRule(db, { name: 'net', expression: 'round(amount + qty, 3)', knownColumns: columns });
  const job = createJob(db, {
    datasetVersionId: ds.version.id,
    mode: 'row',
    batchSize: 5,
    rules: [{ outputName: 'net', ruleVersionId: v.version.id }],
  });

  // Worker A commits the first 4 tasks then "dies" holding 3 more.
  const a = 'worker-A';
  const claimed = claimTasks(db, job.id, a, 7);
  for (const taskNo of claimed.slice(0, 4)) {
    commitTask(db, job.id, taskNo, a, runTaskVia(db, job.id, taskNo, a));
  }
  assert.equal(claimed.length, 7);

  // Expire A's leases (simulating a killed process).
  db.prepare('UPDATE job_tasks SET lease_expires_at = ? WHERE job_id = ? AND owner = ?').run(
    '2000-01-01T00:00:00.000Z',
    job.id,
    a,
  );
  const requeued = recoverStaleJobs(db, { leaseMs: 1 });
  assert.equal(requeued, 3);
  const ledger = listTasks(db, job.id);
  assert.equal(ledger.filter((t) => t.status === 'done').length, 4);
  assert.equal(ledger.filter((t) => t.status === 'pending').length, ledger.length - 4);

  // Worker B takes over and finishes. Re-running the same task must not
  // duplicate output rows: the task ledger is the commit point.
  const b = 'worker-B';
  for (;;) {
    const more = claimTasks(db, job.id, b, 4);
    if (more.length === 0) break;
    for (const taskNo of more) commitTask(db, job.id, taskNo, b, runTaskVia(db, job.id, taskNo, b));
  }
  const result = tryFinalizeJob(db, job.id, { mode: 'row' });
  assert.equal(result.finalized, true, 'job should finalize after recovery');
  const lines = fs.readFileSync(path.join(result.job.result_dir, 'result.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, ROWS.length, 'no duplicated and no missing rows');
});

test('finalization is idempotent under concurrent callers', () => {
  const { db, ds } = setup();
  const v = saveRule(db, { name: 'n', expression: 'qty', knownColumns: Object.keys(ROWS[0]) });
  const job = createJob(db, {
    datasetVersionId: ds.version.id,
    mode: 'row',
    batchSize: 25,
    rules: [{ outputName: 'n', ruleVersionId: v.version.id }],
  });
  const w = 'fin-w';
  for (;;) {
    const claimed = claimTasks(db, job.id, w, 1);
    if (claimed.length === 0) break;
    for (const t of claimed) commitTask(db, job.id, t, w, runTaskVia(db, job.id, t, w));
  }
  const first = tryFinalizeJob(db, job.id, { mode: 'row' });
  const second = tryFinalizeJob(db, job.id, { mode: 'row' });
  assert.equal(first.finalized, true);
  assert.equal(second.finalized, false, 'second finalize is a no-op');
});

test('a bad expression fails only its own task, not the whole job', () => {
  const { db, ds } = setup();
  const columns = Object.keys(ROWS[0]);
  // Absent until its task runs; then divide by a zero column in one batch.
  const rows = [...ROWS];
  rows[51] = { ...rows[51], qty: 0 };
  const ds2 = ingestDataset(db, { name: 'orders2', source: 'test', records: rows });
  const v = saveRule(db, { name: 'ratio', expression: 'amount / qty', knownColumns: columns });
  const job = createJob(db, {
    datasetVersionId: ds2.version.id,
    mode: 'row',
    batchSize: 5,
    rules: [{ outputName: 'ratio', ruleVersionId: v.version.id }],
  });
  const w = 'fail-w';
  let failures = 0;
  let successes = 0;
  for (let guard = 0; guard < 100; guard += 1) {
    const claimed = claimTasks(db, job.id, w, 1);
    if (claimed.length === 0) break;
    const taskNo = claimed[0];
    try {
      commitTask(db, job.id, taskNo, w, runTaskVia(db, job.id, taskNo, w));
      successes += 1;
    } catch (err) {
      failures += 1;
      assert.match(String(err.message), /division by zero/);
      // The executor reports which input row failed; claimTasks clears the
      // stored error on reclaim, so capture it from the thrown error here.
      assert.ok(err.rowNo, 'error carries the failing input row number');
      db.prepare("UPDATE job_tasks SET status = 'failed' WHERE job_id = ? AND task_no = ?").run(job.id, taskNo);
    }
  }
  assert.equal(failures, 1, 'exactly the task containing the bad row fails');
  assert.ok(successes >= 10, 'all other tasks complete');
});
