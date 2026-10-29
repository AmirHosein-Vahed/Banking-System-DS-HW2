export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNSUPPORTED_OPERATION'
  | 'ACCOUNT_NOT_FOUND'
  | 'INSUFFICIENT_FUNDS'
  | 'IDEMPOTENCY_CONFLICT'
  | 'WRONG_SHARD'
  | 'TX_NOT_FOUND'
  | 'TX_CONFLICT'
  | 'SHARD_UNAVAILABLE'
  | 'COORDINATOR_UNAVAILABLE'
  | 'OVERLOADED'
  | 'UNAUTHORIZED'
  | 'INTERNAL_ERROR';

/**
 * A typed, transport-independent application error. HTTP adapters are the only
 * place that translate it into a status code / response body.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, httpStatus = 500, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export const validationError = (message: string): AppError =>
  new AppError('VALIDATION_ERROR', message, 400);

export const accountNotFound = (accountId: string): AppError =>
  new AppError('ACCOUNT_NOT_FOUND', `Account ${accountId} does not exist`, 404);

export const insufficientFunds = (accountId: string): AppError =>
  new AppError('INSUFFICIENT_FUNDS', `Insufficient funds in account ${accountId}`, 409);

export const wrongShard = (accountId: string, shardId: string): AppError =>
  new AppError('WRONG_SHARD', `Account ${accountId} is not owned by shard ${shardId}`, 409);

export const idempotencyConflict = (requestId: string): AppError =>
  new AppError(
    'IDEMPOTENCY_CONFLICT',
    `Request ${requestId} was already used with a different payload`,
    409,
  );

export const shardUnavailable = (shardId: string): AppError =>
  new AppError('SHARD_UNAVAILABLE', `No healthy replica for shard ${shardId}`, 503);

export const coordinatorUnavailable = (): AppError =>
  new AppError('COORDINATOR_UNAVAILABLE', 'Transaction coordinator is unavailable', 503);

export const txNotFound = (txId: string): AppError =>
  new AppError('TX_NOT_FOUND', `Transaction ${txId} is unknown`, 404);

export const unauthorized = (): AppError => new AppError('UNAUTHORIZED', 'Unauthorized', 401);

export const overloaded = (): AppError =>
  new AppError('OVERLOADED', 'Too many concurrent requests', 503);
