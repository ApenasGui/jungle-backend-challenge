export interface OutboxState {
  id: string; aggregateId: string; eventType: string; payload: Record<string, unknown>;
  occurredAt: Date; attempts: number; nextAttemptAt: Date; publishedAt: Date | null;
}
interface EnqueueEvent {
  readonly eventId: string; readonly aggregateId: string; readonly eventType: string; readonly occurredAt: Date;
  toJSON(): Record<string, unknown>;
}

export class OutboxMessage {
  private constructor(private readonly state: OutboxState) {}
  // Copia o envelope para que alterações externas não mudem o evento enfileirado.
  static enqueue(event: EnqueueEvent): OutboxMessage {
    return OutboxMessage.rehydrate({ id: event.eventId, aggregateId: event.aggregateId,
      eventType: event.eventType, payload: event.toJSON(), occurredAt: event.occurredAt,
      attempts: 0, nextAttemptAt: event.occurredAt, publishedAt: null });
  }
  static rehydrate(state: OutboxState): OutboxMessage {
    return new OutboxMessage({ ...state, payload: structuredClone(state.payload),
      occurredAt: new Date(state.occurredAt), nextAttemptAt: new Date(state.nextAttemptAt),
      publishedAt: state.publishedAt ? new Date(state.publishedAt) : null });
  }
  isDue(now: Date): boolean { return !this.state.publishedAt && this.state.nextAttemptAt <= now; }
  isPending(): boolean { return this.state.publishedAt === null; }
  get attempts(): number { return this.state.attempts; }
  get nextAttemptAt(): Date { return new Date(this.state.nextAttemptAt); }
  get publishedAt(): Date | null { return this.state.publishedAt ? new Date(this.state.publishedAt) : null; }
  markPublished(at: Date): void {
    this.assertPending();
    this.state.publishedAt = new Date(at);
  }
  // A tentativa e o agendamento são persistidos mesmo quando SQS está fora do ar.
  scheduleRetry(now: Date): void {
    this.assertPending();
    this.state.attempts++;
    this.state.nextAttemptAt = new Date(now.getTime() + Math.min(1000 * 2 ** Math.min(this.state.attempts - 1, 10), 60000));
  }
  snapshot(): OutboxState { return structuredClone(this.state); }
  private assertPending(): void {
    if (!this.isPending()) throw new Error('OUTBOX_ALREADY_PUBLISHED');
  }
}
