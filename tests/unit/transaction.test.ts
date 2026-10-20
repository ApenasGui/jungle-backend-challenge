import { describe, expect, test } from 'bun:test';
import { WagerTransaction, type TransactionProps } from '../../src/domain/wager-transaction';
import { hashTransactionPayload, type TransactionPayload } from '../../src/application/transaction-payload';
import { at, money, tx, hash } from './fixtures';

describe('WagerTransaction', () => {
  test.each(['PROCESSED', 'REJECTED', 'FAILED'] as const)('%s é terminal, inclusive após reidratação', status => {
    const transaction = tx();
    if (status === 'PROCESSED') transaction.markProcessed(undefined, at, money('75.00'));
    if (status === 'REJECTED') transaction.reject('INSUFFICIENT_FUNDS', at, money('0.00'));
    if (status === 'FAILED') transaction.fail('INFRASTRUCTURE_FAILURE', at);
    const rebuilt = WagerTransaction.rehydrate(transaction.snapshot());
    expect(rebuilt.status).toBe(status);
    expect(rebuilt.isTerminal()).toBe(true);
    expect(() => rebuilt.markProcessed(undefined, at, money('0.00'))).toThrow('INVALID_TRANSACTION_STATE');
    expect(() => rebuilt.reject('INSUFFICIENT_FUNDS', at)).toThrow('INVALID_TRANSACTION_STATE');
    expect(() => rebuilt.fail('INFRASTRUCTURE_FAILURE', at)).toThrow('INVALID_TRANSACTION_STATE');
    expect(() => rebuilt.markPendingReference()).toThrow('INVALID_TRANSACTION_STATE');
  });
  test('pendente pode terminar por expiração da referência', () => {
    const transaction = tx({ kind: 'REFUND', referenceExternalTransactionId: 'missing' });
    transaction.markPendingReference(); transaction.markPendingReference();
    transaction.reject('REFERENCE_NOT_FOUND', at);
    expect(transaction.status).toBe('REJECTED');
    expect(transaction.failureCode).toBe('REFERENCE_NOT_FOUND');
  });
  test('não permite resultado processado sem resolver a referência', () => {
    const transaction = tx({ kind: 'REFUND', referenceExternalTransactionId: 'missing' });
    expect(() => transaction.markProcessed(undefined, at, money('100.00'))).toThrow('INVALID_TRANSACTION_STATE');
    expect(transaction.status).toBe('PENDING');
    expect(() => tx().markPendingReference()).toThrow('INVALID_TRANSACTION_STATE');
  });
  test.each([
    { kind: 'OPENING' }, { kind: 'INVALID' }, { kind: 'REFUND' }, { kind: 'ROLLBACK' },
    { kind: 'LOSS', money: money('1.00') }, { kind: 'BET', money: money('0.00') },
    { kind: 'BET', money: money('1.00').negate() }, { providerId: '' }, { payloadHash: 'bad' },
    { referenceExternalTransactionId: 'bet-reference' },
    { kind: 'WIN', externalTransactionId: 'self', referenceExternalTransactionId: 'self' },
  ])('rejeita contrato inválido %#', overrides => {
    expect(() => tx(overrides as Partial<TransactionProps>)).toThrow('INVALID_TRANSACTION');
  });
  test('protege datas de criação e processamento', () => {
    const created = new Date(at); const transaction = tx({ createdAt: created });
    created.setFullYear(2000);
    const processed = new Date(at); transaction.markProcessed(undefined, processed, money('75.00'));
    processed.setFullYear(2000); transaction.processedAt?.setFullYear(2001);
    expect(transaction.createdAt).toEqual(at); expect(transaction.processedAt).toEqual(at);
  });
});

describe('Hash e conflito de idempotência', () => {
  const payload: TransactionPayload = { providerId: 'p', externalTransactionId: 'ext', walletId: 'w',
    playerId: 'player', gameId: 'game', roundId: 'round', kind: 'BET', money: { amount: '25.00', currency: 'BRL' } };
  test('ordem de chaves e metadados de transporte não alteram o hash', () => {
    const reordered = { ...Object.fromEntries(Object.entries(payload).reverse()),
      money: { currency: 'BRL', amount: '25.00' }, messageId: 'transport', idempotencyKey: 'header' } as unknown as TransactionPayload;
    expect(hashTransactionPayload(payload)).toBe(hashTransactionPayload(reordered));
    expect(hashTransactionPayload({ ...payload, referenceExternalTransactionId: undefined })).toBe(hashTransactionPayload(payload));
  });
  test.each(['providerId', 'externalTransactionId', 'walletId', 'playerId', 'gameId', 'roundId'] as const)
    ('alterar %s altera o hash', field => {
      expect(hashTransactionPayload({ ...payload, [field]: 'changed' })).not.toBe(hashTransactionPayload(payload));
    });
  test('mudanças de valor, moeda, kind e referência são detectadas', () => {
    const original = hashTransactionPayload(payload);
    for (const changed of [
      { ...payload, money: { ...payload.money, amount: '26.00' } },
      { ...payload, money: { ...payload.money, currency: 'USD' } },
      { ...payload, kind: 'WIN' as const }, { ...payload, referenceExternalTransactionId: 'ref' },
    ]) expect(hashTransactionPayload(changed)).not.toBe(original);
  });
  test('mesma chave e payload diferente falham sem alterar o resultado existente', () => {
    const transaction = tx(); transaction.markProcessed(undefined, at, money('75.00'));
    expect(() => transaction.assertPayload(hash)).not.toThrow();
    expect(() => transaction.assertPayload('b'.repeat(64))).toThrow('IDEMPOTENCY_CONFLICT');
    expect(transaction.resultBalance?.toString()).toBe('75.00');
  });
});
