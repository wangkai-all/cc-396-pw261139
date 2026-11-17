import { all, get, run, transaction } from '../db.js';
import { hashJson, newId, nowIso, inferColumns, normalizeRecord } from '../lib/util.js';

/**
 * Immutable dataset versioning.
 *
 * Every load creates a new version row; existing versions are never mutated.
 * The version id is SHA-256 over the canonical row content, so re-loading
 * identical bytes is a no-op instead of a duplicate version, and a job's
 * "inputs version" is verifiable by re-hashing the stored rows.
 */

export function latestDatasetVersion(db, datasetId) {
  return get(
    db,
    `SELECT * FROM dataset_versions WHERE dataset_id = ? ORDER BY version_no DESC LIMIT 1`,
    datasetId,
  );
}

export function getDataset(db, id) {
  return get(db, 'SELECT * FROM datasets WHERE id = ?', id);
}

export function listDatasets(db) {
  return all(
    db,
    `SELECT d.*, (SELECT MAX(version_no) FROM dataset_versions v WHERE v.dataset_id = d.id) AS latest_version
     FROM datasets d ORDER BY d.name`,
  );
}

export function getDatasetVersion(db, id) {
  return get(db, 'SELECT * FROM dataset_versions WHERE id = ?', id);
}

export function listDatasetVersions(db, datasetId) {
  return all(
    db,
    'SELECT * FROM dataset_versions WHERE dataset_id = ? ORDER BY version_no DESC',
    datasetId,
  );
}

export function loadDatasetRows(db, versionId) {
  return all(
    db,
    'SELECT row_no, data_json FROM dataset_rows WHERE dataset_version_id = ? ORDER BY row_no',
    versionId,
  ).map((r) => ({ rowNo: r.row_no, data: JSON.parse(r.data_json) }));
}

/**
 * Insert (or reuse) a dataset version.
 * `records` must already be normalised flat objects.
 */
export function ingestDataset(db, { name, description = '', source, records, idPrefix = 'ds' }) {
  const normalized = records.map((r, i) => normalizeRecord(r, i + 1));
  if (normalized.length === 0) {
    const err = new Error('dataset has no rows');
    err.code = 'E_EMPTY_DATASET';
    throw err;
  }
  const columns = inferColumns(normalized);
  const contentHash = hashJson({ columns, rows: normalized });

  return transaction(db, () => {
    let dataset = get(db, 'SELECT * FROM datasets WHERE name = ?', name);
    if (!dataset) {
      dataset = {
        id: newId(`${idPrefix}_`),
        name,
        description,
        created_at: nowIso(),
      };
      run(
        db,
        'INSERT INTO datasets (id, name, description, created_at) VALUES (?, ?, ?, ?)',
        dataset.id,
        dataset.name,
        dataset.description,
        dataset.created_at,
      );
    }

    const existing = get(
      db,
      'SELECT * FROM dataset_versions WHERE dataset_id = ? AND content_hash = ?',
      dataset.id,
      contentHash,
    );
    if (existing) {
      return { dataset, version: existing, reused: true, columns };
    }

    const previous = latestDatasetVersion(db, dataset.id);
    const versionNo = (previous?.version_no ?? 0) + 1;
    const versionId = newId(`${idPrefix}v_`);
    const createdAt = nowIso();
    run(
      db,
      `INSERT INTO dataset_versions
         (id, dataset_id, version_no, columns_json, row_count, content_hash, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      versionId,
      dataset.id,
      versionNo,
      JSON.stringify(columns),
      normalized.length,
      contentHash,
      source,
      createdAt,
    );
    const insertRow = db.prepare(
      'INSERT INTO dataset_rows (dataset_version_id, row_no, data_json) VALUES (?, ?, ?)',
    );
    for (let i = 0; i < normalized.length; i += 1) {
      insertRow.run(versionId, i + 1, JSON.stringify(normalized[i]));
    }
    return {
      dataset,
      version: get(db, 'SELECT * FROM dataset_versions WHERE id = ?', versionId),
      reused: false,
      columns,
    };
  });
}

/** Recompute the content hash from stored rows; proves the input version. */
export function verifyDatasetVersion(db, versionId) {
  const version = getDatasetVersion(db, versionId);
  if (!version) return { ok: false, error: 'dataset version not found' };
  const rows = loadDatasetRows(db, versionId).map((r) => r.data);
  const columns = JSON.parse(version.columns_json);
  const actual = hashJson({ columns, rows });
  return {
    ok: actual === version.content_hash && rows.length === version.row_count,
    expected: version.content_hash,
    actual,
    rowCount: rows.length,
  };
}
