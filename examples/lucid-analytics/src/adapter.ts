import type { RateLimitEvent } from '@lucid/ratelimit';

/** Minimal application-side shape; adapt `record` to the queue API used by your Lucid Analytics deployment. */
export interface LucidAnalyticsQueue {
  record(eventName: string, fields: Readonly<Record<string, string | number | boolean>>): void;
}

/** Only non-sensitive decision fields are forwarded. Identity and idempotency keys are never included. */
export function createRateLimitAnalyticsHook(
  queue: LucidAnalyticsQueue,
): (event: RateLimitEvent) => void {
  return (event) => {
    queue.record('rate_limit.decision', {
      algorithm: event.algorithm,
      policy: event.policy,
      success: event.success,
      enforced: event.enforced,
      degraded: event.degraded,
      cost: event.cost,
      limit: event.limit,
      remaining: event.remaining,
      retryAfter: event.retryAfter,
      durationMs: event.durationMs,
      timestamp: event.timestamp,
      ...(event.reason === undefined ? {} : { reason: event.reason }),
    });
  };
}
