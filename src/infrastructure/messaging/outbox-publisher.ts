import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { DataSource } from 'typeorm';
import { OutboxSchema } from '../database/entities/financial.schemas';
import { OutboxMessage } from '../../domain/outbox-message';
import { WorkerMetrics } from './worker-metrics';

export class OutboxPublisher {
  constructor(private readonly source: DataSource, private readonly client: SQSClient,
    private readonly queueUrl: string, private readonly metrics = new WorkerMetrics(),
    private readonly hooks: { afterPublish?: () => Promise<void> } = {}) {}

  async publishOnce(): Promise<boolean> {
    return this.source.transaction(async manager => {
      // A reserva dura até confirmar publicação; um crash libera o lock para outra instância.
      const row = await manager.createQueryBuilder(OutboxSchema, 'event')
        .where('event.publishedAt IS NULL AND event.nextAttemptAt <= :now', { now: new Date() })
        .orderBy('event.nextAttemptAt', 'ASC').addOrderBy('event.id', 'ASC')
        .limit(1).setLock('pessimistic_write').setOnLocked('skip_locked').getOne();
      if (!row) return false;
      const event = OutboxMessage.rehydrate(row);
      this.metrics.gauge('wagering_outbox_lag_seconds', Math.max(0, (Date.now() - row.occurredAt.getTime()) / 1000));
      try {
        await this.client.send(new SendMessageCommand({ QueueUrl: this.queueUrl,
          MessageBody: JSON.stringify(row.payload), MessageGroupId: row.aggregateId, MessageDeduplicationId: row.id,
        }), { abortSignal: AbortSignal.timeout(5000) });
      } catch {
        event.scheduleRetry(new Date());
        const retry = event.snapshot();
        await manager.update(OutboxSchema, row.id, { attempts: retry.attempts, nextAttemptAt: retry.nextAttemptAt });
        this.metrics.increment('wagering_outbox_retries_total');
        return true;
      }
      await this.hooks.afterPublish?.();
      event.markPublished(new Date());
      await manager.update(OutboxSchema, row.id, { publishedAt: event.snapshot().publishedAt });
      this.metrics.increment('wagering_outbox_published_total');
      return true;
    });
  }
}
