import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../src/expr/parser.js';
import { evaluate } from '../../src/expr/evaluator.js';
import { ExprError } from '../../src/expr/errors.js';

function value(expr, row = {}, dims = null) {
  return evaluate(parse(expr), { row, dims, group: null });
}

test('arithmetic and precedence', () => {
  assert.equal(value('1 + 2 * 3'), 7);
  assert.equal(value('(1 + 2) * 3'), 9);
  assert.equal(value('-2 * -3'), 6);
  assert.equal(value('10 % 3'), 1);
  assert.equal(value('7 / 2'), 3.5);
  assert.equal(value('2 * (3 + 4) - 5 / 5'), 13);
});

test('string literals and escapes', () => {
  assert.equal(value('"a" + "b"'), 'ab');
  assert.equal(value("'it\\'s'"), "it's");
  assert.equal(value('"tab\\there"'), 'tab\there');
  assert.equal(value('"line\\nbreak"'), 'line\nbreak');
});

test('null propagation follows SQL three-valued logic', () => {
  assert.equal(value('null + 1'), null);
  assert.equal(value('null == null'), null);
  assert.equal(value('1 == null'), null);
  assert.equal(value('null and true'), null);
  assert.equal(value('null and false'), false);
  assert.equal(value('null or true'), true);
  assert.equal(value('null or false'), null);
  assert.equal(value('not null'), null);
  assert.equal(value('null is null'), true);
  assert.equal(value('null is not null'), false);
  assert.equal(value('1 is null'), false);
});

test('comparison and boolean operators', () => {
  assert.equal(value('1 < 2 and 2 <= 2'), true);
  assert.equal(value('3 > 4 or 4 >= 4'), true);
  assert.equal(value('1 != 2'), true);
  assert.equal(value('1 <> 2'), true);
  assert.equal(value('"a" < "b"'), true);
});

test('in / between / not in', () => {
  assert.equal(value('2 in (1, 2, 3)'), true);
  assert.equal(value('4 in (1, 2, 3)'), false);
  assert.equal(value('4 not in (1, 2, 3)'), true);
  assert.equal(value('5 between 1 and 10'), true);
  assert.equal(value('5 between 6 and 10'), false);
  assert.equal(value('5 not between 1 and 4'), true);
  assert.equal(value('null in (1, 2)'), null);
});

test('column access and unknown-column errors', () => {
  assert.equal(value('a * 2', { a: 5 }), 10);
  assert.throws(() => value('missing', { a: 1 }), (e) => e.code === 'E_EVAL' && /unknown column/.test(e.message));
});

test('strict typing rejects mixed comparisons and non-numeric maths', () => {
  assert.throws(() => value('1 < "2"'), (e) => e instanceof ExprError && e.code === 'E_TYPE');
  assert.throws(() => value('"a" - 1'), (e) => e instanceof ExprError && e.code === 'E_TYPE');
  assert.throws(() => value('1 and true'), (e) => e instanceof ExprError && e.code === 'E_TYPE');
});

test('division and modulo by zero are errors, not infinities', () => {
  assert.throws(() => value('1 / 0'), (e) => e.code === 'E_EVAL');
  assert.throws(() => value('1 % 0'), (e) => e.code === 'E_EVAL');
});

test('short-circuit if and coalesce', () => {
  assert.equal(value('if(true, 1, 1 / 0)'), 1);
  assert.equal(value('if(false, 1 / 0, 2)'), 2);
  assert.equal(value('coalesce(null, null, "x")'), 'x');
  assert.equal(value('coalesce(null, null)'), null);
});

test('text functions', () => {
  assert.equal(value('lower("ABC")'), 'abc');
  assert.equal(value('upper("abc")'), 'ABC');
  assert.equal(value('trim("  x  ")'), 'x');
  assert.equal(value('length("héllo")'), 5);
  assert.equal(value('substr("abcdef", 2, 3)'), 'bcd');
  assert.equal(value('startswith("abcdef", "abc")'), true);
  assert.equal(value('contains("abcdef", "cd")'), true);
  assert.equal(value('concat("a", null, "b")'), 'ab');
});

test('numeric functions', () => {
  assert.equal(value('abs(-3)'), 3);
  assert.equal(value('floor(2.9)'), 2);
  assert.equal(value('ceil(2.1)'), 3);
  assert.equal(value('round(2.345, 2)'), 2.35);
  assert.equal(value('round(-2.345, 2)'), -2.35);
  assert.equal(value('round(2.5)'), 3);
  assert.equal(value('min_of(3, 1, 2)'), 1);
  assert.equal(value('max_of(3, 1, 2)'), 3);
});

test('lookup uses the pinned resolver and returns null for misses', () => {
  const dims = {
    get: (name, key) => {
      if (name !== 'seg') {
        const err = new Error(`dimension "${name}" is not pinned for this job`);
        err.code = 'E_DIMENSION_NOT_PINNED';
        throw err;
      }
      return key === 'C1' ? 'enterprise' : null;
    },
  };
  assert.equal(value('lookup("seg", "C1")', {}, dims), 'enterprise');
  assert.equal(value('lookup("seg", "C2")', {}, dims), null);
  assert.equal(value('lookup("seg", null)', {}, dims), null);
  assert.throws(
    () => value('lookup("other", "C1")', {}, dims),
    (e) => e.code === 'E_DIMENSION_NOT_PINNED',
  );
});

test('lookup requires a literal dimension name', () => {
  const dims = { get: () => 'x' };
  assert.throws(() => value('lookup(dim_name, "C1")', { dim_name: 'seg' }, dims), (e) => e.code === 'E_EVAL');
});

test('isolation: no way to reach host functions or build objects', () => {
  // Names like `constructor`/`eval` parse as an ordinary call to an unknown
  // function and are rejected by the closed function table at run time; what
  // matters is that no JS value or host binding is reachable.
  const hostish = [
    'constructor("return 1")',
    'eval("1")',
    'require("fs")',
    'process.exit(1)',
    'Function("return 1")()',
    'import("fs")',
    'globalThis',
    'this',
  ];
  for (const expr of hostish) {
    assert.throws(() => value(expr), (e) => e instanceof ExprError, `should not evaluate: ${expr}`);
  }
  // Syntax that cannot even be represented in the grammar.
  for (const expr of ['[1,2,3]', '{a: 1}', 'a.b', 'x = 1', '`template`', 'a; b', 'a ? b : c']) {
    assert.throws(() => parse(expr), (e) => e instanceof ExprError, `should not parse: ${expr}`);
  }
});

test('unknown functions are rejected at evaluation time', () => {
  assert.throws(() => value('frobnicate(1)'), (e) => e.code === 'E_EVAL');
});

test('parser reports precise locations', () => {
  try {
    parse('1 + * 2');
    assert.fail('should throw');
  } catch (err) {
    assert.equal(err.code, 'E_UNEXPECTED_TOKEN');
    assert.equal(err.line, 1);
    assert.equal(err.col, 5);
  }
});

test('multiline expressions report the right line', () => {
  const source = 'if(a == 1,\n  "x",\n  )';
  try {
    parse(source);
    assert.fail('should throw');
  } catch (err) {
    assert.equal(err.line, 3);
  }
});

test('limits: length, depth, empty in-list', () => {
  assert.throws(() => parse('1 + '.repeat(2000) + '1'), (e) => e.code === 'E_SOURCE_TOO_LONG');
  assert.throws(() => parse('('.repeat(80) + '1' + ')'.repeat(80)), (e) => e.code === 'E_TOO_DEEP');
  assert.throws(() => parse('1 in ()'), (e) => e.code === 'E_EMPTY_LIST');
  assert.throws(() => parse(Array.from({ length: 300 }, (_, i) => `c${i}`).join(' + ')), (e) => e.code === 'E_TOO_COMPLEX');
});

test('chained comparisons are rejected explicitly', () => {
  assert.throws(() => parse('1 < 2 < 3'), (e) => e.code === 'E_CHAINED_COMPARISON');
});

test('unterminated string and bad escape', () => {
  assert.throws(() => parse('"abc'), (e) => e.code === 'E_STRING_UNTERMINATED');
  assert.throws(() => parse('"a\\qb"'), (e) => e.code === 'E_STRING_ESCAPE');
});

test('comments are stripped without affecting division', () => {
  assert.equal(value('1 + 2 // trailing comment'), 3);
  assert.equal(value('10 / 2'), 5);
});

test('determinism: repeated evaluation is identical', () => {
  const ast = parse('round(a * 1.1 + b / 3, 4)');
  const row = { a: 3.7, b: 11.2 };
  const first = evaluate(ast, { row });
  for (let i = 0; i < 100; i += 1) assert.equal(evaluate(ast, { row }), first);
});
