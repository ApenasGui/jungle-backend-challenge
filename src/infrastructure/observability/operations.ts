import { Client } from 'pg';
import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { DataSource } from 'typeorm';
import type { QueueConfig } from '../messaging/sqs-config';
import type { OperationalMetrics } from './metrics';

// As sondas só consultam dependências; não recebem nem removem mensagens.
export class Operations {
  private stopping = false;
  private nextCollectionAt = -Infinity;
  private collection?: Promise<void>;
  constructor(private readonly source: DataSource, private readonly client: SQSClient,
    private readonly queues: QueueConfig, private readonly metrics: OperationalMetrics,
    private readonly cache = { ttlMs: 5000, now: () => performance.now() }) {}

  stop(): void { this.stopping = true; }

  async ready() {
    const results = await Promise.allSettled([
      this.databaseProbe(),
      ...[this.queues.inputUrl, this.queues.dlqUrl, this.queues.eventsUrl].map(QueueUrl =>
        this.client.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] }),
          { abortSignal: AbortSignal.timeout(2000) })),
    ]);
    const checks = { postgres: results[0]?.status === 'fulfilled',
      sqs: results.slice(1).every(result => result.status === 'fulfilled'), accepting: !this.stopping };
    return { status: Object.values(checks).every(Boolean) ? 'ready' : 'not_ready', checks };
  }

  private async databaseProbe(): Promise<void> {
    if (!this.source.isInitialized) throw new Error('Database unavailable');
    const client = new Client({ connectionString: (this.source.options as { url: string }).url,
      connectionTimeoutMillis: 2000, query_timeout: 2000, statement_timeout: 2000 });
    // Conexão dedicada limita a duração da sonda sem disputar o pool financeiro.
    try { await client.connect(); await client.query('SELECT 1'); }
    finally { await client.end(); }
  }

  async collect(): Promise<string> {
    // Scrapes simultâneos compartilham a consulta; só os gauges SQL ficam em cache.
    if (!this.collection && this.cache.now() >= this.nextCollectionAt) {
      this.collection = this.collectDatabaseMetrics().finally(() => {
        this.nextCollectionAt = this.cache.now() + this.cache.ttlMs;
        this.collection = undefined;
      });
    }
    if (this.collection) await this.collection;
    return this.metrics.render();
  }

  private async collectDatabaseMetrics(): Promise<void> {
    try {
      const [row] = await this.source.query(`SELECT count(*)::int AS pending,
        COALESCE(EXTRACT(EPOCH FROM now() - min(occurred_at)),0)::float8 AS lag
        FROM outbox_messages WHERE published_at IS NULL`);
      this.metrics.gauge('wagering_outbox_pending', row.pending);
      this.metrics.gauge('wagering_outbox_lag_seconds', Math.max(0, row.lag));
      this.metrics.gauge('wagering_outbox_collection_success', 1);
    } catch {
      this.metrics.removeGauge('wagering_outbox_pending');
      this.metrics.removeGauge('wagering_outbox_lag_seconds');
      this.metrics.gauge('wagering_outbox_collection_success', 0);
    }
    const statuses = ['PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'];
    try {
      const rows: { status: string; count: number }[] = await this.source.query(
        'SELECT status, count(*)::int AS count FROM wager_transactions GROUP BY status');
      for (const status of statuses) this.metrics.gauge(`wagering_transactions_current{status="${status}"}`,
        rows.find(row => row.status === status)?.count ?? 0);
      this.metrics.gauge('wagering_transactions_collection_success', 1);
    } catch {
      for (const status of statuses) this.metrics.removeGauge(`wagering_transactions_current{status="${status}"}`);
      this.metrics.gauge('wagering_transactions_collection_success', 0);
    }
  }
}
