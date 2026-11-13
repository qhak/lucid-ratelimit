import type {
  AlgorithmDecision,
  NormalizedAlgorithmPolicy,
  PersistedBucketState,
  SlidingWindowEvent,
} from '../types.js';

const TOKEN_SCALE = 1_000_000;
const TOKEN_SCALE_BIGINT = 1_000_000n;

export function evaluateFixedWindow(
  policy: NormalizedAlgorithmPolicy,
  state: PersistedBucketState | undefined,
  cost: number,
  now: number,
): AlgorithmDecision {
  const windowMs = policy.windowMs;
  if (policy.algorithm !== 'fixed-window' || windowMs === undefined)
    throw new TypeError('Expected a fixed-window policy.');
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const reset = windowStart + windowMs;
  const currentCount =
    state?.algorithm === 'fixed-window' && state.windowStart === windowStart
      ? (state.count ?? 0)
      : 0;
  const permanent = cost > policy.limit;
  const success = !permanent && currentCount + cost <= policy.limit;
  const remaining = Math.max(0, policy.limit - currentCount - (success ? cost : 0));
  const decision: AlgorithmDecision = {
    algorithm: policy.algorithm,
    success,
    limit: policy.limit,
    remaining,
    reset,
    retryAfter: success || permanent ? 0 : Math.ceil((reset - now) / 1_000),
    ...(permanent ? { reason: 'cost_exceeds_limit' } : {}),
    ...(success
      ? {
          nextState: { algorithm: 'fixed-window', count: currentCount + cost, windowStart },
        }
      : {}),
  };
  return decision;
}

function earliestEligibleAt(
  events: readonly SlidingWindowEvent[],
  requiredToFree: number,
  now: number,
): number {
  const ordered = [...events].sort((left, right) => left.expiresAt - right.expiresAt);
  let freed = 0;
  for (const event of ordered) {
    freed += event.cost;
    if (freed >= requiredToFree) return event.expiresAt;
  }
  return now;
}

export function evaluateSlidingWindow(
  policy: NormalizedAlgorithmPolicy,
  events: readonly SlidingWindowEvent[],
  cost: number,
  now: number,
): AlgorithmDecision {
  const windowMs = policy.windowMs;
  if (policy.algorithm !== 'sliding-window' || windowMs === undefined)
    throw new TypeError('Expected a sliding-window policy.');
  const activeEvents = events.filter((event) => event.expiresAt > now);
  const used = activeEvents.reduce((sum, event) => sum + event.cost, 0);
  const permanent = cost > policy.limit;
  const success = !permanent && used + cost <= policy.limit;
  const reset =
    activeEvents.length === 0 ? now : Math.max(...activeEvents.map((event) => event.expiresAt));
  const needed = Math.max(0, used + cost - policy.limit);
  const retryAt = permanent ? 0 : success ? 0 : earliestEligibleAt(activeEvents, needed, now);
  return {
    algorithm: policy.algorithm,
    success,
    limit: policy.limit,
    remaining: Math.max(0, policy.limit - used - (success ? cost : 0)),
    reset: success ? Math.max(reset, now + windowMs) : reset,
    retryAfter: retryAt === 0 ? 0 : Math.max(0, Math.ceil((retryAt - now) / 1_000)),
    ...(permanent ? { reason: 'cost_exceeds_limit' } : {}),
    ...(success ? { recordEvent: true } : {}),
  };
}

function refillTokens(
  policy: NormalizedAlgorithmPolicy,
  state: PersistedBucketState | undefined,
  now: number,
): { tokensMicros: number; remainder: number; lastRefillAt: number } {
  const capacity = policy.capacity;
  const refillRate = policy.refillRate;
  const refillIntervalMs = policy.refillIntervalMs;
  if (capacity === undefined || refillRate === undefined || refillIntervalMs === undefined) {
    throw new TypeError('Token-bucket policy is missing validated values.');
  }
  const capacityMicros = capacity * TOKEN_SCALE;
  if (state?.algorithm !== 'token-bucket') {
    return { tokensMicros: capacityMicros, remainder: 0, lastRefillAt: now };
  }

  const lastRefillAt = Math.min(now, state.lastRefillAt ?? now);
  const elapsed = Math.max(0, now - lastRefillAt);
  const previousTokens = Math.min(
    capacityMicros,
    Math.max(0, state.tokensMicros ?? capacityMicros),
  );
  const previousRemainder = Math.max(0, state.refillRemainder ?? 0);
  const numerator =
    BigInt(elapsed) * BigInt(refillRate) * TOKEN_SCALE_BIGINT + BigInt(previousRemainder);
  const gained = numerator / BigInt(refillIntervalMs);
  const remainder = Number(numerator % BigInt(refillIntervalMs));
  const tokens = BigInt(previousTokens) + gained;
  if (tokens >= BigInt(capacityMicros)) {
    return { tokensMicros: capacityMicros, remainder: 0, lastRefillAt: now };
  }
  return { tokensMicros: Number(tokens), remainder, lastRefillAt: now };
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (numerator <= 0n) return 0n;
  return (numerator + denominator - 1n) / denominator;
}

export function evaluateTokenBucket(
  policy: NormalizedAlgorithmPolicy,
  state: PersistedBucketState | undefined,
  cost: number,
  now: number,
): AlgorithmDecision {
  if (
    policy.algorithm !== 'token-bucket' ||
    policy.capacity === undefined ||
    policy.refillRate === undefined ||
    policy.refillIntervalMs === undefined
  ) {
    throw new TypeError('Expected a token-bucket policy.');
  }
  const capacityMicros = policy.capacity * TOKEN_SCALE;
  const costMicros = cost * TOKEN_SCALE;
  const refilled = refillTokens(policy, state, now);
  const permanent = cost > policy.capacity;
  const success = !permanent && refilled.tokensMicros >= costMicros;
  const tokensAfter = refilled.tokensMicros - (success ? costMicros : 0);
  const resetNumerator =
    BigInt(capacityMicros - tokensAfter) * BigInt(policy.refillIntervalMs) -
    BigInt(refilled.remainder);
  const resetMs = Number(ceilDiv(resetNumerator, BigInt(policy.refillRate) * TOKEN_SCALE_BIGINT));
  const retryNumerator =
    BigInt(Math.max(0, costMicros - refilled.tokensMicros)) * BigInt(policy.refillIntervalMs) -
    BigInt(refilled.remainder);
  const retryMs = Number(ceilDiv(retryNumerator, BigInt(policy.refillRate) * TOKEN_SCALE_BIGINT));
  const reset = now + resetMs;
  return {
    algorithm: policy.algorithm,
    success,
    limit: policy.capacity,
    remaining: Math.floor(tokensAfter / TOKEN_SCALE),
    reset,
    retryAfter: success || permanent ? 0 : Math.ceil(retryMs / 1_000),
    ...(permanent ? { reason: 'cost_exceeds_capacity' } : {}),
    ...(success
      ? {
          nextState: {
            algorithm: 'token-bucket',
            tokensMicros: tokensAfter,
            lastRefillAt: now,
            refillRemainder: refilled.remainder,
          },
        }
      : {}),
  };
}

export function evaluateAlgorithm(
  policy: NormalizedAlgorithmPolicy,
  state: PersistedBucketState | undefined,
  events: readonly SlidingWindowEvent[],
  cost: number,
  now: number,
): AlgorithmDecision {
  switch (policy.algorithm) {
    case 'fixed-window':
      return evaluateFixedWindow(policy, state, cost, now);
    case 'sliding-window':
      return evaluateSlidingWindow(policy, events, cost, now);
    case 'token-bucket':
      return evaluateTokenBucket(policy, state, cost, now);
  }
}

export { TOKEN_SCALE as TOKEN_MICRO_SCALE };
