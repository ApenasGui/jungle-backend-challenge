import type { DataSource } from 'typeorm';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { FinancialService } from '../../application/financial-service';
import { TypeOrmFinancialStore } from '../database/typeorm-financial-store';
import { FinancialDiagnosticsService } from '../observability/financial-diagnostics';
import { OutboxPublisher } from './outbox-publisher';
import { ReferenceWorker } from './reference-worker';
import { SqsConsumer } from './sqs-consumer';
import type { QueueConfig } from './sqs-config';

export class WorkerRuntime {
  readonly metrics = new FinancialDiagnosticsService();
  readonly consumer: SqsConsumer;
  readonly publisher: OutboxPublisher;
  readonly references: ReferenceWorker;
  private running = false;
  private tasks: Promise<void>[] = [];
  private readonly pauseAbort = new AbortController();
  constructor(source: DataSource, client: SQSClient, queues: QueueConfig) {
    const service = new FinancialService(new TypeOrmFinancialStore(source, this.metrics), this.metrics);
    this.consumer = new SqsConsumer(client, queues, service, this.metrics);
    this.publisher = new OutboxPublisher(source, client, queues.eventsUrl, this.metrics);
    this.references = new ReferenceWorker(source, service, this.metrics);
  }
  start(): void {
    if (this.running) return;
    this.running = true;
    this.tasks = [this.loop('consumer', () => this.consumer.pollOnce(20), 0),
      this.loop('outbox', () => this.publisher.publishOnce(), 250, true),
      this.loop('references', () => this.references.runOnce(), 1000)];
  }
  // Para novas leituras e aguarda o processamento atual antes de fechar banco e SQS.
  async stop(): Promise<void> {
    this.running = false; this.consumer.stop(); this.pauseAbort.abort();
    await Promise.all(this.tasks);
  }
  private async loop(name: string, work: () => Promise<unknown>, interval: number, waitOnlyWhenIdle = false): Promise<void> {
    while (this.running) {
      let failed = false;
      let worked: unknown;
      try { worked = await work(); }
      catch {
        failed = true;
        if (this.running) {
          this.metrics.increment('wagering_worker_errors_total');
          this.metrics.log('worker_retry', { worker: name });
        }
      }
      // A outbox só espera quando não há evento disponível; cada envio ainda usa seu próprio commit.
      const delay = failed ? 1000 : waitOnlyWhenIdle && worked === true ? 0 : interval;
      if (this.running && delay) await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); this.pauseAbort.signal.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, delay);
        this.pauseAbort.signal.addEventListener('abort', finish, { once: true });
      });
    }
  }
}
