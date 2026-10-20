import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';
import { money } from './fixtures';

describe('Money', () => {
  test('soma e subtração são exatas e não alteram a origem', () => {
    const first = money('0.10');
    expect(first.add(money('0.20')).toString()).toBe('0.30');
    expect(money('0.30').subtract(first).toString()).toBe('0.20');
    expect(first.toString()).toBe('0.10');
    expect(Object.isFrozen(first)).toBe(true);
  });
  test('preserva centavos acima do limite seguro de number', () => {
    expect(money('9007199254740993.01').add(money('0.01')).toString()).toBe('9007199254740993.02');
  });
  test('serializa sempre como string com duas casas', () => {
    expect(JSON.stringify(money('10.00'))).toBe('{"amount":"10.00","currency":"BRL"}');
  });
  test.each(['NaN', 'Infinity', '-Infinity', '1e2', '', ' ', ' 1.00', '1.00 ', '1', '1.0',
    '1.001', '1.005', '-0.00', '-1.00', '+1.00', '01.00', '.50', '1,00', '1000000000000000000.00'])
    ('rejeita entrada inválida sem arredondar: %s', amount => {
      expect(() => money(amount)).toThrow();
    });
  test('rejeita number em tempo de execução', () => {
    expect(() => Money.from({ amount: 1 as unknown as string, currency: 'BRL' })).toThrow();
  });
  test('rejeita códigos de moeda fora do escopo', () => {
    expect(() => money('1.00', 'XYZ')).toThrow();
    expect(() => money('1.00', 'brl')).toThrow();
  });
  test('rejeita mistura de moedas em operações e comparações', () => {
    const brl = money('1.00'); const usd = money('1.00', 'USD');
    expect(() => brl.add(usd)).toThrow('CURRENCY_MISMATCH');
    expect(() => brl.subtract(usd)).toThrow('CURRENCY_MISMATCH');
    expect(() => brl.equals(usd)).toThrow('CURRENCY_MISMATCH');
    expect(() => brl.isLessThan(usd)).toThrow('CURRENCY_MISMATCH');
  });
  test('diferenças negativas são internas e reidratáveis', () => {
    const difference = money('1.00').subtract(money('2.00'));
    expect(difference.isNegative()).toBe(true);
    expect(difference.negate().equals(money('1.00'))).toBe(true);
    expect(Money.rehydrate(difference.toJSON()).equals(difference)).toBe(true);
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(money('0.01').isPositive()).toBe(true);
  });
  test('overflow falha sem arredondar ou perder centavos', () => {
    const max = money('999999999999999999.99');
    expect(() => max.add(money('0.01'))).toThrow('AMOUNT_OUT_OF_RANGE');
    expect(max.subtract(money('0.01')).toString()).toBe('999999999999999999.98');
  });
});
