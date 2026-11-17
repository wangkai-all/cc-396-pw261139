import crypto from 'node:crypto';

/** Canonical JSON: recursively sorted object keys, stable for hashing. */
export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key]);
    return out;
  }
  return value;
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function hashJson(value) {
  return sha256(canonicalJson(value));
}

export function shortHash(value, length = 12) {
  return sha256(value).slice(0, length);
}

const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

export function newId(prefix = '') {
  const bytes = crypto.randomBytes(14);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return `${prefix}${out}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Parse RFC4180-style CSV with quoted fields and embedded newlines.
 *
 * With `header: true` (the default) the first record is column names; with
 * `header: false` every record is data and the caller supplies the meaning of
 * each position (used for the two-column dimension key,value format).
 */
export function parseCsv(text, { header = true } = {}) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      pushField();
      i += 1;
      continue;
    }
    if (ch === '\r' && text[i + 1] === '\n') {
      pushRow();
      i += 2;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (quoted) {
    const err = new Error('unterminated quoted field in CSV');
    err.code = 'E_CSV';
    throw err;
  }
  // A final newline terminates the last record; it does not start a new one.
  // Only push a pending field/row if the parser is mid-record.
  if (field.length > 0 || row.length > 0) pushRow();
  if (rows.length === 0) return { columns: [], rows: [] };
  if (!header) return { columns: [], rows };
  const headerCells = rows[0].map((h, idx) => {
    const name = String(h).trim();
    if (!name) {
      const err = new Error(`CSV header column ${idx + 1} is empty`);
      err.code = 'E_CSV';
      throw err;
    }
    return name;
  });
  if (new Set(headerCells).size !== headerCells.length) {
    const err = new Error('CSV header contains duplicate column names');
    err.code = 'E_CSV';
    throw err;
  }
  const dataRows = [];
  for (let r = 1; r < rows.length; r += 1) {
    const cells = rows[r];
    if (cells.length === 1 && cells[0] === '') continue;
    if (cells.length !== headerCells.length) {
      const err = new Error(`CSV row ${r + 1} has ${cells.length} cells, expected ${headerCells.length}`);
      err.code = 'E_CSV';
      err.row = r + 1;
      throw err;
    }
    dataRows.push(cells);
  }
  return { columns: headerCells, rows: dataRows };
}

/** JSONL: one object per line. */
export function parseJsonl(text) {
  const rows = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      const e = new Error(`invalid JSON on line ${i + 1}: ${err.message}`);
      e.code = 'E_JSONL';
      e.row = i + 1;
      throw e;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      const e = new Error(`line ${i + 1} is not a JSON object`);
      e.code = 'E_JSONL';
      e.row = i + 1;
      throw e;
    }
    rows.push(obj);
  }
  return rows;
}

/**
 * Normalise an incoming record to flat scalar columns.
 * Arrays/objects are rejected rather than stringified: the rule language has
 * no way to use them and silently coercing would hide data problems.
 */
export function normalizeRecord(record, rowNumber) {
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    if (!isSafeColumnName(key)) {
      const e = new Error(`row ${rowNumber}: column name ${JSON.stringify(key)} is not allowed (letters, digits, underscore; must not start with a digit)`);
      e.code = 'E_SCHEMA';
      throw e;
    }
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
      out[key] = value;
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        const e = new Error(`row ${rowNumber}: column "${key}" is not a finite number`);
        e.code = 'E_SCHEMA';
        throw e;
      }
      out[key] = value;
    } else {
      const e = new Error(`row ${rowNumber}: column "${key}" must be a string, number, boolean or null`);
      e.code = 'E_SCHEMA';
      throw e;
    }
    if (typeof out[key] === 'string' && out[key].length > 100_000) {
      const e = new Error(`row ${rowNumber}: column "${key}" exceeds 100000 characters`);
      e.code = 'E_SCHEMA';
      throw e;
    }
  }
  return out;
}

export function isSafeColumnName(name) {
  return typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

export function isSafeName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(name);
}

/** Coerce CSV cell text into the dataset's inferred scalar types. */
export function coerceCsvValue(text) {
  if (text === '') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    const n = Number(text);
    if (Number.isFinite(n)) return n;
  }
  return text;
}

export function inferColumns(rows) {
  const order = [];
  const seen = new Map();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.set(key, { name: key, types: new Set() });
        order.push(key);
      }
      const value = row[key];
      if (value !== null) seen.get(key).types.add(typeof value);
    }
  }
  return order.map((name) => {
    const types = [...seen.get(name).types].sort();
    let type = 'null';
    if (types.length === 1) type = types[0];
    else if (types.length > 1) type = 'mixed';
    return { name, type };
  });
}

export function encodeAggregateValue(value) {
  if (value === null) return 'z';
  if (typeof value === 'number') return `n:${value}`;
  if (typeof value === 'string') return `s:${value}`;
  if (typeof value === 'boolean') return `b:${value ? 1 : 0}`;
  return `x:${String(value)}`;
}

export function decodeGroupKey(keyJson) {
  return JSON.parse(keyJson);
}
