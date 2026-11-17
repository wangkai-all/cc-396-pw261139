import { all, get, run, transaction } from '../db.js';
import { parse } from '../expr/parser.js';
import { analyzeAst } from '../expr/evaluator.js';
import { ExprError, excerpt } from '../expr/errors.js';
import { hashJson, newId, nowIso, isSafeName } from '../lib/util.js';

/**
 * Rule versions.
 *
 * A rule is compiled once at save time (parse + static checks) and the AST is
 * stored with the row. Jobs copy the compiled AST into job_rules, so editing
 * or deleting a rule later cannot alter a job that is already running. If a
 * job's stored AST is ever missing (e.g. hand-edited database), the worker
 * re-parses from the pinned expression text — the text is always the source
 * of truth and is never treated as documentation.
 */

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function staticCheck(expression, { mode = 'row', knownColumns = null, knownDimensions = null, outputName = null } = {}) {
  let ast;
  try {
    ast = parse(expression);
  } catch (err) {
    if (err instanceof ExprError) {
      return { ok: false, error: serializeError(err, expression) };
    }
    throw err;
  }
  const info = analyzeAst(ast);
  const warnings = [];
  const errors = [];

  if (outputName && !IDENT.test(outputName)) {
    errors.push({ code: 'E_OUTPUT_NAME', message: `output name "${outputName}" must match ${IDENT}` });
  }
  if (info.aggregates.size > 0 && mode !== 'group') {
    errors.push({
      code: 'E_AGGREGATE_CONTEXT',
      message: `aggregate function(s) ${[...info.aggregates].join(', ')} are only allowed in group output expressions`,
    });
  }
  if (mode === 'group' && info.aggregates.size === 0) {
    warnings.push('group output has no aggregate function; it will repeat the first value of the group');
  }
  for (const fn of info.functions) {
    if (fn === 'lookup' && !knownDimensions) {
      continue;
    }
  }
  if (knownColumns) {
    const known = new Set(knownColumns);
    for (const column of info.columns) {
      if (!known.has(column)) {
        errors.push({
          code: 'E_UNKNOWN_COLUMN',
          message: `unknown column "${column}"; available columns: ${[...known].sort().join(', ')}`,
        });
      }
    }
  }
  if (knownDimensions) {
    const known = new Set(knownDimensions);
    for (const dim of info.dimensions) {
      if (!known.has(dim)) {
        warnings.push(`dimension "${dim}" is not loaded; lookup("${dim}", ...) will fail at run time`);
      }
    }
  }
  return {
    ok: errors.length === 0,
    ast,
    info: {
      columns: [...info.columns].sort(),
      functions: [...info.functions].sort(),
      dimensions: [...info.dimensions].sort(),
      aggregates: [...info.aggregates].sort(),
    },
    outputType: inferOutputType(ast),
    errors,
    warnings,
  };
}

function inferOutputType(ast) {
  if (!ast) return 'unknown';
  switch (ast.type) {
    case 'Literal':
      if (ast.value === null) return 'null';
      return typeof ast.value;
    case 'Binary':
      if (['and', 'or'].includes(ast.op)) return 'boolean';
      if (['==', '!=', '<', '<=', '>', '>='].includes(ast.op)) return 'boolean';
      return 'number';
    case 'Unary':
      return ast.op === 'not' ? 'boolean' : 'number';
    case 'IsNull':
    case 'InList':
    case 'Between':
      return 'boolean';
    case 'Call': {
      if (['lookup', 'coalesce', 'if', 'min_of', 'max_of', 'min', 'max'].includes(ast.name)) {
        const inner = ast.name === 'lookup' || ast.name === 'coalesce' ? null : ast.args;
        return inner ? 'union' : 'unknown';
      }
      if (['lower', 'upper', 'trim', 'concat', 'substr'].includes(ast.name)) return 'string';
      if (['length', 'abs', 'round', 'floor', 'ceil', 'sum', 'count', 'avg', 'count_distinct'].includes(ast.name)) {
        return 'number';
      }
      if (['startswith', 'endswith', 'contains'].includes(ast.name)) return 'boolean';
      return 'unknown';
    }
    default:
      return 'unknown';
  }
}

export function serializeError(err, expression) {
  return {
    code: err.code ?? 'E_UNKNOWN',
    message: err.message,
    line: err.line ?? null,
    col: err.col ?? null,
    excerpt: expression ? excerpt(expression, err.line, err.col) : '',
  };
}

export function latestRuleVersion(db, name) {
  return get(db, 'SELECT * FROM rule_versions WHERE name = ? ORDER BY version_no DESC LIMIT 1', name);
}

export function listRules(db) {
  return all(
    db,
    `SELECT name, MAX(version_no) AS latest_version, COUNT(*) AS versions
     FROM rule_versions GROUP BY name ORDER BY name`,
  );
}

export function listRuleVersions(db, name) {
  return all(db, 'SELECT * FROM rule_versions WHERE name = ? ORDER BY version_no DESC', name);
}

export function getRuleVersion(db, id) {
  return get(db, 'SELECT * FROM rule_versions WHERE id = ?', id);
}

/**
 * Save a new rule version. Identical expression + note + source is reused
 * rather than versioned again, so "publish the same rule twice" is idempotent.
 */
export function saveRule(db, { name, expression, note = '', source = 'api', knownColumns = null, knownDimensions = null, mode = 'row' }) {
  if (!isSafeName(name)) {
    const err = new Error(`rule name ${JSON.stringify(name)} is not allowed`);
    err.code = 'E_SCHEMA';
    throw err;
  }
  const check = staticCheck(expression, { mode, knownColumns, knownDimensions, outputName: null });
  if (!check.ok) {
    const err = new Error(check.error ? check.error.message : check.errors.map((e) => e.message).join('; '));
    err.code = check.error ? check.error.code : check.errors[0].code;
    err.details = check.error ?? { errors: check.errors };
    throw err;
  }
  const fingerprint = hashJson({ expression, note, source });
  return transaction(db, () => {
    const latest = latestRuleVersion(db, name);
    if (latest && hashJson({ expression: latest.expression, note: latest.note, source: latest.source }) === fingerprint) {
      return { version: latest, reused: true };
    }
    const versionNo = (latest?.version_no ?? 0) + 1;
    const id = newId('rule_');
    run(
      db,
      `INSERT INTO rule_versions
        (id, name, version_no, expression, ast_json, output_type, columns_json, functions_json, dimensions_json, source, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      name,
      versionNo,
      expression,
      JSON.stringify(check.ast),
      check.outputType,
      JSON.stringify(check.info.columns),
      JSON.stringify(check.info.functions),
      JSON.stringify(check.info.dimensions),
      source,
      note,
      nowIso(),
    );
    return { version: getRuleVersion(db, id), reused: false, info: check.info };
  });
}

export function parseStored(expression, astJson) {
  if (astJson) {
    try {
      return JSON.parse(astJson);
    } catch {
      /* fall through to re-parse */
    }
  }
  return parse(expression);
}
