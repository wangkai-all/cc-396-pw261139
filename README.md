# pointwise-rules

A small, dependency-free data rule engine. Users attach **restricted expressions**
to data columns; the engine evaluates them for real (not as annotations), with
version-pinned inputs, resumable jobs, and results that can be traced back to
the exact input and rule versions that produced them.

```
browser ──HTTP──> src/server.js ──> SQLite (control plane)
                                        │
                                        ├── data/results/<job>/result.jsonl
                                        │                 /manifest.json
                                        │                 /tasks/*.json
                                        └── job_tasks ledger
                         ▲
        src/worker.js ───┘   (any number, separate processes)
```

The server, the workers and the result directory are independent: the server
never evaluates an expression, workers never serve HTTP, and results are plain
files on disk that can be archived without the database.

## Quick start

Requires Node.js ≥ 22.13 (for `node:sqlite`). There are no npm dependencies.

```bash
npm run seed      # deterministic demo data: 240 orders, 5 dimensions, 5 rules
npm start         # http://127.0.0.1:3000  (spawns a worker per job by default)
```

To run the processing tier separately:

```bash
AUTO_SPAWN_WORKER=0 npm start
npm run worker            # one-shot: drain all pending work, then exit
npm run worker -- --watch # keep polling
```

See the whole guarantee set demonstrated without a browser:

```bash
npm run demo
```

Tests (41 cases, unit + integration + real HTTP):

```bash
npm test
```

## The expression language

One expression per output column. Grammar is deliberately tiny — scalar
literals, column references, operators, and a closed function table. There is
no assignment, no statement separator, no member access, no lambda, no
import, and no way to name a host object or function. Unknown identifiers are
rejected; the function table is consulted with an own-property guard, so
`constructor(...)` cannot reach `Object.prototype`.

```text
net_amount   = if(status == "refunded", 0, round(gross_amount * (1 - discount_pct), 2))
segment      = if(lookup("customer_segment", customer_id) == "enterprise", "key-account", "volume")
month        = substr(order_date, 1, 7)              // group key
revenue      = sum(net_amount)                        // group output
```

**Types.** `null`, boolean, number (finite double), string. Comparisons and
arithmetic are strict: `"2" + 1` is a type error, not `3`. Logical operators
use SQL three-valued logic — `null and false` is `false`, `null and true` is
`null`. `if` and `coalesce` short-circuit, so `if(x != 0, 1/x, null)` is safe.

**Functions.**

| kind | names |
| --- | --- |
| conditional | `if(cond, a, b)`, `coalesce(...)` |
| dimension | `lookup("dimension_name", key)` — returns `null` on a miss |
| text | `lower`, `upper`, `trim`, `length`, `concat`, `substr(s, start[, len])`, `startswith`, `endswith`, `contains` |
| numeric | `abs`, `round(x[, digits])`, `floor`, `ceil`, `min_of`, `max_of` |
| aggregate (group mode only) | `sum`, `count`, `min`, `max`, `avg`, `count_distinct` |

Division or modulo by zero throws `E_EVAL` rather than returning `Infinity`/`NaN`.
There is intentionally no `now()`, `today()`, or `random()`, so the same row
and the same pinned dimensions always produce the same value.

**Limits.** Source ≤ 4000 chars, ≤ 512 tokens, nesting depth ≤ 40; parse
errors carry line/column and a caret excerpt that the UI highlights.

**Group mode is two-phase.** Row-level outputs are computed first; aggregates
accumulate over the *augmented* row. That means `revenue = sum(net_amount)`
can reference another configured output by name — but that output must be part
of the same job, since aggregates only see columns the job produces. Group keys
may be expressions too (`month = substr(order_date, 1, 7)`).

## Version pinning and reproducibility

Everything that can change a result is versioned and pinned at job creation:

* **Dataset versions** are content-addressed (SHA-256 over canonical JSON).
  Uploading identical data reuses the version instead of creating a new one;
  `GET /api/dataset-versions/:id/verify` re-hashes stored rows to detect
  tampering.
* **Dimension versions** are content-addressed in the same way. A job stores
  the dimension version ids it was created with (`job_dimensions`), and
  workers build their lookup maps from those versions only.
* **Rule versions** are immutable. A job copies the expression text and the
  compiled AST into `job_rules` at creation time.

Consequences:

* Editing a rule, re-uploading a dimension, or uploading a new dataset version
  **cannot change a job that is already running**. The second half of a job
  uses exactly the same pinned text, AST and dimension tables as the first
  half.
* Mid-run edits affect only jobs created afterwards.

### Cache or re-parse?

**Compile once per job snapshot, cache by snapshot fingerprint, never share
across jobs.** See `src/engine/compile-cache.js` for the full rationale.

* *Isolation*: a cache entry is keyed by the job id plus a hash of the exact
  (expression, AST, group keys, dimension version ids) triple. Two jobs can
  never share an entry, so a bad or edited rule in one job cannot leak into
  another.
* *Reproducibility*: within a job the same compiled object is reused for every
  task, so task 1 and task 50 cannot diverge. Re-parsing is only a fallback
  for a job whose stored AST is unreadable — and it re-parses the **pinned**
  text, not the live rule table.
* The AST is stored, so the normal path parses nothing per batch.

### Order-independent aggregation

Group sums must not depend on how rows are split across tasks or workers.
`src/lib/exact.js` accumulates each sum as an exact integer in units of
2^-1074 (every finite double is an integer multiple), then rounds once at the
end. Addition of BigInts is exact and commutative, so any partition of the
input yields bit-identical output. Verified against CPython's `math.fsum` on
4000 random cases with zero mismatches. The integration suite asserts an
identical `outputContentHash` for batch sizes 1, 7, 37 and 240.

## Failure containment

* An expression that fails to compile is rejected at save/preview time with a
  location; it never enters the job table.
* A row that fails at evaluation fails its **task** with `rowNo`, error code
  and message; other tasks continue, other jobs are unaffected.
* A task is retried up to 3 attempts, then the job is marked failed with the
  first row-level error and the attempt history in the event log.
* `lookup()` against a dimension the job did not pin fails with
  `E_DIMENSION_NOT_PINNED` rather than silently reading the current version.

## Crash recovery and resumability

Tasks are the unit of work and the unit of commit:

1. A worker claims tasks under a lease (`claimTasks`, `BEGIN IMMEDIATE`), so
   two workers can never process the same task concurrently.
2. It writes the task output file atomically (`write + fsync + rename`), then
   commits the ledger row referencing it.
3. `tryFinalizeJob` streams all committed outputs into `result.jsonl`, hashes
   the actual bytes, writes `manifest.json`, and flips the job to `done` in a
   single transaction. Finalization is idempotent.

If a worker process dies, its lease expires. `recoverStaleJobs` (called by
workers on startup and exposed as `POST /api/jobs/recover`) returns orphaned
tasks to the queue. A fresh worker redoes exactly the unfinished tasks; tasks
that were already committed are not recomputed. Killing and restarting the
worker mid-job is covered by an automated test.

## Traceability

`manifest.json` in each job's result directory records:

* dataset id, name, version number, **content hash** and row count;
* every pinned dimension: name, version id/number, content hash, row count;
* every output: rule name, rule version id/number, exact expression text;
* the SHA-256 of the expression text;
* `outputContentHash` — SHA-256 over the exact bytes of `result.jsonl`.

The result rows themselves contain the original input fields plus the computed
outputs, so any value can be re-derived from `(input version, rule version,
dimension versions)` recorded in the manifest.

## Web UI (`public/`)

* **Rule Studio** — editor with line-number gutter, live validation, save a new
  rule version, and **preview** against real rows of a chosen dataset version.
  Dimension chips show which version will be pinned; switching a chip changes
  the version used for preview and jobs (the "swap dimension table" flow).
* **Jobs** — create row or group jobs (group keys and outputs), watch task
  progress, inspect the per-task log, download `result.jsonl`, view the
  manifest, cancel, wake the worker, and **fork**: edit a rule and run the new
  version over the same pinned input side by side with the old job. Forked
  jobs record `resumedFrom`.
* **Data & Dimensions** — upload datasets (CSV/JSONL) and dimension tables
  (positional `key,value` CSV or JSONL), browse versions.
* **Recover** — requeues tasks whose leases expired, for when a worker was
  killed rather than shut down.

## CLI

```bash
node scripts/cli.js datasets
node scripts/cli.js rules
node scripts/cli.js eval --expr 'round(gross_amount * 0.9, 2)' --row 3
node scripts/cli.js preview --rule net_amount_v1 --dim customer_segment
node scripts/cli.js run --rule net_amount_v1 --rule segment_bucket --dim customer_segment --batch 50
node scripts/cli.js run --mode group --key month_key --rule revenue_by_month --rule net_amount_v1
node scripts/cli.js verify --version <dataset-version-id>
node scripts/cli.js events --job <job-id>
```

## HTTP API

| method | path | purpose |
| --- | --- | --- |
| GET | `/api/health` | liveness, db/results paths |
| GET/POST | `/api/datasets` | list / ingest (`data[]` or `content` + `format: csv\|jsonl`) |
| GET | `/api/datasets/:id/versions` | version history |
| GET | `/api/dataset-versions/:id` | paginated rows (`limit`, `offset`) |
| GET | `/api/dataset-versions/:id/verify` | re-hash stored rows |
| GET/POST | `/api/dimensions` | list / ingest |
| GET | `/api/dimensions/:name` | version history |
| GET | `/api/dimension-versions/:id` | sample entries |
| GET | `/api/rules`, `/api/rules/:name` | list / versions |
| POST | `/api/rules` | persist a new (deduplicated) rule version |
| POST | `/api/rules/validate` | parse + static analysis, no persistence |
| POST | `/api/preview` | evaluate against real rows; never creates a job |
| POST | `/api/jobs` | create a job (pins input, dims, rules) |
| GET | `/api/jobs`, `/api/jobs/:id` | list / detail + tasks + events |
| GET | `/api/jobs/:id/result` | paginated output rows |
| GET | `/api/jobs/:id/result.jsonl` | download the result |
| GET | `/api/jobs/:id/manifest` | traceability manifest |
| POST | `/api/jobs/:id/fork` | run a new rule set over the same pinned input |
| POST | `/api/jobs/:id/cancel`, `/wake` | control a job |
| POST | `/api/jobs/recover` | requeue tasks with expired leases |

## Layout

```
src/expr/       lexer, parser, evaluator, errors      (the sandboxed language)
src/engine/     datasets, dimensions, rules, compiler, executor,
                jobs (leases/commit/finalize), compile-cache, preview
src/lib/        exact (BigInt summation), util (hashing, CSV/JSONL)
src/server.js   HTTP + static files; never evaluates rules
src/worker.js   standalone task processor
scripts/        seed, demo, cli
public/         vanilla JS single-page UI
test/unit/      language semantics
test/integration/  engine guarantees + real HTTP API
```

## Configuration

| variable | default | meaning |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | HTTP bind |
| `DB_PATH` | `data/pointwise.db` | SQLite control plane |
| `RESULTS_DIR` | `data/results` | job result directories |
| `LEASE_MS` | `30000` | task lease duration |
| `MAX_UPLOAD_BYTES` | `26214400` | upload cap |
| `AUTO_SPAWN_WORKER` | `1` | server spawns a worker per job (`0` to run the tier separately) |

Workers accept `--job <id>`, `--watch`, `--once`, `--max-tasks N`,
`--lease-ms N`, `--poll-ms N`.
