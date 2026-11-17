import { fail } from './errors.js';

/**
 * Tokenizer for the restricted rule language.
 *
 * Deliberately small: numbers, quoted strings, identifiers, comparison and
 * arithmetic operators, boolean keywords. There is no way to express
 * assignment, function definition, statement separation, or a callable
 * object, so nothing parsed here can ever be executed as code.
 */

const KEYWORDS = new Set(['and', 'or', 'not', 'true', 'false', 'null', 'in', 'is', 'between']);

const TWO_CHAR = new Set(['==', '!=', '<>', '<=', '>=', '&&', '||']);
const ONE_CHAR = new Set(['+', '-', '*', '/', '%', '(', ')', ',', '<', '>', '!']);

/** Hard limits; a rule is a single scalar expression, not a script. */
export const LIMITS = Object.freeze({
  maxSourceLength: 4000,
  maxTokens: 512,
  maxDepth: 40,
});

export function tokenize(source) {
  if (typeof source !== 'string') fail('E_SOURCE_TYPE', 'expression must be a string');
  if (source.length > LIMITS.maxSourceLength) {
    fail('E_SOURCE_TOO_LONG', `expression exceeds ${LIMITS.maxSourceLength} characters`);
  }

  const tokens = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;

  const where = (at = i) => ({ line, col: at - lineStart + 1, offset: at });
  const push = (type, value, start, extra) => {
    if (tokens.length >= LIMITS.maxTokens) {
      fail('E_TOO_COMPLEX', `expression exceeds ${LIMITS.maxTokens} tokens`, where(start));
    }
    tokens.push({ type, value, line, col: start - lineStart + 1, offset: start, ...extra });
  };

  while (i < source.length) {
    const ch = source[i];

    if (ch === '\n') {
      i += 1;
      line += 1;
      lineStart = i;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i += 1;
      continue;
    }

    // `//` to end of line. Nothing else from `/` is a comment delimiter, and
    // the parser only ever emits a division when a value precedes it.
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }

    const start = i;

    // Numbers: digits with one optional fractional part, no signs, no
    // exponents, no hex. Leading zeros are rejected to keep them from being
    // silently read as octal-looking identifiers for users.
    if (ch >= '0' && ch <= '9') {
      while (i < source.length && source[i] >= '0' && source[i] <= '9') i += 1;
      if (source[i] === '.') {
        i += 1;
        const fracStart = i;
        while (i < source.length && source[i] >= '0' && source[i] <= '9') i += 1;
        if (i === fracStart) fail('E_NUMBER', 'expected digits after decimal point', where(i));
      }
      if (source[i] === '.' || (source[i] >= 'a' && source[i] <= 'z')) {
        fail('E_NUMBER', 'malformed number literal', where(i));
      }
      const raw = source.slice(start, i);
      const value = Number(raw);
      if (!Number.isFinite(value)) fail('E_NUMBER', 'number literal is not finite', where(start));
      push('number', value, start, { raw });
      continue;
    }

    // Strings: single or double quoted. Escapes are limited to a fixed table
    // so there is no interpolation, no backtick evaluation, no \u{} syntax.
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      let out = '';
      let closed = false;
      while (i < source.length) {
        const c = source[i];
        if (c === quote) {
          i += 1;
          closed = true;
          break;
        }
        if (c === '\n') break;
        if (c === '\\') {
          const esc = source[i + 1];
          const table = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', 0: '\0' };
          if (!(esc in table)) fail('E_STRING_ESCAPE', `unsupported escape \\${esc ?? ''}`, where(i));
          out += table[esc];
          i += 2;
          continue;
        }
        out += c;
        i += 1;
      }
      if (!closed) fail('E_STRING_UNTERMINATED', 'unterminated string literal', where(start));
      push('string', out, start);
      continue;
    }

    // Identifiers: ASCII letters/underscore start, then letters, digits,
    // underscore, or dot. Dots are rejected by the parser so the error is a
    // helpful "lookup() is the only way to read another relation" message
    // rather than a confusing unexpected-token.
    if (/[A-Za-z_]/.test(ch)) {
      while (i < source.length && /[A-Za-z0-9_.]/.test(source[i])) i += 1;
      const word = source.slice(start, i);
      const lower = word.toLowerCase();
      if (KEYWORDS.has(lower)) push('keyword', lower, start);
      else push('ident', word, start);
      continue;
    }

    const two = source.slice(i, i + 2);
    if (TWO_CHAR.has(two)) {
      i += 2;
      push('op', two, start);
      continue;
    }
    if (ONE_CHAR.has(ch)) {
      i += 1;
      push('op', ch, start);
      continue;
    }

    fail('E_UNEXPECTED_CHAR', `unexpected character ${JSON.stringify(ch)}`, where(start));
  }

  push('eof', '', i);
  return tokens;
}
