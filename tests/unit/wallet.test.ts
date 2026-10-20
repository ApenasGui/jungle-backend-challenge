import { describe, expect, test } from 'bun:test';
import { Wallet } from '../../src/domain/wallet';
import { WagerTransaction } from '../../src/domain/wager-transaction';
import { context, money, open, tx, at, walletId, playerId } from './fixtures';

describe('Wallet e operações financeiras', () => {
  test('abertura positiva gera crédito e versão 1', () => {
    const { wallet, transaction, entry } = open();
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(transaction?.kind).toBe('OPENING');
    expect(transaction?.status).toBe('PROCESSED');
    expect(entry?.direction).toBe('CREDIT');
    expect(entry?.balanceBefore.toString()).toBe('0.00');
    expect(entry?.isBalanced()).toBe(true);
  });
  test('abertura zero não gera transação nem lançamento', () => {
    const result = open('0.00');
    expect(result.wallet.version).toBe(1);
    expect(result.transaction).toBeUndefined();
    expect(result.entry).toBeUndefined();
  });
  test('abertura negativa é inválida e abertura positiva exige dados do ledger', () => {
    expect(() => Wallet.open({ id: walletId, playerId, initialBalance: money('1.00').negate(), at })).toThrow();
    expect(() => Wallet.open({ id: walletId, playerId, initialBalance: money('1.00'), at })).toThrow();
  });
  test('BET debita e WIN credita com incremento de versão', () => {
    const { wallet } = open(); const bet = tx();
    expect(wallet.apply(bet, context())?.direction).toBe('DEBIT');
    expect(wallet.balance.toString()).toBe('75.00');
    const win = tx({ kind: 'WIN', money: money('50.00'), referenceExternalTransactionId: bet.externalTransactionId });
    expect(wallet.apply(win, context(bet))?.direction).toBe('CREDIT');
    expect(wallet.balance.toString()).toBe('125.00');
    expect(wallet.version).toBe(3);
  });
  test('apostas que disputam saldo: regra sequencial após lock (não é teste de concorrência)', () => {
    const { wallet } = open(); const first = tx({ money: money('80.00') });
    const second = tx({ money: money('80.00') });
    wallet.apply(first, context());
    expect(wallet.apply(second, context())).toBeUndefined();
    expect(first.status).toBe('PROCESSED');
    expect(second.status).toBe('REJECTED');
    expect(second.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(2);
  });
  test('LOSS não altera saldo, versão ou data de atualização', () => {
    const { wallet } = open(); const loss = tx({ kind: 'LOSS', money: money('0.00') });
    expect(wallet.apply(loss, { ...context(), at: new Date('2026-10-20') })).toBeUndefined();
    expect(loss.status).toBe('PROCESSED');
    expect(loss.resultBalance?.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(at);
  });
  test('REFUND reverte BET integralmente', () => {
    const { wallet } = open(); const bet = tx(); wallet.apply(bet, context());
    const refund = tx({ kind: 'REFUND', referenceExternalTransactionId: bet.externalTransactionId });
    expect(wallet.apply(refund, context(bet))?.direction).toBe('CREDIT');
    expect(wallet.balance.toString()).toBe('100.00');
    expect(refund.referenceTransactionId).toBe(bet.id);
  });
  test.each(['BET', 'WIN', 'REFUND'] as const)('ROLLBACK inverte %s', kind => {
    const { wallet } = open(); const bet = tx(); wallet.apply(bet, context());
    const reference = kind === 'BET' ? bet : tx({ kind,
      referenceExternalTransactionId: kind === 'REFUND' ? bet.externalTransactionId : undefined });
    if (reference !== bet) wallet.apply(reference, context(kind === 'REFUND' ? bet : undefined));
    const before = wallet.balance;
    const rollback = tx({ kind: 'ROLLBACK', referenceExternalTransactionId: reference.externalTransactionId });
    const entry = wallet.apply(rollback, context(reference));
    expect(entry?.direction).toBe(kind === 'BET' ? 'CREDIT' : 'DEBIT');
    expect(wallet.balance.equals(kind === 'BET' ? before.add(money('25.00')) : before.subtract(money('25.00')))).toBe(true);
  });
  test('reversão sem saldo tem código distinto e permanece auditável', () => {
    const { wallet } = open('0.00'); const win = tx({ kind: 'WIN' }); wallet.apply(win, context());
    wallet.apply(tx(), context());
    const rollback = tx({ kind: 'ROLLBACK', referenceExternalTransactionId: win.externalTransactionId });
    expect(wallet.apply(rollback, context(win))).toBeUndefined();
    expect(rollback.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    expect(rollback.status).toBe('REJECTED');
    expect(wallet.balance.toString()).toBe('0.00');
  });
  test('referência fora de ordem fica pendente e pode ser aplicada depois', () => {
    const { wallet } = open(); const bet = tx();
    const refund = tx({ kind: 'REFUND', referenceExternalTransactionId: bet.externalTransactionId });
    expect(wallet.apply(refund, context())).toBeUndefined();
    expect(refund.status).toBe('PENDING_REFERENCE');
    expect(wallet.version).toBe(1);
    wallet.apply(bet, context()); wallet.apply(refund, context(bet));
    expect(refund.status).toBe('PROCESSED');
    expect(wallet.balance.toString()).toBe('100.00');
  });
  test('referência ainda pendente permanece aguardando', () => {
    const { wallet } = open(); const bet = tx();
    const refund = tx({ kind: 'REFUND', referenceExternalTransactionId: bet.externalTransactionId });
    wallet.apply(refund, context(bet));
    expect(refund.status).toBe('PENDING_REFERENCE');
  });
  test('referência rejeitada não pode ser revertida', () => {
    const { wallet } = open(); const bet = tx({ money: money('200.00') }); wallet.apply(bet, context());
    const refund = tx({ kind: 'REFUND', money: money('200.00'), referenceExternalTransactionId: bet.externalTransactionId });
    wallet.apply(refund, context(bet));
    expect(refund.failureCode).toBe('REFERENCE_NOT_PROCESSED');
  });
  test.each(['providerId', 'playerId', 'walletId', 'roundId', 'externalTransactionId'] as const)
    ('rejeita referência de outro %s', field => {
      const { wallet } = open(); const bet = tx(); wallet.apply(bet, context());
      const snapshot = bet.snapshot();
      const reference = WagerTransaction.rehydrate({ ...snapshot, [field]: 'other' });
      const refund = tx({ kind: 'REFUND', referenceExternalTransactionId: bet.externalTransactionId });
      wallet.apply(refund, context(reference));
      expect(refund.failureCode).toBe('REFERENCE_MISMATCH');
    });
  test('rejeita moeda diferente na referência', () => {
    const { wallet } = open(); const reference = tx({ money: money('25.00', 'USD') });
    const refund = tx({ kind: 'REFUND', referenceExternalTransactionId: reference.externalTransactionId });
    wallet.apply(refund, context(reference));
    expect(refund.failureCode).toBe('REFERENCE_MISMATCH');
  });
  test('rejeita reversão parcial e duplicada', () => {
    const { wallet } = open(); const bet = tx(); wallet.apply(bet, context());
    const partial = tx({ kind: 'REFUND', money: money('10.00'), referenceExternalTransactionId: bet.externalTransactionId });
    wallet.apply(partial, context(bet)); expect(partial.failureCode).toBe('REVERSAL_AMOUNT_MISMATCH');
    const duplicate = tx({ kind: 'ROLLBACK', referenceExternalTransactionId: bet.externalTransactionId });
    wallet.apply(duplicate, context(bet, true)); expect(duplicate.failureCode).toBe('ALREADY_REVERSED');
    expect(wallet.balance.toString()).toBe('75.00');
  });
  test('REFUND só aceita BET e ROLLBACK não aceita LOSS', () => {
    const { wallet } = open(); const win = tx({ kind: 'WIN' }); wallet.apply(win, context());
    const refund = tx({ kind: 'REFUND', referenceExternalTransactionId: win.externalTransactionId });
    wallet.apply(refund, context(win)); expect(refund.failureCode).toBe('INVALID_REFERENCE_KIND');
    const loss = tx({ kind: 'LOSS', money: money('0.00') }); wallet.apply(loss, context());
    const rollback = tx({ kind: 'ROLLBACK', referenceExternalTransactionId: loss.externalTransactionId });
    wallet.apply(rollback, context(loss)); expect(rollback.failureCode).toBe('INVALID_REFERENCE_KIND');
  });
  test('rejeita moeda e proprietário incompatíveis sem mudar saldo', () => {
    const { wallet } = open(); const wrongCurrency = tx({ money: money('25.00', 'USD') });
    wallet.apply(wrongCurrency, context()); expect(wrongCurrency.failureCode).toBe('CURRENCY_MISMATCH');
    const wrongPlayer = tx({ playerId: 'other' }); wallet.apply(wrongPlayer, context());
    expect(wrongPlayer.failureCode).toBe('WALLET_MISMATCH');
    expect(wallet.version).toBe(1);
  });
  test('resultado original é preservado após novas operações e reidratação', () => {
    const { wallet } = open(); const bet = tx(); wallet.apply(bet, context());
    wallet.apply(tx({ kind: 'WIN', money: money('50.00') }), context());
    expect(bet.resultBalance?.toString()).toBe('75.00');
    expect(() => wallet.apply(bet, context())).toThrow('INVALID_TRANSACTION_STATE');
    const rebuilt = Wallet.rehydrate(wallet.snapshot());
    expect(rebuilt.balance.toString()).toBe('125.00');
    expect(rebuilt.version).toBe(3);
  });
  test('overflow rejeita crédito sem alteração parcial', () => {
    const { wallet } = open('999999999999999999.99'); const win = tx({ kind: 'WIN' });
    expect(wallet.apply(win, context())).toBeUndefined();
    expect(win.failureCode).toBe('AMOUNT_OUT_OF_RANGE');
    expect(wallet.version).toBe(1);
  });
  test('datas e snapshots retornados não expõem estado mutável', () => {
    const { wallet } = open(); const snapshot = wallet.snapshot();
    snapshot.createdAt.setFullYear(2000); snapshot.version = 99;
    expect(wallet.createdAt).toEqual(at); expect(wallet.version).toBe(1);
  });
});
