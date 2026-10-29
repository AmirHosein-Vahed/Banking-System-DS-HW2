import { beforeAll, describe, expect, it } from 'vitest';

const gateway = process.env.GATEWAY_URL ?? 'http://localhost:8080';

interface ApiResponse {
  status: number;
  body: Record<string, unknown>;
}

async function call(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<ApiResponse> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  if (idempotencyKey !== undefined) {
    headers['idempotency-key'] = idempotencyKey;
  }
  const response = await fetch(`${gateway}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const parsed = text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>);
  return { status: response.status, body: parsed };
}

const balanceOf = async (account: string): Promise<number> => {
  const response = await call('GET', `/v1/accounts/${account}/balance`);
  expect(response.status).toBe(200);
  return Number(response.body.balance);
};

const key = (prefix: string): string => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

let available = false;

beforeAll(async () => {
  try {
    const response = await fetch(`${gateway}/healthz`, { signal: AbortSignal.timeout(1500) });
    available = response.ok;
  } catch {
    available = false;
  }

  if (!available && process.env.RUN_INTEGRATION === '1') {
    throw new Error(`Integration tests require a running gateway at ${gateway}`);
  }
});

describe('gateway integration', () => {
  it('reports the shard map and all four replicas', async () => {
    if (!available) {
      return;
    }
    const status = await call('GET', '/v1/status');
    expect(status.status).toBe(200);
    expect(status.body.shardMapVersion).toBe(1);
    expect(status.body.replicas).toHaveLength(4);
    expect((status.body.replicas as { healthy: boolean }[]).every((r) => r.healthy)).toBe(true);
  });

  it('reads balances from the owning shard', async () => {
    if (!available) {
      return;
    }
    const a = await call('GET', '/v1/accounts/A0100/balance');
    const b = await call('GET', '/v1/accounts/A1100/balance');
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.account).toBe('A0100');
    expect(b.body.account).toBe('A1100');
  });

  it('returns 404 for an account outside the shard map', async () => {
    if (!available) {
      return;
    }
    const response = await call('GET', '/v1/accounts/A9999/balance');
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('ACCOUNT_NOT_FOUND');
  });

  it('replays a deposit idempotently and rejects a different payload', async () => {
    if (!available) {
      return;
    }
    const idempotencyKey = key('itest-dep');
    const before = await balanceOf('A0800');

    const first = await call('POST', '/v1/accounts/A0800/deposits', { amount: 10 }, idempotencyKey);
    const replay = await call('POST', '/v1/accounts/A0800/deposits', { amount: 10 }, idempotencyKey);
    const conflict = await call('POST', '/v1/accounts/A0800/deposits', { amount: 11 }, idempotencyKey);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(Number(first.body.balance)).toBe(before + 10);
    expect(Number(replay.body.balance)).toBe(before + 10);
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await balanceOf('A0800')).toBe(before + 10);
  });

  it('rejects a withdrawal above the balance', async () => {
    if (!available) {
      return;
    }
    const response = await call('POST', '/v1/accounts/A0800/withdrawals', { amount: 10_000_000 }, key('itest-wd'));
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('moves money inside one shard atomically', async () => {
    if (!available) {
      return;
    }
    const from = 'A0300';
    const to = 'A0301';
    const beforeFrom = await balanceOf(from);
    const beforeTo = await balanceOf(to);

    const response = await call('POST', '/v1/transfers', { from, to, amount: 7 }, key('itest-local'));
    expect(response.status).toBe(200);
    expect(await balanceOf(from)).toBe(beforeFrom - 7);
    expect(await balanceOf(to)).toBe(beforeTo + 7);
  });

  it('moves money across shards with two-phase commit', async () => {
    if (!available) {
      return;
    }
    const from = 'A0700';
    const to = 'A1700';
    const beforeFrom = await balanceOf(from);
    const beforeTo = await balanceOf(to);

    const response = await call('POST', '/v1/transfers', { from, to, amount: 25 }, key('itest-cross'));
    expect(response.status).toBe(200);
    expect(response.body.outcome).toBe('COMMITTED');
    expect(typeof response.body.txId).toBe('string');
    expect(await balanceOf(from)).toBe(beforeFrom - 25);
    expect(await balanceOf(to)).toBe(beforeTo + 25);

    const status = await call('GET', `/v1/transactions/${String(response.body.txId)}`);
    expect(status.status).toBe(200);
    expect(status.body.status).toBe('COMPLETED');
    expect(status.body.votes).toEqual({ A: 'YES', B: 'YES' });
  });

  it('aborts the whole transfer when one shard rejects it', async () => {
    if (!available) {
      return;
    }
    const from = 'A0700';
    const to = 'A1700';
    const beforeFrom = await balanceOf(from);
    const beforeTo = await balanceOf(to);

    const response = await call('POST', '/v1/transfers', { from, to, amount: 10_000_000 }, key('itest-abort'));
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('INSUFFICIENT_FUNDS');
    expect(await balanceOf(from)).toBe(beforeFrom);
    expect(await balanceOf(to)).toBe(beforeTo);
  });

  it('keeps all balances exact under concurrent opposite transfers', async () => {
    if (!available) {
      return;
    }
    const from = 'A0700';
    const to = 'A1700';
    const beforeFrom = await balanceOf(from);
    const beforeTo = await balanceOf(to);

    const requests: Promise<ApiResponse>[] = [];
    for (let index = 0; index < 20; index += 1) {
      requests.push(call('POST', '/v1/transfers', { from, to, amount: 1 }, key('itest-c1')));
      requests.push(call('POST', '/v1/transfers', { from: to, to: from, amount: 1 }, key('itest-c2')));
    }
    const results = await Promise.all(requests);

    expect(results.filter((result) => result.status === 200)).toHaveLength(40);
    expect(await balanceOf(from)).toBe(beforeFrom);
    expect(await balanceOf(to)).toBe(beforeTo);
  });

  it('rejects malformed input with 400', async () => {
    if (!available) {
      return;
    }
    const response = await call('POST', '/v1/accounts/A0100/deposits', { amount: -5 });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
  });
});
