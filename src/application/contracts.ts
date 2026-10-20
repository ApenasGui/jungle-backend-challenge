import { ApplicationError } from './application-error';
import { Money, type MoneyProps } from '../domain/money';
import type { TransactionPayload } from './transaction-payload';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function invalid(): never { throw new ApplicationError('INVALID_PAYLOAD'); }

// A mesma validação é usada por HTTP e pelos futuros consumidores de mensagens.
function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !allowed.includes(key))) return invalid();
  return result;
}
export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) return invalid();
  return value;
}
export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) return invalid();
  return value.toLowerCase();
}
function parseMoney(value: unknown): MoneyProps {
  const input = object(value, ['amount', 'currency']);
  if (typeof input.amount !== 'string' || typeof input.currency !== 'string') return invalid();
  return Money.from({ amount: input.amount, currency: input.currency }).toJSON();
}
export function parseWallet(value: unknown): { playerId: string; initialBalance: MoneyProps } {
  const input = object(value, ['playerId', 'initialBalance']);
  return { playerId: uuid(input.playerId), initialBalance: parseMoney(input.initialBalance) };
}
export function parseTransaction(value: unknown): TransactionPayload {
  const input = object(value, ['providerId', 'externalTransactionId', 'walletId', 'playerId',
    'roundId', 'gameId', 'kind', 'money', 'referenceExternalTransactionId']);
  if (!['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'].includes(input.kind as string)) return invalid();
  return {
    providerId: identifier(input.providerId), externalTransactionId: identifier(input.externalTransactionId),
    walletId: uuid(input.walletId), playerId: uuid(input.playerId), roundId: identifier(input.roundId),
    gameId: identifier(input.gameId), kind: input.kind as TransactionPayload['kind'], money: parseMoney(input.money),
    referenceExternalTransactionId: input.referenceExternalTransactionId === undefined
      ? undefined : identifier(input.referenceExternalTransactionId),
  };
}

export interface LedgerCursor { walletId: string; version: number }
export function parseLedgerPage(walletId: string, cursor: unknown, limit: unknown) {
  const pageSize = limit === undefined ? 50 : typeof limit === 'string' && /^[1-9]\d{0,2}$/.test(limit) ? Number(limit) : invalid();
  if (pageSize > 100) return invalid();
  let version = 0;
  if (cursor !== undefined) {
    if (typeof cursor !== 'string' || cursor.length > 200 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return invalid();
    try {
      const parsed = object(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')), ['walletId', 'version']);
      if (parsed.walletId !== walletId || !Number.isSafeInteger(parsed.version) || (parsed.version as number) < 1) return invalid();
      version = parsed.version as number;
    } catch { return invalid(); }
  }
  return { version, limit: pageSize };
}
export function encodeLedgerCursor(cursor: LedgerCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}
