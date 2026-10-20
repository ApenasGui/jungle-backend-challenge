import { DomainError } from './domain-error';
import { Money } from './money';
import { WagerTransaction } from './wager-transaction';
import { WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}
export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  at: Date;
  opening?: { transactionId: string; ledgerId: string; payloadHash: string };
}
export interface ApplyTransactionContext {
  ledgerId: string;
  at: Date;
  reference?: WagerTransaction;
  alreadyReversed?: boolean;
}

export class Wallet {
  private state: WalletState;
  private constructor(state: WalletState) {
    this.state = { ...state, createdAt: new Date(state.createdAt), updatedAt: new Date(state.updatedAt) };
  }

  // A abertura positiva já devolve sua transação e seu lançamento correspondentes.
  static open(props: OpenWalletProps): {
    wallet: Wallet; transaction?: WagerTransaction; entry?: WalletLedgerEntry;
  } {
    if (!props.id || !props.playerId || props.initialBalance.isNegative()
      || !Number.isFinite(props.at.getTime())) throw new DomainError('INVALID_TRANSACTION');
    const wallet = new Wallet({ id: props.id, playerId: props.playerId, balance: props.initialBalance,
      version: 1, createdAt: props.at, updatedAt: props.at });
    if (props.initialBalance.isZero()) return { wallet };
    if (!props.opening) throw new DomainError('INVALID_TRANSACTION');
    const transaction = WagerTransaction.opening({
      id: props.opening.transactionId, providerId: '__internal__', externalTransactionId: props.id,
      idempotencyKey: `opening:${props.id}`, payloadHash: props.opening.payloadHash,
      walletId: props.id, playerId: props.playerId, roundId: props.id, gameId: '__opening__',
      money: props.initialBalance, createdAt: props.at,
    });
    const entry = WalletLedgerEntry.create({ id: props.opening.ledgerId, walletId: props.id,
      transactionId: transaction.id, direction: 'CREDIT', money: props.initialBalance,
      balanceBefore: Money.zero(wallet.currency), balanceAfter: wallet.balance,
      walletVersion: 1, createdAt: props.at });
    transaction.markProcessed(undefined, props.at, wallet.balance);
    return { wallet, transaction, entry };
  }

  static rehydrate(state: WalletState): Wallet { return new Wallet(state); }
  get id(): string { return this.state.id; }
  get playerId(): string { return this.state.playerId; }
  get currency(): string { return this.balance.currency; }
  get balance(): Money { return this.state.balance; }
  get version(): number { return this.state.version; }
  get createdAt(): Date { return new Date(this.state.createdAt); }
  get updatedAt(): Date { return new Date(this.state.updatedAt); }
  snapshot(): WalletState { return { ...this.state, createdAt: this.createdAt, updatedAt: this.updatedAt }; }

  // O caso de uso deve carregar esta wallet sob lock e persistir todo o resultado junto.
  apply(transaction: WagerTransaction, context: ApplyTransactionContext): WalletLedgerEntry | undefined {
    if (transaction.isTerminal()) throw new DomainError('INVALID_TRANSACTION_STATE');
    if (transaction.kind === 'OPENING') throw new DomainError('INVALID_TRANSACTION');
    try {
      if (transaction.walletId !== this.id || transaction.playerId !== this.playerId) {
        throw new DomainError('WALLET_MISMATCH');
      }
      if (transaction.money.currency !== this.currency) throw new DomainError('CURRENCY_MISMATCH');
      if (transaction.referenceExternalTransactionId) {
        if (!context.reference) {
          transaction.markPendingReference();
          return undefined;
        }
        this.validateReference(transaction, context.reference, context.alreadyReversed ?? false);
        if (!context.reference.isTerminal()) {
          transaction.markPendingReference();
          return undefined;
        }
      }

      let entry: WalletLedgerEntry | undefined;
      if (transaction.affectsBalance()) {
        const direction = transaction.ledgerDirectionFor(context.reference);
        if (direction === 'DEBIT' && this.balance.isLessThan(transaction.money)) {
          throw new DomainError(transaction.kind === 'ROLLBACK'
            ? 'REVERSAL_INSUFFICIENT_FUNDS' : 'INSUFFICIENT_FUNDS');
        }
        const balanceAfter = direction === 'DEBIT'
          ? this.balance.subtract(transaction.money) : this.balance.add(transaction.money);
        entry = WalletLedgerEntry.create({ id: context.ledgerId, walletId: this.id,
          transactionId: transaction.id, direction, money: transaction.money,
          balanceBefore: this.balance, balanceAfter, walletVersion: this.version + 1,
          createdAt: context.at });
      }
      transaction.markProcessed(transaction.referenceExternalTransactionId ? context.reference?.id : undefined,
        context.at, entry?.balanceAfter ?? this.balance);
      if (entry) {
        this.state.balance = entry.balanceAfter;
        this.state.version = entry.walletVersion;
        this.state.updatedAt = new Date(context.at);
      }
      return entry;
    } catch (error) {
      if (!(error instanceof DomainError) || error.code === 'INVALID_TRANSACTION_STATE'
        || error.code === 'INVALID_LEDGER') throw error;
      transaction.reject(error.code, context.at, this.balance);
      return undefined;
    }
  }

  private validateReference(transaction: WagerTransaction, reference: WagerTransaction, reversed: boolean): void {
    if (reference.providerId !== transaction.providerId
      || reference.externalTransactionId !== transaction.referenceExternalTransactionId
      || reference.walletId !== this.id || reference.playerId !== this.playerId
      || reference.money.currency !== transaction.money.currency || reference.roundId !== transaction.roundId) {
      throw new DomainError('REFERENCE_MISMATCH');
    }
    if (reference.isTerminal() && reference.status !== 'PROCESSED') throw new DomainError('REFERENCE_NOT_PROCESSED');
    const allowed = transaction.kind === 'ROLLBACK' ? ['BET', 'WIN', 'REFUND'] : ['BET'];
    if (!allowed.includes(reference.kind)) throw new DomainError('INVALID_REFERENCE_KIND');
    if (transaction.requiresReference()) {
      if (!transaction.money.equals(reference.money)) throw new DomainError('REVERSAL_AMOUNT_MISMATCH');
      if (reversed) throw new DomainError('ALREADY_REVERSED');
    }
  }
}
