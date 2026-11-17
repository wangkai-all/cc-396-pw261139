import { all, get } from '../db.js';
import { evaluate } from '../expr/evaluator.js';
import { RuleFailure } from './compiler.js';
import { getCompiled } from './compile-cache.js';
import { loadPinnedResolvers } from './dimension.js';
import { getJob } from './jobs.js';

/**
 * Preview executes a rule against a handful of *actual* dataset rows, so the
 * web UI shows real computed values rather than a syntax-only check. It uses
 * the exact same compiled-rule path as a job (same evaluator, same compiled
 * AST keyed by the same fingerprint shape), with the candidate rule set built
 * as an ephemeral job-like snapshot - nothing is written to the database and
 * no cache entry is shared with a real job unless the fingerprint matches.
 */

export function previewRule(db, { datasetVersionId, expression, ast, limit = 10, dimensions = [], mode = 'row', groupKeys = [] }) {
  const rows = all(
    db,
    'SELECT row_no, data_json FROM dataset_rows WHERE dataset_version_id = ? ORDER BY row_no LIMIT ?',
    datasetVersionId,
    Math.max(1, Math.min(200, limit)),
  );
  if (rows.length === 0) {
    const err = new Error('dataset version has no rows to preview');
    err.code = 'E_EMPTY_DATASET';
    throw err;
  }

  const pins = [];
  for (const dim of dimensions) {
    const version = get(db, 'SELECT * FROM dimension_versions WHERE id = ?', dim.dimensionVersionId);
    if (!version) {
      const err = new Error(`dimension version ${dim.dimensionVersionId} not found`);
      err.code = 'E_NOT_FOUND';
      throw err;
    }
    pins.push({ name: version.name, dimension_version_id: version.id, version_no: version.version_no });
  }
  const dimResolver = loadPinnedResolvers(db, pins);

  const fakeJob = {
    id: `preview_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    mode,
    rules: [
      {
        output_name: 'preview_value',
        expression,
        ast_json: ast ? JSON.stringify(ast) : null,
        kind: 'value',
      },
    ],
    group_keys:
      mode === 'group'
        ? groupKeys.map((k) => ({ name: k.name, expression: k.expression, ast: k.ast }))
        : [],
    dimensions: pins.map((p) => ({ name: p.name, dimension_version_id: p.dimension_version_id, version_no: p.version_no })),
  };

  const columns = rows.map((r) => JSON.parse(r.data_json));
  const inputColumns = [...new Set(columns.flatMap((c) => Object.keys(c)))];
  const results = [];
  let compiled;
  try {
    compiled = getCompiled(fakeJob, dimResolver);
  } catch (err) {
    return { ok: false, error: { code: err.code ?? 'E_COMPILE', message: err.message }, inputColumns, results: [] };
  }

  if (mode === 'group') {
    const groups = new Map();
    for (let i = 0; i < columns.length; i += 1) {
      const row = { ...columns[i], __row_no: rows[i].row_no };
      try {
        const kv = compiled.evaluateKey(row);
        const key = JSON.stringify(Object.keys(kv).sort().map((k) => [k, kv[k]]));
        let g = groups.get(key);
        if (!g) {
          g = { keyValues: kv, state: compiled.newGroupState() };
          groups.set(key, g);
        }
        compiled.accumulate(g.state, row);
      } catch (err) {
        return {
          ok: false,
          error: { code: err.code ?? 'E_RULE', message: err.message, line: err.line ?? null, col: err.col ?? null },
          inputColumns,
          results: [],
        };
      }
    }
    for (const g of groups.values()) {
      try {
        const out = compiled.finalizeGroup(g.keyValues, g.state);
        results.push({ key: g.keyValues, value: out.preview_value });
      } catch (err) {
        return {
          ok: false,
          error: { code: err.code ?? 'E_RULE', message: err.message, line: err.line ?? null, col: err.col ?? null },
          inputColumns,
          results: [],
        };
      }
    }
  } else {
    for (let i = 0; i < columns.length; i += 1) {
      const row = { ...columns[i], __row_no: rows[i].row_no };
      try {
        const value = evaluate(JSON.parse(JSON.stringify(compiled.rules[0].ast)), {
          row,
          dims: dimResolver,
          group: null,
        });
        results.push({ rowNo: rows[i].row_no, input: columns[i], value });
      } catch (err) {
        return {
          ok: false,
          error: {
            code: err.code ?? 'E_RULE',
            message: err.message,
            line: err.line ?? null,
            col: err.col ?? null,
          },
          inputColumns,
          results,
        };
      }
    }
  }

  return { ok: true, inputColumns, results, pinnedDimensions: dimResolver.pins };
}

export { getJob, RuleFailure };
