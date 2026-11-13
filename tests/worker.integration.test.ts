import { env } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  RateLimit,
  RateLimitConfigurationError,
  type RateLimitNamespaceLike,
} from '@lucid/ratelimit';
import { withRateLimit } from '@lucid/ratelimit-middleware';
import { honoRateLimit } from '@lucid/ratelimit-middleware/hono';
import type { RateLimitDurableObject } from '@lucid/ratelimit/durable-object';

interface TestEnvironment {
  RATE_LIMITER: DurableObjectNamespace<RateLimitDurableObject>;
}

const binding = (env as unknown as TestEnvironment).RATE_LIMITER;

function makeLimiter(limit: number, scope = 'integration') {
  return new RateLimit({
    namespace: binding,
    scope,
    algorithm: 'fixed-window',
    limit,
    window: '1m',
  });
}

async function durableShardId(identity: string, scope = 'integration'): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([scope, identity]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const identityDigest = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `lucid-ratelimit:v1:${identityDigest.slice(0, 2)}`;
}

async function identityDigest(identity: string, scope: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([scope, identity]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('Worker to SQLite Durable Object', () => {
  it('atomically grants no more than the configured capacity under concurrent clients', async () => {
    const key = `concurrent:${crypto.randomUUID()}`;
    const clients = [makeLimiter(12), makeLimiter(12)];
    const outcomes = await Promise.all(
      Array.from({ length: 80 }, (_, index) => clients[index % clients.length]?.limit(key)),
    );
    expect(outcomes.filter((result) => result?.success)).toHaveLength(12);
    expect(outcomes.filter((result) => !result?.success)).toHaveLength(68);
  });

  it('persists quota across Durable Object eviction', async () => {
    const key = `persist:${crypto.randomUUID()}`;
    const limiter = makeLimiter(2);
    expect((await limiter.limit(key)).success).toBe(true);
    const stub = binding.get(binding.idFromName(await durableShardId(key)));
    await evictDurableObject(stub as unknown as DurableObjectStub<RateLimitDurableObject>);
    expect((await limiter.limit(key)).remaining).toBe(0);
    expect((await limiter.limit(key)).success).toBe(false);
  });

  it('runs expiry cleanup through the Durable Object alarm without a real-time sleep', async () => {
    const key = `alarm-cleanup:${crypto.randomUUID()}`;
    const scope = 'alarm-cleanup-test';
    const digest = await identityDigest(key, scope);
    const limiter = new RateLimit({
      namespace: binding,
      scope,
      algorithm: 'fixed-window',
      limit: 1,
      window: '1m',
    });
    expect((await limiter.limit(key)).success).toBe(true);
    const shardName = `lucid-ratelimit:v1:${digest.slice(0, 2)}`;
    const stub = binding.get(binding.idFromName(shardName));
    const doStub = stub as unknown as DurableObjectStub;
    const before = await runInDurableObject(doStub, (_instance, state) => {
      const rows = state.storage.sql
        .exec<{ count: number }>(
          'SELECT COUNT(*) AS count FROM rate_limit_buckets WHERE owner_key = ?',
          digest,
        )
        .toArray();
      state.storage.sql.exec(
        'UPDATE rate_limit_buckets SET expires_at = ? WHERE owner_key = ?',
        Date.now() - 1,
        digest,
      );
      state.storage.sql.exec(
        'UPDATE rate_limit_identities SET expires_at = ? WHERE owner_key = ?',
        Date.now() - 1,
        digest,
      );
      return rows[0]?.count ?? 0;
    });
    expect(before).toBe(1);
    expect(await runDurableObjectAlarm(doStub)).toBe(true);
    const after = await runInDurableObject(
      doStub,
      (_instance, state) =>
        state.storage.sql
          .exec<{ count: number }>(
            'SELECT COUNT(*) AS count FROM rate_limit_buckets WHERE owner_key = ?',
            digest,
          )
          .toArray()[0]?.count ?? 0,
    );
    expect(after).toBe(0);
  });

  it('returns the original decision for an idempotent retry', async () => {
    const key = `idempotent:${crypto.randomUUID()}`;
    const limiter = makeLimiter(1);
    const first = await limiter.limit(key, { idempotencyKey: 'request-123' });
    const retry = await limiter.limit(key, { idempotencyKey: 'request-123' });
    const next = await limiter.limit(key, { idempotencyKey: 'request-124' });
    expect(first.success).toBe(true);
    expect(retry.success).toBe(true);
    expect(next.success).toBe(false);
  });

  it('rejects reuse of an idempotency key with different request parameters', async () => {
    const key = `idempotency-conflict:${crypto.randomUUID()}`;
    const limiter = makeLimiter(10);
    await limiter.limit(key, { cost: 1, idempotencyKey: 'same-key' });
    await expect(
      limiter.limit(key, { cost: 2, idempotencyKey: 'same-key' }),
    ).rejects.toBeInstanceOf(RateLimitConfigurationError);
  });

  it('isolates application scopes that share the same binding', async () => {
    const key = `scope:${crypto.randomUUID()}`;
    const one = makeLimiter(1, 'app-one');
    const two = makeLimiter(1, 'app-two');
    expect((await one.limit(key)).success).toBe(true);
    expect((await one.limit(key)).success).toBe(false);
    expect((await two.limit(key)).success).toBe(true);
  });

  it('does not partially consume a composite policy when one constraint rejects', async () => {
    const key = `composite:${crypto.randomUUID()}`;
    const limiter = new RateLimit({
      namespace: binding,
      scope: 'integration-composite',
      policies: {
        combined: {
          constraints: [
            { algorithm: 'fixed-window', limit: 2, window: '1m' },
            { algorithm: 'sliding-window', limit: 3, window: '1m' },
          ],
        },
      },
    });
    const first = await limiter.limit(key, { cost: 2 });
    const denied = await limiter.limit(key, { cost: 1 });
    const deniedAgain = await limiter.limit(key, { cost: 1 });
    expect(first.success).toBe(true);
    expect(denied.success).toBe(false);
    expect(denied.constraints?.map((constraint) => constraint.success)).toEqual([false, true]);
    expect(denied.constraints?.[1]?.remaining).toBe(1);
    expect(deniedAgain.constraints?.[1]?.remaining).toBe(1);
  });

  it('runs the vanilla Worker middleware against the real Durable Object binding', async () => {
    const key = `vanilla-middleware:${crypto.randomUUID()}`;
    const limiter = makeLimiter(1, 'vanilla-middleware');
    const handler = withRateLimit(limiter, { key: () => key }, async () => new Response('handled'));
    const request = new Request('https://example.test/');
    const context = {} as ExecutionContext;
    const first = await handler(request, {}, context);
    const second = await handler(request, {}, context);
    expect(first.status).toBe(200);
    expect(first.headers.get('RateLimit-Remaining')).toBe('0');
    expect(second.status).toBe(429);
    expect(second.headers.get('Retry-After')).toBeTruthy();
  });

  it('runs the Hono adapter and forwards headers or a 429 response', async () => {
    const key = `hono-middleware:${crypto.randomUUID()}`;
    const limiter = makeLimiter(1, 'hono-middleware');
    const app = new Hono();
    app.use('*', honoRateLimit<object>(limiter, { key: () => key }));
    app.get('/api', (context) => context.text('handled'));
    const first = await app.request('/api');
    const second = await app.request('/api');
    expect(first.status).toBe(200);
    expect(first.headers.get('RateLimit-Remaining')).toBe('0');
    expect(second.status).toBe(429);
  });
});

describe('failure strategy', () => {
  const failingNamespace: RateLimitNamespaceLike = {
    idFromName: (name) => name,
    get: () => ({
      limit: async () => {
        throw new Error('simulated binding failure');
      },
    }),
  };

  it('fails closed with an explicit degraded result', async () => {
    const limiter = new RateLimit({
      namespace: failingNamespace,
      algorithm: 'fixed-window',
      limit: 1,
      window: '1s',
    });
    const result = await limiter.limit('user:1');
    expect(result.success).toBe(false);
    expect(result.enforced).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.reason).toBe('rate_limit_unavailable');
    expect(result.headers['Retry-After']).toBe('1');
  });

  it('fails open only when explicitly configured and still marks the decision degraded', async () => {
    let reported = false;
    const limiter = new RateLimit({
      namespace: failingNamespace,
      algorithm: 'fixed-window',
      limit: 1,
      window: '1s',
      failureMode: 'open',
      onError: (error) => {
        reported = error.name === 'RateLimitUnavailableError';
      },
    });
    const result = await limiter.limit('user:1');
    expect(result.success).toBe(true);
    expect(result.enforced).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.headers).toEqual({});
    expect(reported).toBe(true);
  });

  it('uses the failure mode when an actual Durable Object storage write fails', async () => {
    const key = `storage-failure:${crypto.randomUUID()}`;
    const scope = 'storage-failure-test';
    const digest = await identityDigest(key, scope);
    const shardName = `lucid-ratelimit:v1:${digest.slice(0, 2)}`;
    const stub = binding.get(binding.idFromName(shardName));
    const doStub = stub as unknown as DurableObjectStub;
    await runInDurableObject(doStub, (_instance, state) => {
      state.storage.sql.exec(`
        CREATE TRIGGER codex_test_fail_bucket
        BEFORE INSERT ON rate_limit_buckets
        WHEN NEW.owner_key = '${digest}'
        BEGIN
          SELECT RAISE(ABORT, 'simulated storage failure');
        END;
      `);
    });

    let errorReported = false;
    const limiter = new RateLimit({
      namespace: binding,
      scope,
      algorithm: 'fixed-window',
      limit: 1,
      window: '1m',
      onError: (error) => {
        errorReported = error.name === 'RateLimitUnavailableError';
      },
    });
    const result = await limiter.limit(key);
    const openLimiter = new RateLimit({
      namespace: binding,
      scope,
      algorithm: 'fixed-window',
      limit: 1,
      window: '1m',
      failureMode: 'open',
    });
    const openResult = await openLimiter.limit(key);
    await runInDurableObject(doStub, (_instance, state) => {
      state.storage.sql.exec('DROP TRIGGER codex_test_fail_bucket');
    });

    expect(result.success).toBe(false);
    expect(result.enforced).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.reason).toBe('rate_limit_unavailable');
    expect(result.failureCode).toBe('durable_object_storage');
    expect(errorReported).toBe(true);
    expect(openResult.success).toBe(true);
    expect(openResult.enforced).toBe(false);
    expect(openResult.degraded).toBe(true);
    expect(openResult.headers).toEqual({});
  });
});
