import { Money } from '../../domain/money';
import { Wallet } from '../../domain/wallet';
import { WagerTransaction } from '../../domain/wager-transaction';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import type { LedgerRow, TransactionRow, WalletRow } from './entities/financial.schemas';

// Separa os registros do ORM das classes de domínio e preserva os decimais exatos.
export function walletToRow(wallet: Wallet): WalletRow {
  return { ...wallet.snapshot(), balance: wallet.balance.toString(), currency: wallet.currency };
}
export function walletFromRow(row: WalletRow): Wallet {
  const { currency, balance, ...state } = row;
  return Wallet.rehydrate({ ...state, balance: Money.rehydrate({ amount: balance, currency }) });
}
export function transactionToRow(transaction: WagerTransaction,
  retry?: Pick<TransactionRow, 'referenceAttempts' | 'nextReferenceAttemptAt' | 'referenceExpiresAt'>): TransactionRow {
  const { money, resultBalance, ...state } = transaction.snapshot();
  return { ...state, amount: money.toString(), currency: money.currency,
    referenceExternalTransactionId: state.referenceExternalTransactionId ?? null,
    referenceTransactionId: state.referenceTransactionId ?? null, failureCode: state.failureCode ?? null,
    processedAt: state.processedAt ?? null, resultBalance: resultBalance?.toString() ?? null,
    resultCurrency: resultBalance?.currency ?? null,
    referenceAttempts: retry?.referenceAttempts ?? 0,
    nextReferenceAttemptAt: retry?.nextReferenceAttemptAt ?? null,
    referenceExpiresAt: retry?.referenceExpiresAt ?? null };
}
export function transactionFromRow(row: TransactionRow): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id, providerId: row.providerId, externalTransactionId: row.externalTransactionId,
    idempotencyKey: row.idempotencyKey, payloadHash: row.payloadHash,
    walletId: row.walletId, playerId: row.playerId, roundId: row.roundId, gameId: row.gameId,
    kind: row.kind, status: row.status, createdAt: row.createdAt,
    money: Money.rehydrate({ amount: row.amount, currency: row.currency }),
    referenceExternalTransactionId: row.referenceExternalTransactionId ?? undefined,
    referenceTransactionId: row.referenceTransactionId ?? undefined,
    failureCode: row.failureCode ?? undefined, processedAt: row.processedAt ?? undefined,
    resultBalance: row.resultBalance !== null && row.resultCurrency !== null
      ? Money.rehydrate({ amount: row.resultBalance, currency: row.resultCurrency }) : undefined });
}
export function ledgerToRow(entry: WalletLedgerEntry): LedgerRow {
  const { money, balanceBefore, balanceAfter, ...state } = entry.snapshot();
  return { ...state, amount: money.toString(), currency: money.currency,
    balanceBefore: balanceBefore.toString(), balanceAfter: balanceAfter.toString() };
}
export function ledgerFromRow(row: LedgerRow): WalletLedgerEntry {
  const { amount, currency, balanceBefore, balanceAfter, ...state } = row;
  return WalletLedgerEntry.rehydrate({ ...state,
    money: Money.rehydrate({ amount, currency }),
    balanceBefore: Money.rehydrate({ amount: balanceBefore, currency }),
    balanceAfter: Money.rehydrate({ amount: balanceAfter, currency }) });
}
