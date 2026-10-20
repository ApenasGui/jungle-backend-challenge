import { DataSource, EntityManager, In, MoreThan } from 'typeorm';
import { ApplicationError } from '../../application/application-error';
import type { FinancialSession, FinancialStore } from '../../application/financial-store';
import type { IntegrationEvent } from '../../application/integration-events';
import { Wallet } from '../../domain/wallet';
import { WagerTransaction } from '../../domain/wager-transaction';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { InboxMessage } from '../../domain/inbox-message';
import { InboxSchema, LedgerSchema, OutboxSchema, TransactionSchema, WalletSchema } from './entities/financial.schemas';
import { ledgerFromRow, ledgerToRow, transactionFromRow, transactionToRow, walletFromRow, walletToRow } from './financial-mappers';

function sqlCode(error: unknown): string | undefined {
  const value = error as { code?: string; driverError?: { code?: string } };
  return value?.driverError?.code ?? value?.code;
}

export class TypeOrmFinancialStore implements FinancialStore {
  constructor(private readonly source: DataSource) {}

  // Só repete transações abortadas pelo PostgreSQL; resultado de commit incerto não é repetido aqui.
  async transaction<T>(work: (session: FinancialSession) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        if (!this.source.isInitialized) throw new ApplicationError('SERVICE_UNAVAILABLE');
        return await this.source.transaction('READ COMMITTED', async manager => {
          await manager.query("SET LOCAL lock_timeout = '3s'");
          await manager.query("SET LOCAL statement_timeout = '10s'");
          return work(new TypeOrmFinancialSession(manager));
        });
      } catch (error) {
        const code = sqlCode(error);
        if (['40001', '40P01', '55P03'].includes(code ?? '') && attempt < 2) {
          await Bun.sleep(20 * (attempt + 1));
          continue;
        }
        if (code === '23505') throw new ApplicationError('CONFLICT');
        const message = error instanceof Error ? error.message : '';
        if (['40001', '40P01', '55P03', '57014', '57P01', '57P02', '57P03',
          'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT'].includes(code ?? '') || code?.startsWith('08')) {
          throw new ApplicationError('SERVICE_UNAVAILABLE');
        }
        if (['Connection terminated unexpectedly', 'Connection terminated',
          'timeout exceeded when trying to connect'].includes(message)) throw new ApplicationError('SERVICE_UNAVAILABLE');
        throw error;
      }
    }
  }
}

class TypeOrmFinancialSession implements FinancialSession {
  constructor(private readonly manager: EntityManager) {}
  async receiveInbox(consumer: string, messageId: string, hash: string) {
    await this.manager.query(`INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
      VALUES ($1,$2,$3,now()) ON CONFLICT (consumer_name,message_id) DO NOTHING`, [consumer, messageId, hash]);
    const row = await this.manager.findOneOrFail(InboxSchema, { where: { consumerName: consumer, messageId },
      lock: { mode: 'pessimistic_write' } });
    if (!InboxMessage.rehydrate(row).matches(hash)) throw new ApplicationError('CONFLICT', 'INBOX_PAYLOAD_CONFLICT');
  }
  async finishInbox(consumer: string, messageId: string) {
    await this.manager.query(`UPDATE inbox_messages SET processed_at=COALESCE(processed_at,now())
      WHERE consumer_name=$1 AND message_id=$2`, [consumer, messageId]);
  }
  async referenceSchedule(id: string) {
    const row = await this.manager.findOneByOrFail(TransactionSchema, { id });
    return { attempts: row.referenceAttempts, nextAt: row.nextReferenceAttemptAt, expiresAt: row.referenceExpiresAt };
  }
  async updateTransaction(tx: WagerTransaction, attempts: number, nextAt: Date | null, expiresAt: Date | null) {
    const row = transactionToRow(tx, { referenceAttempts: attempts, nextReferenceAttemptAt: nextAt, referenceExpiresAt: expiresAt });
    await this.manager.update(TransactionSchema, tx.id, row);
  }
  async findWallet(id: string, lock = false) {
    const row = await this.manager.findOne(WalletSchema, { where: { id },
      lock: lock ? { mode: 'pessimistic_write' } : undefined });
    return row ? walletFromRow(row) : null;
  }
  async insertWallet(wallet: Wallet) { await this.manager.insert(WalletSchema, walletToRow(wallet)); }
  async updateWallet(wallet: Wallet) { await this.manager.update(WalletSchema, wallet.id, walletToRow(wallet)); }
  async byKey(idempotencyKey: string) {
    const row = await this.manager.findOneBy(TransactionSchema, { idempotencyKey });
    return row ? transactionFromRow(row) : null;
  }
  async byExternal(providerId: string, externalTransactionId: string) {
    const row = await this.manager.findOneBy(TransactionSchema, { providerId, externalTransactionId });
    return row ? transactionFromRow(row) : null;
  }
  async byId(id: string) {
    const row = await this.manager.findOneBy(TransactionSchema, { id });
    return row ? transactionFromRow(row) : null;
  }
  async insertTransaction(tx: WagerTransaction) {
    const pending = tx.status === 'PENDING_REFERENCE';
    await this.manager.insert(TransactionSchema, transactionToRow(tx, {
      referenceAttempts: 0,
      nextReferenceAttemptAt: pending ? new Date(Date.now() + 1000) : null,
      referenceExpiresAt: pending ? new Date(Date.now() + 24 * 60 * 60 * 1000) : null,
    }));
  }
  async hasReversal(referenceTransactionId: string) {
    return this.manager.existsBy(TransactionSchema, { referenceTransactionId,
      status: 'PROCESSED', kind: In(['REFUND', 'ROLLBACK']) });
  }
  async insertLedger(entry: WalletLedgerEntry) { await this.manager.insert(LedgerSchema, ledgerToRow(entry)); }
  async enqueue(event: IntegrationEvent) {
    await this.manager.save(OutboxSchema, { id: event.eventId, aggregateId: event.aggregateId,
      eventType: event.eventType, payload: event.toJSON(), occurredAt: event.occurredAt,
      attempts: 0, nextAttemptAt: event.occurredAt, publishedAt: null });
  }
  async ledger(walletId: string, version: number, limit: number) {
    const rows = await this.manager.find(LedgerSchema, { where: { walletId, walletVersion: MoreThan(version) },
      order: { walletVersion: 'ASC' }, take: limit });
    return rows.map(ledgerFromRow);
  }
  async reconcile(walletId: string) {
    const [row] = await this.manager.query(`SELECT
      COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::numeric(20,2)::text AS amount,
      COUNT(*)::text AS count FROM wallet_ledger_entries WHERE wallet_id = $1`, [walletId]);
    return { amount: row.amount as string, count: Number(row.count) };
  }
}
