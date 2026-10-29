import { validationError } from './errors';

export const ACCOUNT_ID_PATTERN = /^A[0-9]{4}$/;
export const MAX_AMOUNT = 1_000_000_000_000;

export function isAccountId(value: string): boolean {
  return ACCOUNT_ID_PATTERN.test(value);
}

export function assertAccountId(value: unknown): string {
  if (typeof value !== 'string' || !ACCOUNT_ID_PATTERN.test(value)) {
    throw validationError('account must match A followed by exactly four digits (e.g. A0500)');
  }
  return value;
}

export function accountNumber(accountId: string): number {
  assertAccountId(accountId);
  return Number.parseInt(accountId.slice(1), 10);
}

export function formatAccountNumber(value: number): string {
  if (!Number.isInteger(value) || value < 1 || value > 9999) {
    throw validationError('account number must be between 1 and 9999');
  }
  return `A${value.toString().padStart(4, '0')}`;
}

export function parseAmount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw validationError('amount must be a positive whole number');
  }
  if (value > MAX_AMOUNT) {
    throw validationError(`amount must not exceed ${MAX_AMOUNT}`);
  }
  return value;
}
