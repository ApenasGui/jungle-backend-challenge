import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { createApplication } from '../../src/bootstrap';
import { Operations } from '../../src/infrastructure/observability/operations';
import { WorkerMetrics } from '../../src/infrastructure/messaging/worker-metrics';
import { TypeOrmFinancialStore } from '../../src/infrastructure/database/typeorm-financial-store';
import { FinancialService } from '../../src/application/financial-service';
import { createTestDatabase } from './database';
import { createTestQueues } from './queue-fixture';

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let queues: Awaited<ReturnType<typeof createTestQueues>>;
let metrics: WorkerMetrics;
let operations: Operations;
let app: INestApplication | undefined;
beforeEach(async () => {
  db = await createTestDatabase(); queues = await createTestQueues();
  metrics = new WorkerMetrics(); operations = new Operations(db.source, queues.client, queues.config, metrics);
});
afterEach(async () => {
  try {
    if (db.source.isInitialized) expect(await db.source.query(`SELECT w.id FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id=w.id
      GROUP BY w.id HAVING w.balance < 0 OR w.balance <> COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END),0)`)).toEqual([]);
  } finally {
    if (app) { await app.close(); app = undefined; }
    await queues.close(); await db.close();
  }
});

test('readiness verifica banco e filas sem consumir mensagens', async () => {
  await queues.send({ probe: 'preserved' });
  expect(await operations.ready()).toEqual({ status: 'ready', checks: { postgres: true, sqs: true, accepting: true } });
  expect(await queues.count(queues.config.inputUrl)).toBe(1);
});
test('readiness detecta fila ausente e sinaliza shutdown', async () => {
  const broken = new Operations(db.source, queues.client,
    { ...queues.config, eventsUrl: `${queues.config.eventsUrl}-missing` }, metrics);
  expect((await broken.ready()).checks.sqs).toBe(false);
  operations.stop();
  expect((await operations.ready()).status).toBe('not_ready');
});
test('readiness e coleta sinalizam banco indisponível sem expor credenciais', async () => {
  await db.source.destroy();
  const result = await operations.ready();
  expect(result.status).toBe('not_ready'); expect(result.checks.postgres).toBe(false);
  expect(JSON.stringify(result)).not.toContain('postgresql');
  expect(await operations.collect()).toContain('wagering_outbox_collection_success 0');
});
test('outbox lag usa evento pendente mais antigo e zera ao drenar', async () => {
  const service = new FinancialService(new TypeOrmFinancialStore(db.source), { reconciliationMismatch() {} });
  await service.createWallet({ playerId: crypto.randomUUID(), initialBalance: { amount: '10.00', currency: 'BRL' } },
    { correlationId: 'lag-test' });
  await db.source.query("UPDATE outbox_messages SET occurred_at=now()-interval '120 seconds'");
  const report = await operations.collect();
  expect(report).toContain('wagering_outbox_pending 2');
  expect(report).toContain('wagering_transactions_current{status="PROCESSED"} 1');
  expect(Number(report.match(/wagering_outbox_lag_seconds (\S+)/)?.[1])).toBeGreaterThanOrEqual(120);
  await db.source.query('UPDATE outbox_messages SET published_at=now()');
  expect(await operations.collect()).toContain('wagering_outbox_lag_seconds 0');
});
test('API responde readiness 200 e mantém liveness quando o banco cai', async () => {
  app = await createApplication(db.source, true); await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  expect((await fetch(`${base}/health/ready`)).status).toBe(200);
  await db.source.destroy();
  expect((await fetch(`${base}/health/ready`)).status).toBe(503);
  expect((await fetch(`${base}/health/live`)).status).toBe(200);
});
test('HTTP correlaciona logs e eventos sem vazar dinheiro ou chave de idempotência', async () => {
  app = await createApplication(db.source, true); await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const service = app.get(FinancialService);
  const owner = await service.createWallet({ playerId: crypto.randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } },
    { correlationId: 'opening' });
  const input = { walletId: owner.id, playerId: owner.playerId, providerId: 'provider-a',
    externalTransactionId: 'external-1', roundId: 'round', gameId: 'game', kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' } };
  const log = spyOn(console, 'log').mockImplementation(() => {});
  try {
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${base}/wagering/transactions`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'secret-key', 'x-correlation-id': 'trace:123' },
        body: JSON.stringify(input) });
      expect(response.status).toBe(200); expect(response.headers.get('x-correlation-id')).toBe('trace:123');
      await response.json();
    }
    const report = await (await fetch(`${base}/metrics`)).text();
    expect(report).toContain('wagering_transactions_processed_total 1');
    expect(report).toContain('wagering_duplicates_total 1');
    expect(report).toContain('wagering_processing_duration_seconds_count 2');
    expect(report).toContain('wagering_processing_duration_seconds_bucket{le="+Inf"} 2');
    const logs = log.mock.calls.map(args => String(args[0])).join('\n');
    expect(logs).toContain('"correlationId":"trace:123"');
    expect(logs).toContain('"transactionId":'); expect(logs).toContain(owner.id);
    expect(logs).not.toContain('25.00'); expect(logs).not.toContain('secret-key');
    const events = await db.source.query("SELECT payload FROM outbox_messages WHERE payload->>'correlationId'='trace:123'");
    expect(events).toHaveLength(2);
  } finally { log.mockRestore(); }
});
test('conflito real de lock incrementa contador e retry antes de recuperar', async () => {
  const store = new TypeOrmFinancialStore(db.source, metrics);
  const service = new FinancialService(store, { reconciliationMismatch() {} });
  const owner = await service.createWallet({ playerId: crypto.randomUUID(), initialBalance: { amount: '0.00', currency: 'BRL' } },
    { correlationId: 'lock' });
  const runner = db.source.createQueryRunner(); await runner.connect(); await runner.startTransaction();
  await runner.query('SELECT id FROM wallets WHERE id=$1 FOR UPDATE', [owner.id]);
  const reading = store.transaction(session => session.findWallet(owner.id, true));
  try {
    await Bun.sleep(3200); await runner.commitTransaction(); await reading;
    expect(metrics.render()).toContain('wagering_lock_conflicts_total 1');
    expect(metrics.render()).toContain('wagering_retries_total 1');
  } finally {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    await runner.release(); await reading.catch(() => {});
  }
});

test('reconciliação detecta divergência, gera métrica e não corrige o saldo silenciosamente', async () => {
  app = await createApplication(db.source, true); await app.listen(0, '127.0.0.1');
  const base = await app.getUrl(); const service = app.get(FinancialService);
  const owner = await service.createWallet({ playerId: crypto.randomUUID(),
    initialBalance: { amount: '100.00', currency: 'BRL' } }, { correlationId: 'opening' });
  const log = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    // Corrupção simulada somente no banco descartável; o trigger volta antes da consulta.
    await db.source.query('ALTER TABLE wallets DISABLE TRIGGER wallet_matches_ledger');
    try { await db.source.query('UPDATE wallets SET balance=99.00 WHERE id=$1', [owner.id]); }
    finally { await db.source.query('ALTER TABLE wallets ENABLE TRIGGER wallet_matches_ledger'); }
    const response = await fetch(`${base}/wallets/${owner.id}/reconciliation`, { method: 'POST',
      headers: { 'x-correlation-id': 'drift-test' } });
    expect(response.status).toBe(200);
    const result = await response.json() as { consistent: boolean; difference: { amount: string } };
    expect(result.consistent).toBe(false); expect(result.difference.amount).toBe('-1.00');
    expect((await service.getWallet(owner.id)).balance.amount).toBe('99.00');
    expect(await (await fetch(`${base}/metrics`)).text()).toContain('wagering_reconciliation_mismatches_total 1');
    expect(log.mock.calls.map(args => String(args[0])).join('')).toContain('"correlationId":"drift-test"');
  } finally {
    log.mockRestore();
    await db.source.query('UPDATE wallets SET balance=100.00 WHERE id=$1', [owner.id]);
  }
});
