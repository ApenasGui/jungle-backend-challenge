import type { Wallet } from '../domain/wallet';
import type { WagerTransaction } from '../domain/wager-transaction';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import type { IntegrationEvent } from './integration-events';

export interface FinancialSession {
  receiveInbox(consumer: string, messageId: string, hash: string): Promise<void>;
  finishInbox(consumer: string, messageId: string): Promise<void>;
  referenceSchedule(id: string): Promise<{ attempts: number; nextAt: Date | null; expiresAt: Date | null }>;
  updateTransaction(tx: WagerTransaction, attempts: number, nextAt: Date | null, expiresAt: Date | null): Promise<void>;
  findWallet(id: string, lock?: boolean): Promise<Wallet | null>;
  insertWallet(wallet: Wallet): Promise<void>;
  updateWallet(wallet: Wallet): Promise<void>;
  byKey(key: string): Promise<WagerTransaction | null>;
  byExternal(providerId: string, externalId: string): Promise<WagerTransaction | null>;
  byId(id: string): Promise<WagerTransaction | null>;
  insertTransaction(tx: WagerTransaction): Promise<void>;
  hasReversal(referenceId: string): Promise<boolean>;
  insertLedger(entry: WalletLedgerEntry): Promise<void>;
  enqueue(event: IntegrationEvent): Promise<void>;
  ledger(walletId: string, afterVersion: number, limit: number): Promise<WalletLedgerEntry[]>;
  reconcile(walletId: string): Promise<{ amount: string; count: number }>;
}
export interface FinancialStore {
  transaction<T>(work: (session: FinancialSession) => Promise<T>): Promise<T>;
}
export interface FinancialDiagnostics {
  reconciliationMismatch(walletId: string, correlationId: string): void;
}
