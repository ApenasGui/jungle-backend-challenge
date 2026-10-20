export interface OutboxState {
  id: string; aggregateId: string; eventType: string; payload: Record<string, unknown>;
  occurredAt: Date; attempts: number; nextAttemptAt: Date; publishedAt: Date | null;
}

export class OutboxMessage {
  private constructor(private readonly state: OutboxState) {}
  static rehydrate(state: OutboxState): OutboxMessage {
    return new OutboxMessage({ ...state, payload: structuredClone(state.payload),
      occurredAt: new Date(state.occurredAt), nextAttemptAt: new Date(state.nextAttemptAt),
      publishedAt: state.publishedAt ? new Date(state.publishedAt) : null });
  }
  isDue(now: Date): boolean { return !this.state.publishedAt && this.state.nextAttemptAt <= now; }
  markPublished(at: Date): void { this.state.publishedAt = new Date(at); }
  // A tentativa e o agendamento são persistidos mesmo quando SQS está fora do ar.
  scheduleRetry(now: Date): void {
    this.state.attempts++;
    this.state.nextAttemptAt = new Date(now.getTime() + Math.min(1000 * 2 ** Math.min(this.state.attempts - 1, 10), 60000));
  }
  snapshot(): OutboxState { return structuredClone(this.state); }
}
