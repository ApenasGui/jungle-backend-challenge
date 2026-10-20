import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { createApplication } from '../../src/bootstrap';
import { createTestDatabase } from './database';
import { OutboxSchema, TransactionSchema } from '../../src/infrastructure/database/entities/financial.schemas';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let app: INestApplication;
let base: string;
async function request(path: string, body?: unknown, key?: string) {
  const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}
async function wallet(amount = '100.00') {
  const result = await request('/wallets', { playerId: crypto.randomUUID(), initialBalance: { amount, currency: 'BRL' } });
  expect(result.status).toBe(201);
  return result.body as { id: string; playerId: string };
}
function payload(owner: { id: string; playerId: string }, overrides: Record<string, unknown> = {}) {
  return { providerId: 'provider-a', externalTransactionId: crypto.randomUUID(), walletId: owner.id,
    playerId: owner.playerId, roundId: 'round', gameId: 'game', kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' }, ...overrides };
}
beforeAll(async () => {
  database = await createTestDatabase();
  app = await createApplication(database.source, true);
  await app.listen(0, '127.0.0.1'); base = await app.getUrl();
}, 30000);
afterAll(async () => { if (app) await app.close(); if (database) await database.close(); }, 30000);
afterEach(async () => {
  if (!database?.source.isInitialized) return;
  expect(await database.source.query(`SELECT w.id FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id=w.id
    GROUP BY w.id HAVING w.balance <> COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END),0)`)).toEqual([]);
});

describe('API financeira com PostgreSQL real', () => {
  test('corpo acima do limite retorna 413 sem criar transação', async () => {
    const before = await database.source.getRepository(TransactionSchema).count();
    const response = await fetch(`${base}/wagering/transactions`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ padding: 'x'.repeat(110000) }) });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ statusCode: 413, code: 'PAYLOAD_TOO_LARGE' });
    expect(await database.source.getRepository(TransactionSchema).count()).toBe(before);
  });
  test('cria, consulta e reconcilia wallet com abertura auditável', async () => {
    const owner = await wallet();
    const result = await request(`/wallets/${owner.id}`);
    expect(result.status).toBe(200); expect(result.body.balance.amount).toBe('100.00');
    const ledger = await request(`/wallets/${owner.id}/ledger`);
    expect(ledger.body.items).toHaveLength(1); expect(ledger.body.items[0].direction).toBe('CREDIT');
    const reconciliation = await request(`/wallets/${owner.id}/reconciliation`, {});
    expect(reconciliation.status).toBe(200); expect(reconciliation.body.consistent).toBe(true);
    expect(reconciliation.body.checkedEntries).toBe(1); expect(reconciliation.body.difference.amount).toBe('0.00');
    const events = await database.source.getRepository(OutboxSchema).findBy({ aggregateId: owner.id });
    expect(events.map(event => event.eventType).sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(events.every(event => event.publishedAt === null)).toBe(true);
  });
  test('wallet duplicada retorna conflito', async () => {
    const owner = await wallet();
    expect((await request('/wallets', { playerId: owner.playerId, initialBalance: { amount: '0.00', currency: 'BRL' } })).status).toBe(409);
  });
  test.each([
    null, [], {}, { playerId: 'invalid', initialBalance: { amount: '1.00', currency: 'BRL' } },
    { playerId: crypto.randomUUID(), initialBalance: { amount: 10, currency: 'BRL' } },
    { playerId: crypto.randomUUID(), initialBalance: { amount: '1.001', currency: 'BRL' } },
    { playerId: crypto.randomUUID(), initialBalance: { amount: '1.00', currency: 'BRL', extra: true } },
    { playerId: crypto.randomUUID(), initialBalance: { amount: '1.00', currency: 'BRL' }, extra: true },
  ].map(body => ({ body })))('rejeita contrato de wallet inválido %#', async ({ body }) => {
    expect((await request('/wallets', body)).status).toBe(400);
  });
  test('transação pode ser consultada pelos dois identificadores', async () => {
    const owner = await wallet(); const input = payload(owner);
    const result = await request('/wagering/transactions', input, crypto.randomUUID());
    expect(result.status).toBe(200); expect(result.body.balance.amount).toBe('75.00');
    const byId = await request(`/wagering/transactions/${result.body.transactionId}`);
    const byProvider = await request(`/providers/provider-a/wagering/transactions/${input.externalTransactionId}`);
    expect(byId.body).toEqual(byProvider.body); expect(byId.body.kind).toBe('BET');
  });
  test('replay devolve saldo original, sem novo débito ou evento', async () => {
    const owner = await wallet(); const input = payload(owner); const key = crypto.randomUUID();
    const original = await request('/wagering/transactions', input, key);
    await request('/wagering/transactions', payload(owner, { kind: 'WIN' }), crypto.randomUUID());
    const before = await database.source.getRepository(OutboxSchema).countBy({ aggregateId: owner.id });
    const replay = await request('/wagering/transactions', input, key);
    expect(replay.body).toEqual({ ...original.body, idempotentReplay: true });
    expect(replay.body.balance.amount).toBe('75.00');
    expect((await request(`/wallets/${owner.id}`)).body.balance.amount).toBe('100.00');
    expect(await database.source.getRepository(OutboxSchema).countBy({ aggregateId: owner.id })).toBe(before);
  });
  test('payload divergente na mesma chave e ID externo com outra chave são conflitos', async () => {
    const owner = await wallet(); const input = payload(owner); const key = crypto.randomUUID();
    await request('/wagering/transactions', input, key);
    const changed = await request('/wagering/transactions', { ...input, money: { amount: '26.00', currency: 'BRL' } }, key);
    expect(changed.status).toBe(409); expect(changed.body.code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await request('/wagering/transactions', input, crypto.randomUUID())).status).toBe(409);
  });
  test('rejeição por saldo retorna 422, é auditável e pode ser repetida', async () => {
    const owner = await wallet('0.00'); const input = payload(owner); const key = crypto.randomUUID();
    const result = await request('/wagering/transactions', input, key);
    expect(result.status).toBe(422); expect(result.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect((await request('/wagering/transactions', input, key)).body.idempotentReplay).toBe(true);
    expect((await request(`/wallets/${owner.id}/ledger`)).body.items).toHaveLength(0);
    expect(await database.source.getRepository(OutboxSchema).countBy({ aggregateId: owner.id })).toBe(1);
  });
  test('rejeita moeda incompatível e preserva moeda do saldo de replay', async () => {
    const owner = await wallet();
    const result = await request('/wagering/transactions', payload(owner, { money: { amount: '25.00', currency: 'USD' } }), crypto.randomUUID());
    expect(result.status).toBe(422); expect(result.body.failureCode).toBe('CURRENCY_MISMATCH');
    expect(result.body.balance.currency).toBe('BRL');
  });
  test('referência ausente retorna 202 e persiste programação e evento', async () => {
    const owner = await wallet(); const input = payload(owner, { kind: 'REFUND', referenceExternalTransactionId: 'missing' });
    const result = await request('/wagering/transactions', input, crypto.randomUUID());
    expect(result.status).toBe(202); expect(result.body.status).toBe('PENDING_REFERENCE');
    const row = await database.source.getRepository(TransactionSchema).findOneByOrFail({ id: result.body.transactionId });
    expect(row.nextReferenceAttemptAt).not.toBeNull(); expect(row.referenceExpiresAt).not.toBeNull();
    expect((await request(`/wallets/${owner.id}`)).body.balance.amount).toBe('100.00');
  });
  test('REFUND processa uma vez e ROLLBACK da mesma BET é rejeitado', async () => {
    const owner = await wallet(); const bet = payload(owner);
    await request('/wagering/transactions', bet, crypto.randomUUID());
    const refund = await request('/wagering/transactions', payload(owner, { kind: 'REFUND', referenceExternalTransactionId: bet.externalTransactionId }), crypto.randomUUID());
    expect(refund.status).toBe(200); expect(refund.body.balance.amount).toBe('100.00');
    const duplicate = await request('/wagering/transactions', payload(owner, { kind: 'ROLLBACK', referenceExternalTransactionId: bet.externalTransactionId }), crypto.randomUUID());
    expect(duplicate.status).toBe(422); expect(duplicate.body.failureCode).toBe('ALREADY_REVERSED');
  });
  test('paginação é estável com novos lançamentos e limita cursor à wallet', async () => {
    const owner = await wallet();
    await request('/wagering/transactions', payload(owner), crypto.randomUUID());
    const first = await request(`/wallets/${owner.id}/ledger?limit=1`);
    await request('/wagering/transactions', payload(owner), crypto.randomUUID());
    const second = await request(`/wallets/${owner.id}/ledger?limit=1&cursor=${first.body.nextCursor}`);
    const third = await request(`/wallets/${owner.id}/ledger?limit=1&cursor=${second.body.nextCursor}`);
    expect([first, second, third].map(page => page.body.items[0].walletVersion)).toEqual([1, 2, 3]);
    expect(third.body.nextCursor).toBeNull();
    const other = await wallet();
    expect((await request(`/wallets/${other.id}/ledger?cursor=${first.body.nextCursor}`)).status).toBe(400);
  });
  test.each(['limit=0', 'limit=101', 'limit=abc', 'cursor=bad', 'limit=1&limit=2'])('paginação inválida: %s', async query => {
    const owner = await wallet(); expect((await request(`/wallets/${owner.id}/ledger?${query}`)).status).toBe(400);
  });
  test('chave obrigatória, OPENING proibido e referência obrigatória são validados', async () => {
    const owner = await wallet();
    expect((await request('/wagering/transactions', payload(owner))).status).toBe(400);
    expect((await request('/wagering/transactions', payload(owner, { kind: 'OPENING' }), 'key')).status).toBe(400);
    expect((await request('/wagering/transactions', payload(owner, { kind: 'REFUND' }), 'key')).status).toBe(400);
  });
  test('IDs inválidos e recursos ausentes são distintos', async () => {
    expect((await request('/wallets/not-a-uuid')).status).toBe(400);
    expect((await request(`/wallets/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await request(`/wagering/transactions/${crypto.randomUUID()}`)).status).toBe(404);
  });
  test('métrica de reconciliação está disponível', async () => {
    const response = await fetch(`${base}/metrics`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('wagering_reconciliation_mismatches_total 0');
  });
  test('falha ao gravar outbox desfaz a movimentação inteira pela API', async () => {
    const owner = await wallet(); const input = payload(owner); const key = crypto.randomUUID();
    // Falha injetada apenas neste banco temporário para testar a transação real.
    await database.source.query(`CREATE FUNCTION test_outbox_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected outbox failure'; END $$;
      CREATE TRIGGER test_outbox_failure BEFORE INSERT ON outbox_messages FOR EACH ROW EXECUTE FUNCTION test_outbox_failure();`);
    try {
      const result = await request('/wagering/transactions', input, key);
      expect(result.status).toBe(500); expect(result.body.code).toBe('INTERNAL_ERROR');
      expect((await request(`/wallets/${owner.id}`)).body.balance.amount).toBe('100.00');
      expect((await request(`/wallets/${owner.id}/ledger`)).body.items).toHaveLength(1);
      expect(await database.source.getRepository(TransactionSchema).countBy({ idempotencyKey: key })).toBe(0);
      expect(await database.source.getRepository(OutboxSchema).countBy({ aggregateId: owner.id })).toBe(2);
    } finally {
      await database.source.query('DROP TRIGGER test_outbox_failure ON outbox_messages; DROP FUNCTION test_outbox_failure();');
    }
    expect((await request('/wagering/transactions', input, key)).status).toBe(200);
  });
  test('banco indisponível retorna 503 sem detalhes internos', async () => {
    const isolated = await createTestDatabase();
    const unavailableApp = await createApplication(isolated.source, true);
    try {
      await unavailableApp.listen(0, '127.0.0.1');
      const url = await unavailableApp.getUrl(); await isolated.source.destroy();
      const response = await fetch(`${url}/wallets/${crypto.randomUUID()}`);
      expect(response.status).toBe(503); expect(response.headers.get('retry-after')).toBe('1');
      expect(await response.json()).toEqual({ statusCode: 503, code: 'SERVICE_UNAVAILABLE' });
    } finally { await unavailableApp.close(); await isolated.close(); }
  });
});
