import { AppError, isAppError, type ErrorCode } from '../domain/errors';

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  'VALIDATION_ERROR',
  'UNSUPPORTED_OPERATION',
  'ACCOUNT_NOT_FOUND',
  'INSUFFICIENT_FUNDS',
  'IDEMPOTENCY_CONFLICT',
  'WRONG_SHARD',
  'TX_NOT_FOUND',
  'TX_CONFLICT',
  'SHARD_UNAVAILABLE',
  'COORDINATOR_UNAVAILABLE',
  'OVERLOADED',
  'UNAUTHORIZED',
  'INTERNAL_ERROR',
]);

export interface InternalResponse<T> {
  status: number;
  body: T;
}

export interface FetchOptions {
  method: 'GET' | 'POST';
  body?: unknown;
  timeoutMs: number;
  internalToken?: string;
  requestId?: string;
  clientIp?: string;
}

/**
 * Small internal HTTP client. It turns transport failures into typed errors so
 * the coordinator can distinguish "participant down" from "participant voted NO".
 */
export async function fetchJson<T>(url: string, options: FetchOptions): Promise<InternalResponse<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json',
    };
    if (options.internalToken !== undefined) {
      headers['x-internal-token'] = options.internalToken;
    }
    if (options.requestId !== undefined) {
      headers['x-request-id'] = options.requestId;
    }
    if (options.clientIp !== undefined) {
      headers['x-client-ip'] = options.clientIp;
    }
    const response = await fetch(url, {
      method: options.method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed: unknown = undefined;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { message: text };
      }
    }
    if (!response.ok) {
      const body = parsed as { code?: string; message?: string; details?: unknown } | undefined;
      const code = body?.code;
      const message = body?.message ?? text;
      if (typeof code === 'string' && KNOWN_ERROR_CODES.has(code)) {
        throw new AppError(code as ErrorCode, message, response.status, body?.details);
      }
      throw new AppError(
        'INTERNAL_ERROR',
        `Upstream ${url} returned ${response.status}: ${message}`,
        502,
      );
    }
    return { status: response.status, body: parsed as T };
  } catch (error) {
    if (isAppError(error)) {
      throw error;
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AppError('INTERNAL_ERROR', `Upstream ${url} timed out after ${options.timeoutMs}ms`, 504);
    }
    throw new AppError(
      'INTERNAL_ERROR',
      `Upstream ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
      502,
    );
  } finally {
    clearTimeout(timer);
  }
}
