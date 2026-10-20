import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';
import { WagerTransaction, type TransactionProps } from '../../src/domain/wager-transaction';

export const at = new Date('2026-10-19T12:00:00.000Z');
export const walletId = '00000000-0000-4000-8000-000000000001';
export const playerId = '00000000-0000-4000-8000-000000000002';
export const hash = 'a'.repeat(64);
export function money(amount: string, currency = 'BRL'): Money { return Money.from({ amount, currency }); }
export function open(balance = '100.00') {
  return Wallet.open({ id: walletId, playerId, initialBalance: money(balance), at,
    opening: { transactionId: '00000000-0000-4000-8000-000000000003',
      ledgerId: '00000000-0000-4000-8000-000000000004', payloadHash: hash } });
}
export function tx(overrides: Partial<TransactionProps> = {}): WagerTransaction {
  return WagerTransaction.create({ id: crypto.randomUUID(), providerId: 'provider-a',
    externalTransactionId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(),
    payloadHash: hash, walletId, playerId, roundId: 'round-1', gameId: 'game-1', kind: 'BET',
    money: money('25.00'), createdAt: at, ...overrides });
}
export function context(reference?: WagerTransaction, alreadyReversed = false) {
  return { ledgerId: crypto.randomUUID(), at, reference, alreadyReversed };
}
