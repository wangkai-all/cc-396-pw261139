#!/usr/bin/env node
/** Small CLI to drive the engine without the web UI. */
import fs from 'node:fs';
import { openDatabase, all, get } from '../src/db.js';
import { config } from '../src/config.js';
import { latestDatasetVersion, verifyDatasetVersion, loadDatasetRows } from '../src/engine/dataset.js';
import { latestDimensionVersion } from '../src/engine/dimension.js';
import { latestRuleVersion, getRuleVersion } from '../src/engine/rules.js';
import { createJob, getJob, claimTasks, commitTask, tryFinalizeJob, jobEvents, listTasks } from '../src/engine/jobs.js';
import { runTask } from '../src/engine/executor.js';
import { previewRule } from '../src/engine/preview.js';
import { parse } from '../src/expr/parser.js';
import { evaluate } from '../src/expr/evaluator.js';

const db = openDatabase(config.dbPath);
const [cmd, ...args] = process.argv.slice(2);

function value(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
function flag(name) {
  return args.includes(`--${name}`);
}

function resolveDatasetVersion() {
  const explicit = value('dataset-version');
  if (explicit) return explicit;
  const name = value('dataset') || 'demo_orders';
  const ds = get(db, 'SELECT * FROM datasets WHERE name = ?', name);
  if (!ds) throw new Error(`dataset ${name} not found; run npm run seed`);
  return latestDatasetVersion(db, ds.id).id;
}

function resolveRule(name) {
  const rv = latestRuleVersion(db, name);
  if (!rv) throw new Error(`rule ${name} not found`);
  return rv;
}

async function main() {
  switch (cmd) {
    case 'datasets': {
      console.log(JSON.stringify(all(db, 'SELECT id, name FROM datasets'), null, 2));
      return;
    }
    case 'rules': {
      const rows = all(db, 'SELECT name, version_no, output_type FROM rule_versions ORDER BY name, version_no');
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    case 'eval': {
      const expr = value('expr');
      const rv = value('row');
      const versionId = resolveDatasetVersion();
      const rows = loadDatasetRows(db, versionId);
      const row = rv ? rows[Number(rv) - 1] : rows[0];
      const value_ = evaluate(parse(expr), { row: row.data, dims: makeDims() });
      console.log(JSON.stringify({ rowNo: row.rowNo, value: value_ }));
      return;
    }
    case 'run': {
      // --rule a --rule b --dim customer_segment --batch 200 [--mode group --key month]
      const ruleNames = [];
      for (let i = 0; i < args.length; i += 1) if (args[i] === '--rule') ruleNames.push(args[i + 1]);
      if (ruleNames.length === 0) throw new Error('--rule is required');
      const dimNames = [];
      for (let i = 0; i < args.length; i += 1) if (args[i] === '--dim') dimNames.push(args[i + 1]);
      const mode = value('mode') === 'group' ? 'group' : 'row';
      const datasetVersionId = resolveDatasetVersion();
      const rules = ruleNames.map((n) => {
        const rv = resolveRule(n);
        return { outputName: n, ruleVersionId: rv.id };
      });
      let groupKeys = [];
      if (mode === 'group') {
        const keyRule = resolveRule(value('key') || 'month_key');
        groupKeys = [{ name: value('key') || 'month_key', ruleVersionId: keyRule.id }];
      }
      const dims = dimNames.map((n) => {
        const dv = latestDimensionVersion(db, n);
        if (!dv) throw new Error(`dimension ${n} not found`);
        return { dimensionVersionId: dv.id };
      });
      const job = createJob(db, {
        name: value('name') || `cli-${mode}`,
        datasetVersionId,
        mode,
        groupKeys,
        rules,
        dimensions: dims,
        batchSize: Number(value('batch') || 200),
      });
      console.error(`job ${job.id} created (${job.total_rows} rows, ${job.batch_size}/task)`);
      const worker = 'cli';
      for (;;) {
        const claimed = claimTasks(db, job.id, worker, 1);
        if (claimed.length === 0) break;
        const out = runTask(db, job.id, claimed[0], worker);
        commitTask(db, job.id, claimed[0], worker, out);
      }
      const fin = tryFinalizeJob(db, job.id, { mode });
      const files = jobResultFilesSafe(job.id);
      console.log(JSON.stringify({ jobId: job.id, status: fin.job.status, manifestHash: fin.manifestHash, rows: fin.rows, result: files.result, manifest: files.manifest }, null, 2));
      return;
    }
    case 'preview': {
      const expr = value('expr') || resolveRule(value('rule')).expression;
      const versionId = resolveDatasetVersion();
      const dimNames = [];
      for (let i = 0; i < args.length; i += 1) if (args[i] === '--dim') dimNames.push(args[i + 1]);
      const r = previewRule(db, {
        datasetVersionId: versionId,
        expression: expr,
        limit: Number(value('limit') || 5),
        mode: value('mode') === 'group' ? 'group' : 'row',
        groupKeys: value('mode') === 'group' ? [{ name: 'month_key', expression: 'substr(order_date, 1, 7)', ast: parse('substr(order_date, 1, 7)') }] : [],
        dimensions: dimNames.map((n) => ({ dimensionVersionId: latestDimensionVersion(db, n).id })),
      });
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    case 'verify': {
      console.log(JSON.stringify(verifyDatasetVersion(db, value('version') || resolveDatasetVersion()), null, 2));
      return;
    }
    case 'events': {
      console.log(JSON.stringify(jobEvents(db, value('job'), 50), null, 2));
      return;
    }
    default:
      console.log(`commands: datasets | rules | eval --expr | preview --rule|--expr | run --rule | verify | events --job`);
  }
}

function makeDims() {
  const dv = latestDimensionVersion(db, 'customer_segment');
  if (!dv) return null;
  const rows = all(db, 'SELECT key, key_type, value_json FROM dimension_rows WHERE dimension_version_id = ?', dv.id);
  const map = new Map(rows.map((r) => [`${r.key_type}\u0000${r.key}`, JSON.parse(r.value_json)]));
  return (name, key) => {
    if (name !== 'customer_segment') return null;
    return map.get(`s\u0000${key}`) ?? null;
  };
}

function jobResultFilesSafe(jobId) {
  const job = get(db, 'SELECT result_dir FROM jobs WHERE id = ?', jobId);
  return { result: `${job.result_dir}/result.jsonl`, manifest: `${job.result_dir}/manifest.json` };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
