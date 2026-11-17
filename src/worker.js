#!/usr/bin/env node
import { config } from './config.js';
import { openDatabase } from './db.js';
import { all, get } from './db.js';
import { runTask } from './engine/executor.js';
import {
  claimTasks,
  commitTask,
  failTask,
  getJob,
  logEvent,
  renewLease,
  tryFinalizeJob,
  recoverStaleJobs,
  DEFAULT_LEASE_MS,
} from './engine/jobs.js';

/**
 * Standalone worker process.
 *
 * Runs independently of the HTTP server: it opens its own database connection,
 * claims tasks with leases, evaluates them in this process, and exits when
 * there is no work left (or keeps polling with --watch). Killing it mid-task
 * leaves a lease that expires; any worker - including a fresh restart - will
 * reclaim and redo exactly the unfinished tasks, because task outputs are
 * written atomically and only committed together with the ledger row.
 *
 * Usage:
 *   node src/worker.js [--job <id>] [--watch] [--max-tasks N] [--lease-ms N]
 */

function parseArgs(argv) {
  const opts = { jobId: null, watch: false, maxTasks: Infinity, leaseMs: config.leaseMs, pollMs: 250, once: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--job' || a === '-j') opts.jobId = argv[++i];
    else if (a === '--watch' || a === '-w') opts.watch = true;
    else if (a === '--once') opts.once = true;
    else if (a === '--max-tasks') opts.maxTasks = Number(argv[++i]);
    else if (a === '--lease-ms') opts.leaseMs = Number(argv[++i]);
    else if (a === '--poll-ms') opts.pollMs = Number(argv[++i]);
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'usage: node src/worker.js [--job <id>] [--watch] [--once] [--max-tasks N] [--lease-ms N]\n',
      );
      process.exit(0);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const workerId = `w_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
const db = openDatabase(config.dbPath);

let stopping = false;
let running = 0;
let tasksDone = 0;

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopping = true;
    if (running === 0) {
      log('worker stopped on signal');
      process.exit(0);
    }
    log('worker draining; unfinished leases will be reclaimed by another worker');
  });
}

function log(message) {
  process.stderr.write(`[worker ${workerId}] ${message}\n`);
}

function candidateJobs() {
  if (opts.jobId) return [opts.jobId];
  return all(
    db,
    `SELECT id FROM jobs WHERE status IN ('pending', 'running') ORDER BY created_at LIMIT 25`,
  ).map((r) => r.id);
}

function processOneJob(jobId) {
  const job = getJob(db, jobId);
  if (!job) return { worked: false, error: `job ${jobId} not found` };
  if (job.status === 'cancelled' || job.status === 'done') return { worked: false };

  const [taskNo] = claimTasks(db, jobId, workerId, 1, opts.leaseMs);
  if (taskNo === undefined) {
    // No claimable task: either all done (finalize) or another worker is
    // mid-flight on the remaining ones.
    const remaining = get(
      db,
      "SELECT COUNT(*) AS n FROM job_tasks WHERE job_id = ? AND status != 'done'",
      jobId,
    );
    if (Number(remaining.n) === 0) {
      tryFinalizeJob(db, jobId, { mode: job.mode });
      return { worked: false };
    }
    return { worked: false, waiting: Number(remaining.n) };
  }

  running += 1;
  const startedAt = Date.now();
  try {
    // Heartbeat in the background for long tasks.
    const beat = setInterval(() => {
      try {
        renewLease(db, jobId, workerId, [taskNo], opts.leaseMs);
      } catch {
        /* transient */
      }
    }, Math.max(1000, Math.floor(opts.leaseMs / 3)));
    beat.unref?.();

    const output = runTask(db, jobId, taskNo, workerId);
    clearInterval(beat);
    commitTask(db, jobId, taskNo, workerId, output);
    tasksDone += 1;
    log(`task ${taskNo} of ${jobId} done in ${Date.now() - startedAt}ms (${output.rowCount} rows)`);
    const after = get(db, "SELECT COUNT(*) AS n FROM job_tasks WHERE job_id = ? AND status != 'done'", jobId);
    if (Number(after.n) === 0) {
      const result = tryFinalizeJob(db, jobId, { mode: job.mode });
      if (result.finalized) log(`job ${jobId} finalized: ${result.rows} output rows -> ${result.job.result_dir}`);
    }
    return { worked: true };
  } catch (err) {
    log(`task ${taskNo} of ${jobId} failed: ${err.code ?? 'E_TASK'}: ${err.message}`);
    try {
      failTask(db, jobId, taskNo, workerId, err);
      logEvent(db, jobId, 'error', 'rule-error', err.message, {
        taskNo,
        rowNo: err.rowNo ?? null,
        rule: err.ruleName ?? null,
      });
      // A deterministic rule failure will fail again on retry; cap attempts.
      const task = get(db, 'SELECT attempts FROM job_tasks WHERE job_id = ? AND task_no = ?', jobId, taskNo);
      if (task && task.attempts >= 3) {
        db.prepare("UPDATE job_tasks SET status = 'failed', error = ?, updated_at = ? WHERE job_id = ? AND task_no = ?").run(
          `${err.code ?? 'E_TASK'}: ${err.message}`,
          new Date().toISOString(),
          jobId,
          taskNo,
        );
        db.prepare("UPDATE jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?").run(
          err.message,
          new Date().toISOString(),
          jobId,
        );
      }
    } catch (nested) {
      log(`could not record failure: ${nested.message}`);
    }
    return { worked: false, error: err };
  } finally {
    running -= 1;
  }
}

function main() {
  log(`starting; db=${config.dbPath}`);
  recoverStaleJobs(db, { leaseMs: opts.leaseMs });

  if (opts.once) {
    for (const jobId of candidateJobs()) processOneJob(jobId);
    process.exit(0);
  }

  /**
   * Stop conditions (important for "kill the process and resume"):
   *  * --watch keeps polling forever until a signal;
   *  * otherwise the worker exits once it has no job it can make progress on,
   *    which includes: the queue is empty, the target job is finished, or the
   *    only remaining tasks are leased by another live worker. Exiting is
   *    safe at any point because unfinished leases are reclaimed on restart.
   */
  let idlePolls = 0;
  const tick = () => {
    if (stopping && running === 0) {
      log(`stopped after ${tasksDone} task(s)`);
      process.exit(0);
    }
    if (tasksDone >= opts.maxTasks) {
      log(`reached --max-tasks (${tasksDone}); exiting`);
      process.exit(0);
    }
    if (running > 0) {
      setImmediate(tick);
      return;
    }

    let progress = false;
    let claimable = false;
    for (const jobId of candidateJobs()) {
      const result = processOneJob(jobId);
      if (result.worked) {
        progress = true;
        break;
      }
      if (result.waiting) claimable = true;
    }

    if (progress) {
      idlePolls = 0;
      setImmediate(tick);
      return;
    }

    if (opts.watch) {
      // Keep polling, but do not spin on a job held entirely by other workers.
      idlePolls += 1;
      setTimeout(tick, claimable ? Math.max(opts.pollMs, 500) : opts.pollMs);
      return;
    }

    if (claimable) {
      // Another worker is processing the last tasks; give it a couple of
      // polls in case it dies, then exit and let a future run pick up.
      idlePolls += 1;
      if (idlePolls < 4) {
        setTimeout(tick, Math.max(opts.pollMs, 500));
        return;
      }
    }
    const pending = candidateJobs();
    const activeWork = db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('pending','running')")
      .get();
    if (Number(activeWork.n) === 0) {
      log(`no active jobs; ${tasksDone} task(s) done, exiting`);
      process.exit(0);
    }
    log(`nothing claimable right now (${pending.length} active job(s)); exiting`);
    process.exit(0);
  };
  setTimeout(tick, 0);
}

main();
