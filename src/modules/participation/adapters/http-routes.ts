import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ParticipantService } from '../application/participant-service';
import { assertInternalToken } from '../../../shared/infra/http';

const OpSchema = z.object({
  type: z.enum(['debit', 'credit']),
  accountId: z.string(),
  amount: z.number(),
});

const PrepareSchema = z.object({
  txId: z.string().min(1).max(120),
  gid: z.string().min(1).max(190),
  shardId: z.string().min(1),
  ops: z.array(OpSchema).min(1),
});

const ResolveSchema = z.object({
  txId: z.string().min(1).max(120),
  gid: z.string().min(1).max(190),
});

export interface ParticipantRoutesOptions {
  readonly service: ParticipantService;
  readonly internalToken: string;
}

export function registerParticipantRoutes(
  app: FastifyInstance,
  options: ParticipantRoutesOptions,
): void {
  app.post('/internal/v1/participants/prepare', async (request) => {
    assertInternalToken(request, options.internalToken);
    const body = PrepareSchema.parse(request.body);
    request.action = '2pc.prepare';
    return options.service.prepare(body.txId, body.gid, body.shardId, body.ops);
  });

  app.post('/internal/v1/participants/commit', async (request) => {
    assertInternalToken(request, options.internalToken);
    const body = ResolveSchema.parse(request.body);
    request.action = '2pc.commit';
    await options.service.commit(body.txId, body.gid);
    return { ack: 'DONE' };
  });

  app.post('/internal/v1/participants/abort', async (request) => {
    assertInternalToken(request, options.internalToken);
    const body = ResolveSchema.parse(request.body);
    request.action = '2pc.abort';
    await options.service.abort(body.txId, body.gid);
    return { ack: 'DONE' };
  });

  app.get('/internal/v1/participants/:txId', async (request) => {
    assertInternalToken(request, options.internalToken);
    const params = z.object({ txId: z.string().min(1) }).parse(request.params);
    const state = await options.service.getState(params.txId);
    return { status: 'success', txId: params.txId, state: state ?? 'UNKNOWN' };
  });
}
