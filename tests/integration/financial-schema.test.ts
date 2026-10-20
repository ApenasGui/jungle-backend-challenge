import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { DataSource, EntityManager } from 'typeorm';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';
import { WagerTransaction, type TransactionProps } from '../../src/domain/wager-transaction';
import { InboxSchema, LedgerSchema, OutboxSchema, TransactionSchema, WalletSchema, type LedgerRow, type TransactionRow } from '../../src/infrastructure/database/entities/financial.schemas';
import { ledgerToRow, transactionToRow, walletFromRow, walletToRow } from '../../src/infrastructure/database/financial-mappers';
import { createTestDatabase } from './database';

const at = new Date('2026-10-19T12:00:00Z');
const money = (amount: string) => Money.from({ amount, currency: 'BRL' });
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let source: DataSource;

// Estes helpers exercitam domínio e ORM; ainda não são o caso de uso da aplicação.
async function open(balance = '100.00') {
  const result = Wallet.open({ id: crypto.randomUUID(), playerId: crypto.randomUUID(),
    initialBalance: money(balance), at, opening: { transactionId: crypto.randomUUID(),
      ledgerId: crypto.randomUUID(), payloadHash: 'a'.repeat(64) } });
  await source.transaction(async manager => {
    await manager.insert(WalletSchema, walletToRow(result.wallet));
    if (result.transaction) await manager.insert(TransactionSchema, transactionToRow(result.transaction));
    if (result.entry) await manager.insert(LedgerSchema, ledgerToRow(result.entry));
  });
  return result;
}
function transaction(wallet: Wallet, overrides: Partial<TransactionProps> = {}) {
  return WagerTransaction.create({ id: crypto.randomUUID(), providerId: 'provider-a',
    externalTransactionId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(),
    payloadHash: 'b'.repeat(64), walletId: wallet.id, playerId: wallet.playerId,
    roundId: 'round-1', gameId: 'game-1', kind: 'BET', money: money('25.00'), createdAt: at, ...overrides });
}
async function apply(wallet: Wallet, tx: WagerTransaction, reference?: WagerTransaction) {
  const entry = wallet.apply(tx, { at, ledgerId: crypto.randomUUID(), reference });
  await source.transaction(async manager => {
    await manager.insert(TransactionSchema, transactionToRow(tx));
    if (entry) await manager.insert(LedgerSchema, ledgerToRow(entry));
    await manager.update(WalletSchema, wallet.id, walletToRow(wallet));
  });
  return entry;
}
async function sqlFails(work: () => Promise<unknown>, code = '23514', message?: string) {
  let caught: unknown;
  try { await work(); } catch (error) { caught = error; }
  expect(caught).toBeDefined();
  const error = caught as { driverError?: { code: string; message: string }; code?: string; message: string };
  expect(error.driverError?.code ?? error.code).toBe(code);
  if (message) expect(error.driverError?.message ?? error.message).toContain(message);
}
async function writeBet(manager: EntityManager, wallet: Wallet,
  changeLedger: Partial<LedgerRow> = {}, changeTransaction: Partial<TransactionRow> = {}) {
  const tx = transaction(wallet);
  const entry = wallet.apply(tx, { at, ledgerId: crypto.randomUUID() })!;
  await manager.insert(TransactionSchema, { ...transactionToRow(tx), ...changeTransaction });
  await manager.insert(LedgerSchema, { ...ledgerToRow(entry), ...changeLedger });
  await manager.update(WalletSchema, wallet.id, walletToRow(wallet));
  return tx;
}

beforeAll(async () => { database = await createTestDatabase(); source = database.source; }, 30000);
afterAll(async () => { if (database) await database.close(); }, 30000);

// Toda tentativa, aceita ou rejeitada, deve deixar saldo reconstruível pelo ledger.
afterEach(async () => {
  if (!source?.isInitialized) return;
  const inconsistent = await source.query(`
    SELECT w.id FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
    GROUP BY w.id HAVING w.balance <> COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)
      OR w.balance < 0`);
  expect(inconsistent).toEqual([]);
});

describe('Migrations e persistência reais', () => {
  test('migration é registrada, não reaplica e faz down/up em banco isolado', async () => {
    const isolated = await createTestDatabase();
    try {
      expect(await isolated.source.runMigrations()).toHaveLength(0);
      await isolated.source.undoLastMigration({ transaction: 'all' });
      const [row] = await isolated.source.query("SELECT to_regclass('public.wallets') AS table_name");
      expect(row.table_name).toBeNull();
      const functions = await isolated.source.query("SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace");
      expect(functions).toEqual([]);
      expect(await isolated.source.runMigrations({ transaction: 'all' })).toHaveLength(1);
    } finally { await isolated.close(); }
  }, 30000);
  test('abertura positiva grava as três entidades e mantém centavos grandes', async () => {
    const { wallet } = await open('9007199254740993.01');
    const row = await source.getRepository(WalletSchema).findOneByOrFail({ id: wallet.id });
    expect(row.balance).toBe('9007199254740993.01');
    expect(walletFromRow(row).balance.equals(wallet.balance)).toBe(true);
    expect(await source.getRepository(LedgerSchema).countBy({ walletId: wallet.id })).toBe(1);
  });
  test('abertura zero não exige ledger', async () => {
    const { wallet } = await open('0.00');
    expect(await source.getRepository(LedgerSchema).countBy({ walletId: wallet.id })).toBe(0);
  });
  test('BET, WIN, LOSS, REFUND e ROLLBACK preservam a cadeia', async () => {
    const { wallet } = await open();
    const bet = transaction(wallet); await apply(wallet, bet);
    const refund = transaction(wallet, { kind: 'REFUND', referenceExternalTransactionId: bet.externalTransactionId });
    await apply(wallet, refund, bet);
    const rollback = transaction(wallet, { kind: 'ROLLBACK', referenceExternalTransactionId: refund.externalTransactionId });
    await apply(wallet, rollback, refund);
    await apply(wallet, transaction(wallet, { kind: 'WIN' }));
    await apply(wallet, transaction(wallet, { kind: 'LOSS', money: money('0.00') }));
    const row = await source.getRepository(WalletSchema).findOneByOrFail({ id: wallet.id });
    expect(row.balance).toBe('100.00'); expect(row.version).toBe(5);
    expect(await source.getRepository(LedgerSchema).countBy({ walletId: wallet.id })).toBe(5);
  });
  test('wallet duplicada por jogador/moeda falha no banco', async () => {
    const { wallet } = await open('0.00');
    await sqlFails(() => source.manager.insert(WalletSchema, { ...walletToRow(wallet), id: crypto.randomUUID() }), '23505');
  });
  test.each(['idempotencyKey', 'externalTransactionId'] as const)('unicidade de %s é persistente', async field => {
    const { wallet } = await open(); const first = transaction(wallet);
    await source.manager.insert(TransactionSchema, transactionToRow(first));
    const duplicate = transaction(wallet, { [field]: first[field] });
    await sqlFails(() => source.manager.insert(TransactionSchema, transactionToRow(duplicate)), '23505');
  });
  test('mesmo ID externo é aceito para provedores diferentes', async () => {
    const { wallet } = await open(); const first = transaction(wallet);
    await source.manager.insert(TransactionSchema, transactionToRow(first));
    const other = transaction(wallet, { providerId: 'provider-b', externalTransactionId: first.externalTransactionId });
    await source.manager.insert(TransactionSchema, transactionToRow(other));
  });
});

describe('Constraints e triggers contra escritas inválidas', () => {
  test.each(['-0.01', 'NaN', 'Infinity'])('saldo inválido %s é recusado', async balance => {
    const { wallet } = await open();
    await sqlFails(() => source.query('UPDATE wallets SET balance = $1 WHERE id = $2', [balance, wallet.id]),
      balance === 'Infinity' ? '22003' : '23514');
  });
  test('alterar saldo sem ledger falha no commit', async () => {
    const { wallet } = await open();
    await sqlFails(() => source.transaction(async manager => {
      await manager.query('UPDATE wallets SET balance = 101 WHERE id = $1', [wallet.id]);
    }), '23514', 'wallet and ledger disagree');
  });
  test('abertura positiva sem lançamento falha', async () => {
    const result = Wallet.open({ id: crypto.randomUUID(), playerId: crypto.randomUUID(), initialBalance: money('0.00'), at });
    await sqlFails(() => source.manager.insert(WalletSchema, { ...walletToRow(result.wallet), balance: '10.00' }));
  });
  test('identidade da wallet é imutável', async () => {
    const { wallet } = await open();
    await sqlFails(() => source.query('UPDATE wallets SET player_id = $1 WHERE id = $2', [crypto.randomUUID(), wallet.id]));
  });
  test.each(['UPDATE wallet_ledger_entries SET amount = amount', 'DELETE FROM wallet_ledger_entries',
    'TRUNCATE wallet_ledger_entries'])('ledger bloqueia %s', async sql => {
    await open(); await sqlFails(() => source.query(sql), '23514', 'ledger is append-only');
  });
  test.each([
    ['aritmética incorreta', { balanceAfter: '74.00' }],
    ['cadeia com saldo inicial divergente', { balanceBefore: '99.00', balanceAfter: '74.00' }],
    ['versão fora de sequência', { walletVersion: 9 }],
  ] as const)('ledger rejeita %s', async (_name, override) => {
    const { wallet } = await open();
    await sqlFails(() => source.transaction(manager => writeBet(manager, wallet, override)));
  });
  test('moeda divergente é bloqueada por chave estrangeira composta', async () => {
    const { wallet } = await open();
    await sqlFails(() => source.transaction(manager => writeBet(manager, wallet, { currency: 'USD' })), '23503');
  });
  test('transação processada exige ledger', async () => {
    const { wallet } = await open(); const tx = transaction(wallet);
    tx.markProcessed(undefined, at, money('75.00'));
    await sqlFails(() => source.manager.insert(TransactionSchema, transactionToRow(tx)), '23514', 'transaction without matching ledger');
  });
  test('transação pendente não pode ter ledger', async () => {
    const { wallet } = await open();
    await sqlFails(() => source.transaction(manager => writeBet(manager, wallet, {}, {
      status: 'PENDING', processedAt: null, resultBalance: null, resultCurrency: null,
    })), '23514', 'unprocessed transaction cannot have ledger');
  });
  test('direção de BET deve ser débito mesmo com aritmética correta', async () => {
    const { wallet } = await open();
    await sqlFails(() => source.transaction(async manager => {
      const tx = transaction(wallet); tx.markProcessed(undefined, at, money('125.00'));
      await manager.insert(TransactionSchema, transactionToRow(tx));
      await manager.insert(LedgerSchema, { id: crypto.randomUUID(), walletId: wallet.id, transactionId: tx.id,
        direction: 'CREDIT', amount: '25.00', currency: 'BRL', balanceBefore: '100.00', balanceAfter: '125.00', walletVersion: 2, createdAt: at });
      await manager.update(WalletSchema, wallet.id, { balance: '125.00', version: 2 });
    }), '23514', 'transaction without matching ledger');
  });
  test('saldo de replay precisa coincidir com o lançamento', async () => {
    const { wallet } = await open();
    await sqlFails(() => source.transaction(manager => writeBet(manager, wallet, {}, { resultBalance: '99.00' })));
  });
  test('a mesma transação não pode gerar outro lançamento', async () => {
    const { wallet } = await open(); const tx = transaction(wallet);
    const entry = await apply(wallet, tx);
    await sqlFails(() => source.transaction(async manager => {
      await manager.insert(LedgerSchema, { ...ledgerToRow(entry!), id: crypto.randomUUID(),
        balanceBefore: '75.00', balanceAfter: '50.00', walletVersion: 3 });
      await manager.update(WalletSchema, wallet.id, { balance: '50.00', version: 3 });
    }), '23505');
  });
  test('LOSS não pode gerar lançamento mesmo com saldo coerente', async () => {
    const { wallet } = await open(); const loss = transaction(wallet, { kind: 'LOSS', money: money('0.00') });
    loss.markProcessed(undefined, at, money('75.00'));
    await sqlFails(() => source.transaction(async manager => {
      await manager.insert(TransactionSchema, transactionToRow(loss));
      await manager.insert(LedgerSchema, { id: crypto.randomUUID(), walletId: wallet.id, transactionId: loss.id,
        direction: 'DEBIT', amount: '25.00', currency: 'BRL', balanceBefore: '100.00', balanceAfter: '75.00', walletVersion: 2, createdAt: at });
      await manager.update(WalletSchema, wallet.id, { balance: '75.00', version: 2 });
    }), '23514', 'LOSS cannot have ledger');
  });
  test('payload pendente e transação terminal não podem ser alterados', async () => {
    const { wallet, transaction: opening } = await open();
    const pending = transaction(wallet); await source.manager.insert(TransactionSchema, transactionToRow(pending));
    await sqlFails(() => source.query('UPDATE wager_transactions SET amount = 26 WHERE id = $1', [pending.id]));
    await sqlFails(() => source.query('UPDATE wager_transactions SET status = status WHERE id = $1', [opening!.id]));
    await sqlFails(() => source.query('DELETE FROM wager_transactions WHERE id = $1', [opening!.id]));
  });
  test('reversões duplicadas do mesmo tipo ou tipos diferentes são bloqueadas', async () => {
    const { wallet } = await open(); const bet = transaction(wallet); await apply(wallet, bet);
    const refund = transaction(wallet, { kind: 'REFUND', referenceExternalTransactionId: bet.externalTransactionId });
    await apply(wallet, refund, bet);
    for (const kind of ['REFUND', 'ROLLBACK'] as const) {
      const row = await source.getRepository(WalletSchema).findOneByOrFail({ id: wallet.id });
      const duplicate = transaction(wallet, { kind, referenceExternalTransactionId: bet.externalTransactionId });
      await sqlFails(() => apply(walletFromRow(row), duplicate, bet), '23505');
    }
  });
  test('referência de outra rodada é rejeitada mesmo sem validação do domínio', async () => {
    const { wallet } = await open(); const bet = transaction(wallet); await apply(wallet, bet);
    const refund = transaction(wallet, { kind: 'REFUND', referenceExternalTransactionId: bet.externalTransactionId });
    const entry = wallet.apply(refund, { at, ledgerId: crypto.randomUUID(), reference: bet })!;
    await sqlFails(() => source.transaction(async manager => {
      await manager.insert(TransactionSchema, { ...transactionToRow(refund), roundId: 'other-round' });
      await manager.insert(LedgerSchema, ledgerToRow(entry));
      await manager.update(WalletSchema, wallet.id, walletToRow(wallet));
    }), '23514', 'invalid processed reference');
  });
});

describe('Atomicidade SQL', () => {
  test.each(['success', 'before_commit', 'deferred_constraint'] as const)('atomicidade de todas as tabelas: %s', async scenario => {
    const fail = scenario !== 'success';
    const { wallet } = await open(); const messageId = crypto.randomUUID(); const eventId = crypto.randomUUID();
    let txId: string | undefined;
    const work = () => source.transaction(async manager => {
      txId = (await writeBet(manager, wallet)).id;
      await manager.insert(InboxSchema, { consumerName: 'test', messageId, payloadHash: 'c'.repeat(64), receivedAt: at, processedAt: at });
      await manager.insert(OutboxSchema, { id: eventId, aggregateId: wallet.id, eventType: 'WagerTransactionProcessed',
        payload: { transactionId: txId }, occurredAt: at, attempts: 0, nextAttemptAt: at, publishedAt: null });
      if (scenario === 'before_commit') throw new Error('simulated failure before commit');
      if (scenario === 'deferred_constraint') await manager.update(WalletSchema, wallet.id, { balance: '76.00' });
    });
    if (scenario === 'before_commit') await expect(work()).rejects.toThrow('simulated failure');
    else if (scenario === 'deferred_constraint') await sqlFails(work, '23514', 'wallet and ledger disagree');
    else await work();
    const row = await source.getRepository(WalletSchema).findOneByOrFail({ id: wallet.id });
    expect(row.balance).toBe(fail ? '100.00' : '75.00');
    expect(await source.getRepository(TransactionSchema).countBy({ id: txId! })).toBe(fail ? 0 : 1);
    expect(await source.getRepository(LedgerSchema).countBy({ walletId: wallet.id })).toBe(fail ? 1 : 2);
    expect(await source.getRepository(InboxSchema).countBy({ messageId })).toBe(fail ? 0 : 1);
    expect(await source.getRepository(OutboxSchema).countBy({ id: eventId })).toBe(fail ? 0 : 1);
  });
  test('inbox permite outros consumidores, mas bloqueia duplicata no mesmo consumidor', async () => {
    const row = { consumerName: 'a', messageId: crypto.randomUUID(), payloadHash: 'c'.repeat(64), receivedAt: at, processedAt: at };
    await source.manager.insert(InboxSchema, row);
    await sqlFails(() => source.manager.insert(InboxSchema, row), '23505');
    await source.manager.insert(InboxSchema, { ...row, consumerName: 'b' });
  });
});
