import { fail } from './errors.js';

/**
 * Deterministic evaluator with three-valued (SQL-style) logic.
 *
 * Every value is one of: null, boolean, number, string. There are no
 * objects, arrays, or callables, so a rule cannot mutate the engine state or
 * reach the host process. The same (AST, row, pinned dimensions) always
 * produces the same value: the function set is pure, there is intentionally
 * no now()/today()/random(), and group sums use compensated summation so the
 * result does not depend on row arrival order.
 */

const MAX_STRING = 100_000;
const MAX_ARGS = 16;

export const AGGREGATE_FUNCTIONS = new Set(['sum', 'count', 'min', 'max', 'avg', 'count_distinct']);

export const SCALAR_FUNCTIONS = new Set([
  'lookup',
  'coalesce',
  'if',
  'lower',
  'upper',
  'trim',
  'length',
  'concat',
  'substr',
  'startswith',
  'endswith',
  'contains',
  'abs',
  'round',
  'floor',
  'ceil',
  'min_of',
  'max_of',
]);

const ARITY = {
  lookup: [2, 2],
  coalesce: [1, MAX_ARGS],
  if: [3, 3],
  lower: [1, 1],
  upper: [1, 1],
  trim: [1, 1],
  length: [1, 1],
  concat: [1, MAX_ARGS],
  substr: [2, 3],
  startswith: [2, 2],
  endswith: [2, 2],
  contains: [2, 2],
  abs: [1, 1],
  round: [1, 2],
  floor: [1, 1],
  ceil: [1, 1],
  min_of: [1, MAX_ARGS],
  max_of: [1, MAX_ARGS],
  sum: [1, 1],
  count: [0, 1],
  min: [1, 1],
  max: [1, 1],
  avg: [1, 1],
  count_distinct: [1, 1],
};

export function typeName(v) {
  if (v === null) return 'null';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  if (typeof v === 'string') return 'text';
  if (typeof v === 'boolean') return 'boolean';
  return typeof v;
}

function invalid(message, node) {
  fail('E_EVAL', message, { line: node?.line, col: node?.col });
}

function typeError(message, node) {
  fail('E_TYPE', message, { line: node?.line, col: node?.col });
}

function roundHalfAwayFromZero(x, digits = 0) {
  if (!Number.isFinite(x)) invalid('round() received a non-finite number');
  if (digits < 0 || digits > 9) typeError('round() digits must be between 0 and 9');
  if (!Number.isInteger(digits)) typeError('round() digits must be an integer');
  const factor = 10 ** digits;
  const scaled = x * factor;
  const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled) + Number.EPSILON);
  return rounded / factor;
}

function checkString(s, node) {
  if (s.length > MAX_STRING) {
    invalid(`text value exceeds the ${MAX_STRING} character limit`, node);
  }
  return s;
}

/** Three-valued truth: true, false, or null. */
export function truth3(v, node) {
  if (v === null || typeof v === 'boolean') return v;
  typeError(`expected a boolean condition but found ${typeName(v)}`, node);
}

/**
 * Build an evaluation context bound to one rule execution.
 *
 * `dims` must be a snapshot resolver (see dimension.js): `get(name, key)`.
 * `group` is present only when evaluating an aggregate output expression and
 * exposes `aggregate(fnName, argAstList, rowValues)`.
 */
export function makeContext({ row = {}, dims = null, group = null, warn = null } = {}) {
  return { row, dims, group, warn };
}

function requireDims(ctx, node) {
  if (!ctx.dims) {
    invalid('lookup() is not available in this execution context', node);
  }
  return ctx.dims;
}

function compareValues(op, a, b, node) {
  if (a === null || b === null) return null;
  if (typeof a !== typeof b) {
    typeError(`cannot compare ${typeName(a)} with ${typeName(b)}`, node);
  }
  if (typeof a !== 'number' && typeof a !== 'string' && typeof a !== 'boolean') {
    typeError(`cannot compare values of type ${typeName(a)}`, node);
  }
  switch (op) {
    case '==':
      return a === b;
    case '!=':
      return a !== b;
    case '<':
      return a < b;
    case '<=':
      return a <= b;
    case '>':
      return a > b;
    case '>=':
      return a >= b;
    default:
      invalid(`unknown comparison operator ${op}`, node);
  }
}

function numberArg(v, fn, node) {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    typeError(`${fn}() expects a number but found ${typeName(v)}`, node);
  }
  return v;
}

function stringArg(v, fn, node) {
  if (typeof v !== 'string') {
    typeError(`${fn}() expects text but found ${typeName(v)}`, node);
  }
  return v;
}

export function evaluate(node, ctx) {
  return evalNode(node, ctx);
}

function evalNode(node, ctx) {
  switch (node.type) {
    case 'Literal':
      return node.value;

    case 'Column': {
      if (!Object.prototype.hasOwnProperty.call(ctx.row, node.name)) {
        invalid(`unknown column "${node.name}"`, node);
      }
      const v = ctx.row[node.name];
      if (v === undefined) return null;
      if (v === null) return null;
      if (typeof v === 'number') {
        if (!Number.isFinite(v)) invalid(`column "${node.name}" holds a non-finite number`, node);
        return v;
      }
      if (typeof v === 'string') return checkString(v, node);
      if (typeof v === 'boolean') return v;
      typeError(`column "${node.name}" holds an unsupported value of type ${typeof v}`, node);
      break;
    }

    case 'Unary': {
      const v = evalNode(node.operand, ctx);
      if (node.op === 'not') {
        const t = truth3(v, node);
        return t === null ? null : !t;
      }
      if (node.op === '-') {
        return -numberArg(v, 'unary -', node);
      }
      if (node.op === '+') {
        return numberArg(v, 'unary +', node);
      }
      invalid(`unknown unary operator ${node.op}`, node);
      break;
    }

    case 'Binary': {
      if (node.op === 'and') {
        const l = truth3(evalNode(node.left, ctx), node.left);
        if (l === false) return false;
        const r = truth3(evalNode(node.right, ctx), node.right);
        if (r === false) return false;
        if (l === null || r === null) return null;
        return true;
      }
      if (node.op === 'or') {
        const l = truth3(evalNode(node.left, ctx), node.left);
        if (l === true) return true;
        const r = truth3(evalNode(node.right, ctx), node.right);
        if (r === true) return true;
        if (l === null || r === null) return null;
        return false;
      }

      const a = evalNode(node.left, ctx);
      const b = evalNode(node.right, ctx);

      if (node.op === '==' || node.op === '!=' || node.op === '<' || node.op === '<=' || node.op === '>' || node.op === '>=') {
        return compareValues(node.op, a, b, node);
      }

      if (a === null || b === null) return null;
      if (node.op === '+' && typeof a === 'string' && typeof b === 'string') {
        return checkString(a + b, node);
      }
      const x = numberArg(a, `operator ${node.op}`, node.left);
      const y = numberArg(b, `operator ${node.op}`, node.right);
      switch (node.op) {
        case '+':
          return x + y;
        case '-':
          return x - y;
        case '*':
          return x * y;
        case '/':
          if (y === 0) invalid('division by zero', node);
          return x / y;
        case '%':
          if (y === 0) invalid('modulo by zero', node);
          return x % y;
        default:
          invalid(`unknown operator ${node.op}`, node);
      }
      break;
    }

    case 'IsNull':
      return (evalNode(node.operand, ctx) === null) !== node.negated;

    case 'InList': {
      const v = evalNode(node.operand, ctx);
      if (v === null) return null;
      let sawNull = false;
      for (const item of node.list) {
        const candidate = evalNode(item, ctx);
        if (candidate === null) {
          sawNull = true;
          continue;
        }
        const eq = compareValues('==', v, candidate, node);
        if (eq === true) return !node.negated;
      }
      // SQL semantics: a non-match against a list containing null is unknown.
      if (sawNull) return null;
      return node.negated;
    }

    case 'Between': {
      const v = evalNode(node.operand, ctx);
      const low = evalNode(node.low, ctx);
      const high = evalNode(node.high, ctx);
      if (v === null || low === null || high === null) return null;
      const geLow = compareValues('>=', v, low, node.operand);
      const leHigh = compareValues('<=', v, high, node.operand);
      if (geLow === null || leHigh === null) return null;
      return (geLow && leHigh) !== node.negated;
    }

    case 'Call':
      return evalCall(node, ctx);

    default:
      invalid(`unsupported expression node ${node.type}`, node);
  }
}

function evalArgs(node, ctx) {
  if (node.args.length > MAX_ARGS) {
    invalid(`${node.name}() accepts at most ${MAX_ARGS} arguments`, node);
  }
  const out = new Array(node.args.length);
  for (let i = 0; i < node.args.length; i += 1) out[i] = evalNode(node.args[i], ctx);
  return out;
}

function evalCall(node, ctx) {
  const name = node.name;
  // Own-property check, not a truthiness check: `ARITY['constructor']` would
  // otherwise resolve to Object.prototype.constructor and blow up below.
  const arity = Object.prototype.hasOwnProperty.call(ARITY, name) ? ARITY[name] : null;
  if (!arity) invalid(`unknown function "${name}"`, node);
  const [min, max] = arity;
  if (node.args.length < min || node.args.length > max) {
    invalid(
      `${name}() expects ${min === max ? min : `${min}-${max}`} argument(s), got ${node.args.length}`,
      node,
    );
  }

  // `if` and `coalesce` short-circuit so an unused branch cannot raise.
  if (name === 'if') {
    const cond = truth3(evalNode(node.args[0], ctx), node.args[0]);
    if (cond === true) return evalNode(node.args[1], ctx);
    return evalNode(node.args[2], ctx);
  }
  if (name === 'coalesce') {
    for (const arg of node.args) {
      const v = evalNode(arg, ctx);
      if (v !== null) return v;
    }
    return null;
  }

  if (AGGREGATE_FUNCTIONS.has(name)) {
    if (!ctx.group) {
      invalid(`${name}() is only allowed in group output expressions`, node);
    }
    return ctx.group.aggregate(name, node.args, node);
  }

  if (name === 'lookup') {
    const dimName = node.args[0];
    if (dimName.type !== 'Literal' || typeof dimName.value !== 'string') {
      invalid('lookup() requires a dimension name as a string literal', dimName);
    }
    const resolver = requireDims(ctx, node);
    const key = evalNode(node.args[1], ctx);
    if (key === null) return null;
    if (typeof key !== 'string' && typeof key !== 'number' && typeof key !== 'boolean') {
      typeError(`lookup() key must be a scalar, found ${typeName(key)}`, node.args[1]);
    }
    const value = resolver.get(dimName.value, key);
    return value === undefined ? null : value;
  }

  const args = evalArgs(node, ctx);

  switch (name) {
    case 'lower':
      return checkString(stringArg(args[0], name, node).toLowerCase(), node);
    case 'upper':
      return checkString(stringArg(args[0], name, node).toUpperCase(), node);
    case 'trim':
      return stringArg(args[0], name, node).trim();
    case 'length':
      return [...stringArg(args[0], name, node)].length;
    case 'concat':
      return checkString(
        args.map((v) => (v === null ? '' : String(v))).join(''),
        node,
      );
    case 'substr': {
      const s = [...stringArg(args[0], name, node)];
      const start = numberArg(args[1], name, node);
      if (!Number.isInteger(start) || start < 1) typeError('substr() start must be an integer >= 1');
      const len = args.length === 3 ? numberArg(args[2], name, node) : s.length;
      if (!Number.isInteger(len) || len < 0) typeError('substr() length must be an integer >= 0');
      return s.slice(start - 1, start - 1 + len).join('');
    }
    case 'startswith':
      return stringArg(args[0], name, node).startsWith(stringArg(args[1], name, node));
    case 'endswith':
      return stringArg(args[0], name, node).endsWith(stringArg(args[1], name, node));
    case 'contains':
      return stringArg(args[0], name, node).includes(stringArg(args[1], name, node));
    case 'abs':
      return Math.abs(numberArg(args[0], name, node));
    case 'round':
      return roundHalfAwayFromZero(
        numberArg(args[0], name, node),
        args.length === 2 ? numberArg(args[1], name, node) : 0,
      );
    case 'floor':
      return Math.floor(numberArg(args[0], name, node));
    case 'ceil':
      return Math.ceil(numberArg(args[0], name, node));
    case 'min_of':
    case 'max_of': {
      const nonNull = args.filter((v) => v !== null);
      if (nonNull.length === 0) return null;
      let best = nonNull[0];
      for (const v of nonNull.slice(1)) {
        const cmp = compareValues(name === 'min_of' ? '<' : '>', v, best, node);
        if (cmp === true) best = v;
      }
      return best;
    }
    default:
      invalid(`unknown function "${name}"`, node);
  }
}

/**
 * Walk the AST collecting the columns and functions it references.
 * Used by the compiler for schema checks and for dependency metadata.
 */
export function analyzeAst(node, out = { columns: new Set(), functions: new Set(), dimensions: new Set(), aggregates: new Set(), lookupKeys: [] }) {
  switch (node.type) {
    case 'Column':
      out.columns.add(node.name);
      break;
    case 'Call': {
      out.functions.add(node.name);
      if (AGGREGATE_FUNCTIONS.has(node.name)) out.aggregates.add(node.name);
      if (node.name === 'lookup' && node.args[0]?.type === 'Literal') {
        out.dimensions.add(node.args[0].value);
        out.lookupKeys.push(node.args[1]);
      }
      for (const a of node.args) analyzeAst(a, out);
      break;
    }
    case 'Unary':
      analyzeAst(node.operand, out);
      break;
    case 'Binary':
      analyzeAst(node.left, out);
      analyzeAst(node.right, out);
      break;
    case 'IsNull':
      analyzeAst(node.operand, out);
      break;
    case 'InList':
      analyzeAst(node.operand, out);
      for (const i of node.list) analyzeAst(i, out);
      break;
    case 'Between':
      analyzeAst(node.operand, out);
      analyzeAst(node.low, out);
      analyzeAst(node.high, out);
      break;
    case 'Literal':
      break;
    default:
      break;
  }
  return out;
}
