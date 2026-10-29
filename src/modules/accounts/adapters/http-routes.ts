import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AccountStore } from '../application/ports';
import { assertInternalToken } from '../../../shared/infra/http';
import { newId } from '../../../shared/domain/ids';
import { payloadHash } from '../../../shared/domain/hash';
import { assertAccountId, parseAmount } from '../../../shared/domain/money';

const RequestBody = z.object({ amount: z.number(), requestId: z.string().min(1).max(200).optional() });
const TransferBody = z.object({
  from: z.string(),
  to: z.string(),
  amount: z.number(),
  requestId: z.string().min(1).max(200).optional(),
});

function requestId(request: FastifyRequest, bodyRequestId?: string): string {
  const header = request.headers['idempotency-key'];
  const candidate = bodyRequestId ?? (typeof header === 'string' ? header : undefined);
  return candidate !== undefined && candidate.length > 0 && candidate.length <= 200 ? candidate : newId();
}

export interface AccountRoutesOptions {
  readonly store: AccountStore;
  readonly internalToken: string;
}

export function registerAccountRoutes(app: FastifyInstance, options: AccountRoutesOptions): void {
  app.get('/internal/v1/accounts/:accountId/balance', async (request) => {
    assertInternalToken(request, options.internalToken);
    const params = z.object({ accountId: z.string() }).parse(request.params);
    const accountId = assertAccountId(params.accountId);
    request.action = 'balance';
    request.account = accountId;
    const balance = await options.store.getBalance(accountId);
    return { status: 'success', requestId: request.requestId, ...balance };
  });

  app.post('/internal/v1/accounts/:accountId/deposit', async (request) => {
    assertInternalToken(request, options.internalToken);
    const params = z.object({ accountId: z.string() }).parse(request.params);
    const body = RequestBody.parse(request.body);
    const accountId = assertAccountId(params.accountId);
    const amount = parseAmount(body.amount);
    const id = requestId(request, body.requestId);
    request.action = 'deposit';
    request.account = accountId;
    const result = await options.store.deposit({
      accountId,
      amount,
      requestId: id,
      payloadHash: payloadHash({ action: 'deposit', accountId, amount }),
    });
    return { status: 'success', requestId: id, ...result };
  });

  app.post('/internal/v1/accounts/:accountId/withdraw', async (request) => {
    assertInternalToken(request, options.internalToken);
    const params = z.object({ accountId: z.string() }).parse(request.params);
    const body = RequestBody.parse(request.body);
    const accountId = assertAccountId(params.accountId);
    const amount = parseAmount(body.amount);
    const id = requestId(request, body.requestId);
    request.action = 'withdraw';
    request.account = accountId;
    const result = await options.store.withdraw({
      accountId,
      amount,
      requestId: id,
      payloadHash: payloadHash({ action: 'withdraw', accountId, amount }),
    });
    return { status: 'success', requestId: id, ...result };
  });

  app.post('/internal/v1/local-transfers', async (request) => {
    assertInternalToken(request, options.internalToken);
    const body = TransferBody.parse(request.body);
    const from = assertAccountId(body.from);
    const to = assertAccountId(body.to);
    const amount = parseAmount(body.amount);
    const id = requestId(request, body.requestId);
    request.action = 'transfer';
    request.account = from;
    const result = await options.store.transferLocal({
      from,
      to,
      amount,
      requestId: id,
      payloadHash: payloadHash({ action: 'transfer', from, to, amount }),
    });
    return { status: 'success', requestId: id, ...result };
  });

  // Kept for completeness of the internal surface; gateway uses the explicit
  // deposit/withdraw endpoints above.
  app.get('/internal/v1/accounts/:accountId', async (request) => {
    assertInternalToken(request, options.internalToken);
    const params = z.object({ accountId: z.string() }).parse(request.params);
    const accountId = assertAccountId(params.accountId);
    const result = await options.store.getBalance(accountId);
    return { status: 'success', requestId: request.requestId, ...result };
  });
}
