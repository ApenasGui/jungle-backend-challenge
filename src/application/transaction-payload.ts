import { createHash } from 'node:crypto';
import type { MoneyProps } from '../domain/money';
import type { TransactionKind } from '../domain/wager-transaction';

export interface TransactionPayload {
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: Exclude<TransactionKind, 'OPENING'>;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

// Ordena as chaves para produzir o mesmo hash independentemente da ordem do JSON.
function canonical(value: unknown): string {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter(key => object[key] !== undefined).sort()
      .map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// Seleciona apenas campos de negócio: headers e metadados de transporte ficam fora.
export function hashTransactionPayload(payload: TransactionPayload): string {
  const business = {
    providerId: payload.providerId, externalTransactionId: payload.externalTransactionId,
    walletId: payload.walletId, playerId: payload.playerId, roundId: payload.roundId,
    gameId: payload.gameId, kind: payload.kind,
    money: { amount: payload.money.amount, currency: payload.money.currency },
    referenceExternalTransactionId: payload.referenceExternalTransactionId,
  };
  return createHash('sha256').update(canonical(business)).digest('hex');
}
