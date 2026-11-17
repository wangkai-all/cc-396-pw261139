import { tokenize, LIMITS } from './lexer.js';
import { fail } from './errors.js';

/**
 * Recursive-descent parser producing a small, closed AST.
 *
 * Grammar (informal):
 *   expr        := or
 *   or          := and (("or" | "||") and)*
 *   and         := not (("and" | "&&") not)*
 *   not         := ("not" | "!") not | comparison
 *   comparison  := additive (cmp additive)?
 *                | additive ["not"] "in" "(" args ")"
 *                | additive "is" ["not"] "null"
 *                | additive ["not"] "between" additive "and" additive
 *   additive    := multiplicative (("+"|"-") multiplicative)*
 *   multiplicative := unary (("*"|"/"|"%") unary)*
 *   unary       := ("-"|"+") unary | primary
 *   primary     := number | string | "true" | "false" | "null"
 *                | ident "(" args ")" | ident | "(" expr ")"
 *
 * Chained comparisons (`a < b < c`) are rejected: they read like SQL but
 * would silently evaluate as booleans on the left.
 *
 * Nesting depth is bounded on the parser call stack rather than on grammar
 * precedence levels, so a deeply parenthesised expression is rejected before
 * it can exhaust the JS stack, while ordinary precedence chains are free.
 */

const COMPARISON_OPS = new Set(['==', '!=', '<>', '<', '<=', '>', '>=']);

export function parse(source) {
  const tokens = tokenize(source);
  let pos = 0;
  let depth = 0;

  const peek = (offset = 0) => tokens[Math.min(pos + offset, tokens.length - 1)];
  const atOp = (v) => {
    const t = peek();
    return t.type === 'op' && t.value === v;
  };
  const atKw = (v) => {
    const t = peek();
    return t.type === 'keyword' && t.value === v;
  };
  const advance = () => tokens[pos++];
  const where = (tok = peek()) => ({ line: tok.line, col: tok.col, offset: tok.offset });

  function enter() {
    depth += 1;
    if (depth > LIMITS.maxDepth) {
      fail('E_TOO_DEEP', `expression nesting exceeds ${LIMITS.maxDepth}`, where());
    }
  }
  function leave() {
    depth -= 1;
  }

  function describe(t) {
    if (t.type === 'eof') return 'end of expression';
    if (t.type === 'string') return 'string literal';
    return t.raw ? `${t.type} ${t.raw}` : `${t.type} ${JSON.stringify(t.value)}`;
  }

  function expectOp(value) {
    if (!atOp(value)) {
      fail('E_UNEXPECTED_TOKEN', `expected ${JSON.stringify(value)} but found ${describe(peek())}`, where());
    }
    return advance();
  }

  function parseExpr() {
    return parseOr();
  }

  function parseOr() {
    let left = parseAnd();
    while (atKw('or') || atOp('||')) {
      const op = advance();
      const right = parseAnd();
      left = { type: 'Binary', op: 'or', left, right, line: op.line, col: op.col };
    }
    return left;
  }

  function parseAnd() {
    let left = parseNot();
    while (atKw('and') || atOp('&&')) {
      const op = advance();
      const right = parseNot();
      left = { type: 'Binary', op: 'and', left, right, line: op.line, col: op.col };
    }
    return left;
  }

  function parseNot() {
    enter();
    try {
      if (atKw('not') || atOp('!')) {
        const op = advance();
        const operand = parseNot();
        return { type: 'Unary', op: 'not', operand, line: op.line, col: op.col };
      }
      return parseComparison();
    } finally {
      leave();
    }
  }

  function parseComparison() {
    const left = parseAdditive();
    const t = peek();

    if (t.type === 'op' && COMPARISON_OPS.has(t.value)) {
      advance();
      const right = parseAdditive();
      const next = peek();
      if (next.type === 'op' && COMPARISON_OPS.has(next.value)) {
        fail('E_CHAINED_COMPARISON', 'chained comparisons are ambiguous; combine with "and" instead', where(next));
      }
      return {
        type: 'Binary',
        op: t.value === '<>' ? '!=' : t.value,
        left,
        right,
        line: t.line,
        col: t.col,
      };
    }

    if (atKw('is')) {
      advance();
      const negated = atKw('not') ? (advance(), true) : false;
      if (!atKw('null')) {
        fail('E_UNEXPECTED_TOKEN', `expected "null" after "is" but found ${describe(peek())}`, where());
      }
      advance();
      return { type: 'IsNull', operand: left, negated, line: t.line, col: t.col };
    }

    if (atKw('not') && peek(1).type === 'keyword' && peek(1).value === 'in') {
      advance();
      advance();
      return parseInList(left, true, t);
    }
    if (atKw('in')) {
      advance();
      return parseInList(left, false, t);
    }

    if (atKw('between') || (atKw('not') && peek(1).type === 'keyword' && peek(1).value === 'between')) {
      let negated = false;
      if (atKw('not')) {
        advance();
        negated = true;
      }
      advance(); // between
      const low = parseAdditive();
      if (!atKw('and')) {
        fail('E_UNEXPECTED_TOKEN', `expected "and" inside between but found ${describe(peek())}`, where());
      }
      advance();
      const high = parseAdditive();
      return { type: 'Between', operand: left, low, high, negated, line: t.line, col: t.col };
    }

    return left;
  }

  function parseInList(left, negated, tok) {
    expectOp('(');
    const list = [];
    if (!atOp(')')) {
      do {
        list.push(parseExpr());
      } while (atOp(',') && advance());
    }
    expectOp(')');
    if (list.length === 0) {
      fail('E_EMPTY_LIST', 'in list must contain at least one value', where(tok));
    }
    return { type: 'InList', operand: left, list, negated, line: tok.line, col: tok.col };
  }

  function parseAdditive() {
    let left = parseMultiplicative();
    while (atOp('+') || atOp('-')) {
      const op = advance();
      const right = parseMultiplicative();
      left = { type: 'Binary', op: op.value, left, right, line: op.line, col: op.col };
    }
    return left;
  }

  function parseMultiplicative() {
    let left = parseUnary();
    while (atOp('*') || atOp('/') || atOp('%')) {
      const op = advance();
      const right = parseUnary();
      left = { type: 'Binary', op: op.value, left, right, line: op.line, col: op.col };
    }
    return left;
  }

  function parseUnary() {
    enter();
    try {
      if (atOp('-') || atOp('+')) {
        const op = advance();
        const operand = parseUnary();
        if (op.value === '-' && operand.type === 'Literal' && typeof operand.value === 'number') {
          return { ...operand, value: -operand.value, line: op.line, col: op.col };
        }
        return { type: 'Unary', op: op.value, operand, line: op.line, col: op.col };
      }
      return parsePrimary();
    } finally {
      leave();
    }
  }

  function parseArgs() {
    expectOp('(');
    const args = [];
    if (!atOp(')')) {
      do {
        args.push(parseExpr());
      } while (atOp(',') && advance());
    }
    expectOp(')');
    return args;
  }

  function parsePrimary() {
    const t = peek();

    if (t.type === 'number' || t.type === 'string') {
      advance();
      return { type: 'Literal', value: t.value, line: t.line, col: t.col };
    }
    if (t.type === 'keyword' && (t.value === 'true' || t.value === 'false')) {
      advance();
      return { type: 'Literal', value: t.value === 'true', line: t.line, col: t.col };
    }
    if (atKw('null')) {
      advance();
      return { type: 'Literal', value: null, line: t.line, col: t.col };
    }
    if (t.type === 'ident') {
      advance();
      if (t.value.includes('.')) {
        fail(
          'E_QUALIFIED_NAME',
          `"${t.value}" is not a column reference; use lookup("dimension_name", key)`,
          where(t),
        );
      }
      if (atOp('(')) {
        enter();
        try {
          const args = parseArgs();
          return { type: 'Call', name: t.value, args, line: t.line, col: t.col };
        } finally {
          leave();
        }
      }
      return { type: 'Column', name: t.value, line: t.line, col: t.col };
    }
    if (atOp('(')) {
      advance();
      enter();
      try {
        const inner = parseExpr();
        expectOp(')');
        return inner;
      } finally {
        leave();
      }
    }

    fail('E_UNEXPECTED_TOKEN', `unexpected ${describe(t)}`, where(t));
  }

  const ast = parseExpr();
  if (peek().type !== 'eof') {
    fail('E_TRAILING_TOKEN', `unexpected ${describe(peek())} after end of expression`, where());
  }
  return ast;
}
