import { createHash } from 'node:crypto';
import { ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand,
  type Message, type SQSClient } from '@aws-sdk/client-sqs';
import { FinancialService } from '../../application/financial-service';
import { ApplicationError } from '../../application/application-error';
import { identifier } from '../../application/contracts';
import { DomainError } from '../../domain/domain-error';
import type { QueueConfig } from './sqs-config';
import { WorkerMetrics } from './worker-metrics';

interface Envelope {
  messageId: string; type: 'WagerTransactionRequested'; occurredAt: string;
  data: Record<string, unknown>; correlationId?: string;
}
function envelope(body: string): Envelope {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { throw new ApplicationError('INVALID_PAYLOAD'); }
  const value = parsed as Envelope | null;
  if (!value || typeof value !== 'object' || value.type !== 'WagerTransactionRequested'
    || typeof value.occurredAt !== 'string' || !Number.isFinite(Date.parse(value.occurredAt))
    || !value.data || typeof value.data !== 'object' || Array.isArray(value.data)) throw new ApplicationError('INVALID_PAYLOAD');
  identifier(value.messageId);
  if (value.correlationId !== undefined) identifier(value.correlationId);
  return value;
}

export class SqsConsumer {
  private readonly receiveAbort = new AbortController();
  private stopping = false;
  constructor(private readonly client: SQSClient, private readonly queues: QueueConfig,
    private readonly service: FinancialService, private readonly metrics = new WorkerMetrics(),
    private readonly hooks: { afterCommit?: () => Promise<void> } = {}) {}

  stop(): void { this.stopping = true; this.receiveAbort.abort(); }

  async pollOnce(waitSeconds = 0): Promise<boolean> {
    if (this.stopping) return false;
    const result = await this.client.send(new ReceiveMessageCommand({ QueueUrl: this.queues.inputUrl,
      MaxNumberOfMessages: 1, WaitTimeSeconds: waitSeconds, VisibilityTimeout: this.queues.visibilitySeconds,
      MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'] }), { abortSignal: this.receiveAbort.signal });
    const message = result.Messages?.[0];
    if (!message?.ReceiptHandle) return false;
    if (this.stopping) { await this.visibility(message, 0); return false; }
    await this.process(message);
    return true;
  }

  private async process(message: Message): Promise<void> {
    const start = performance.now();
    let heartbeatWork = Promise.resolve();
    const heartbeat = setInterval(() => {
      heartbeatWork = heartbeatWork.then(() => this.visibility(message, this.queues.visibilitySeconds)).catch(() => {
        this.metrics.increment('wagering_visibility_errors_total');
      });
    }, Math.max(200, this.queues.visibilitySeconds * 1000 / 3));
    let parsed: Envelope | undefined;
    try {
      parsed = envelope(message.Body ?? '');
      const { idempotencyKey, ...payload } = parsed.data;
      const result = await this.service.submit(payload, idempotencyKey, {
        correlationId: parsed.correlationId ?? parsed.messageId, causationId: parsed.messageId,
      }, { consumer: 'wager-transactions', messageId: parsed.messageId });
      if (!result.idempotentReplay) this.metrics.increment(`wagering_transactions_${result.status.toLowerCase()}_total`);
      if (result.idempotentReplay) this.metrics.increment('wagering_duplicates_total');
      this.metrics.log('transaction_committed', { messageId: parsed.messageId, transactionId: result.transactionId,
        walletId: typeof payload.walletId === 'string' ? payload.walletId : undefined,
        providerId: typeof payload.providerId === 'string' ? payload.providerId : undefined,
        correlationId: parsed.correlationId ?? parsed.messageId, status: result.status });
      // Ponto de falha injetável usado apenas pelos testes de crash após commit.
      await this.hooks.afterCommit?.();
      clearInterval(heartbeat); await heartbeatWork;
      await this.ack(message);
    } catch (error) {
      clearInterval(heartbeat); await heartbeatWork;
      const attempts = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
      const permanent = error instanceof DomainError
        || (error instanceof ApplicationError && error.code !== 'SERVICE_UNAVAILABLE');
      const code = error instanceof DomainError || error instanceof ApplicationError ? error.code : 'INFRASTRUCTURE_FAILURE';
      if (permanent || attempts >= this.queues.maxAttempts) {
        // Só confirma a origem depois que a cópia auditável chegou à DLQ.
        await this.client.send(new SendMessageCommand({ QueueUrl: this.queues.dlqUrl,
          MessageBody: message.Body ?? '{}', MessageGroupId: message.Attributes?.MessageGroupId ?? 'invalid',
          MessageDeduplicationId: createHash('sha256').update(`${message.MessageId}:${message.Body}`).digest('hex'),
          MessageAttributes: { failureCode: { DataType: 'String', StringValue: code } },
        }), { abortSignal: AbortSignal.timeout(5000) });
        if (!permanent && parsed) {
          const { idempotencyKey, ...payload } = parsed.data;
          try {
            const recorded = await this.service.auditDeliveryFailure(payload, idempotencyKey, {
              correlationId: parsed.correlationId ?? parsed.messageId, causationId: parsed.messageId });
            if (recorded) this.metrics.increment('wagering_transactions_failed_total');
          } catch {
            // Se o banco continua indisponível, o corpo original já está preservado na DLQ.
            this.metrics.increment('wagering_failure_audit_errors_total');
          }
        }
        await this.ack(message);
        this.metrics.increment('wagering_dlq_messages_total');
        this.metrics.log('message_dead_lettered', { messageId: parsed?.messageId ?? message.MessageId, code });
      } else {
        this.metrics.increment('wagering_retries_total');
        await this.visibility(message, Math.min(2 ** Math.min(attempts, 8), 300));
        this.metrics.log('message_retry', { messageId: parsed?.messageId ?? message.MessageId, attempts, code });
      }
    } finally {
      clearInterval(heartbeat); await heartbeatWork;
      this.metrics.observe((performance.now() - start) / 1000);
    }
  }
  private async ack(message: Message): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: this.queues.inputUrl, ReceiptHandle: message.ReceiptHandle! }),
      { abortSignal: AbortSignal.timeout(5000) });
  }
  private async visibility(message: Message, seconds: number): Promise<void> {
    await this.client.send(new ChangeMessageVisibilityCommand({ QueueUrl: this.queues.inputUrl,
      ReceiptHandle: message.ReceiptHandle!, VisibilityTimeout: Math.floor(seconds) }), { abortSignal: AbortSignal.timeout(5000) });
  }
}
