import type { RateLimit, RateLimitPolicy } from '@lucid/ratelimit';
import type { Context, MiddlewareHandler } from 'hono';
import {
  createRateLimitGuard,
  mergeRateLimitHeaders,
  type RateLimitMiddlewareOptions,
} from './index.js';

export type HonoContextLike<Bindings extends object> = Pick<
  Context<{ Bindings: Bindings }>,
  'req' | 'env' | 'header'
>;

/** Structural Hono adapter. Hono is an optional peer dependency and is not loaded at runtime. */
export function honoRateLimit<
  Bindings extends object,
  Policies extends Record<string, RateLimitPolicy> = Record<string, RateLimitPolicy>,
>(
  limiter: RateLimit<Policies>,
  options: RateLimitMiddlewareOptions<Bindings, Policies, HonoContextLike<Bindings>>,
): MiddlewareHandler<{ Bindings: Bindings }> {
  const guard = createRateLimitGuard(limiter, options);
  return async (context, next) => {
    const outcome = await guard(context.req.raw, context.env, context);
    if (outcome.response) return outcome.response;
    for (const [name, value] of Object.entries(outcome.result.headers)) context.header(name, value);
    await next();
  };
}

/** Apply limiter headers to an already-produced Hono response. */
export function withHonoRateLimitHeaders(
  response: Response,
  headers: Readonly<Record<string, string>>,
): Response {
  return mergeRateLimitHeaders(response, headers);
}
