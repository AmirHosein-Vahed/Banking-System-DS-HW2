import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { newId } from '../domain/ids';
import { isAppError, unauthorized } from '../domain/errors';

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
    startedAt: number;
    action?: string;
    account?: string;
  }
}

interface LoggerLike {
  info(fields: object, message?: string): void;
  warn(fields: object, message?: string): void;
  error(fields: object, message?: string): void;
}

export function attachRequestLogging(app: FastifyInstance, logger: LoggerLike): void {
  app.addHook('onRequest', async (request, reply) => {
    request.requestId =
      typeof request.headers['x-request-id'] === 'string' && request.headers['x-request-id'].length > 0
        ? request.headers['x-request-id']
        : newId();
    request.startedAt = Date.now();
    reply.header('x-request-id', request.requestId);
    logger.info(
      {
        event: 'request',
        requestId: request.requestId,
        method: request.method,
        url: request.url,
        clientIp: request.ip,
        forwardedFor: request.headers['x-forwarded-for'],
      },
      'request received',
    );
  });

  app.addHook('onResponse', async (request, reply) => {
    logger.info(
      {
        event: 'response',
        requestId: request.requestId,
        method: request.method,
        url: request.url,
        clientIp: request.ip,
        action: request.action,
        account: request.account,
        statusCode: reply.statusCode,
        result: reply.statusCode < 400 ? 'success' : 'error',
        latencyMs: Date.now() - request.startedAt,
      },
      'response sent',
    );
  });
}

export function registerErrorHandler(app: FastifyInstance, logger: LoggerLike): void {
  app.setErrorHandler((error, request, reply) => {
    const requestId = request.requestId ?? 'unknown';

    if (error instanceof ZodError) {
      logger.warn({ requestId, issues: error.issues }, 'validation failed');
      return reply.status(400).send({
        status: 'error',
        code: 'VALIDATION_ERROR',
        message: error.issues.map((issue) => issue.message).join('; '),
        requestId,
      });
    }

    if (isAppError(error)) {
      logger.warn({ requestId, code: error.code, details: error.details }, error.message);
      return reply.status(error.httpStatus).send({
        status: 'error',
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
        requestId,
      });
    }

    const fastifyError = error as { code?: string; statusCode?: number; message?: string };
    if (fastifyError.statusCode !== undefined && fastifyError.statusCode < 500) {
      return reply.status(fastifyError.statusCode).send({
        status: 'error',
        code: 'VALIDATION_ERROR',
        message: fastifyError.message ?? 'Invalid request',
        requestId,
      });
    }

    logger.error({ requestId, err: error }, 'unhandled error');
    return reply.status(500).send({
      status: 'error',
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      requestId,
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      status: 'error',
      code: 'UNSUPPORTED_OPERATION',
      message: `No route for ${request.method} ${request.url}`,
      requestId: request.requestId ?? 'unknown',
    });
  });
}

export function assertInternalToken(request: FastifyRequest, expected: string): void {
  const supplied = request.headers['x-internal-token'];
  if (typeof supplied !== 'string' || supplied !== expected) {
    throw unauthorized();
  }
}
