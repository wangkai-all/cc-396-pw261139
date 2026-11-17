/**
 * Structured errors for the expression language.
 *
 * Every error carries a stable machine-readable `code` plus a 1-based
 * line/column so the web preview and the task log can point at the exact
 * token. Evaluation errors additionally carry the runtime context that the
 * worker needs to attribute the failure to a rule + input row.
 */

export class ExprError extends Error {
  constructor(code, message, where = {}) {
    const loc = where.line ? ` (line ${where.line}, col ${where.col})` : '';
    super(`${message}${loc}`);
    this.name = 'ExprError';
    this.code = code;
    this.line = where.line ?? null;
    this.col = where.col ?? null;
    this.offset = where.offset ?? null;
    this.detail = where.detail ?? null;
  }
}

export function fail(code, message, where) {
  throw new ExprError(code, message, where);
}

/** Wrap a folder of tokens into a source excerpt for error UI. */
export function excerpt(source, line, col, radius = 30) {
  if (!line || !source) return '';
  const lines = source.split('\n');
  const text = lines[line - 1];
  if (typeof text !== 'string') return '';
  const start = Math.max(0, (col ?? 1) - 1 - radius);
  const end = Math.min(text.length, (col ?? 1) + radius);
  const pad = ' '.repeat(Math.max(0, (col ?? 1) - 1 - start));
  return `${text.slice(start, end)}\n${pad}^`;
}
