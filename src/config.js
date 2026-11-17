import path from 'node:path';

const env = process.env;

/**
 * Configuration is read once at process start. Configuration is deliberately
 * process-local: the server, each worker, and the result directory are meant
 * to be deployable and restartable independently.
 */
export const config = Object.freeze({
  port: Number(env.PORT || 3000),
  host: env.HOST || '127.0.0.1',
  dbPath: path.resolve(env.DB_PATH || path.join(process.cwd(), 'data', 'pointwise.db')),
  resultsDir: path.resolve(env.RESULTS_DIR || path.join(process.cwd(), 'data', 'results')),
  leaseMs: Number(env.LEASE_MS || 30_000),
  maxUploadBytes: Number(env.MAX_UPLOAD_BYTES || 25 * 1024 * 1024),
  autoSpawnWorker: env.AUTO_SPAWN_WORKER !== '0',
  workerCommand: env.WORKER_COMMAND || '',
});

process.env.RESULTS_DIR = config.resultsDir;
