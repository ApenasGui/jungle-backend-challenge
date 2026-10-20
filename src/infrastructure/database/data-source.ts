import 'reflect-metadata';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { InboxSchema, LedgerSchema, OutboxSchema, TransactionSchema, WalletSchema } from './entities/financial.schemas';

// Cria a configuração sem abrir conexão ou alterar o schema automaticamente.
export function createDataSource(): DataSource {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL precisa estar definida.');

  return new DataSource({
    type: 'postgres',
    url,
    entities: [WalletSchema, TransactionSchema, LedgerSchema, InboxSchema, OutboxSchema],
    migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
    synchronize: false,
    migrationsRun: false,
    logging: false,
    extra: { connectionTimeoutMillis: 5000, statement_timeout: 10000 },
  });
}
