import { RateLimit } from '@lucid/ratelimit';
import type { RateLimitDurableObject } from '@lucid/ratelimit/durable-object';

export { RateLimitDurableObject } from '@lucid/ratelimit/durable-object';

interface Env {
  RATE_LIMITER: DurableObjectNamespace<RateLimitDurableObject>;
  // In a real service, validate this key against your authentication store first.
  API_KEY_TO_TENANT: KVNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const presentedKey = request.headers.get('Authorization')?.replace(/^Bearer\s+/iu, '');
    if (!presentedKey) return new Response('Unauthorized', { status: 401 });
    const tenant = await env.API_KEY_TO_TENANT.get(presentedKey);
    if (!tenant) return new Response('Unauthorized', { status: 401 });

    const limiter = new RateLimit({
      namespace: env.RATE_LIMITER,
      algorithm: 'token-bucket',
      capacity: 100,
      refillRate: 20,
      refillInterval: '1m',
      failureMode: 'closed',
    });
    const computeCost = new URL(request.url).pathname === '/v1/generate' ? 5 : 1;
    const idempotencyKey = request.headers.get('Idempotency-Key');
    const decision = await limiter.limit(`tenant:${tenant}`, {
      cost: computeCost,
      ...(idempotencyKey === null ? {} : { idempotencyKey }),
    });
    if (!decision.success) {
      return new Response(JSON.stringify({ error: decision.reason ?? 'rate_limited' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', ...decision.headers },
      });
    }
    return Response.json({ ok: true, tenant }, { headers: decision.headers });
  },
};
