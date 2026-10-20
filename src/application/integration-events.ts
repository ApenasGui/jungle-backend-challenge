import type { WagerTransaction } from '../domain/wager-transaction';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';

export interface EventContext { correlationId: string; causationId?: string }

// O envelope salvo na outbox possui ID estável, versão e valores monetários serializados.
export abstract class IntegrationEvent {
  abstract readonly eventType: string;
  readonly version = 1;
  readonly eventId = crypto.randomUUID();
  protected constructor(readonly aggregateId: string, readonly occurredAt: Date,
    protected readonly data: Readonly<Record<string, unknown>>, protected readonly context: EventContext) {}
  toJSON(): Record<string, unknown> {
    return { eventId: this.eventId, eventType: this.eventType, version: this.version,
      aggregateId: this.aggregateId, correlationId: this.context.correlationId,
      causationId: this.context.causationId, occurredAt: this.occurredAt.toISOString(), data: this.data };
  }
}
function transactionData(tx: WagerTransaction): Record<string, unknown> {
  return { transactionId: tx.id, providerId: tx.providerId, externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId, playerId: tx.playerId, roundId: tx.roundId, gameId: tx.gameId,
    kind: tx.kind, status: tx.status, money: tx.money.toJSON(),
    balance: tx.resultBalance?.toJSON(), failureCode: tx.failureCode,
    referenceExternalTransactionId: tx.referenceExternalTransactionId, referenceTransactionId: tx.referenceTransactionId };
}
export class WagerTransactionProcessed extends IntegrationEvent {
  readonly eventType = 'WagerTransactionProcessed';
  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed(tx.walletId, tx.processedAt!, transactionData(tx), ctx);
  }
}
export class WagerTransactionRejected extends IntegrationEvent {
  readonly eventType = 'WagerTransactionRejected';
  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected(tx.walletId, tx.processedAt!, transactionData(tx), ctx);
  }
}
export class WagerTransactionFailed extends IntegrationEvent {
  readonly eventType = 'WagerTransactionFailed';
  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionFailed {
    return new WagerTransactionFailed(tx.walletId, tx.processedAt!, transactionData(tx), ctx);
  }
}
export class WagerTransactionPendingReference extends IntegrationEvent {
  readonly eventType = 'WagerTransactionPendingReference';
  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(tx.walletId, tx.createdAt, transactionData(tx), ctx);
  }
}
export class WalletBalanceChanged extends IntegrationEvent {
  readonly eventType = 'WalletBalanceChanged';
  static from(entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged(entry.walletId, entry.createdAt, {
      walletId: entry.walletId, transactionId: entry.transactionId, direction: entry.direction,
      money: entry.money.toJSON(), balanceBefore: entry.balanceBefore.toJSON(),
      balanceAfter: entry.balanceAfter.toJSON(), walletVersion: entry.walletVersion,
    }, ctx);
  }
}
