import { all, get, run, transaction } from '../db.js';
import { hashJson, newId, nowIso, isSafeName, isSafeColumnName } from '../lib/util.js';

/**
 * Dimension (lookup) tables are versioned for the same reason datasets are:
 * a job pins (name -> version) at creation, so changing a mapping while the
 * job runs cannot change its result. Lookup keys are canonicalised by type
 * ("1" and 1 are distinct keys) to keep surprising coercions out of joins.
 */

export function keyTypeOf(key) {
  if (typeof key === 'string') return 's';
  if (typeof key === 'number' && Number.isFinite(key)) return 'n';
  if (typeof key === 'boolean') return 'b';
  return null;
}

export function normalizeDimKey(key) {
  const type = keyTypeOf(key);
  if (!type) return null;
  if (type === 'n') return String(key);
  if (type === 'b') return key ? 'true' : 'false';
  return key;
}

export function listDimensions(db) {
  return all(
    db,
    `SELECT name, MAX(version_no) AS latest_version, COUNT(*) AS versions
     FROM dimension_versions GROUP BY name ORDER BY name`,
  );
}

export function latestDimensionVersion(db, name) {
  return get(
    db,
    'SELECT * FROM dimension_versions WHERE name = ? ORDER BY version_no DESC LIMIT 1',
    name,
  );
}

export function getDimensionVersion(db, id) {
  return get(db, 'SELECT * FROM dimension_versions WHERE id = ?', id);
}

export function listDimensionVersions(db, name) {
  return all(
    db,
    'SELECT * FROM dimension_versions WHERE name = ? ORDER BY version_no DESC',
    name,
  );
}

/**
 * `entries` is a list of { key, value }. `value` must be a scalar (string,
 * number, boolean, null) because lookup() returns a scalar.
 */
export function ingestDimension(db, { name, source, entries }) {
  if (!isSafeName(name)) {
    const err = new Error(`dimension name ${JSON.stringify(name)} is not allowed (letters, digits, underscore, dot, dash)`);
    err.code = 'E_SCHEMA';
    throw err;
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    const err = new Error('dimension has no entries');
    err.code = 'E_EMPTY_DIMENSION';
    throw err;
  }
  const seen = new Set();
  const normalized = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const type = keyTypeOf(entry?.key);
    if (!type) {
      const err = new Error(`dimension entry ${i + 1}: key must be a string, number or boolean`);
      err.code = 'E_SCHEMA';
      throw err;
    }
    const value = entry.value;
    if (!(value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))) {
      const err = new Error(`dimension entry ${i + 1}: value must be a scalar`);
      err.code = 'E_SCHEMA';
      throw err;
    }
    const key = normalizeDimKey(entry.key);
    const dedupe = `${type}\u0000${key}`;
    if (seen.has(dedupe)) {
      const err = new Error(`dimension entry ${i + 1}: duplicate key ${JSON.stringify(entry.key)}`);
      err.code = 'E_DUPLICATE_KEY';
      throw err;
    }
    seen.add(dedupe);
    normalized.push({ key, type, value });
  }
  const contentHash = hashJson(
    normalized
      .slice()
      .sort((a, b) => (a.type + a.key < b.type + b.key ? -1 : 1))
      .map((e) => [e.type, e.key, e.value]),
  );

  return transaction(db, () => {
    const existing = get(
      db,
      'SELECT * FROM dimension_versions WHERE name = ? AND content_hash = ?',
      name,
      contentHash,
    );
    if (existing) return { version: existing, reused: true };

    const previous = latestDimensionVersion(db, name);
    const versionNo = (previous?.version_no ?? 0) + 1;
    const id = newId('dim_');
    run(
      db,
      `INSERT INTO dimension_versions
         (id, name, version_no, columns_json, row_count, content_hash, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      name,
      versionNo,
      JSON.stringify(['key', 'value']),
      normalized.length,
      contentHash,
      source,
      nowIso(),
    );
    const insert = db.prepare(
      'INSERT INTO dimension_rows (dimension_version_id, key, key_type, value_json) VALUES (?, ?, ?, ?)',
    );
    for (const e of normalized) insert.run(id, e.key, e.type, JSON.stringify(e.value));
    return { version: get(db, 'SELECT * FROM dimension_versions WHERE id = ?', id), reused: false };
  });
}

/**
 * Load a version into an in-memory map and freeze it. The job worker receives
 * the frozen resolver, which is the mechanism that guarantees a running job
 * keeps using the version it started with even if a newer one is published.
 */
export function loadDimensionResolver(db, versionId, name) {
  const version = getDimensionVersion(db, versionId);
  if (!version) {
    const err = new Error(`dimension version ${versionId} not found`);
    err.code = 'E_DIMENSION_MISSING';
    throw err;
  }
  const map = new Map();
  const rows = all(
    db,
    'SELECT key, key_type, value_json FROM dimension_rows WHERE dimension_version_id = ?',
    versionId,
  );
  for (const row of rows) {
    map.set(`${row.key_type}\u0000${row.key}`, JSON.parse(row.value_json));
  }
  const frozen = Object.freeze({ name, versionId, versionNo: version.version_no, size: map.size });

  function get(name_arg, key) {
    if (name_arg !== name) {
      const err = new Error(`dimension "${name_arg}" is not pinned for this job`);
      err.code = 'E_DIMENSION_NOT_PINNED';
      throw err;
    }
    const type = keyTypeOf(key);
    if (!type) {
      const err = new Error(`lookup key has unsupported type ${typeof key}`);
      err.code = 'E_TYPE';
      throw err;
    }
    const found = map.get(`${type}\u0000${normalizeDimKey(key)}`);
    return found === undefined ? null : found;
  }

  return { meta: frozen, get, size: map.size };
}

/** Build the composite resolver for a job's pinned dimension set. */
export function loadPinnedResolvers(db, pins) {
  const resolvers = new Map();
  for (const pin of pins) {
    resolvers.set(pin.name, loadDimensionResolver(db, pin.dimension_version_id, pin.name));
  }
  return {
    get(name, key) {
      const resolver = resolvers.get(name);
      if (!resolver) {
        const err = new Error(`dimension "${name}" is not pinned for this job`);
        err.code = 'E_DIMENSION_NOT_PINNED';
        throw err;
      }
      return resolver.get(name, key);
    },
    pins: pins.map((p) => ({
      name: p.name,
      versionId: p.dimension_version_id,
      versionNo: p.version_no ?? null,
    })),
    resolvers,
  };
}

export { isSafeColumnName };
