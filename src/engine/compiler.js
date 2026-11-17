import { evaluate, AGGREGATE_FUNCTIONS, analyzeAst } from '../expr/evaluator.js';
import { ExprError } from '../expr/errors.js';
import { canonicalJson, encodeAggregateValue } from '../lib/util.js';
import { ZERO, addExact, exactSumToDouble, serializeExact, deserializeExact } from '../lib/exact.js';

/**
 * Compiles the pinned rule set for one job.
 *
 * Compilation happens once per job, from the job's stored expression text and
 * the job's pinned dimension versions. The worker does not consult the live
 * rule tables or the newest dimension version, which is what makes a running
 * job immune to rule edits and dimension re-uploads.
 */

export class RuleFailure extends Error {
  constructor(ruleName, rowNo, cause, phase) {
    super(cause?.message ?? String(cause));
    this.name = 'RuleFailure';
    this.ruleName = ruleName;
    this.rowNo = rowNo;
    this.phase = phase;
    this.code = cause?.code ?? 'E_RULE';
    this.line = cause?.line ?? null;
    this.col = cause?.col ?? null;
  }
}

function aggregateSignature(node) {
  return canonicalJson({ fn: node.name, args: node.args });
}

/**
 * Find every distinct aggregate call in the rule and assign it an accumulator.
 * Aggregate arguments are evaluated per row; the output expression is
 * evaluated once per group against pre-computed aggregate values.
 */
function collectAggregates(ast, registry) {
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Call') {
      if (AGGREGATE_FUNCTIONS.has(node.name)) {
        const sig = aggregateSignature(node);
        if (!registry.has(sig)) {
          registry.set(sig, { signature: sig, fn: node.name, args: node.args, node });
        }
        // Aggregate arguments are row expressions: do not descend looking for
        // nested aggregates (they are rejected below).
        for (const arg of node.args) walk(arg);
        return;
      }
      for (const arg of node.args) walk(arg);
      return;
    }
    if (node.type === 'Binary') {
      walk(node.left);
      walk(node.right);
      return;
    }
    if (node.type === 'Unary') return walk(node.operand);
    if (node.type === 'IsNull') return walk(node.operand);
    if (node.type === 'InList') {
      walk(node.operand);
      for (const i of node.list) walk(i);
      return;
    }
    if (node.type === 'Between') {
      walk(node.operand);
      walk(node.low);
      walk(node.high);
    }
  };
  walk(ast);
  return registry;
}

function findNestedAggregate(node, insideAggregate = false) {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'Call') {
    const isAgg = AGGREGATE_FUNCTIONS.has(node.name);
    if (isAgg && insideAggregate) return true;
    return node.args.some((a) => findNestedAggregate(a, insideAggregate || isAgg));
  }
  if (node.type === 'Binary') return findNestedAggregate(node.left, insideAggregate) || findNestedAggregate(node.right, insideAggregate);
  if (node.type === 'Unary') return findNestedAggregate(node.operand, insideAggregate);
  if (node.type === 'IsNull') return findNestedAggregate(node.operand, insideAggregate);
  if (node.type === 'InList') return findNestedAggregate(node.operand, insideAggregate) || node.list.some((n) => findNestedAggregate(n, insideAggregate));
  if (node.type === 'Between') return findNestedAggregate(node.operand, insideAggregate) || findNestedAggregate(node.low, insideAggregate) || findNestedAggregate(node.high, insideAggregate);
  return false;
}

export function compileJob({ mode, rules, groupKeys = [], dimResolver, onWarn = null }) {
  const aggregateRegistry = new Map();
  const allRules = [];
  const seenOutputs = new Set();

  for (const rule of rules) {
    if (seenOutputs.has(rule.output_name)) {
      const err = new Error(`duplicate output name "${rule.output_name}"`);
      err.code = 'E_DUPLICATE_OUTPUT';
      throw err;
    }
    seenOutputs.add(rule.output_name);
    const ast = typeof rule.ast === 'string' ? JSON.parse(rule.ast) : rule.ast;
    if (findNestedAggregate(ast)) {
      const err = new Error(`rule "${rule.output_name}": aggregate functions cannot be nested`);
      err.code = 'E_NESTED_AGGREGATE';
      throw err;
    }
    collectAggregates(ast, aggregateRegistry);
    allRules.push({ name: rule.output_name, ast, expression: rule.expression, kind: rule.kind });
  }

  const keySpecs = groupKeys.map((key) => {
    const ast = typeof key.ast === 'string' ? JSON.parse(key.ast) : key.ast;
    return { name: key.name, ast };
  });

  // Group mode is two-phase: first compute every output that has no
  // aggregate (these are ordinary row expressions and may feed aggregates),
  // then evaluate the aggregate outputs per group. Doing it this way means
  // `sum(net_amount)` can refer to another configured output directly instead
  // of forcing the user to copy the expression.
  const rowRules = mode === 'group'
    ? allRules.filter((r) => analyzeAst(r.ast).aggregates.size === 0)
    : allRules;
  const aggRules = mode === 'group'
    ? allRules.filter((r) => analyzeAst(r.ast).aggregates.size > 0)
    : [];

  const keyNames = new Set(keySpecs.map((k) => k.name));
  const producedNames = new Set([...keyNames, ...rowRules.map((r) => r.name)]);
  if (mode === 'group') {
    for (const rule of aggRules) {
      for (const column of analyzeAst(rule.ast).columns) {
        if (!producedNames.has(column)) {
          const err = new Error(
            `group output "${rule.name}": column "${column}" is unavailable in the group context; ` +
              `reference a group key, a row-level output, or wrap it in an aggregate`,
          );
          err.code = 'E_GROUP_COLUMN';
          throw err;
        }
      }
    }
  }

  const requiresLookup = allRules.some((r) => analyzeAst(r.ast).functions.has('lookup'));
  const aggregateList = [...aggregateRegistry.values()];
  const compiledRules = [...rowRules, ...aggRules];

  return {
    mode,
    rules: compiledRules,
    rowRules,
    aggRules,
    keySpecs,
    aggregateList,
    requiresLookup,
    /** Phase 1: compute non-aggregate outputs for one input row. */
    evaluateRow(row) {
      const out = {};
      for (const rule of rowRules) {
        try {
          out[rule.name] = evaluate(rule.ast, { row, dims: dimResolver, group: null });
        } catch (err) {
          throw new RuleFailure(rule.name, row.__row_no ?? null, err, 'value');
        }
      }
      return out;
    },
    evaluateKey(row) {
      const out = {};
      for (const spec of keySpecs) {
        out[spec.name] = evaluate(spec.ast, { row, dims: dimResolver, group: null });
      }
      return out;
    },
    /**
     * Phase 1 for a group row: compute non-aggregate outputs first, then
     * accumulate aggregates against the *augmented* row so `sum(net_amount)`
     * sees the value another configured output just produced.
     */
    accumulate(state, row, computed = null) {
      const augmented = computed ? { ...row, ...computed } : row;
      for (const agg of aggregateList) {
        const slot = state.slots[agg.signature] ?? (state.slots[agg.signature] = newSlot(agg.fn));
        if (agg.fn === 'count' && agg.args.length === 0) {
          slot.n += 1;
          continue;
        }
        let value;
        try {
          value = evaluate(agg.args[0], { row: augmented, dims: dimResolver, group: null });
        } catch (err) {
          throw new RuleFailure(agg.node.name, row.__row_no ?? null, err, 'aggregate');
        }
        addValue(slot, value);
      }
    },
    /** Phase 2: evaluate the aggregate outputs for one finished group. */
    finalizeGroup(keyValues, state) {
      const aggResults = new Map();
      for (const agg of aggregateList) {
        aggResults.set(agg.signature, finishSlot(state.slots[agg.signature], agg.fn));
      }
      const groupContext = {
        aggregate(name, args, node) {
          const sig = canonicalJson({ fn: name, args });
          if (!aggResults.has(sig)) {
            const err = new ExprError('E_EVAL', 'aggregate value was not accumulated');
            throw err;
          }
          return aggResults.get(sig);
        },
      };
      const out = { ...keyValues };
      for (const rule of aggRules) {
        try {
          out[rule.name] = evaluate(rule.ast, { row: keyValues, dims: dimResolver, group: groupContext });
        } catch (err) {
          throw new RuleFailure(rule.name, null, err, 'finalize');
        }
      }
      return out;
    },
    newGroupState() {
      return { slots: {} };
    },
    aggregateList,
    onWarn,
  };
}

/* ------------------------------------------------------------------ *
 * Exact, order-independent accumulators.
 *
 * Sums are accumulated as exact integers: every finite double is an integer
 * multiple of 2^-1074, so the running total is held as a BigInt in those
 * units (see lib/exact.js) and rounded to a double once, at the end.
 * Addition of BigInts is exact and commutative, so splitting rows across
 * tasks or workers cannot change the result: the same multiset of values
 * always produces bit-identical output regardless of batch size or order.
 * ------------------------------------------------------------------ */

function newSlot(fn) {
  switch (fn) {
    case 'sum':
    case 'avg':
      return { fn, exact: ZERO, n: 0 };
    case 'count':
      return { fn, n: 0 };
    case 'count_distinct':
      return { fn, seen: new Set() };
    case 'min':
      return { fn, value: undefined };
    case 'max':
      return { fn, value: undefined };
    default:
      return { fn, n: 0 };
  }
}

function addValue(slot, value) {
  if (value === null || value === undefined) return;
  if (typeof value !== 'number') {
    const err = new ExprError('E_TYPE', `${slot.fn}() expects numbers but found ${typeof value}`);
    throw err;
  }
  if (!Number.isFinite(value)) {
    throw new ExprError('E_EVAL', `${slot.fn}() received a non-finite number`);
  }
  switch (slot.fn) {
    case 'sum':
    case 'avg':
      slot.exact = addExact(slot.exact, value);
      slot.n += 1;
      return;
    case 'count':
      slot.n += 1;
      return;
    case 'count_distinct':
      slot.seen.add(encodeAggregateValue(value));
      return;
    case 'min':
      if (slot.value === undefined || value < slot.value) slot.value = value;
      return;
    case 'max':
      if (slot.value === undefined || value > slot.value) slot.value = value;
      return;
    default:
      return;
  }
}

function finishSlot(slot, fn) {
  if (!slot) {
    // No rows accumulated for this aggregate (empty group cannot happen for
    // streaming groups, but keep the shape total).
    return fn === 'count' ? 0 : null;
  }
  switch (fn) {
    case 'sum':
      return exactSumToDouble(slot.exact);
    case 'avg':
      return slot.n === 0 ? null : exactSumToDouble(slot.exact) / slot.n;
    case 'count':
      return slot.n;
    case 'count_distinct':
      return slot.seen.size;
    case 'min':
    case 'max':
      return slot.value === undefined ? null : slot.value;
    default:
      return null;
  }
}

/** Merge two in-memory slots; exact accumulators merge as integer addition. */
export function mergeSlot(a, b) {
  if (!a) return b;
  if (!b) return a;
  switch (a.fn) {
    case 'sum':
    case 'avg':
      return { fn: a.fn, exact: a.exact + b.exact, n: a.n + b.n };
    case 'count':
      return { fn: a.fn, n: a.n + b.n };
    case 'count_distinct': {
      const merged = new Set(a.values ?? a.seen);
      for (const v of b.values ?? b.seen) merged.add(v);
      return { fn: a.fn, values: [...merged] };
    }
    case 'min': {
      const values = [a.value, b.value].filter((v) => v !== undefined && v !== null);
      return { fn: a.fn, value: values.length ? Math.min(...values) : undefined };
    }
    case 'max': {
      const values = [a.value, b.value].filter((v) => v !== undefined && v !== null);
      return { fn: a.fn, value: values.length ? Math.max(...values) : undefined };
    }
    default:
      return a;
  }
}

export function serializeGroupState(state) {
  const slots = {};
  for (const [sig, slot] of Object.entries(state.slots)) {
    if (slot.fn === 'count_distinct') {
      slots[sig] = { fn: slot.fn, values: [...slot.seen] };
    } else if (slot.fn === 'sum' || slot.fn === 'avg') {
      slots[sig] = { fn: slot.fn, exact: serializeExact(slot.exact), n: slot.n };
    } else {
      slots[sig] = { ...slot };
    }
  }
  return { slots };
}

export function deserializeGroupState(json) {
  const slots = {};
  for (const [sig, slot] of Object.entries(json.slots ?? {})) {
    if (slot.fn === 'count_distinct') slots[sig] = { fn: slot.fn, seen: new Set(slot.values) };
    else if (slot.fn === 'sum' || slot.fn === 'avg') slots[sig] = { fn: slot.fn, exact: deserializeExact(slot.exact), n: slot.n };
    else slots[sig] = { ...slot };
  }
  return { slots };
}

export function finishFromSerialized(slot, fn) {
  if (!slot) return fn === 'count' ? 0 : null;
  if (slot.fn === 'count_distinct') return new Set(slot.values).size;
  return finishSlot(slot, fn);
}
