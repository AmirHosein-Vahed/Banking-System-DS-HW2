import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * A1 requires a configurable maximum number of simultaneous clients. The
 * gateway applies the public limit; shards apply their own smaller guard.
 *
 * Requests rejected by the limit never enter the counted set, so the counter
 * cannot drift negative when a rejected request completes.
 */
export function attachConcurrencyLimit(app: FastifyInstance, maxConcurrent: number): void {
  let active = 0;
  const counted = new WeakSet<FastifyRequest>();

  app.addHook('onRequest', async (request, reply) => {
    if (active >= maxConcurrent) {
      reply.header('retry-after', '1');
      await reply.status(503).send({
        status: 'error',
        code: 'OVERLOADED',
        message: `Server is at its configured limit of ${maxConcurrent} concurrent requests`,
        requestId: request.requestId ?? 'unknown',
      });
      return;
    }
    active += 1;
    counted.add(request);
  });

  app.addHook('onResponse', async (request) => {
    if (counted.has(request)) {
      counted.delete(request);
      active = Math.max(0, active - 1);
    }
  });
}

export function attachReplicaHeader(app: FastifyInstance, replicaId: string): void {
  app.addHook('onSend', async (_request, reply) => {
    reply.header('x-replica-id', replicaId);
  });
}
