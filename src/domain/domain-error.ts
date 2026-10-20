export type FailureCode =
  | 'INVALID_MONEY' | 'CURRENCY_MISMATCH' | 'AMOUNT_OUT_OF_RANGE'
  | 'INVALID_TRANSACTION' | 'INVALID_TRANSACTION_STATE' | 'INVALID_LEDGER'
  | 'INSUFFICIENT_FUNDS' | 'REVERSAL_INSUFFICIENT_FUNDS'
  | 'REFERENCE_NOT_FOUND' | 'REFERENCE_NOT_PROCESSED' | 'REFERENCE_MISMATCH'
  | 'INVALID_REFERENCE_KIND' | 'REVERSAL_AMOUNT_MISMATCH' | 'ALREADY_REVERSED'
  | 'WALLET_MISMATCH' | 'IDEMPOTENCY_CONFLICT' | 'INFRASTRUCTURE_FAILURE';

// Mantém um código estável para tratar falhas sem interpretar mensagens.
export class DomainError extends Error {
  constructor(public readonly code: FailureCode, message: string = code) {
    super(message);
    this.name = 'DomainError';
  }
}
