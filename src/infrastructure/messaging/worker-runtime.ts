import type { DataSource } from 'typeorm';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { FinancialService } from '../../application/financial-service';
import { TypeOrmFinancialStore } from '../database/typeorm-financial-store';
import { FinancialDiagnosticsService } from '../http/financial-diagnostics';
import { OutboxPublisher } from './outbox-publisher';
import { ReferenceWorker } from './reference-worker';
import { SqsConsumer } from './sqs-consumer';
import type { QueueConfig } from './sqs-config';
import { WorkerMetrics } from './worker-metrics';

export class WorkerRuntime {
  readonly metrics = new WorkerMetrics();
  readonly consumer: SqsConsumer;
  readonly publisher: OutboxPublisher;
  readonly references: ReferenceWorker;
  private running = false;
  private tasks: Promise<void>[] = [];
  private readonly pauseAbort = new AbortController();
  constructor(source: DataSource, client: SQSClient, queues: QueueConfig) {
    const service = new FinancialService(new TypeOrmFinancialStore(source, this.metrics), new FinancialDiagnosticsService());
    this.consumer = new SqsConsumer(client, queues, service, this.metrics);
    this.publisher = new OutboxPublisher(source, client, queues.eventsUrl, this.metrics);
    this.references = new ReferenceWorker(source, service, this.metrics);
  }
  start(): void {
    if (this.running) return;
    this.running = true;
    this.tasks = [this.loop('consumer', () => this.consumer.pollOnce(20), 0),
      this.loop('outbox', () => this.publisher.publishOnce(), 250),
      this.loop('references', () => this.references.runOnce(), 1000)];
  }
  // Para novas leituras e aguarda o processamento atual antes de fechar banco e SQS.
  async stop(): Promise<void> {
    this.running = false; this.consumer.stop(); this.pauseAbort.abort();
    await Promise.all(this.tasks);
  }
  private async loop(name: string, work: () => Promise<unknown>, interval: number): Promise<void> {
    while (this.running) {
      let failed = false;
      try { await work(); }
      catch {
        failed = true;
        if (this.running) {
          this.metrics.increment('wagering_worker_errors_total');
          this.metrics.log('worker_retry', { worker: name });
        }
      }
      const delay = failed ? 1000 : interval;
      if (this.running && delay) await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); this.pauseAbort.signal.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, delay);
        this.pauseAbort.signal.addEventListener('abort', finish, { once: true });
      });
    }
  }
}
