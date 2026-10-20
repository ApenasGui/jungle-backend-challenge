import Decimal from 'decimal.js';
import { DomainError } from './domain-error';

export interface MoneyProps { amount: string; currency: string }

// A precisão excede o limite NUMERIC(20,2), inclusive nas somas intermediárias.
const ExactDecimal = Decimal.clone({ precision: 50 });
const MAX_AMOUNT = new ExactDecimal('999999999999999999.99');

export class Money {
  private constructor(private readonly value: Decimal, readonly currency: string) {
    if (!value.isFinite() || value.abs().greaterThan(MAX_AMOUNT)) {
      throw new DomainError('AMOUNT_OUT_OF_RANGE');
    }
    Object.freeze(this);
  }

  // Contratos externos exigem duas casas e nunca aceitam valor negativo.
  static from({ amount, currency }: MoneyProps): Money {
    if (typeof amount !== 'string' || !/^(0|[1-9]\d{0,17})\.\d{2}$/.test(amount)) {
      throw new DomainError('INVALID_MONEY');
    }
    Money.assertCurrency(currency);
    return new Money(new ExactDecimal(amount), currency);
  }

  // Reconstrói valores internos, incluindo diferenças negativas de reconciliação.
  static rehydrate({ amount, currency }: MoneyProps): Money {
    if (typeof amount !== 'string' || !/^-?(0|[1-9]\d{0,17})\.\d{2}$/.test(amount)) {
      throw new DomainError('INVALID_MONEY');
    }
    Money.assertCurrency(currency);
    return new Money(new ExactDecimal(amount), currency);
  }

  static zero(currency: string): Money { return Money.from({ amount: '0.00', currency }); }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money { return new Money(this.value.negated(), this.currency); }
  isZero(): boolean { return this.value.isZero(); }
  isPositive(): boolean { return this.value.greaterThan('0'); }
  isNegative(): boolean { return this.value.lessThan('0'); }
  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }
  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.equals(other.value);
  }
  toJSON(): MoneyProps { return { amount: this.toString(), currency: this.currency }; }
  toString(): string { return this.value.toFixed(2); }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) throw new DomainError('CURRENCY_MISMATCH');
  }

  private static assertCurrency(currency: string): void {
    // Escopo explícito: duas moedas permitem testar conflitos sem aceitar códigos fictícios.
    if (currency !== 'BRL' && currency !== 'USD') throw new DomainError('INVALID_MONEY');
  }
}
