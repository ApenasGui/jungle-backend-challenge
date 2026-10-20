import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { createTestDatabase } from '../integration/database';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
const children: ReturnType<typeof Bun.spawn<'pipe', 'pipe', 'pipe'>>[] = [];
const urls: string[] = [];

async function start(url: string) {
  const child = Bun.spawn([process.execPath, 'tests/support/api-process.ts'], {
    env: { ...process.env, DATABASE_URL: url }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  children.push(child);
  const reader = child.stdout.getReader();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const ready = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('API process startup timed out')), 15000); }),
    ]);
    if (!ready.value) throw new Error(`API failed: ${await new Response(child.stderr).text()}`);
    return (JSON.parse(new TextDecoder().decode(ready.value)) as { url: string }).url;
  } finally { clearTimeout(timeout); reader.releaseLock(); }
}
async function stopChildren() {
  for (const child of children) {
    if (child.exitCode !== null) continue;
    child.stdin.write('stop\n'); child.stdin.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([child.exited, new Promise<void>(resolve => {
      timer = setTimeout(() => { child.kill(); resolve(); }, 5000);
    })]);
    clearTimeout(timer); await child.exited;
  }
}
beforeAll(async () => {
  database = await createTestDatabase();
  try { for (let i = 0; i < 3; i++) urls.push(await start(database.url)); }
  catch (error) { await stopChildren(); await database.close(); throw error; }
}, 60000);
afterAll(async () => { await stopChildren(); if (database?.source.isInitialized) await database.close(); }, 30000);
afterEach(async () => {
  if (!database?.source.isInitialized) return;
  expect(await database.source.query(`SELECT w.id FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id=w.id
    GROUP BY w.id HAVING w.balance < 0 OR w.balance <> COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END),0)`)).toEqual([]);
});
async function post(index: number, path: string, body: unknown, key?: string) {
  const response = await fetch(`${urls[index % 3]}${path}`, { method: 'POST', headers: {
    'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}),
  }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}
async function wallet() {
  const response = await post(0, '/wallets', { playerId: crypto.randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } });
  expect(response.status).toBe(201); return response.body;
}
function payload(owner: { id: string; playerId: string }, amount = '25.00') {
  return { providerId: 'provider-a', externalTransactionId: crypto.randomUUID(), playerId: owner.playerId,
    walletId: owner.id, roundId: 'round', gameId: 'game', kind: 'BET', money: { amount, currency: 'BRL' } };
}
test('50 duplicatas em três processos causam um débito e dois eventos', async () => {
  const owner = await wallet(); const input = payload(owner); const key = crypto.randomUUID();
  const results = await Promise.all(Array.from({ length: 50 }, (_, i) => post(i, '/wagering/transactions', input, key)));
  expect(results.every(result => result.status === 200)).toBe(true);
  expect(results.filter(result => !result.body.idempotentReplay)).toHaveLength(1);
  expect(new Set(results.map(result => result.body.transactionId)).size).toBe(1);
  const [row] = await database.source.query('SELECT balance FROM wallets WHERE id=$1', [owner.id]);
  expect(row.balance).toBe('75.00');
  const [counts] = await database.source.query(`SELECT
    (SELECT count(*)::int FROM wallet_ledger_entries WHERE wallet_id=$1 AND direction='DEBIT') AS debits,
    (SELECT count(*)::int FROM outbox_messages WHERE aggregate_id=$1) AS events`, [owner.id]);
  expect(counts).toEqual({ debits: 1, events: 4 });
}, 30000);
test('duas apostas de 80 disputam saldo 100: uma processa e outra é rejeitada', async () => {
  const owner = await wallet();
  const results = await Promise.all([0, 1].map(i => post(i, '/wagering/transactions', payload(owner, '80.00'), crypto.randomUUID())));
  expect(results.map(result => result.status).sort()).toEqual([200, 422]);
  expect(results.find(result => result.status === 422)!.body.failureCode).toBe('INSUFFICIENT_FUNDS');
  const [row] = await database.source.query('SELECT balance, version FROM wallets WHERE id=$1', [owner.id]);
  expect(row).toEqual({ balance: '20.00', version: 2 });
});
test('chave global concorrente entre wallets diferentes não produz dois débitos', async () => {
  const first = await wallet(); const second = await wallet(); const key = crypto.randomUUID();
  const results = await Promise.all([post(0, '/wagering/transactions', payload(first), key), post(1, '/wagering/transactions', payload(second), key)]);
  expect(results.map(result => result.status).sort()).toEqual([200, 409]);
  const [row] = await database.source.query('SELECT sum(balance)::text AS total FROM wallets WHERE id=ANY($1::uuid[])', [[first.id, second.id]]);
  expect(row.total).toBe('175.00');
});
test('lock em uma wallet não impede outra wallet de processar', async () => {
  const first = await wallet(); const second = await wallet();
  const runner = database.source.createQueryRunner(); await runner.connect(); await runner.startTransaction();
  let blocked: Promise<Awaited<ReturnType<typeof post>>> | undefined;
  try {
    await runner.query('SELECT id FROM wallets WHERE id=$1 FOR UPDATE', [first.id]);
    blocked = post(0, '/wagering/transactions', payload(first), crypto.randomUUID());
    const other = await post(1, '/wagering/transactions', payload(second), crypto.randomUUID());
    expect(other.status).toBe(200);
    // O lock continua retido quando a outra wallet termina.
    expect(runner.isTransactionActive).toBe(true);
    await runner.commitTransaction();
    expect((await blocked).status).toBe(200);
  } finally {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    await runner.release(); if (blocked) await blocked;
  }
});
test('replay continua seguro depois de reiniciar um processo', async () => {
  const owner = await wallet(); const input = payload(owner); const key = crypto.randomUUID();
  const first = await post(0, '/wagering/transactions', input, key);
  expect(first.status).toBe(200);
  const child = children[0]!;
  child.stdin.write('stop\n'); child.stdin.end();
  await child.exited;
  urls[0] = await start(database.url);
  const replay = await post(0, '/wagering/transactions', input, key);
  expect(replay.status).toBe(200);
  expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  const [row] = await database.source.query('SELECT balance, version FROM wallets WHERE id=$1', [owner.id]);
  expect(row).toEqual({ balance: '75.00', version: 2 });
}, 30000);
