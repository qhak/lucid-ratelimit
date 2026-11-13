import type {
  LimitOptions,
  RateLimit,
  RateLimitEvent,
  RateLimitPolicy,
  RateLimitResult,
} from '@lucid/ratelimit';

export type MiddlewareContext<Env> = ExecutionContext & { readonly env?: Env };

export interface RateLimitMiddlewareOptions<
  Env,
  Policies extends Record<string, RateLimitPolicy> = Record<string, RateLimitPolicy>,
  Context = MiddlewareContext<Env>,
> {
  /** Resolve identity from authenticated application state or a trusted proxy value. */
  readonly key: (request: Request, env: Env, context: Context) => string | Promise<string>;
  readonly policy?:
    | (keyof Policies & string)
    | ((
        request: Request,
        env: Env,
        context: Context,
      ) => (keyof Policies & string) | undefined | Promise<(keyof Policies & string) | undefined>);
  readonly cost?:
    number | ((request: Request, env: Env, context: Context) => number | Promise<number>);
  readonly idempotencyKey?: (
    request: Request,
    env: Env,
    context: Context,
  ) => string | undefined | Promise<string | undefined>;
  readonly body?:
    | unknown
    | ((result: RateLimitResult, request: Request, context: Context) => unknown | Promise<unknown>);
  readonly onRejected?: (input: {
    request: Request;
    result: RateLimitResult;
    context: Context;
  }) => Response | Promise<Response>;
}

export interface GuardOutcome {
  readonly result: RateLimitResult;
  readonly response?: Response;
}

export function createRateLimitGuard<
  Env,
  Policies extends Record<string, RateLimitPolicy> = Record<string, RateLimitPolicy>,
  Context = MiddlewareContext<Env>,
>(
  limiter: RateLimit<Policies>,
  options: RateLimitMiddlewareOptions<Env, Policies, Context>,
): (request: Request, env: Env, context: Context) => Promise<GuardOutcome> {
  return async (request, env, context) => {
    const identity = await options.key(request, env, context);
    const policy =
      typeof options.policy === 'function'
        ? await options.policy(request, env, context)
        : options.policy;
    const cost =
      typeof options.cost === 'function' ? await options.cost(request, env, context) : options.cost;
    const idempotencyKey =
      options.idempotencyKey === undefined
        ? undefined
        : await options.idempotencyKey(request, env, context);
    const limitOptions: LimitOptions = {
      ...(policy === undefined ? {} : { policy }),
      ...(cost === undefined ? {} : { cost }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    };
    const result = await limiter.limit(identity, limitOptions);
    if (result.success) return { result };

    if (options.onRejected) {
      const response = await options.onRejected({ request, result, context });
      return { result, response: mergeRateLimitHeaders(response, result.headers) };
    }
    const body =
      typeof options.body === 'function'
        ? await options.body(result, request, context)
        : (options.body ?? { error: 'rate_limited', retryAfter: result.retryAfter });
    return {
      result,
      response: new Response(JSON.stringify(body), {
        status: 429,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...result.headers },
      }),
    };
  };
}

export function withRateLimit<
  Env,
  Policies extends Record<string, RateLimitPolicy> = Record<string, RateLimitPolicy>,
  Context = MiddlewareContext<Env>,
>(
  limiter: RateLimit<Policies>,
  options: RateLimitMiddlewareOptions<Env, Policies, Context>,
  handler: (request: Request, env: Env, context: Context) => Response | Promise<Response>,
): (request: Request, env: Env, context: Context) => Promise<Response> {
  const guard = createRateLimitGuard(limiter, options);
  return async (request, env, context) => {
    const outcome = await guard(request, env, context);
    if (outcome.response) return outcome.response;
    const response = await handler(request, env, context);
    return mergeRateLimitHeaders(response, outcome.result.headers);
  };
}

export function mergeRateLimitHeaders(
  response: Response,
  additions: Readonly<Record<string, string>>,
): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(additions)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export type { RateLimitEvent, RateLimitResult };
