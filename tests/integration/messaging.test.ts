import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { FinancialService } from '../../src/application/financial-service';
import { TypeOrmFinancialStore } from '../../src/infrastructure/database/typeorm-financial-store';
import { SqsConsumer } from '../../src/infrastructure/messaging/sqs-consumer';
import { OutboxPublisher } from '../../src/infrastructure/messaging/outbox-publisher';
import { ReferenceWorker } from '../../src/infrastructure/messaging/reference-worker';
import { WorkerRuntime } from '../../src/infrastructure/messaging/worker-runtime';
import { InboxSchema, OutboxSchema, TransactionSchema, WalletSchema } from '../../src/infrastructure/database/entities/financial.schemas';
import { createTestDatabase } from './database';
import { createTestQueues } from './queue-fixture';

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let queues: Awaited<ReturnType<typeof createTestQueues>>;
let service: FinancialService;
const ctx = { correlationId: 'test-messaging' };
beforeEach(async () => {
  db = await createTestDatabase(); queues = await createTestQueues();
  service = new FinancialService(new TypeOrmFinancialStore(db.source), { reconciliationMismatch() {} });
}, 30000);
afterEach(async () => {
  try {
    if (db?.source.isInitialized) expect(await db.source.query(`SELECT w.id FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id=w.id
      GROUP BY w.id HAVING w.balance < 0 OR w.balance <> COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END),0)`)).toEqual([]);
  } finally { if (queues) await queues.close(); if (db) await db.close(); }
}, 30000);
async function wallet(amount = '100.00') {
  return service.createWallet({ playerId: crypto.randomUUID(), initialBalance: { amount, currency: 'BRL' } }, ctx);
}
function command(owner: { id: string; playerId: string }, overrides: Record<string, unknown> = {}) {
  return { providerId: 'provider-a', externalTransactionId: crypto.randomUUID(), walletId: owner.id,
    playerId: owner.playerId, roundId: 'round', gameId: 'game', kind: 'BET', money: { amount: '25.00', currency: 'BRL' }, ...overrides };
}
function envelope(data: unknown, key = crypto.randomUUID(), messageId = crypto.randomUUID()) {
  return { messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(),
    data: { ...data as Record<string, unknown>, idempotencyKey: key } };
}
function consumer(hooks: ConstructorParameters<typeof SqsConsumer>[4] = {}) {
  return new SqsConsumer(queues.client, queues.config, service, undefined, hooks);
}
async function consume(worker = consumer()) {
  for (let i = 0; i < 80; i++) {
    if (await worker.pollOnce()) return;
    await Bun.sleep(50);
  }
  throw new Error('Mensagem não recebida no prazo do teste');
}
async function balance(id: string) { return (await service.getWallet(id)).balance.amount; }

// Mata um processo real exatamente no ponto sinalizado pelo próprio worker.
async function crashProcess(mode: 'consumer' | 'publisher') {
  const child = Bun.spawn([process.execPath, 'tests/support/messaging-process.ts', mode], {
    env: { ...process.env, DATABASE_URL: db.url, SQS_QUEUE_URL: queues.config.inputUrl,
      SQS_EVENTS_QUEUE_URL: queues.config.eventsUrl, SQS_DLQ_URL: queues.config.dlqUrl },
    stdout: 'pipe', stderr: 'pipe',
  });
  const reader = child.stdout.getReader(); let buffer = '';
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([ (async () => {
      for (;;) {
        const next = await reader.read();
        if (next.done) throw new Error(`Worker exited: ${await new Response(child.stderr).text()}`);
        buffer += new TextDecoder().decode(next.value);
        if (buffer.includes('"test_crash_point"')) return;
      }
    })(), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Crash point not reached')), 15000); }) ]);
  } finally { clearTimeout(timeout); child.kill(9); await child.exited; reader.releaseLock(); }
}

test('SQS usa o caso de uso HTTP e confirma inbox, saldo e outbox juntos', async () => {
  const owner = await wallet(); const body = envelope(command(owner)); await queues.send(body);
  await consume();
  expect(await balance(owner.id)).toBe('75.00');
  const inbox = await db.source.getRepository(InboxSchema).findOneByOrFail({ messageId: body.messageId });
  expect(inbox.processedAt).not.toBeNull();
  expect(await db.source.getRepository(OutboxSchema).count()).toBe(4);
  expect(await queues.count(queues.config.inputUrl)).toBe(0);
});
test('redelivery com mesmo messageId e nova deduplicação SQS não duplica efeitos', async () => {
  const owner = await wallet(); const body = envelope(command(owner));
  await queues.send(body); await consume(); await queues.send(body); await consume();
  expect(await balance(owner.id)).toBe('75.00'); expect(await db.source.getRepository(InboxSchema).count()).toBe(1);
  expect(await db.source.getRepository(OutboxSchema).count()).toBe(4);
});
test('HTTP seguido de SQS faz replay e registra a inbox', async () => {
  const owner = await wallet(); const input = command(owner); const key = crypto.randomUUID();
  const first = await service.submit(input, key, ctx);
  await queues.send(envelope(input, key)); await consume();
  expect(await balance(owner.id)).toBe('75.00');
  expect(await db.source.getRepository(TransactionSchema).countBy({ id: first.transactionId })).toBe(1);
  expect(await db.source.getRepository(InboxSchema).count()).toBe(1);
});
test('messageId com payload divergente vai à DLQ sem novo débito', async () => {
  const owner = await wallet(); const body = envelope(command(owner));
  await queues.send(body); await consume();
  await queues.send({ ...body, data: { ...body.data, money: { amount: '26.00', currency: 'BRL' } } }); await consume();
  expect(await balance(owner.id)).toBe('75.00'); expect(await queues.drain(queues.config.dlqUrl)).toHaveLength(1);
});
test('rejeição comercial é terminal e recebe ack, sem ir à DLQ', async () => {
  const owner = await wallet('0.00'); await queues.send(envelope(command(owner))); await consume();
  expect(await balance(owner.id)).toBe('0.00');
  expect(await db.source.getRepository(TransactionSchema).countBy({ status: 'REJECTED' })).toBe(1);
  expect(await queues.count(queues.config.dlqUrl)).toBe(0); expect(await queues.count(queues.config.inputUrl)).toBe(0);
});
test('mensagem malformada vai à DLQ e não cria inbox financeira', async () => {
  await queues.send({ invalid: true }); await consume();
  expect(await queues.drain(queues.config.dlqUrl)).toHaveLength(1);
  expect(await db.source.getRepository(InboxSchema).count()).toBe(0);
});

test('falha ao enviar à DLQ preserva a mensagem de origem para recuperação', async () => {
  await queues.send({ invalid: true });
  const broken = new SqsConsumer(queues.client,
    { ...queues.config, dlqUrl: `${queues.config.dlqUrl}-missing` }, service);
  await expect(consume(broken)).rejects.toThrow();
  expect(await queues.count(queues.config.inputUrl)).toBe(1);
  await consume();
  expect(await queues.drain(queues.config.dlqUrl)).toHaveLength(1);
  expect(await queues.count(queues.config.inputUrl)).toBe(0);
});

test('worker fecha conexões e encerra com erro quando a porta está ocupada', async () => {
  const occupied = Bun.serve({ hostname: '0.0.0.0', port: 0, fetch: () => new Response('test') });
  const child = Bun.spawn([process.execPath, 'src/worker.ts'], {
    env: { ...process.env, DATABASE_URL: db.url, WORKER_PORT: String(occupied.port) },
    stdout: 'pipe', stderr: 'pipe',
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const exitCode = await Promise.race([child.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Worker não encerrou após falha de startup')), 5000);
      })]);
    expect(exitCode).toBe(1);
    expect(await new Response(child.stderr).text()).toContain('worker_start_failed');
  } finally {
    clearTimeout(timer); child.kill(); await child.exited; occupied.stop(true);
  }
});
test('indisponibilidade transitória permite retry e processamento após recuperação', async () => {
  const owner = await wallet(); await queues.send(envelope(command(owner)));
  await db.source.destroy(); await consume();
  expect(await queues.count(queues.config.inputUrl)).toBe(1);
  await db.source.initialize(); await consume();
  expect(await balance(owner.id)).toBe('75.00'); expect(await queues.count(queues.config.inputUrl)).toBe(0);
});
test('limite de tentativas encaminha falha persistente à DLQ', async () => {
  const owner = await wallet(); await queues.send(envelope(command(owner)));
  await db.source.destroy(); await consume(); await consume();
  expect(await queues.drain(queues.config.dlqUrl)).toHaveLength(1);
  expect(await queues.count(queues.config.inputUrl)).toBe(0);
  await db.source.initialize(); expect(await balance(owner.id)).toBe('100.00');
});
test('dois publishers concorrentes publicam todos os eventos sem perda', async () => {
  const owner = await wallet();
  for (let i = 0; i < 4; i++) await service.submit(command(owner, { kind: 'WIN' }), crypto.randomUUID(), ctx);
  const first = new OutboxPublisher(db.source, queues.client, queues.config.eventsUrl);
  const second = new OutboxPublisher(db.source, queues.client, queues.config.eventsUrl);
  async function drain(publisher: OutboxPublisher) { for (let i = 0; i < 20 && await publisher.publishOnce(); i++) {} }
  await Promise.all([drain(first), drain(second)]);
  const rows = await db.source.getRepository(OutboxSchema).find();
  expect(rows).toHaveLength(10); expect(rows.every(row => row.publishedAt)).toBe(true);
  const events = await queues.drain(queues.config.eventsUrl);
  expect(events).toHaveLength(10); expect(new Set(events.map(event => event.eventId)).size).toBe(10);
});

test('falha persistente registra FAILED e evento sem alterar o saldo', async () => {
  const owner = await wallet(); const body = envelope(command(owner));
  await db.source.query(`CREATE FUNCTION test_processed_fail() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected'; END $$;
    CREATE TRIGGER test_processed_fail BEFORE INSERT ON wager_transactions FOR EACH ROW
    WHEN (NEW.status = 'PROCESSED') EXECUTE FUNCTION test_processed_fail();`);
  await queues.send(body); await consume(); await consume();
  expect(await queues.drain(queues.config.dlqUrl)).toHaveLength(1);
  expect(await balance(owner.id)).toBe('100.00');
  const failed = await db.source.getRepository(TransactionSchema).findOneByOrFail({ status: 'FAILED' });
  expect(failed.failureCode).toBe('INFRASTRUCTURE_FAILURE');
  expect(await db.source.getRepository(OutboxSchema).countBy({ eventType: 'WagerTransactionFailed' })).toBe(1);
  const { idempotencyKey, ...input } = body.data;
  await service.auditDeliveryFailure(input, idempotencyKey, ctx);
  expect(await db.source.getRepository(TransactionSchema).countBy({ status: 'FAILED' })).toBe(1);
});
test('falha de publicação persiste backoff e depois permite recuperar', async () => {
  await wallet();
  const broken = new OutboxPublisher(db.source, queues.client, `${queues.config.eventsUrl}-missing`);
  expect(await broken.publishOnce()).toBe(true);
  const row = await db.source.getRepository(OutboxSchema).findOneByOrFail({ attempts: 1 });
  expect(row.nextAttemptAt.getTime()).toBeGreaterThan(row.occurredAt.getTime()); expect(row.publishedAt).toBeNull();
  await db.source.query('UPDATE outbox_messages SET next_attempt_at=now()');
  const recovered = new OutboxPublisher(db.source, queues.client, queues.config.eventsUrl);
  while (await recovered.publishOnce()) {}
  expect(await queues.drain(queues.config.eventsUrl)).toHaveLength(2);
});
test('falha após envio e antes de marcar publicação recupera com mesmo eventId', async () => {
  await wallet();
  const broken = new OutboxPublisher(db.source, queues.client, queues.config.eventsUrl, undefined,
    { afterPublish: async () => { throw new Error('crash after send'); } });
  await expect(broken.publishOnce()).rejects.toThrow('crash after send');
  const first = await queues.drain(queues.config.eventsUrl); expect(first).toHaveLength(1);
  const stored = await db.source.getRepository(OutboxSchema).findOneByOrFail({ id: first[0]!.eventId as string });
  expect(stored.publishedAt).toBeNull();
  const recovered = new OutboxPublisher(db.source, queues.client, queues.config.eventsUrl);
  while (await recovered.publishOnce()) {}
  expect((await db.source.getRepository(OutboxSchema).find()).every(row => row.publishedAt)).toBe(true);
});
test('REFUND antes da BET é reprocessado uma vez por dois workers', async () => {
  const owner = await wallet(); const bet = command(owner);
  const pending = await service.submit(command(owner, { kind: 'REFUND', referenceExternalTransactionId: bet.externalTransactionId }), crypto.randomUUID(), ctx);
  expect(pending.status).toBe('PENDING_REFERENCE');
  await service.submit(bet, crypto.randomUUID(), ctx);
  const now = new Date(Date.now() + 2000);
  await Promise.all([new ReferenceWorker(db.source, service).runOnce(now), new ReferenceWorker(db.source, service).runOnce(now)]);
  expect(await balance(owner.id)).toBe('100.00');
  expect((await service.getTransaction(pending.transactionId)).status).toBe('PROCESSED');
  const [row] = await db.source.query('SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE transaction_id=$1', [pending.transactionId]);
  expect(row.count).toBe(1);
});
test('referência inexistente tem backoff e rejeição auditável no TTL', async () => {
  const owner = await wallet();
  const pending = await service.submit(command(owner, { kind: 'ROLLBACK', referenceExternalTransactionId: 'missing' }), crypto.randomUUID(), ctx);
  const worker = new ReferenceWorker(db.source, service); const now = new Date(Date.now() + 2000);
  await worker.runOnce(now);
  const row = await db.source.getRepository(TransactionSchema).findOneByOrFail({ id: pending.transactionId });
  expect(row.referenceAttempts).toBe(1); expect(row.nextReferenceAttemptAt!.getTime()).toBeGreaterThan(now.getTime());
  await worker.runOnce(new Date(Date.now() + 25 * 60 * 60 * 1000));
  const result = await service.getTransaction(pending.transactionId);
  expect(result.status).toBe('REJECTED'); expect(result.failureCode).toBe('REFERENCE_NOT_FOUND');
  expect(await balance(owner.id)).toBe('100.00');
});

test('referência inexistente termina na centésima tentativa sem agendar a 101', async () => {
  const owner = await wallet();
  const pending = await service.submit(command(owner, { kind: 'REFUND', referenceExternalTransactionId: 'missing' }),
    crypto.randomUUID(), ctx);
  await db.source.query("UPDATE wager_transactions SET reference_attempts=99,next_reference_attempt_at=now() WHERE id=$1",
    [pending.transactionId]);
  await new ReferenceWorker(db.source, service).runOnce();
  const row = await db.source.getRepository(TransactionSchema).findOneByOrFail({ id: pending.transactionId });
  expect(row.status).toBe('REJECTED');
  expect(row.referenceAttempts).toBe(100);
  expect(row.nextReferenceAttemptAt).toBeNull();
  expect(row.failureCode).toBe('REFERENCE_NOT_FOUND');
});

test('referência recebida antes da última tentativa ainda pode ser processada', async () => {
  const owner = await wallet(); const bet = command(owner);
  const pending = await service.submit(command(owner, { kind: 'REFUND', referenceExternalTransactionId: bet.externalTransactionId }),
    crypto.randomUUID(), ctx);
  await service.submit(bet, crypto.randomUUID(), ctx);
  await db.source.query("UPDATE wager_transactions SET reference_attempts=99,next_reference_attempt_at=now() WHERE id=$1",
    [pending.transactionId]);
  await new ReferenceWorker(db.source, service).runOnce();
  const row = await db.source.getRepository(TransactionSchema).findOneByOrFail({ id: pending.transactionId });
  expect(row.status).toBe('PROCESSED'); expect(row.referenceAttempts).toBe(100);
  expect(await balance(owner.id)).toBe('100.00');
});
test('shutdown interrompe long polling sem esperar os 20 segundos', async () => {
  const runtime = new WorkerRuntime(db.source, queues.client, queues.config);
  runtime.start(); await Bun.sleep(50); const start = performance.now();
  await runtime.stop(); expect(performance.now() - start).toBeLessThan(5000);
});

test('runtime drena backlog sem inserir pausa entre eventos disponíveis', async () => {
  await wallet(); await wallet();
  const runtime = new WorkerRuntime(db.source, queues.client, queues.config);
  const publish = runtime.publisher.publishOnce.bind(runtime.publisher);
  let priorPause: { elapsed: boolean } | undefined;
  const pauses: boolean[] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];
  let published = 0; let complete!: () => void;
  const drained = new Promise<void>(resolve => { complete = resolve; });
  const spy = spyOn(runtime.publisher, 'publishOnce').mockImplementation(async () => {
    if (priorPause) pauses.push(priorPause.elapsed);
    const result = await publish();
    if (result) {
      const pause = { elapsed: false }; priorPause = pause;
      timers.push(setTimeout(() => { pause.elapsed = true; }, 0));
      if (++published === 4) complete();
    }
    return result;
  });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    runtime.start();
    await Promise.race([drained, new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error('Backlog não drenado')), 10000);
    })]);
    expect(pauses.slice(0, 3)).toEqual([false, false, false]);
    expect(await queues.drain(queues.config.eventsUrl)).toHaveLength(4);
  } finally {
    clearTimeout(deadline); await runtime.stop(); spy.mockRestore();
    for (const timer of timers) clearTimeout(timer);
  }
});
test('shutdown em mensagem em andamento conclui commit e ack', async () => {
  const owner = await wallet(); await queues.send(envelope(command(owner)));
  let committed!: () => void; let release!: () => void;
  const reached = new Promise<void>(resolve => { committed = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const worker = consumer({ afterCommit: async () => { committed(); await gate; } });
  const processing = consume(worker); await reached;
  worker.stop(); release(); await processing;
  expect(await balance(owner.id)).toBe('75.00'); expect(await queues.count(queues.config.inputUrl)).toBe(0);
});
test('processo morto após commit e antes do ack permite redelivery e publicação posterior', async () => {
  const owner = await wallet(); const body = envelope(command(owner)); await queues.send(body);
  await crashProcess('consumer');
  expect(await balance(owner.id)).toBe('75.00');
  expect(await queues.count(queues.config.inputUrl)).toBe(1);
  await consume();
  expect(await balance(owner.id)).toBe('75.00');
  expect(await db.source.getRepository(InboxSchema).count()).toBe(1);
  const publisher = new OutboxPublisher(db.source, queues.client, queues.config.eventsUrl);
  while (await publisher.publishOnce()) {}
  expect(await queues.drain(queues.config.eventsUrl)).toHaveLength(4);
  expect(await queues.count(queues.config.inputUrl)).toBe(0);
}, 30000);
test('publisher morto após enviar libera sua reserva para outra instância', async () => {
  await wallet(); await crashProcess('publisher');
  const publisher = new OutboxPublisher(db.source, queues.client, queues.config.eventsUrl);
  while (await publisher.publishOnce()) {}
  expect((await db.source.getRepository(OutboxSchema).find()).every(row => row.publishedAt)).toBe(true);
  const events = await queues.drain(queues.config.eventsUrl);
  expect(new Set(events.map(event => event.eventId)).size).toBe(2);
}, 30000);
test('falha na outbox desfaz também a inbox da mensagem SQS', async () => {
  const owner = await wallet(); const body = envelope(command(owner));
  await db.source.query(`CREATE FUNCTION test_outbox_fail() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected'; END $$;
    CREATE TRIGGER test_outbox_fail BEFORE INSERT ON outbox_messages FOR EACH ROW EXECUTE FUNCTION test_outbox_fail();`);
  await queues.send(body);
  try {
    await consume(); expect(await balance(owner.id)).toBe('100.00');
    expect(await db.source.getRepository(InboxSchema).count()).toBe(0);
    expect(await db.source.getRepository(TransactionSchema).count()).toBe(1);
  } finally { await db.source.query('DROP TRIGGER test_outbox_fail ON outbox_messages; DROP FUNCTION test_outbox_fail();'); }
  await consume(); expect(await balance(owner.id)).toBe('75.00');
});
