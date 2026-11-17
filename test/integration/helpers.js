/**
 * Integration-test helpers.
 *
 * `runTaskVia` is a thin wrapper so the tests express "worker X runs task N"
 * without importing the async worker loop; it delegates to the same executor
 * the real worker process uses.
 */
export {
  createJob,
  getJob,
  claimTasks,
  commitTask,
  tryFinalizeJob,
  recoverStaleJobs,
  listTasks,
  renewLease,
  failTask,
} from '../../src/engine/jobs.js';

import { runTask } from '../../src/engine/executor.js';

export function runTaskVia(db, jobId, taskNo, workerId) {
  return runTask(db, jobId, taskNo, workerId);
}
