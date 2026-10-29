import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CoordinatorService } from '../application/coordinator-service';
import type { TxJournal } from '../application/ports';
import type { TxRecord } from '../domain/tx';
import { toView } from '../domain/tx';
import { assertInternalToken } from '../../../shared/infra/http';
import { newId } from '../../../shared/domain/ids';
import { AppError, type ErrorCode } from '../../../shared/domain/errors';

const TransferSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  amount: z.number(),
  requestId: z.string().min(1).max(200).optional(),
});

/**
 * A committed transfer can still have been aborted because a participant
 * voted NO. The first NO vote carries the machine-readable reason
 * (`CODE: message`), which is what the client should see instead of a
 * misleading success response.
 */
function abortError(record: TxRecord): AppError {
  const reason =
    record.participants.find((participant) => participant.voteReason !== undefined)?.voteReason ??
    '';
  const separator = reason.indexOf(':');
  const code = separator === -1 ? '' : reason.slice(0, separator);
  const message = separator === -1 ? reason : reason.slice(separator + 1).trim();
  const details = { txId: record.txId, outcome: 'ABORTED' };

  const mapping: Record<string, { code: ErrorCode; status: number }> = {
    INSUFFICIENT_FUNDS: { code: 'INSUFFICIENT_FUNDS', status: 409 },
    ACCOUNT_NOT_FOUND: { code: 'ACCOUNT_NOT_FOUND', status: 404 },
    CONTENTION: { code: 'OVERLOADED', status: 503 },
    UNAVAILABLE: { code: 'SHARD_UNAVAILABLE', status: 503 },
    TX_ABORTED: { code: 'TX_CONFLICT', status: 409 },
  };
  const mapped = mapping[code] ?? { code: 'TX_CONFLICT' as ErrorCode, status: 409 };
  return new AppError(
    mapped.code,
    message.length > 0 ? message : 'Distributed transfer was aborted',
    mapped.status,
    details,
  );
}

export interface CoordinatorRoutesOptions {
  readonly service: CoordinatorService;
  readonly journal: TxJournal;
  readonly internalToken: string;
}

export function registerCoordinatorRoutes(
  app: FastifyInstance,
  options: CoordinatorRoutesOptions,
): void {
  app.post('/internal/v1/transfers', async (request, reply) => {
    assertInternalToken(request, options.internalToken);
    const body = TransferSchema.parse(request.body);
    request.action = 'transfer';
    request.account = body.from;
    const header = request.headers['idempotency-key'];
    const requestId =
      body.requestId ?? (typeof header === 'string' && header.length > 0 ? header : newId());
    const record = await options.service.transfer({
      clientRequestId: requestId,
      from: body.from,
      to: body.to,
      amount: body.amount,
    });
    if (record.status === 'COMPLETED' && record.outcome === 'ABORTED') {
      throw abortError(record);
    }
    const view = toView(record);
    return reply
      .status(view.status === 'COMPLETED' ? 200 : 202)
      .send({ requestId, ...view });
  });

  app.get('/internal/v1/transactions/:txId', async (request) => {
    assertInternalToken(request, options.internalToken);
    const params = z.object({ txId: z.string().min(1) }).parse(request.params);
    return options.service.view(params.txId);
  });

  app.get('/internal/v1/transactions', async (request) => {
    assertInternalToken(request, options.internalToken);
    const query = z
      .object({ status: z.enum(['unresolved']).default('unresolved'), limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(request.query);
    const records = await options.journal.listUnresolved(query.limit);
    return { status: 'success', transactions: records.map(toView) };
  });
}
