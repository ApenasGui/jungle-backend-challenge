export interface InboxState {
  consumerName: string; messageId: string; payloadHash: string; receivedAt: Date; processedAt: Date | null;
}
export class InboxMessage {
  private constructor(private readonly state: InboxState) {}
  static receive(consumerName: string, messageId: string, payloadHash: string): InboxMessage {
    return new InboxMessage({ consumerName, messageId, payloadHash, receivedAt: new Date(), processedAt: null });
  }
  static rehydrate(state: InboxState): InboxMessage { return new InboxMessage(structuredClone(state)); }
  isProcessed(): boolean { return this.state.processedAt !== null; }
  matches(hash: string): boolean { return this.state.payloadHash === hash; }
  markProcessed(at: Date): void { this.state.processedAt ??= new Date(at); }
  snapshot(): InboxState { return structuredClone(this.state); }
}
