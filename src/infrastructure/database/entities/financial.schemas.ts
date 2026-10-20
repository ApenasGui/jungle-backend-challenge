import { EntitySchema } from 'typeorm';
import type { FailureCode } from '../../../domain/domain-error';
import type { LedgerDirection, TransactionKind, TransactionStatus } from '../../../domain/wager-transaction';

export interface WalletRow {
  id: string; playerId: string; currency: string; balance: string;
  version: number; createdAt: Date; updatedAt: Date;
}
export interface TransactionRow {
  id: string; providerId: string; externalTransactionId: string; idempotencyKey: string;
  payloadHash: string; walletId: string; playerId: string; roundId: string; gameId: string;
  kind: TransactionKind; amount: string; currency: string; status: TransactionStatus;
  referenceExternalTransactionId: string | null; referenceTransactionId: string | null;
  failureCode: FailureCode | null; resultBalance: string | null; resultCurrency: string | null;
  referenceAttempts: number; nextReferenceAttemptAt: Date | null; referenceExpiresAt: Date | null;
  createdAt: Date; processedAt: Date | null;
}
export interface LedgerRow {
  id: string; walletId: string; transactionId: string; direction: LedgerDirection;
  amount: string; currency: string; balanceBefore: string; balanceAfter: string;
  walletVersion: number; createdAt: Date;
}
export interface InboxRow {
  consumerName: string; messageId: string; payloadHash: string; receivedAt: Date; processedAt: Date | null;
}
export interface OutboxRow {
  id: string; aggregateId: string; eventType: string; payload: Record<string, unknown>;
  occurredAt: Date; attempts: number; nextAttemptAt: Date; publishedAt: Date | null;
}

const moneyColumn = { type: 'numeric', precision: 20, scale: 2 } as const;
const timestamp = { type: 'timestamptz' } as const;
const identifier = { type: 'varchar', length: 200 } as const;

// NUMERIC permanece string no driver; a conversão para Money é feita nos mappers.
export const WalletSchema = new EntitySchema<WalletRow>({
  name: 'WalletRow', tableName: 'wallets', synchronize: false,
  columns: {
    id: { type: 'uuid', primary: true }, playerId: { type: 'uuid', name: 'player_id' },
    currency: { type: 'varchar', length: 3 }, balance: moneyColumn,
    version: { type: 'integer' }, createdAt: { ...timestamp, name: 'created_at' },
    updatedAt: { ...timestamp, name: 'updated_at' },
  },
});
export const TransactionSchema = new EntitySchema<TransactionRow>({
  name: 'TransactionRow', tableName: 'wager_transactions', synchronize: false,
  columns: {
    id: { type: 'uuid', primary: true }, providerId: { ...identifier, name: 'provider_id' },
    externalTransactionId: { ...identifier, name: 'external_transaction_id' },
    idempotencyKey: { ...identifier, name: 'idempotency_key' }, payloadHash: { type: 'char', length: 64, name: 'payload_hash' },
    walletId: { type: 'uuid', name: 'wallet_id' }, playerId: { type: 'uuid', name: 'player_id' },
    roundId: { ...identifier, name: 'round_id' }, gameId: { ...identifier, name: 'game_id' },
    kind: { type: 'varchar', length: 10 }, amount: moneyColumn, currency: { type: 'varchar', length: 3 },
    status: { type: 'varchar', length: 20 },
    referenceExternalTransactionId: { ...identifier, name: 'reference_external_transaction_id', nullable: true },
    referenceTransactionId: { type: 'uuid', name: 'reference_transaction_id', nullable: true },
    failureCode: { type: 'varchar', length: 80, name: 'failure_code', nullable: true },
    resultBalance: { ...moneyColumn, name: 'result_balance', nullable: true },
    resultCurrency: { type: 'varchar', length: 3, name: 'result_currency', nullable: true },
    referenceAttempts: { type: 'integer', name: 'reference_attempts', default: 0 },
    nextReferenceAttemptAt: { ...timestamp, name: 'next_reference_attempt_at', nullable: true },
    referenceExpiresAt: { ...timestamp, name: 'reference_expires_at', nullable: true },
    createdAt: { ...timestamp, name: 'created_at' }, processedAt: { ...timestamp, name: 'processed_at', nullable: true },
  },
});
export const LedgerSchema = new EntitySchema<LedgerRow>({
  name: 'LedgerRow', tableName: 'wallet_ledger_entries', synchronize: false,
  columns: {
    id: { type: 'uuid', primary: true }, walletId: { type: 'uuid', name: 'wallet_id' },
    transactionId: { type: 'uuid', name: 'transaction_id' }, direction: { type: 'varchar', length: 6 },
    amount: moneyColumn, currency: { type: 'varchar', length: 3 },
    balanceBefore: { ...moneyColumn, name: 'balance_before' }, balanceAfter: { ...moneyColumn, name: 'balance_after' },
    walletVersion: { type: 'integer', name: 'wallet_version' }, createdAt: { ...timestamp, name: 'created_at' },
  },
});
export const InboxSchema = new EntitySchema<InboxRow>({
  name: 'InboxRow', tableName: 'inbox_messages', synchronize: false,
  columns: {
    consumerName: { ...identifier, name: 'consumer_name', primary: true },
    messageId: { ...identifier, name: 'message_id', primary: true },
    payloadHash: { type: 'char', length: 64, name: 'payload_hash' },
    receivedAt: { ...timestamp, name: 'received_at' }, processedAt: { ...timestamp, name: 'processed_at', nullable: true },
  },
});
export const OutboxSchema = new EntitySchema<OutboxRow>({
  name: 'OutboxRow', tableName: 'outbox_messages', synchronize: false,
  columns: {
    id: { type: 'uuid', primary: true }, aggregateId: { type: 'uuid', name: 'aggregate_id' },
    eventType: { type: 'varchar', length: 100, name: 'event_type' }, payload: { type: 'jsonb' },
    occurredAt: { ...timestamp, name: 'occurred_at' }, attempts: { type: 'integer', default: 0 },
    nextAttemptAt: { ...timestamp, name: 'next_attempt_at' }, publishedAt: { ...timestamp, name: 'published_at', nullable: true },
  },
});
