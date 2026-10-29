import { randomUUID } from 'node:crypto';

interface Options {
  url: string;
  action: 'balance' | 'deposit' | 'withdraw' | 'transfer';
  account: string;
  to: string;
  amount: number;
  count: number;
  concurrency: number;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    url: process.env.GATEWAY_URL ?? 'http://localhost:8080',
    action: 'balance',
    account: 'A0500',
    to: 'A1500',
    amount: 1,
    count: 100,
    concurrency: 20,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === undefined || value === undefined) {
      continue;
    }
    if (key === '--url') options.url = value;
    if (key === '--action') options.action = value as Options['action'];
    if (key === '--account') options.account = value;
    if (key === '--to') options.to = value;
    if (key === '--amount') options.amount = Number(value);
    if (key === '--count') options.count = Number(value);
    if (key === '--concurrency') options.concurrency = Number(value);
    index += 1;
  }
  return options;
}

function pathFor(options: Options): { method: 'GET' | 'POST'; path: string; body?: unknown } {
  switch (options.action) {
    case 'balance':
      return {
        method: 'GET',
        path: `/v1/accounts/${encodeURIComponent(options.account)}/balance`,
      };
    case 'deposit':
      return {
        method: 'POST',
        path: `/v1/accounts/${encodeURIComponent(options.account)}/deposits`,
        body: { amount: options.amount },
      };
    case 'withdraw':
      return {
        method: 'POST',
        path: `/v1/accounts/${encodeURIComponent(options.account)}/withdrawals`,
        body: { amount: options.amount },
      };
    case 'transfer':
      return {
        method: 'POST',
        path: '/v1/transfers',
        body: { from: options.account, to: options.to, amount: options.amount },
      };
  }
}

interface Result {
  status: number;
  code?: string;
  replica?: string;
  shard?: string;
  balance?: number;
  txStatus?: string;
}

async function runOne(options: Options): Promise<Result> {
  const request = pathFor(options);
  const headers: Record<string, string> = {
    accept: 'application/json',
    'idempotency-key': randomUUID(),
  };
  if (request.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  try {
    const response = await fetch(`${options.url}${request.path}`, {
      method: request.method,
      headers,
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    });
    const body = (await response.json()) as {
      code?: string;
      balance?: number;
      status?: string;
    };
    return {
      status: response.status,
      ...(body.code === undefined ? {} : { code: body.code }),
      ...(response.headers.get('x-replica-id') === null
        ? {}
        : { replica: response.headers.get('x-replica-id') ?? undefined }),
      ...(response.headers.get('x-shard-id') === null
        ? {}
        : { shard: response.headers.get('x-shard-id') ?? undefined }),
      ...(typeof body.balance === 'number' ? { balance: body.balance } : {}),
      ...(typeof body.status === 'string' ? { txStatus: body.status } : {}),
    };
  } catch (error) {
    return { status: 0, code: error instanceof Error ? error.message : String(error) };
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const results: Result[] = new Array(options.count);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= options.count) {
        return;
      }
      results[index] = await runOne(options);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, options.count) }, () => worker()),
  );

  const replicas: Record<string, number> = {};
  const statuses: Record<string, number> = {};
  const codes: Record<string, number> = {};
  for (const result of results) {
    replicas[result.replica ?? '(none)'] = (replicas[result.replica ?? '(none)'] ?? 0) + 1;
    statuses[String(result.status)] = (statuses[String(result.status)] ?? 0) + 1;
    if (result.code !== undefined) {
      codes[result.code] = (codes[result.code] ?? 0) + 1;
    }
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        action: options.action,
        count: options.count,
        concurrency: options.concurrency,
        durationMs: Date.now() - started,
        replicas,
        statuses,
        codes,
        finalBalance: results[results.length - 1]?.balance,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
