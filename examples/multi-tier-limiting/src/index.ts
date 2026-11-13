import { RateLimit } from '@lucid/ratelimit';
import type { RateLimitDurableObject } from '@lucid/ratelimit/durable-object';

export { RateLimitDurableObject } from '@lucid/ratelimit/durable-object';

interface Env {
  RATE_LIMITER: DurableObjectNamespace<RateLimitDurableObject>;
  USERS: KVNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const apiKey = request.headers.get('Authorization')?.replace(/^Bearer\s+/iu, '');
    if (!apiKey) return new Response('Unauthorized', { status: 401 });
    const userId = await env.USERS.get(`api-key:${apiKey}`);
    if (!userId) return new Response('Unauthorized', { status: 401 });
    const tier = (await env.USERS.get(`tier:${userId}`)) ?? 'anonymous';
    const limiter = new RateLimit({
      namespace: env.RATE_LIMITER,
      policies: {
        anonymous: { algorithm: 'sliding-window', limit: 20, window: '1m' },
        free: { algorithm: 'sliding-window', limit: 100, window: '1m' },
        pro: { algorithm: 'token-bucket', capacity: 1_000, refillRate: 100, refillInterval: '1m' },
      },
    });
    const selected = tier === 'pro' ? 'pro' : tier === 'free' ? 'free' : 'anonymous';
    const result = await limiter.limit(`user:${userId}`, { policy: selected });
    if (!result.success)
      return new Response('Too many requests', { status: 429, headers: result.headers });
    return Response.json({ ok: true }, { headers: result.headers });
  },
};
