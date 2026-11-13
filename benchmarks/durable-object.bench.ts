import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { RateLimit, type RateLimitNamespaceLike } from '@lucid/ratelimit';

const namespace = (env as unknown as { RATE_LIMITER: RateLimitNamespaceLike }).RATE_LIMITER;

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

async function measure(
  label: string,
  requestCount: number,
  identityAt: (index: number) => string,
): Promise<void> {
  const scope = `benchmark-${crypto.randomUUID()}-${label}`;
  const limiter = new RateLimit({
    namespace,
    scope,
    algorithm: 'fixed-window',
    limit: 2_000,
    window: '1m',
  });
  const identities = Array.from({ length: requestCount }, (_, index) => identityAt(index));
  const activeKeys = new Set(identities).size;
  const shardNames = new Set<string>();
  for (const identity of identities) {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify([scope, identity])),
    );
    const identityDigest = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    shardNames.add(`lucid-ratelimit:v1:${identityDigest.slice(0, 2)}`);
  }
  const readStorageBytes = async (): Promise<number> => {
    const sizes = await Promise.all(
      [...shardNames].map((shardName) => {
        const stub = namespace.get(namespace.idFromName(shardName));
        return runInDurableObject(
          stub as unknown as DurableObjectStub,
          (_instance, state) => state.storage.sql.databaseSize,
        );
      }),
    );
    return sizes.reduce((sum, size) => sum + size, 0);
  };
  const beforeBytes = await readStorageBytes();
  await Promise.all(identities.map((identity) => limiter.limit(identity)));
  const afterWarmupBytes = await readStorageBytes();
  const latencies: number[] = [];
  const overallStart = performance.now();
  const results = await Promise.all(
    identities.map(async (identity) => {
      const started = performance.now();
      const result = await limiter.limit(identity);
      latencies.push(performance.now() - started);
      return result;
    }),
  );
  const elapsedMs = performance.now() - overallStart;
  const output = {
    label,
    activeKeys,
    requests: requestCount,
    warmupRequests: requestCount,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    requestsPerSecond: Math.round(requestCount / (elapsedMs / 1_000)),
    latencyMs: {
      p50: Number(percentile(latencies, 0.5).toFixed(3)),
      p95: Number(percentile(latencies, 0.95).toFixed(3)),
      p99: Number(percentile(latencies, 0.99).toFixed(3)),
    },
    allowed: results.filter((result) => result.success).length,
    databaseBytesBefore: beforeBytes,
    databaseBytesAfterWarmup: afterWarmupBytes,
    bytesAddedForActiveIdentities: Math.max(0, afterWarmupBytes - beforeBytes),
    approximateBytesPerActiveIdentity: Number(
      (Math.max(0, afterWarmupBytes - beforeBytes) / activeKeys).toFixed(2),
    ),
  };
  console.log(JSON.stringify(output));
  expect(results).toHaveLength(requestCount);
  expect(output.allowed).toBe(requestCount);
}

describe('local Worker-to-Durable-Object benchmark', () => {
  it('measures multiple active-key populations and same-key contention', async () => {
    await measure('independent-identities', 64, (index) => `independent:${index}`);
    await measure('independent-identities', 256, (index) => `independent:${index}`);
    await measure('independent-identities', 1_024, (index) => `independent:${index}`);
    await measure('same-identity-contention', 256, () => 'single-hot-identity');
  });
});
