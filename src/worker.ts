import 'reflect-metadata';
import { createDataSource } from './infrastructure/database/data-source';
import { createSqsClient, queueConfig } from './infrastructure/messaging/sqs-config';
import { WorkerRuntime } from './infrastructure/messaging/worker-runtime';
import { Operations } from './infrastructure/observability/operations';

async function bootstrap(): Promise<void> {
  const source = createDataSource(); await source.initialize();
  const client = createSqsClient();
  const runtime = new WorkerRuntime(source, client, queueConfig());
  const operations = new Operations(source, client, queueConfig(), runtime.metrics);
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({ hostname: '0.0.0.0', port: Number(process.env.WORKER_PORT ?? 3001),
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/metrics') return new Response(await operations.collect(), { headers: { 'content-type': 'text/plain; version=0.0.4' } });
      if (path === '/health/ready') {
        const result = await operations.ready();
        return Response.json(result, { status: result.status === 'ready' ? 200 : 503 });
      }
      if (path === '/health/live') return Response.json({ status: 'ok' });
      return new Response('Not found', { status: 404 });
    } });
  } catch (error) {
    // Uma porta ocupada não deve deixar o pool do banco mantendo o processo aberto.
    client.destroy();
    await source.destroy();
    throw error;
  }
  runtime.start();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    operations.stop();
    try { await runtime.stop(); }
    finally {
      server.stop(); client.destroy();
      if (source.isInitialized) await source.destroy();
    }
  };
  const shutdown = () => { void stop().catch(() => {
    console.error(JSON.stringify({ level: 'error', event: 'worker_stop_failed' }));
    process.exitCode = 1;
  }); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  console.log(JSON.stringify({ level: 'info', event: 'worker_started', port: server.port }));
}
void bootstrap().catch(() => { console.error(JSON.stringify({ level: 'error', event: 'worker_start_failed' })); process.exitCode = 1; });
