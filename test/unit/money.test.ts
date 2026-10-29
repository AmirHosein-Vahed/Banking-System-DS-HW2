import { describe, expect, it } from 'vitest';
import {
  accountNumber,
  assertAccountId,
  formatAccountNumber,
  isAccountId,
  parseAmount,
} from '../../src/shared/domain/money';
import { isAppError } from '../../src/shared/domain/errors';

describe('account identifiers', () => {
  it('accepts A followed by exactly four digits', () => {
    expect(isAccountId('A0001')).toBe(true);
    expect(isAccountId('A9999')).toBe(true);
    expect(isAccountId('A0500')).toBe(true);
  });

  it('rejects malformed identifiers', () => {
    for (const value of ['A1', 'A00001', 'a0500', 'B0001', 'A-500', '']) {
      expect(isAccountId(value)).toBe(false);
    }
  });

  it('throws a validation error with the API error code', () => {
    try {
      assertAccountId('nope');
      expect.unreachable('expected a validation error');
    } catch (error) {
      expect(isAppError(error)).toBe(true);
      if (isAppError(error)) {
        expect(error.code).toBe('VALIDATION_ERROR');
        expect(error.httpStatus).toBe(400);
      }
    }
  });

  it('converts between the identifier and its numeric value', () => {
    expect(accountNumber('A0500')).toBe(500);
    expect(formatAccountNumber(500)).toBe('A0500');
    expect(formatAccountNumber(1)).toBe('A0001');
  });

  it('rejects numbers outside the account space', () => {
    expect(() => formatAccountNumber(0)).toThrow();
    expect(() => formatAccountNumber(10_000)).toThrow();
    expect(() => formatAccountNumber(1.5)).toThrow();
  });
});

describe('amounts', () => {
  it('accepts positive safe integers', () => {
    expect(parseAmount(1)).toBe(1);
    expect(parseAmount(1_000_000)).toBe(1_000_000);
  });

  it('rejects zero, negatives, fractions and non-numbers', () => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '10', null]) {
      expect(() => parseAmount(value)).toThrow();
    }
  });

  it('rejects amounts above the configured maximum', () => {
    expect(() => parseAmount(1_000_000_000_001)).toThrow();
  });
});
