import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { InboxSchema, LedgerSchema, OutboxSchema, TransactionSchema, WalletSchema } from '../../src/infrastructure/database/entities/financial.schemas';
import { InitialFinancialSchema1792440000000 } from '../../src/infrastructure/database/migrations/1792440000000-InitialFinancialSchema';

// Cada execução cria seu próprio banco; a limpeza nunca aponta para wagering.
export async function createTestDatabase() {
  const adminUrl = new URL(process.env.TEST_DATABASE_ADMIN_URL
    ?? 'postgresql://wagering:wagering_local@127.0.0.1:55432/postgres');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(adminUrl.hostname)) {
    throw new Error('Os testes de banco exigem PostgreSQL local.');
  }
  const name = `wagering_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = new Client({ connectionString: adminUrl.toString(), connectionTimeoutMillis: 5000 });
  await admin.connect();
  let created = false;
  const testUrl = new URL(adminUrl);
  testUrl.pathname = `/${name}`;
  const source = new DataSource({ type: 'postgres', url: testUrl.toString(),
    entities: [WalletSchema, TransactionSchema, LedgerSchema, InboxSchema, OutboxSchema],
    migrations: [InitialFinancialSchema1792440000000], synchronize: false,
    extra: { connectionTimeoutMillis: 5000, statement_timeout: 10000 } });

  async function close(): Promise<void> {
    try {
      if (source.isInitialized) await source.destroy();
      if (created) {
        await admin.query(`DROP DATABASE "${name}"`);
        created = false;
      }
    } finally { await admin.end(); }
  }
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    await source.initialize();
    await source.runMigrations({ transaction: 'all' });
    return { source, close, url: testUrl.toString() };
  } catch (error) {
    await close();
    throw error;
  }
}
