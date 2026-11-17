import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { openDatabase, all, get } from './db.js';
import { newId, parseCsv, parseJsonl, coerceCsvValue, isSafeName, clampInt } from './lib/util.js';
import { ingestDataset, listDatasets, listDatasetVersions, getDatasetVersion, verifyDatasetVersion, latestDatasetVersion, loadDatasetRows } from './engine/dataset.js';
import { ingestDimension, listDimensions, listDimensionVersions, latestDimensionVersion, getDimensionVersion } from './engine/dimension.js';
import { saveRule, listRules, listRuleVersions, latestRuleVersion, getRuleVersion, staticCheck, serializeError } from './engine/rules.js';
import { createJob, getJob, listJobs, listTasks, jobEvents, cancelJob, jobResultFiles, forkJob, recoverStaleJobs, logEvent } from './engine/jobs.js';
import { previewRule } from './engine/preview.js';
import { parse } from './expr/parser.js';
import { hashJson } from './lib/util.js';

const db = openDatabase(config.dbPath);
const publicDir = path.resolve(process.cwd(), 'public');
const server = http.createServer(handle);
const startedAt = Date.now();
let workersSpawned = 0;

/** In-memory concurrency guard; the database is the real source of truth. */
const previewLimiter = { active: 0, max: 4 };

server.listen(config.port, config.host, () => {
  process.stdout.write(`pointwise rules server on http://${config.host}:${config.port}\n`);
  if (config.autoSpawnWorker) spawnWorker();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}

/* ------------------------------------------------------------------ *
 * Routing
 * ------------------------------------------------------------------ */

const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const regex = new RegExp(
    `^${pattern.replace(/:([A-Za-z_]+)/g, (_, key) => {
      keys.push(key);
      return '([^/]+)';
    })}$`,
  );
  routes.push({ method, regex, keys, handler });
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const match = r.regex.exec(url.pathname);
      if (!match) continue;
      const params = {};
      r.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(match[i + 1]);
      });
      const body = req.method === 'GET' || req.method === 'DELETE' ? null : await readBody(req);
      const result = await r.handler({ req, res, params, query: url.searchParams, body, url });
      if (result !== undefined && !res.headersSent) sendJson(res, 200, result);
      return;
    }
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      return serveStatic(req, res, url.pathname);
    }
    sendJson(res, 404, { error: { code: 'E_NOT_FOUND', message: `no route for ${req.method} ${url.pathname}` } });
  } catch (err) {
    const status = statusFor(err);
    sendJson(res, status, {
      error: {
        code: err.code || 'E_INTERNAL',
        message: err.message || 'internal error',
        details: err.details ?? null,
      },
    });
  }
}

function statusFor(err) {
  if (err.status) return err.status;
  switch (err.code) {
    case 'E_NOT_FOUND':
      return 404;
    case 'E_VALIDATION':
    case 'E_SCHEMA':
    case 'E_EMPTY_DATASET':
    case 'E_EMPTY_DIMENSION':
    case 'E_DUPLICATE_KEY':
    case 'E_CSV':
    case 'E_JSONL':
    case 'E_DUPLICATE_OUTPUT':
      return 400;
    case 'E_INVALID_STATE':
      return 409;
    default:
      break;
  }
  // Expression errors surface as 422 with code + location.
  if (typeof err.code === 'string' && err.code.startsWith('E_') && err.line !== undefined) return 422;
  if (typeof err.code === 'string' && /^(E_SOURCE|E_NUMBER|E_STRING|E_UNEXPECTED|E_TRAILING|E_TOO_|E_EMPTY_LIST|E_CHAINED|E_QUALIFIED)/.test(err.code)) {
    return 422;
  }
  if (err.code === 'E_TYPE' || err.code === 'E_EVAL' || err.code === 'E_RULE') return 422;
  return 500;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > config.maxUploadBytes) {
      const err = new Error('request body too large');
      err.code = 'E_TOO_LARGE';
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  const text = Buffer.concat(chunks).toString('utf8');
  const type = req.headers['content-type'] || '';
  if (type.includes('application/json')) {
    try {
      return JSON.parse(text);
    } catch {
      const err = new Error('request body is not valid JSON');
      err.code = 'E_BAD_JSON';
      err.status = 400;
      throw err;
    }
  }
  return text;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.resolve(path.join(publicDir, rel));
  if (!file.startsWith(`${publicDir}${path.sep}`) && file !== path.join(publicDir, 'index.html')) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    const ext = path.extname(file);
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
    };
    res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ *
 * Health
 * ------------------------------------------------------------------ */

route('GET', '/api/health', () => ({
  ok: true,
  uptimeMs: Date.now() - startedAt,
  dbPath: config.dbPath,
  resultsDir: config.resultsDir,
  workersSpawned,
}));

/* ------------------------------------------------------------------ *
 * Datasets
 * ------------------------------------------------------------------ */

route('GET', '/api/datasets', () => ({ datasets: listDatasets(db) }));

route('POST', '/api/datasets', ({ body }) => {
  const { name, format, content, data, description, source } = body ?? {};
  if (!isSafeName(name)) throw badRequest('dataset name is required (letters, digits, underscore, dot, dash)');
  let records;
  let sourceLabel = source || 'upload';
  if (Array.isArray(data)) {
    records = data;
  } else if (typeof content === 'string') {
    if (format === 'csv' || sourceLabel === 'csv') {
      const parsed = parseCsv(content);
      records = parsed.rows.map((cells) => {
        const obj = {};
        parsed.columns.forEach((col, i) => {
          obj[col] = coerceCsvValue(cells[i]);
        });
        return obj;
      });
      sourceLabel = sourceLabel === 'upload' ? 'csv' : sourceLabel;
    } else if (format === 'jsonl') {
      records = parseJsonl(content);
    } else {
      throw badRequest('format must be "csv" or "jsonl" when content is text');
    }
  } else {
    throw badRequest('provide data (array of objects) or content + format');
  }
  const result = ingestDataset(db, { name, description: description ?? '', source: sourceLabel, records });
  return {
    dataset: publicDataset(result.dataset),
    version: publicVersion(result.version),
    reused: result.reused,
    columns: result.columns,
  };
});

route('GET', '/api/datasets/:id', ({ params }) => {
  const dataset = get(db, 'SELECT * FROM datasets WHERE id = ?', params.id);
  if (!dataset) throw notFound('dataset not found');
  return {
    dataset: publicDataset(dataset),
    versions: listDatasetVersions(db, params.id).map(publicVersion),
  };
});

route('GET', '/api/datasets/:id/versions', ({ params }) => ({
  versions: listDatasetVersions(db, params.id).map(publicVersion),
}));

route('GET', '/api/dataset-versions/:id', ({ params, query }) => {
  const version = getDatasetVersion(db, params.id);
  if (!version) throw notFound('dataset version not found');
  const limit = clampInt(query.get('limit'), 1, 500, 20);
  const offset = clampInt(query.get('offset'), 0, Number.MAX_SAFE_INTEGER, 0);
  const rows = all(
    db,
    'SELECT row_no, data_json FROM dataset_rows WHERE dataset_version_id = ? ORDER BY row_no LIMIT ? OFFSET ?',
    params.id,
    limit,
    offset,
  );
  return {
    version: publicVersion(version),
    rows: rows.map((r) => ({ rowNo: r.row_no, data: JSON.parse(r.data_json) })),
    total: version.row_count,
  };
});

route('GET', '/api/dataset-versions/:id/verify', ({ params }) => verifyDatasetVersion(db, params.id));

/* ------------------------------------------------------------------ *
 * Dimensions
 * ------------------------------------------------------------------ */

route('GET', '/api/dimensions', () => ({ dimensions: listDimensions(db) }));

route('POST', '/api/dimensions', ({ body }) => {
  const { name, content, format, entries, source } = body ?? {};
  if (!isSafeName(name)) throw badRequest('dimension name is required');
  let list;
  if (Array.isArray(entries)) {
    list = entries.map((e) => ({ key: e.key, value: e.value }));
  } else if (typeof content === 'string') {
    if (format === 'csv') {
      // Dimension CSV is positional: key,value. A leading "key,value" header
      // is tolerated so users can paste either form.
      let parsed = parseCsv(content, { header: false });
      if (parsed.rows.length > 0 && String(parsed.rows[0][0]).trim().toLowerCase() === 'key') parsed.rows.shift();
      if (parsed.rows.some((cells) => cells.length < 2)) {
        throw badRequest('dimension CSV rows must have at least two columns (key,value)');
      }
      list = parsed.rows.map((cells) => ({ key: coerceCsvValue(cells[0]), value: coerceCsvValue(cells[1]) }));
    } else if (format === 'jsonl') {
      list = parseJsonl(content).map((o) => {
        if (!('key' in o)) throw badRequest('dimension JSONL rows need a "key" field');
        if (!('value' in o)) throw badRequest('dimension JSONL rows need a "value" field');
        return { key: o.key, value: o.value };
      });
    } else {
      throw badRequest('format must be "csv" or "jsonl"');
    }
  } else {
    throw badRequest('provide entries or content + format');
  }
  const result = ingestDimension(db, { name, source: source || 'upload', entries: list });
  return { version: publicDimVersion(result.version), reused: result.reused };
});

route('GET', '/api/dimensions/:name', ({ params }) => ({
  versions: listDimensionVersions(db, params.name).map(publicDimVersion),
}));

route('GET', '/api/dimension-versions/:id', ({ params }) => {
  const version = getDimensionVersion(db, params.id);
  if (!version) throw notFound('dimension version not found');
  const limit = clampInt(100, 1, 1000, 100);
  const rows = all(
    db,
    'SELECT key, key_type, value_json FROM dimension_rows WHERE dimension_version_id = ? LIMIT ?',
    params.id,
    limit,
  );
  return {
    version: publicDimVersion(version),
    entries: rows.map((r) => ({ key: r.key_type === 'n' ? Number(r.key) : r.key_type === 'b' ? r.key === 'true' : r.key, value: JSON.parse(r.value_json) })),
  };
});

/* ------------------------------------------------------------------ *
 * Rules
 * ------------------------------------------------------------------ */

route('GET', '/api/rules', () => ({ rules: listRules(db) }));

route('GET', '/api/rules/:name', ({ params }) => {
  const versions = listRuleVersions(db, params.name);
  if (versions.length === 0) throw notFound('rule not found');
  return { name: params.name, versions: versions.map(publicRule) };
});

route('POST', '/api/rules', ({ body }) => {
  const { name, expression, note, knownColumns, knownDimensions, mode } = body ?? {};
  try {
    const result = saveRule(db, {
      name,
      expression,
      note: note ?? '',
      source: 'api',
      knownColumns: Array.isArray(knownColumns) ? knownColumns : null,
      knownDimensions: Array.isArray(knownDimensions) ? knownDimensions : null,
      mode: mode === 'group' ? 'group' : 'row',
    });
    return { rule: publicRule(result.version), reused: result.reused, info: result.info ?? null };
  } catch (err) {
    if (err.details) {
      err.status = 422;
      err.code = err.code || 'E_EXPRESSION';
    }
    throw err;
  }
});

/** Syntax + static analysis without persisting. Always returns 200. */
route('POST', '/api/rules/validate', ({ body }) => {
  const { expression, knownColumns, knownDimensions, mode, outputName } = body ?? {};
  const check = staticCheck(String(expression ?? ''), {
    mode: mode === 'group' ? 'group' : 'row',
    knownColumns: Array.isArray(knownColumns) ? knownColumns : null,
    knownDimensions: Array.isArray(knownDimensions) ? knownDimensions : null,
    outputName: outputName ?? null,
  });
  if (check.ok) {
    return {
      ok: true,
      outputType: check.outputType,
      info: check.info,
      warnings: check.warnings,
      ast: check.ast,
    };
  }
  return { ok: false, error: check.error ?? { code: check.errors[0]?.code, message: check.errors.map((e) => e.message).join('; ') }, errors: check.errors, warnings: check.warnings };
});

route('POST', '/api/preview', ({ body }) => {
  const { datasetVersionId, expression, limit, dimensions, mode, groupKeys, knownDimensions } = body ?? {};
  if (!datasetVersionId) throw badRequest('datasetVersionId is required');
  if (!getDatasetVersion(db, datasetVersionId)) throw notFound('dataset version not found');
  if (previewLimiter.active >= previewLimiter.max) {
    const err = new Error('too many concurrent previews; retry shortly');
    err.code = 'E_BUSY';
    err.status = 429;
    throw err;
  }
  const version = getDatasetVersion(db, datasetVersionId);
  const knownColumns = JSON.parse(version.columns_json).map((c) => c.name);
  const check = staticCheck(String(expression ?? ''), {
    mode: mode === 'group' ? 'group' : 'row',
    knownColumns,
    knownDimensions: Array.isArray(knownDimensions) ? knownDimensions : listDimensions(db).map((d) => d.name),
  });
  if (!check.ok) {
    return { ok: false, stage: 'compile', error: check.error ?? { code: check.errors[0]?.code, message: check.errors.map((e) => e.message).join('; ') }, errors: check.errors, warnings: check.warnings, ast: null };
  }
  previewLimiter.active += 1;
  try {
    const result = previewRule(db, {
      datasetVersionId,
      expression: String(expression ?? ''),
      ast: check.ast,
      limit: limit ?? 10,
      dimensions: Array.isArray(dimensions) ? dimensions : [],
      mode: mode === 'group' ? 'group' : 'row',
      groupKeys: Array.isArray(groupKeys) ? groupKeys : [],
    });
    return { ...result, warnings: check.warnings, outputType: check.outputType, ast: check.ast };
  } finally {
    previewLimiter.active -= 1;
  }
});

/* ------------------------------------------------------------------ *
 * Jobs
 * ------------------------------------------------------------------ */

route('POST', '/api/jobs', ({ body }) => {
  const { name, datasetVersionId, mode, groupKeys, rules, dimensions, batchSize, runLabel, startWorker } = body ?? {};
  const job = createJob(db, {
    name: name ?? '',
    datasetVersionId,
    mode: mode === 'group' ? 'group' : 'row',
    groupKeys: Array.isArray(groupKeys) ? groupKeys : [],
    rules: Array.isArray(rules) ? rules : [],
    dimensions: Array.isArray(dimensions) ? dimensions : [],
    batchSize,
    runLabel: runLabel ?? '',
  });
  if (startWorker && config.autoSpawnWorker) spawnWorker(job.id);
  return { job: publicJob(job) };
});

route('GET', '/api/jobs', ({ query }) => ({
  jobs: listJobs(db, clampInt(query.get('limit'), 1, 200, 50)).map(publicJobSummary),
}));

route('GET', '/api/jobs/:id', ({ params }) => {
  const job = getJob(db, params.id);
  if (!job) throw notFound('job not found');
  const tasks = listTasks(db, params.id);
  const byStatus = {};
  for (const t of tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
  return {
    job: publicJob(job),
    tasks: tasks.map((t) => ({
      taskNo: t.task_no,
      status: t.status,
      rowStart: t.row_start,
      rowEnd: t.row_end,
      attempts: t.attempts,
      owner: t.owner,
      error: t.error,
    })),
    taskSummary: byStatus,
    events: jobEvents(db, params.id, 100).map(publicEvent),
  };
});

route('GET', '/api/jobs/:id/result', ({ params, query }) => {
  const job = getJob(db, params.id);
  if (!job) throw notFound('job not found');
  const limit = clampInt(query.get('limit'), 1, 1000, 50);
  const offset = clampInt(query.get('offset'), 0, Number.MAX_SAFE_INTEGER, 0);
  const files = jobResultFiles(db, params.id);
  if (!fs.existsSync(files.result)) {
    return { ready: false, status: job.status, rows: [], total: null };
  }
  const lines = fs.readFileSync(files.result, 'utf8').split('\n').filter(Boolean);
  return {
    ready: true,
    status: job.status,
    total: lines.length,
    offset,
    rows: lines.slice(offset, offset + limit).map((l) => JSON.parse(l)),
  };
});

route('GET', '/api/jobs/:id/manifest', ({ params, res }) => {
  const files = jobResultFiles(db, params.id);
  if (!files || !fs.existsSync(files.manifest)) throw notFound('manifest not available yet');
  const manifest = fs.readFileSync(files.manifest, 'utf8');
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(manifest);
  return undefined;
});

route('GET', '/api/jobs/:id/result.jsonl', ({ params, res }) => {
  const files = jobResultFiles(db, params.id);
  if (!files || !fs.existsSync(files.result)) throw notFound('result not available yet');
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'content-disposition': `attachment; filename="${params.id}.jsonl"`,
  });
  fs.createReadStream(files.result).pipe(res);
  return undefined;
});

route('POST', '/api/jobs/:id/wake', ({ params }) => {
  const job = getJob(db, params.id);
  if (!job) throw notFound('job not found');
  if (job.status === 'cancelled' || job.status === 'done') {
    throw invalidState(`job is ${job.status}`);
  }
  if (config.autoSpawnWorker) spawnWorker(params.id);
  return { ok: true, workerSpawned: config.autoSpawnWorker };
});

route('POST', '/api/jobs/:id/cancel', ({ params }) => ({ job: publicJob(cancelJob(db, params.id)) }));

route('POST', '/api/jobs/recover', () => ({
  requeuedTasks: recoverStaleJobs(db, { leaseMs: config.leaseMs }),
}));

/** Fork a job with replacement outputs - the A/B rule comparison path. */
route('POST', '/api/jobs/:id/fork', ({ params, body }) => {
  const { rules, name, runLabel, startWorker } = body ?? {};
  if (!Array.isArray(rules) || rules.length === 0) throw badRequest('rules are required');
  const job = forkJob(db, params.id, { rules, name, runLabel });
  if (startWorker && config.autoSpawnWorker) spawnWorker(job.id);
  return { job: publicJob(job) };
});

/* ------------------------------------------------------------------ *
 * Helpers: public shapes and errors
 * ------------------------------------------------------------------ */

function spawnWorker(jobId = null) {
  if (!config.autoSpawnWorker) return;
  const args = [path.join(process.cwd(), 'src', 'worker.js')];
  if (jobId) args.push('--job', jobId);
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  workersSpawned += 1;
}

function badRequest(message) {
  const err = new Error(message);
  err.code = 'E_VALIDATION';
  return err;
}
function notFound(message) {
  const err = new Error(message);
  err.code = 'E_NOT_FOUND';
  return err;
}
function invalidState(message) {
  const err = new Error(message);
  err.code = 'E_INVALID_STATE';
  return err;
}

function publicDataset(d) {
  return { id: d.id, name: d.name, description: d.description, createdAt: d.created_at, latestVersion: d.latest_version ?? null };
}

function publicVersion(v) {
  return {
    id: v.id,
    datasetId: v.dataset_id,
    versionNo: v.version_no,
    rowCount: v.row_count,
    columns: JSON.parse(v.columns_json),
    contentHash: v.content_hash,
    source: v.source,
    createdAt: v.created_at,
  };
}

function publicDimVersion(v) {
  return {
    id: v.id,
    name: v.name,
    versionNo: v.version_no,
    rowCount: v.row_count,
    contentHash: v.content_hash,
    source: v.source,
    createdAt: v.created_at,
  };
}

function publicRule(v) {
  return {
    id: v.id,
    name: v.name,
    versionNo: v.version_no,
    expression: v.expression,
    outputType: v.output_type,
    columns: JSON.parse(v.columns_json),
    functions: JSON.parse(v.functions_json),
    dimensions: JSON.parse(v.dimensions_json),
    source: v.source,
    note: v.note,
    createdAt: v.created_at,
    contentHash: hashJson(v.expression),
  };
}

function publicJob(job) {
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    mode: job.mode,
    datasetVersionId: job.dataset_version_id,
    datasetName: job.dataset_name ?? undefined,
    datasetVersionNo: job.dataset_version_no ?? undefined,
    groupKeys: job.group_keys?.map((k) => k.name) ?? [],
    rules: job.rules?.map((r) => ({
      outputName: r.output_name,
      ruleVersionId: r.rule_version_id,
      expression: r.expression,
      kind: r.kind,
    })) ?? [],
    dimensions: job.dimensions?.map((d) => ({
      name: d.name,
      versionId: d.dimension_version_id,
      versionNo: d.version_no,
      contentHash: d.content_hash,
      rows: d.row_count,
    })) ?? [],
    totalRows: job.total_rows,
    totalGroups: job.total_groups,
    processedRows: job.processed_rows,
    failedRows: job.failed_rows,
    batchSize: job.batch_size,
    createdAt: job.created_at,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
    heartbeatAt: job.heartbeat_at,
    error: job.error,
    resultDir: job.result_dir,
    manifestHash: job.manifest_hash,
    runLabel: job.run_label,
    resumedFrom: job.resumed_from,
  };
}

function publicJobSummary(job) {
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    mode: job.mode,
    datasetName: job.dataset_name,
    datasetVersionNo: job.dataset_version_no,
    totalRows: job.total_rows,
    processedRows: job.processed_rows,
    runLabel: job.run_label,
    resumedFrom: job.resumed_from,
    createdAt: job.created_at,
    finishedAt: job.finished_at,
    manifestHash: job.manifest_hash,
  };
}

function publicEvent(e) {
  return {
    at: e.at,
    level: e.level,
    kind: e.kind,
    message: e.message,
    data: e.data_json ? JSON.parse(e.data_json) : null,
  };
}
