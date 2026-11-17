#!/usr/bin/env node
/**
 * End-to-end demonstration of the guarantees, without the web UI.
 *
 *   1. seed a dataset, dimensions and rules
 *   2. run part of a job, then publish a new rule version mid-run
 *   3. prove the in-flight job still uses the pinned expression
 *   4. simulate a crashed worker (expired lease) and resume with another
 *   5. run a second rule variant over the same pinned input and compare
 *   6. read back the manifest that ties every output to its input version
 *
 * Run: npm run demo
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-demo-'));
process.env.DB_PATH = path.join(tmp, 'demo.db');
process.env.RESULTS_DIR = path.join(tmp, 'results');
process.env.AUTO_SPAWN_WORKER = '0';

const heading = (text) => process.stdout.write(`\n\x1b[1m${text}\x1b[0m\n${'─'.repeat(text.length)}\n`);
const note = (text) => process.stdout.write(`  ${text}\n`);
const fail = (message) => {
  process.stderr.write(`\n\x1b[31m${message}\x1b[0m\n`);
  process.exit(1);
};

try {
  // ---------------------------------------------------------------- 1. seed
  heading('1. seed');
  const seed = spawnSync(process.execPath, [path.join(root, 'scripts', 'seed.js')], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
  });
  if (seed.status !== 0) fail(seed.stderr);
  const seeded = JSON.parse(seed.stdout);
  note(`dataset demo_orders — ${seeded.rows} rows, content ${seeded.datasetContentHash.slice(0, 16)}…`);
  note(`rules: ${seeded.rules.map((r) => `${r.name}@v${r.versionNo}`).join(', ')}`);

  // Env is set before these imports, because src/config.js reads it at load.
  const { openDatabase, get } = await import('../src/db.js');
  const { config } = await import('../src/config.js');
  const { latestDatasetVersion } = await import('../src/engine/dataset.js');
  const { latestDimensionVersion } = await import('../src/engine/dimension.js');
  const { latestRuleVersion, saveRule } = await import('../src/engine/rules.js');
  const { createJob, getJob, claimTasks, commitTask, tryFinalizeJob, recoverStaleJobs } =
    await import('../src/engine/jobs.js');
  const { runTask } = await import('../src/engine/executor.js');

  const db = openDatabase(config.dbPath);
  const closeDb = () => db.close?.();

  const dataset = get(db, "SELECT * FROM datasets WHERE name = 'demo_orders'");
  const datasetVersion = latestDatasetVersion(db, dataset.id);
  const columns = JSON.parse(datasetVersion.columns_json).map((c) => c.name);
  const dims = ['customer_segment', 'region_tier'].map((name) => ({
    dimensionVersionId: latestDimensionVersion(db, name).id,
  }));
  const v1 = latestRuleVersion(db, 'net_amount_v1');

  const drain = (jobId, worker, batch = 4) => {
    for (;;) {
      const tasks = claimTasks(db, jobId, worker, batch);
      if (tasks.length === 0) return;
      for (const task of tasks) commitTask(db, jobId, task, worker, runTask(db, jobId, task, worker));
    }
  };

  const readResult = (job) =>
    fs
      .readFileSync(path.join(job.result_dir, 'result.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

  // ------------------------------------------------------- 2. partial run
  heading('2. run part of a job');
  const job = createJob(db, {
    name: 'demo-run',
    datasetVersionId: datasetVersion.id,
    mode: 'row',
    batchSize: 10,
    rules: [{ outputName: 'net_amount_v1', ruleVersionId: v1.id }],
    dimensions: dims,
  });
  note(`job ${job.id}: ${job.total_rows} rows, ${job.total_rows / 10} tasks of 10`);
  const firstBatch = claimTasks(db, job.id, 'worker-A', 4);
  for (const task of firstBatch.slice(0, 2)) {
    commitTask(db, job.id, task, 'worker-A', runTask(db, job.id, task, 'worker-A'));
  }
  note(`worker-A committed 2 task(s) and died holding ${firstBatch.length - 2} leased task(s)`);

  // --------------------------------------------- 3. publish a new version
  heading('3. publish a new rule version mid-run');
  const v2 = saveRule(db, {
    name: 'net_amount_v1',
    expression: 'gross_amount * 999',
    knownColumns: columns,
    mode: 'row',
  });
  note(`published net_amount_v1 v${v2.version.version_no}: "gross_amount * 999"`);
  note(`the running job still pins "${getJob(db, job.id).rules[0].expression}"`);
  const v3 = saveRule(db, {
    name: 'net_amount_v1',
    expression: 'round(gross_amount * (1 - discount_pct), 2)',
    knownColumns: columns,
    mode: 'row',
  });
  note(`restored net_amount_v1 as v${v3.version.version_no} for new jobs`);

  // ------------------------------------------- 4. expire lease and resume
  heading('4. resume after the worker dies');
  db.prepare(
    'UPDATE job_tasks SET lease_expires_at = ? WHERE job_id = ? AND owner = ?',
  ).run('2000-01-01T00:00:00.000Z', job.id, 'worker-A');
  const requeued = recoverStaleJobs(db, { leaseMs: 1 });
  note(`recovery requeued ${requeued} task(s) whose lease had expired`);
  drain(job.id, 'worker-B');
  const finished = tryFinalizeJob(db, job.id, { mode: 'row' });
  const rows = readResult(finished.job);
  const trustworthy = rows.every((row) =>
    row.status === 'refunded'
      ? row.net_amount_v1 === 0
      : Math.abs(row.net_amount_v1 - Math.round(row.gross_amount * (1 - row.discount_pct) * 100) / 100) < 1e-9,
  );
  note(`worker-B finished: ${rows.length} rows, every one evaluated with the pinned v1 expression: ${trustworthy}`);
  if (!trustworthy) fail('a resumed batch used the edited rule');

  // ------------------------------------------------- 5. parallel variant
  heading('5. run a second rule variant over the same input');
  const variantRule = saveRule(db, {
    name: 'net_amount_variant',
    expression: 'round(gross_amount * (1 - discount_pct) * 1.01, 2)',
    knownColumns: columns,
    mode: 'row',
  });
  const variant = createJob(db, {
    name: 'demo-variant',
    datasetVersionId: datasetVersion.id,
    mode: 'row',
    batchSize: 10,
    rules: [{ outputName: 'net_amount_variant', ruleVersionId: variantRule.version.id }],
    dimensions: dims,
    resumedFrom: job.id,
    runLabel: 'variant-1.01x',
  });
  drain(variant.id, 'worker-C');
  const variantFinished = tryFinalizeJob(db, variant.id, { mode: 'row' });
  const variantRows = readResult(variantFinished.job);
  note(`base    row 1: net_amount_v1      = ${rows[0].net_amount_v1}`);
  note(`variant row 1: net_amount_variant = ${variantRows[0].net_amount_variant}`);
  note(`variant ${variant.id} is a fork of ${variant.resumed_from}`);

  // ---------------------------------------------------- 6. traceability
  heading('6. trace every result back to its input version');
  const manifest = JSON.parse(
    fs.readFileSync(path.join(finished.job.result_dir, 'manifest.json'), 'utf8'),
  );
  const variantManifest = JSON.parse(
    fs.readFileSync(path.join(variantFinished.job.result_dir, 'manifest.json'), 'utf8'),
  );
  note(`input dataset   ${manifest.input.datasetName} v${manifest.input.versionNo}`);
  note(`input hash      ${manifest.input.contentHash}`);
  note(`dimension pins  ${manifest.dimensions.map((d) => `${d.name}@v${d.versionNo}`).join(', ')}`);
  note(`rule versions   ${manifest.rules.map((r) => `${r.ruleName}@v${r.versionNo}`).join(', ')}`);
  note(`output hash     ${manifest.outputContentHash}`);
  note(`both runs read the same input: ${manifest.input.contentHash === variantManifest.input.contentHash}`);
  note(`artifacts: ${path.dirname(finished.job.result_dir)}/…/manifest.json`);

  heading('done');
  closeDb();
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
