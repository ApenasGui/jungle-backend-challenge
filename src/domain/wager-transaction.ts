import { DomainError, type FailureCode } from './domain-error';
import { Money } from './money';

export type TransactionKind = 'OPENING' | 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
export type TransactionStatus = 'PENDING' | 'PENDING_REFERENCE' | 'PROCESSED' | 'REJECTED' | 'FAILED';
export type LedgerDirection = 'DEBIT' | 'CREDIT';

export interface TransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: TransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface TransactionState extends TransactionProps {
  status: TransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  resultBalance?: Money;
}

export class WagerTransaction {
  private state: TransactionState;

  private constructor(state: TransactionState) {
    this.state = { ...state, createdAt: new Date(state.createdAt),
      processedAt: state.processedAt ? new Date(state.processedAt) : undefined };
  }

  // OPENING possui uma factory exclusiva e nunca é aceito como comando de provedor.
  static create(props: TransactionProps): WagerTransaction {
    if (!['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'].includes(props.kind) || props.providerId === '__internal__') {
      throw new DomainError('INVALID_TRANSACTION');
    }
    WagerTransaction.validate(props);
    return new WagerTransaction({ ...props, status: 'PENDING' });
  }

  static opening(props: Omit<TransactionProps, 'kind'>): WagerTransaction {
    const opening: TransactionProps = { ...props, kind: 'OPENING' };
    WagerTransaction.validate(opening);
    if (!props.money.isPositive() || props.referenceExternalTransactionId) {
      throw new DomainError('INVALID_TRANSACTION');
    }
    return new WagerTransaction({ ...opening, status: 'PENDING' });
  }

  static rehydrate(state: TransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get id(): string { return this.state.id; }
  get providerId(): string { return this.state.providerId; }
  get externalTransactionId(): string { return this.state.externalTransactionId; }
  get idempotencyKey(): string { return this.state.idempotencyKey; }
  get payloadHash(): string { return this.state.payloadHash; }
  get walletId(): string { return this.state.walletId; }
  get playerId(): string { return this.state.playerId; }
  get roundId(): string { return this.state.roundId; }
  get gameId(): string { return this.state.gameId; }
  get kind(): TransactionKind { return this.state.kind; }
  get money(): Money { return this.state.money; }
  get referenceExternalTransactionId(): string | undefined { return this.state.referenceExternalTransactionId; }
  get status(): TransactionStatus { return this.state.status; }
  get referenceTransactionId(): string | undefined { return this.state.referenceTransactionId; }
  get failureCode(): FailureCode | undefined { return this.state.failureCode; }
  get resultBalance(): Money | undefined { return this.state.resultBalance; }
  get createdAt(): Date { return new Date(this.state.createdAt); }
  get processedAt(): Date | undefined { return this.state.processedAt ? new Date(this.state.processedAt) : undefined; }

  snapshot(): TransactionState {
    return { ...this.state, createdAt: this.createdAt, processedAt: this.processedAt };
  }

  isTerminal(): boolean { return ['PROCESSED', 'REJECTED', 'FAILED'].includes(this.status); }
  affectsBalance(): boolean { return this.kind !== 'LOSS' && !this.money.isZero(); }
  requiresReference(): boolean { return this.kind === 'REFUND' || this.kind === 'ROLLBACK'; }
  matchesPayload(hash: string): boolean { return this.payloadHash === hash; }
  assertPayload(hash: string): void {
    if (!this.matchesPayload(hash)) throw new DomainError('IDEMPOTENCY_CONFLICT');
  }

  markPendingReference(): void {
    this.assertMutable();
    if (!this.referenceExternalTransactionId) throw new DomainError('INVALID_TRANSACTION_STATE');
    this.state.status = 'PENDING_REFERENCE';
  }

  // Guarda o saldo observado para que replays não usem o saldo atual da wallet.
  markProcessed(referenceId: string | undefined, at: Date, balance: Money): void {
    this.assertMutable();
    if (!Number.isFinite(at.getTime()) || balance.isNegative()) throw new DomainError('INVALID_TRANSACTION_STATE');
    if (Boolean(this.referenceExternalTransactionId) !== Boolean(referenceId)) {
      throw new DomainError('INVALID_TRANSACTION_STATE');
    }
    if (balance.currency !== this.money.currency) throw new DomainError('CURRENCY_MISMATCH');
    this.state.status = 'PROCESSED';
    this.state.referenceTransactionId = referenceId;
    this.state.processedAt = new Date(at);
    this.state.resultBalance = balance;
  }

  reject(code: FailureCode, at: Date, balance?: Money): void {
    this.finish('REJECTED', code, at, balance);
  }
  fail(code: FailureCode, at: Date): void { this.finish('FAILED', code, at); }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    if (this.kind === 'LOSS') throw new DomainError('INVALID_LEDGER');
    if (this.kind === 'ROLLBACK') {
      if (!reference || !['BET', 'WIN', 'REFUND'].includes(reference.kind)) {
        throw new DomainError('INVALID_REFERENCE_KIND');
      }
      return reference.kind === 'BET' ? 'CREDIT' : 'DEBIT';
    }
    return this.kind === 'BET' ? 'DEBIT' : 'CREDIT';
  }

  private finish(status: 'REJECTED' | 'FAILED', code: FailureCode, at: Date, balance?: Money): void {
    this.assertMutable();
    if (!Number.isFinite(at.getTime()) || balance?.isNegative()) throw new DomainError('INVALID_TRANSACTION_STATE');
    this.state.status = status;
    this.state.failureCode = code;
    this.state.processedAt = new Date(at);
    this.state.resultBalance = balance;
  }
  private assertMutable(): void {
    if (this.isTerminal()) throw new DomainError('INVALID_TRANSACTION_STATE');
  }
  private static validate(props: TransactionProps): void {
    const identifiers = [props.id, props.providerId, props.externalTransactionId, props.idempotencyKey,
      props.walletId, props.playerId, props.roundId, props.gameId];
    if (identifiers.some(value => typeof value !== 'string' || !value.trim() || value.length > 200)
      || !/^[a-f0-9]{64}$/.test(props.payloadHash) || !Number.isFinite(props.createdAt.getTime())
      || props.money.isNegative()) throw new DomainError('INVALID_TRANSACTION');
    if (props.kind === 'LOSS' ? !props.money.isZero() : !props.money.isPositive()) {
      throw new DomainError('INVALID_TRANSACTION');
    }
    const reference = props.referenceExternalTransactionId;
    if ((props.kind === 'REFUND' || props.kind === 'ROLLBACK') && !reference) {
      throw new DomainError('INVALID_TRANSACTION');
    }
    if (reference !== undefined && (!reference.trim() || reference.length > 200
      || reference === props.externalTransactionId || props.kind === 'BET' || props.kind === 'OPENING')) {
      throw new DomainError('INVALID_TRANSACTION');
    }
  }
}
