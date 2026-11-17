import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

/**
 * End-to-end API tests: start the real server on an ephemeral port against a
 * temporary database, then drive it over HTTP exactly as the browser does.
 */

let serverProcess;
let base;
let tmpDir;

function waitFor(url, timeoutMs = 10_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const loop = () => {
      http
        .get(url, (res) => {
          res.resume();
          resolve();
        })
        .on('error', () => {
          if (Date.now() - started > timeoutMs) reject(new Error('server did not start'));
          else setTimeout(loop, 100);
        });
    };
    loop();
  });
}

async function call(method, pathname, body) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { status: res.status, payload };
}

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-api-'));
  const port = 4100 + Math.floor(Math.random() * 500);
  base = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, [path.join(process.cwd(), 'src', 'server.js')], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DB_PATH: path.join(tmpDir, 'api.db'),
      RESULTS_DIR: path.join(tmpDir, 'results'),
      AUTO_SPAWN_WORKER: '0',
    },
    stdio: 'ignore',
  });
  await waitFor(`${base}/api/health`);
});

test.after(() => {
  serverProcess?.kill('SIGTERM');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('health endpoint reports the configured stores', async () => {
  const { status, payload } = await call('GET', '/api/health');
  assert.equal(status, 200);
  assert.equal(payload.ok, true);
  assert.ok(payload.dbPath.startsWith(tmpDir));
});

test('dataset upload, version reuse, and rows endpoint', async () => {
  const csv = 'id,amount,qty,region\n1,10.5,2,us\n2,20.25,1,eu\n3,5,4,us\n';
  const first = await call('POST', '/api/datasets', { name: 'sales', content: csv, format: 'csv' });
  assert.equal(first.status, 200);
  assert.equal(first.payload.version.rowCount, 3);
  assert.equal(first.payload.version.columns.find((c) => c.name === 'amount').type, 'number');

  const second = await call('POST', '/api/datasets', { name: 'sales', content: csv, format: 'csv' });
  assert.equal(second.payload.reused, true, 'identical upload reuses the version');
  assert.equal(second.payload.version.id, first.payload.version.id);

  const rows = await call('GET', `/api/dataset-versions/${first.payload.version.id}?limit=2`);
  assert.equal(rows.payload.rows.length, 2);
  assert.equal(rows.payload.rows[0].data.amount, 10.5);

  const verify = await call('GET', `/api/dataset-versions/${first.payload.version.id}/verify`);
  assert.equal(verify.payload.ok, true);
});

test('rule validation returns locations for syntax errors', async () => {
  const bad = await call('POST', '/api/rules/validate', { expression: 'amount * ', knownColumns: ['amount'] });
  assert.equal(bad.payload.ok, false);
  assert.equal(bad.payload.error.code, 'E_UNEXPECTED_TOKEN');
  assert.ok(bad.payload.error.line >= 1);

  const unknownColumn = await call('POST', '/api/rules/validate', {
    expression: 'missing_col + 1',
    knownColumns: ['amount'],
  });
  assert.equal(unknownColumn.payload.ok, false);
  assert.match(unknownColumn.payload.errors[0].message, /unknown column/);

  const good = await call('POST', '/api/rules/validate', { expression: 'round(amount, 2)', knownColumns: ['amount'] });
  assert.equal(good.payload.ok, true);
  assert.equal(good.payload.outputType, 'number');
});

test('preview computes real values and reports row-level errors', async () => {
  const ds = await call('POST', '/api/datasets', {
    name: 'preview_ds',
    data: [
      { id: 1, amount: 10, qty: 2 },
      { id: 2, amount: 0, qty: 0 },
    ],
  });
  const dsVersionId = ds.payload.version.id;

  const ok = await call('POST', '/api/preview', {
    datasetVersionId: dsVersionId,
    expression: 'amount * qty',
    limit: 5,
  });
  assert.equal(ok.payload.ok, true);
  assert.equal(ok.payload.results[0].value, 20);

  const divide = await call('POST', '/api/preview', {
    datasetVersionId: dsVersionId,
    expression: 'amount / qty',
    limit: 5,
  });
  assert.equal(divide.payload.ok, false);
  assert.equal(divide.payload.error.code, 'E_EVAL');
  assert.match(divide.payload.error.message, /division by zero/);
});

test('dimension upload is versioned and lookupable in preview', async () => {
  const ds = await call('POST', '/api/datasets', {
    name: 'dim_ds',
    data: [
      { id: 1, region: 'us' },
      { id: 2, region: 'zz' },
    ],
  });
  const dim = await call('POST', '/api/dimensions', {
    name: 'region_label',
    content: 'us,United States\n',
    format: 'csv',
  });
  assert.equal(dim.status, 200);
  assert.equal(dim.payload.version.versionNo, 1);

  const preview = await call('POST', '/api/preview', {
    datasetVersionId: ds.payload.version.id,
    expression: 'lookup("region_label", region)',
    limit: 5,
    dimensions: [{ dimensionVersionId: dim.payload.version.id }],
  });
  assert.equal(preview.payload.ok, true);
  assert.equal(preview.payload.results[0].value, 'United States');
  assert.equal(preview.payload.results[1].value, null, 'miss returns null');
});

test('job creation rejects unknown versions and empty rule sets', async () => {
  const missing = await call('POST', '/api/jobs', {
    datasetVersionId: 'dsv_missing',
    mode: 'row',
    rules: [{ outputName: 'x', expression: '1' }],
  });
  assert.equal(missing.status, 404);

  const ds = await call('POST', '/api/datasets', { name: 'job_ds', data: [{ a: 1 }] });
  const noRules = await call('POST', '/api/jobs', {
    datasetVersionId: ds.payload.version.id,
    mode: 'row',
    rules: [],
  });
  assert.equal(noRules.status, 400);
});

test('a job runs to completion through the worker process and is traceable', async () => {
  const ds = await call('POST', '/api/datasets', {
    name: 'run_ds',
    data: Array.from({ length: 30 }, (_, i) => ({ id: i + 1, amount: (i + 1) * 1.5 })),
  });
  const rule = await call('POST', '/api/rules', {
    name: 'double_amount',
    expression: 'amount * 2',
    knownColumns: ['id', 'amount'],
  });
  assert.equal(rule.status, 200);

  const created = await call('POST', '/api/jobs', {
    datasetVersionId: ds.payload.version.id,
    mode: 'row',
    batchSize: 7,
    rules: [{ outputName: 'double_amount', ruleVersionId: rule.payload.rule.id }],
  });
  assert.equal(created.status, 200);
  const jobId = created.payload.job.id;

  // Run the real worker binary (separate process) instead of an in-server one.
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(process.cwd(), 'src', 'worker.js'), '--job', jobId], {
      cwd: process.cwd(),
      env: { ...process.env, DB_PATH: path.join(tmpDir, 'api.db'), RESULTS_DIR: path.join(tmpDir, 'results') },
      stdio: 'ignore',
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}`))));
  });

  const detail = await call('GET', `/api/jobs/${jobId}`);
  assert.equal(detail.payload.job.status, 'done');
  assert.equal(detail.payload.job.processedRows, 30);

  const manifest = await call('GET', `/api/jobs/${jobId}/manifest`);
  assert.equal(manifest.payload.input.rows, 30);
  assert.ok(manifest.payload.input.contentHash);
  assert.equal(manifest.payload.rules[0].expression, 'amount * 2');
  assert.ok(manifest.payload.expressionHashes[0]);
  assert.ok(manifest.payload.outputContentHash);

  const result = await call('GET', `/api/jobs/${jobId}/result?limit=3`);
  assert.equal(result.payload.total, 30);
  assert.equal(result.payload.rows[0].double_amount, 3);
});

test('unknown routes return a structured 404', async () => {
  const { status, payload } = await call('GET', '/api/nope');
  assert.equal(status, 404);
  assert.equal(payload.error.code, 'E_NOT_FOUND');
});

test('path traversal on the static handler is refused', async () => {
  const res = await fetch(`${base}/../package.json`);
  assert.ok(res.status === 403 || res.status === 404);
});
