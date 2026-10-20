import { describe, expect, test } from 'bun:test';
import { DataSource } from 'typeorm';
import { WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry';
import { ledgerFromRow, ledgerToRow, transactionFromRow, transactionToRow, walletFromRow, walletToRow } from '../../src/infrastructure/database/financial-mappers';
import { InboxSchema, LedgerSchema, OutboxSchema, TransactionSchema, WalletSchema } from '../../src/infrastructure/database/entities/financial.schemas';
import { at, context, money, open, tx, walletId } from './fixtures';

describe('Ledger', () => {
  const props = { id: 'entry', walletId, transactionId: 'transaction', direction: 'DEBIT' as const,
    money: money('25.00'), balanceBefore: money('100.00'), balanceAfter: money('75.00'), walletVersion: 2, createdAt: at };
  test('lançamento consistente é imutável', () => {
    const entry = WalletLedgerEntry.create(props);
    expect(entry.isBalanced()).toBe(true); expect(Object.isFrozen(entry)).toBe(true);
    entry.createdAt.setFullYear(2000); expect(entry.createdAt).toEqual(at);
    const snapshot = entry.snapshot(); snapshot.balanceAfter = money('999.00');
    expect(entry.balanceAfter.toString()).toBe('75.00');
  });
  test('rejeita aritmética incorreta, negativo, valor zero e moeda conflitante', () => {
    expect(() => WalletLedgerEntry.create({ ...props, balanceAfter: money('76.00') })).toThrow('INVALID_LEDGER');
    expect(() => WalletLedgerEntry.create({ ...props, balanceAfter: money('1.00').negate() })).toThrow('INVALID_LEDGER');
    expect(() => WalletLedgerEntry.create({ ...props, money: money('0.00') })).toThrow('INVALID_LEDGER');
    expect(() => WalletLedgerEntry.create({ ...props, money: money('25.00', 'USD') })).toThrow('CURRENCY_MISMATCH');
  });
});

describe('Mapeamentos TypeORM sem conexão', () => {
  test('wallet e ledger preservam precisão e versão', () => {
    const { wallet, entry } = open('9007199254740993.01');
    const walletRow = walletToRow(wallet);
    expect(typeof walletRow.balance).toBe('string');
    expect(walletFromRow(walletRow).snapshot()).toEqual(wallet.snapshot());
    expect(ledgerFromRow(ledgerToRow(entry!)).snapshot()).toEqual(entry!.snapshot());
  });
  test('transações pendentes e processadas reidratam sem repetir efeitos', () => {
    const { wallet } = open(); const transaction = tx();
    const pending = transactionToRow(transaction);
    expect(pending.resultBalance).toBeNull();
    expect(transactionFromRow(pending).status).toBe('PENDING');
    wallet.apply(transaction, context());
    const rebuilt = transactionFromRow(transactionToRow(transaction));
    expect(rebuilt.snapshot()).toEqual(transaction.snapshot());
    expect(() => wallet.apply(rebuilt, context())).toThrow('INVALID_TRANSACTION_STATE');
  });
  test('rejeição por moeda preserva moeda original e moeda do saldo observado', () => {
    const { wallet } = open(); const transaction = tx({ money: money('25.00', 'USD') });
    wallet.apply(transaction, context()); const row = transactionToRow(transaction);
    expect(row.currency).toBe('USD'); expect(row.resultCurrency).toBe('BRL');
    expect(transactionFromRow(row).snapshot()).toEqual(transaction.snapshot());
  });
  test('valida metadados das cinco entidades sem abrir o banco', async () => {
    class MetadataSource extends DataSource {
      async inspect(): Promise<void> { await this.buildMetadatas(); }
    }
    const source = new MetadataSource({ type: 'postgres',
      entities: [WalletSchema, TransactionSchema, LedgerSchema, InboxSchema, OutboxSchema] });
    await source.inspect();
    expect(source.entityMetadatas).toHaveLength(5);
    expect(source.isInitialized).toBe(false);
    expect(source.getMetadata(WalletSchema).findColumnWithPropertyName('balance')?.type).toBe('numeric');
  });
});
