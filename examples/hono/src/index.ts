import { Hono } from 'hono';
import { RateLimit } from '@lucid/ratelimit';
import { honoRateLimit } from '@lucid/ratelimit-middleware/hono';
import type { RateLimitDurableObject } from '@lucid/ratelimit/durable-object';

export { RateLimitDurableObject } from '@lucid/ratelimit/durable-object';

interface Env {
  RATE_LIMITER: DurableObjectNamespace<RateLimitDurableObject>;
}

function createApp(env: Env): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  const limiter = new RateLimit({
    namespace: env.RATE_LIMITER,
    algorithm: 'sliding-window',
    limit: 120,
    window: '1m',
  });
  app.use(
    '/api/*',
    honoRateLimit(limiter, {
      key: (request) => {
        const ip = request.headers.get('CF-Connecting-IP');
        if (!ip) throw new Error('Cloudflare did not provide CF-Connecting-IP');
        return `ip:${ip}`;
      },
      body: { error: 'rate_limited' },
    }),
  );
  app.get('/api/ping', (context) => context.json({ ok: true }));
  return app;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return createApp(env).fetch(request, env);
  },
};
