import { DomainError } from './domain-error';
import { Money } from './money';
import type { LedgerDirection } from './wager-transaction';

export interface LedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  walletVersion: number;
  createdAt: Date;
}

export class WalletLedgerEntry {
  private readonly state: Readonly<LedgerEntryProps>;
  private constructor(props: LedgerEntryProps) {
    this.state = Object.freeze({ ...props, createdAt: new Date(props.createdAt) });
    Object.freeze(this);
  }

  // Valida a aritmética antes de criar um lançamento imutável.
  static create(props: LedgerEntryProps): WalletLedgerEntry {
    const entry = new WalletLedgerEntry(props);
    if (!props.id || !props.walletId || !props.transactionId || !props.money.isPositive()
      || props.balanceBefore.isNegative() || props.balanceAfter.isNegative()
      || !Number.isSafeInteger(props.walletVersion) || props.walletVersion < 1
      || !Number.isFinite(props.createdAt.getTime())
      || !['CREDIT', 'DEBIT'].includes(props.direction) || !entry.isBalanced()) {
      throw new DomainError('INVALID_LEDGER');
    }
    return entry;
  }
  static rehydrate(props: LedgerEntryProps): WalletLedgerEntry { return new WalletLedgerEntry(props); }
  get id(): string { return this.state.id; }
  get walletId(): string { return this.state.walletId; }
  get transactionId(): string { return this.state.transactionId; }
  get direction(): LedgerDirection { return this.state.direction; }
  get money(): Money { return this.state.money; }
  get balanceBefore(): Money { return this.state.balanceBefore; }
  get balanceAfter(): Money { return this.state.balanceAfter; }
  get walletVersion(): number { return this.state.walletVersion; }
  get createdAt(): Date { return new Date(this.state.createdAt); }
  snapshot(): LedgerEntryProps { return { ...this.state, createdAt: this.createdAt }; }
  isBalanced(): boolean {
    const expected = this.direction === 'CREDIT'
      ? this.balanceBefore.add(this.money) : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
