import { createDataSource } from '../src/infrastructure/database/data-source';

// Executa ou reverte migrations somente mediante comando explícito.
async function migrate(): Promise<void> {
  const action = process.argv[2];
  if (action !== 'run' && action !== 'revert') {
    throw new Error('Use: bun scripts/migrate.ts run|revert');
  }
  const source = createDataSource();
  await source.initialize();
  try {
    if (action === 'run') await source.runMigrations({ transaction: 'all' });
    else await source.undoLastMigration({ transaction: 'all' });
  } finally {
    await source.destroy();
  }
}

void migrate().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
