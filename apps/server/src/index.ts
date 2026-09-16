/**
 * Server entry point.
 *
 * Boots the API, runs migrations when a database is configured, and optionally
 * starts the simulator worker as a separate ingest client.
 */

import { buildApp } from './app.ts';
import { assertConfigSafe, config } from './config.ts';
import { closePool } from './db/pool.ts';
import { SimulatorWorker } from './worker/simulator-worker.ts';

async function main(): Promise<void> {
  const { app, feed, shutdown } = await buildApp();

  assertConfigSafe(app.log);

  await app.listen({ host: config.host, port: config.port });

  let simulator: SimulatorWorker | null = null;
  if (config.simulator.enabled) {
    simulator = new SimulatorWorker(feed, {
      // The worker talks to the server over HTTP exactly as an external device
      // would, rather than reaching into it in-process.
      baseUrl: `http://127.0.0.1:${config.port}`,
      token: config.ingestToken,
      log: app.log,
    });
    simulator.start();
  }

  let closing = false;
  const close = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    app.log.info(`[server] ${signal} received, shutting down`);
    simulator?.stop();
    await shutdown();
    await closePool();
    process.exit(0);
  };

  process.on('SIGINT', () => void close('SIGINT'));
  process.on('SIGTERM', () => void close('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error('[server] failed to start:', error);
  process.exit(1);
});
