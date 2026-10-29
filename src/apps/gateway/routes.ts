import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ShardMap } from '../../modules/routing/domain/shard-map';
import type { ShardClient } from '../../modules/routing/adapters/shard-client';
import type { CoordinatorClient } from '../../modules/coordination/adapters/coordinator-client';
import type { HealthRegistry } from '../../modules/routing/application/health-registry';
import { assertAccountId, parseAmount } from '../../shared/domain/money';
import { newId } from '../../shared/domain/ids';
import { validationError } from '../../shared/domain/errors';

const AmountBody = z.object({ amount: z.number() });
const TransferBody = z.object({
  from: z.string(),
  to: z.string(),
  amount: z.number(),
});

interface AccountBalanceResponse {
  status: 'success';
  requestId: string;
  accountId: string;
  balance: number;
}

interface LocalTransferResponse {
  status: 'success';
  requestId: string;
  from: { accountId: string; balance: number };
  to: { accountId: string; balance: number };
}

export interface GatewayRoutesOptions {
  readonly shardMap: ShardMap;
  readonly shardClient: ShardClient;
  readonly coordinatorClient: CoordinatorClient;
  readonly health: HealthRegistry;
}

function idempotencyKey(request: FastifyRequest): string {
  const header = request.headers['idempotency-key'];
  return typeof header === 'string' && header.length > 0 && header.length <= 200 ? header : newId();
}

function routeHeaders(reply: FastifyReply, shardId: string, replicaId: string): void {
  reply.header('x-shard-id', shardId);
  reply.header('x-replica-id', replicaId);
}

export function registerGatewayRoutes(app: FastifyInstance, options: GatewayRoutesOptions): void {
  app.get('/v1/accounts/:accountId/balance', async (request, reply) => {
    const params = z.object({ accountId: z.string() }).parse(request.params);
    const accountId = assertAccountId(params.accountId);
    request.action = 'balance';
    request.account = accountId;
    const shard = options.shardMap.resolve(accountId);
    const result = await options.shardClient.call<AccountBalanceResponse>(
      shard.id,
      'GET',
      `/internal/v1/accounts/${accountId}/balance`,
      undefined,
      request,
    );
    routeHeaders(reply, result.shardId, result.replicaId);
    return {
      status: 'success',
      requestId: request.requestId,
      account: accountId,
      balance: result.body.balance,
    };
  });

  app.post('/v1/accounts/:accountId/deposits', async (request, reply) => {
    const params = z.object({ accountId: z.string() }).parse(request.params);
    const body = AmountBody.parse(request.body);
    const accountId = assertAccountId(params.accountId);
    const amount = parseAmount(body.amount);
    const requestId = idempotencyKey(request);
    request.action = 'deposit';
    request.account = accountId;
    const shard = options.shardMap.resolve(accountId);
    const result = await options.shardClient.call<AccountBalanceResponse>(
      shard.id,
      'POST',
      `/internal/v1/accounts/${accountId}/deposit`,
      { amount, requestId },
      request,
    );
    routeHeaders(reply, result.shardId, result.replicaId);
    return {
      status: 'success',
      requestId,
      account: accountId,
      balance: result.body.balance,
    };
  });

  app.post('/v1/accounts/:accountId/withdrawals', async (request, reply) => {
    const params = z.object({ accountId: z.string() }).parse(request.params);
    const body = AmountBody.parse(request.body);
    const accountId = assertAccountId(params.accountId);
    const amount = parseAmount(body.amount);
    const requestId = idempotencyKey(request);
    request.action = 'withdraw';
    request.account = accountId;
    const shard = options.shardMap.resolve(accountId);
    const result = await options.shardClient.call<AccountBalanceResponse>(
      shard.id,
      'POST',
      `/internal/v1/accounts/${accountId}/withdraw`,
      { amount, requestId },
      request,
    );
    routeHeaders(reply, result.shardId, result.replicaId);
    return {
      status: 'success',
      requestId,
      account: accountId,
      balance: result.body.balance,
    };
  });

  app.post('/v1/transfers', async (request, reply) => {
    const body = TransferBody.parse(request.body);
    const from = assertAccountId(body.from);
    const to = assertAccountId(body.to);
    const amount = parseAmount(body.amount);
    if (from === to) {
      throw validationError('from and to must be different accounts');
    }
    const requestId = idempotencyKey(request);
    request.action = 'transfer';
    request.account = from;

    const fromShard = options.shardMap.resolve(from);
    const toShard = options.shardMap.resolve(to);

    if (fromShard.id === toShard.id) {
      const result = await options.shardClient.call<LocalTransferResponse>(
        fromShard.id,
        'POST',
        '/internal/v1/local-transfers',
        { from, to, amount, requestId },
        request,
      );
      routeHeaders(reply, result.shardId, result.replicaId);
      return {
        status: 'success',
        requestId,
        from: result.body.from,
        to: result.body.to,
      };
    }

    const view = await options.coordinatorClient.transfer({
      from,
      to,
      amount,
      requestId,
      requestIdForLogs: request.requestId,
      clientIp: request.ip,
    });
    if (view.status === 'COMPLETED') {
      return reply.status(200).send({
        status: 'success',
        requestId,
        txId: view.txId,
        from,
        to,
        amount,
        outcome: view.outcome,
      });
    }
    return reply.status(202).send({
      status: 'pending',
      requestId,
      txId: view.txId,
      statusUrl: `/v1/transactions/${view.txId}`,
    });
  });

  app.get('/v1/transactions/:txId', async (request) => {
    const params = z.object({ txId: z.string().min(1) }).parse(request.params);
    const view = await options.coordinatorClient.status(params.txId);
    return view;
  });

  app.get('/v1/status', async () => ({
    status: 'ok',
    shardMapVersion: options.shardMap.version,
    shardMapFingerprint: options.shardMap.fingerprint(),
    replicas: options.health.snapshot(),
  }));
}
