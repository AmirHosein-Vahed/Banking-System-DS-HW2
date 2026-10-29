import pino, { type Logger } from 'pino';

export interface LoggerOptions {
  service: string;
  shard?: string;
  replica?: string;
  level?: string;
}

export function createLogger(options: LoggerOptions): Logger {
  return pino({
    level: options.level ?? process.env.LOG_LEVEL ?? 'info',
    base: {
      service: options.service,
      ...(options.shard === undefined ? {} : { shard: options.shard }),
      ...(options.replica === undefined ? {} : { replica: options.replica }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
