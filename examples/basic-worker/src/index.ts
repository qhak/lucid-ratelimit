import { RateLimit } from '@lucid/ratelimit';
import { withRateLimit } from '@lucid/ratelimit-middleware';
import type { RateLimitDurableObject } from '@lucid/ratelimit/durable-object';

export { RateLimitDurableObject } from '@lucid/ratelimit/durable-object';

interface Env {
  RATE_LIMITER: DurableObjectNamespace<RateLimitDurableObject>;
}

export default {
  fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    const limiter = new RateLimit({
      namespace: env.RATE_LIMITER,
      algorithm: 'sliding-window',
      limit: 60,
      window: '1m',
    });
    const handle = withRateLimit(
      limiter,
      {
        key: (incoming) => {
          const ip = incoming.headers.get('CF-Connecting-IP');
          if (!ip) throw new Error('Cloudflare did not provide CF-Connecting-IP');
          return `ip:${ip}`;
        },
      },
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    return handle(request, env, context);
  },
};
