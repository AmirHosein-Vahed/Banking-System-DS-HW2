import { randomUUID } from 'node:crypto';
import { Command } from 'commander';

interface ResponseBody {
  status?: string;
  code?: string;
  message?: string;
  [key: string]: unknown;
}

const program = new Command();
program
  .name('bankctl')
  .description('Banking client for the distributed banking platform')
  .version('0.1.0')
  .option('--gateway <url>', 'gateway URL', process.env.GATEWAY_URL ?? 'http://localhost:8080')
  .option('--json', 'print raw JSON', false)
  .option('--request-id <id>', 'explicit idempotency key')
  .option('--wait', 'wait for a pending transfer to resolve', false);

function gateway(): string {
  return program.opts<{ gateway: string }>().gateway.replace(/\/$/, '');
}

function requestId(): string {
  const opts = program.opts<{ requestId?: string }>();
  return opts.requestId ?? randomUUID();
}

async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<number> {
  const opts = program.opts<{ json: boolean }>();
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method === 'POST') {
    headers['content-type'] = 'application/json';
    headers['idempotency-key'] = requestId();
  }
  const response = await fetch(`${gateway()}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: ResponseBody = {};
  try {
    parsed = JSON.parse(text) as ResponseBody;
  } catch {
    process.stderr.write(`${text}\n`);
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(parsed, null, 2)}\n`);
  } else if (response.ok) {
    process.stdout.write(`${formatSuccess(parsed)}\n`);
  } else {
    process.stderr.write(
      `${parsed.code ?? response.status}: ${parsed.message ?? 'request failed'}\n`,
    );
  }

  if (response.status === 202 && parsed.txId !== undefined && program.opts<{ wait: boolean }>().wait) {
    return waitForTransaction(String(parsed.txId));
  }
  return response.ok ? 0 : 1;
}

function formatSuccess(body: ResponseBody): string {
  if (typeof body.balance === 'number' && typeof body.account === 'string') {
    return `${body.account}: ${body.balance}`;
  }
  if (body.from !== undefined && body.to !== undefined) {
    return JSON.stringify(body);
  }
  if (body.txId !== undefined) {
    return `${body.status}: ${String(body.txId)}`;
  }
  return JSON.stringify(body);
}

async function waitForTransaction(txId: string): Promise<number> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${gateway()}/v1/transactions/${txId}`, {
      headers: { accept: 'application/json' },
    });
    const body = (await response.json()) as ResponseBody;
    if (body.status === 'COMPLETED') {
      process.stdout.write(
        `transfer ${body.outcome === 'COMMITTED' ? 'committed' : 'aborted'}: ${txId}\n`,
      );
      return body.outcome === 'COMMITTED' ? 0 : 1;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  process.stderr.write(`transaction still pending after 30s: ${txId}\n`);
  return 2;
}

program
  .command('balance')
  .argument('<account>')
  .action(async (account: string) => {
    process.exitCode = await call('GET', `/v1/accounts/${encodeURIComponent(account)}/balance`);
  });

program
  .command('deposit')
  .argument('<account>')
  .argument('<amount>')
  .action(async (account: string, amount: string) => {
    process.exitCode = await call('POST', `/v1/accounts/${encodeURIComponent(account)}/deposits`, {
      amount: Number(amount),
    });
  });

program
  .command('withdraw')
  .argument('<account>')
  .argument('<amount>')
  .action(async (account: string, amount: string) => {
    process.exitCode = await call('POST', `/v1/accounts/${encodeURIComponent(account)}/withdrawals`, {
      amount: Number(amount),
    });
  });

program
  .command('transfer')
  .argument('<from>')
  .argument('<to>')
  .argument('<amount>')
  .action(async (from: string, to: string, amount: string) => {
    process.exitCode = await call('POST', '/v1/transfers', {
      from,
      to,
      amount: Number(amount),
    });
  });

program
  .command('status')
  .argument('<txId>')
  .action(async (txId: string) => {
    process.exitCode = await call('GET', `/v1/transactions/${encodeURIComponent(txId)}`);
  });

program.parseAsync(process.argv).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
