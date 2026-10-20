import { expect, test } from 'bun:test';
import { OutboxMessage } from '../../src/domain/outbox-message';

function event() {
  const payload = { eventId: 'event-1', data: { money: { amount: '25.00', currency: 'BRL' } } };
  return { eventId: 'event-1', aggregateId: 'wallet-1', eventType: 'TestEvent',
    occurredAt: new Date('2026-10-20T12:00:00Z'), toJSON: () => payload };
}
test('outbox preserva envelope e datas após mudanças nas referências externas', () => {
  const source = event(); const message = OutboxMessage.enqueue(source);
  source.toJSON().data.money.amount = '99.00'; source.occurredAt.setFullYear(2030);
  const snapshot = message.snapshot(); snapshot.payload.eventId = 'changed'; snapshot.nextAttemptAt.setFullYear(2040);
  expect(message.snapshot().payload).toEqual({ eventId: 'event-1', data: { money: { amount: '25.00', currency: 'BRL' } } });
  expect(message.nextAttemptAt.toISOString()).toBe('2026-10-20T12:00:00.000Z');
  expect(message.isDue(new Date('2026-10-20T12:00:00Z'))).toBe(true);
});
test('outbox persiste backoff limitado e recupera agendamento por rehydrate', () => {
  const now = new Date('2026-10-20T12:00:00Z');
  const message = OutboxMessage.enqueue(event());
  message.scheduleRetry(now);
  expect(message.nextAttemptAt.getTime() - now.getTime()).toBe(1000);
  for (let i = 0; i < 10; i++) message.scheduleRetry(now);
  const restored = OutboxMessage.rehydrate(message.snapshot());
  expect(restored.attempts).toBe(11);
  expect(restored.nextAttemptAt.getTime() - now.getTime()).toBe(60000);
  expect(restored.isDue(now)).toBe(false);
});
test('outbox publicada não permite reagendamento nem alteração da data de publicação', () => {
  const message = OutboxMessage.enqueue(event()); const at = new Date('2026-10-20T12:01:00Z');
  message.markPublished(at); at.setFullYear(2030);
  expect(message.isPending()).toBe(false);
  expect(message.isDue(new Date('2040-01-01'))).toBe(false);
  expect(() => message.scheduleRetry(new Date())).toThrow('OUTBOX_ALREADY_PUBLISHED');
  expect(() => message.markPublished(new Date())).toThrow('OUTBOX_ALREADY_PUBLISHED');
  expect(message.publishedAt?.toISOString()).toBe('2026-10-20T12:01:00.000Z');
});
