import { compileJob } from './compiler.js';
import { hashJson } from '../lib/util.js';
import { parseStored } from './rules.js';

/**
 * Compile cache.
 *
 * Question: cache compiled rules, or re-parse every batch?
 *
 * Answer: compile once per *job snapshot*, keyed by a fingerprint of the
 * exact (expression text, AST, dimension version) triple that the job pinned.
 * That gives both properties at once:
 *
 *   * isolation - a cache entry is never shared between two jobs, so a rule
 *     edit or a new dimension version cannot leak into a running job. The
 *     fingerprint is checked on every access; a mismatch forces a rebuild.
 *   * reproducibility - within one job the same compiled object (and therefore
 *     the same AST and pinned dimension maps) is reused for every batch, so
 *     batch 1 and batch 50 cannot diverge because someone re-saved the rule.
 *
 * Because the AST is stored with the job, the common path parses nothing per
 * batch. Re-parsing is the fallback only when a job predates the stored AST or
 * the stored AST fails to load - and it re-parses the pinned expression, not
 * whatever the rule table says now.
 *
 * Entries are bounded by a simple LRU so many jobs in one long-lived worker
 * do not accumulate; a legitimately running job is always re-lookupable.
 */

const MAX_ENTRIES = 32;

const cache = new Map();

export function jobFingerprint(job) {
  return hashJson({
    id: job.id,
    mode: job.mode,
    rules: job.rules.map((r) => [r.output_name, r.expression, r.ast_json]),
    keys: job.group_keys.map((k) => [k.name, k.expression, k.ast]),
    dims: job.dimensions.map((d) => [d.name, d.dimension_version_id]),
  });
}

export function getCompiled(job, dimResolver, { stats = null } = {}) {
  const fingerprint = jobFingerprint(job);
  const hit = cache.get(fingerprint);
  if (hit && hit.jobId === job.id) {
    if (stats) stats.hits += 1;
    // Refresh LRU recency.
    cache.delete(fingerprint);
    cache.set(fingerprint, hit);
    return hit.compiled;
  }
  if (stats) stats.misses += 1;

  const rules = job.rules.map((r) => ({
    output_name: r.output_name,
    expression: r.expression,
    ast: parseStored(r.expression, r.ast_json),
    kind: r.kind,
  }));
  const groupKeys = job.group_keys.map((k) => ({
    name: k.name,
    ast: typeof k.ast === 'string' ? JSON.parse(k.ast) : k.ast,
  }));
  const compiled = compileJob({ mode: job.mode, rules, groupKeys, dimResolver });
  cache.set(fingerprint, { jobId: job.id, compiled, fingerprint });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  return compiled;
}

export function invalidateJob(jobId) {
  for (const [key, value] of cache) {
    if (value.jobId === jobId) cache.delete(key);
  }
}

export function cacheStats() {
  return {
    entries: cache.size,
    jobs: [...new Set([...cache.values()].map((v) => v.jobId))],
  };
}
