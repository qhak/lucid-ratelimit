import { describe, expect, it } from 'vitest';
import {
  evaluateFixedWindow,
  evaluateSlidingWindow,
  evaluateTokenBucket,
} from '@lucid/ratelimit/algorithms';
import { makeRateLimitHeaders } from '../packages/core/src/utils/headers.js';
import {
  normalizePolicy,
  parseDuration,
  RateLimitConfigurationError,
  RateLimitIdentityError,
  validateIdentity,
} from '../packages/core/src/validation.js';
import type {
  NormalizedAlgorithmPolicy,
  PersistedBucketState,
  SlidingWindowEvent,
} from '../packages/core/src/types.js';

describe('fixed window', () => {
  const policy: NormalizedAlgorithmPolicy = {
    algorithm: 'fixed-window',
    limit: 3,
    windowMs: 1_000,
  };

  it('aligns windows to Unix epoch boundaries and resets at the exact boundary', () => {
    const first = evaluateFixedWindow(policy, undefined, 2, 999);
    expect(first.success).toBe(true);
    expect(first.remaining).toBe(1);
    expect(first.reset).toBe(1_000);
    const full = evaluateFixedWindow(policy, first.nextState, 2, 999);
    expect(full.success).toBe(false);
    expect(full.retryAfter).toBe(1);
    const nextWindow = evaluateFixedWindow(policy, first.nextState, 3, 1_000);
    expect(nextWindow.success).toBe(true);
    expect(nextWindow.remaining).toBe(0);
  });

  it('does not create state for a rejected weighted request', () => {
    const first = evaluateFixedWindow(policy, undefined, 2, 10);
    const rejected = evaluateFixedWindow(policy, first.nextState, 2, 10);
    expect(rejected.success).toBe(false);
    expect(rejected.nextState).toBeUndefined();
    expect(rejected.remaining).toBe(1);
  });

  it('permanently rejects a cost above the configured limit', () => {
    const result = evaluateFixedWindow(policy, undefined, 4, 10);
    expect(result.success).toBe(false);
    expect(result.reason).toBe('cost_exceeds_limit');
    expect(result.retryAfter).toBe(0);
  });
});

describe('exact sliding window', () => {
  const policy: NormalizedAlgorithmPolicy = {
    algorithm: 'sliding-window',
    limit: 5,
    windowMs: 1_000,
  };

  it('expires weighted events at their individual rolling boundaries', () => {
    const events: SlidingWindowEvent[] = [
      { createdAt: 0, expiresAt: 1_000, cost: 2 },
      { createdAt: 500, expiresAt: 1_500, cost: 2 },
    ];
    const atBoundary = evaluateSlidingWindow(policy, events, 3, 1_000);
    expect(atBoundary.success).toBe(true);
    expect(atBoundary.remaining).toBe(0);
    expect(atBoundary.reset).toBe(2_000);
  });

  it('calculates retry time from the oldest events needed to admit cost', () => {
    const events: SlidingWindowEvent[] = [
      { createdAt: 100, expiresAt: 1_100, cost: 2 },
      { createdAt: 200, expiresAt: 1_200, cost: 2 },
      { createdAt: 300, expiresAt: 1_300, cost: 1 },
    ];
    const denied = evaluateSlidingWindow(policy, events, 2, 500);
    expect(denied.success).toBe(false);
    expect(denied.retryAfter).toBe(1);
    expect(denied.nextState).toBeUndefined();
  });
});

describe('token bucket', () => {
  const policy: NormalizedAlgorithmPolicy = {
    algorithm: 'token-bucket',
    limit: 10,
    capacity: 10,
    refillRate: 3,
    refillIntervalMs: 1_000,
  };

  it('keeps fractional refill precision without rounding tokens upward', () => {
    const initial = evaluateTokenBucket(policy, undefined, 10, 0);
    const oneToken = evaluateTokenBucket(policy, initial.nextState, 1, 333);
    expect(oneToken.success).toBe(false);
    const oneTokenLater = evaluateTokenBucket(policy, initial.nextState, 1, 334);
    expect(oneTokenLater.success).toBe(true);
    expect(oneTokenLater.remaining).toBe(0);
  });

  it('caps refills at capacity and computes retry-after for weighted cost', () => {
    const empty: PersistedBucketState = {
      algorithm: 'token-bucket',
      tokensMicros: 0,
      lastRefillAt: 0,
      refillRemainder: 0,
    };
    const result = evaluateTokenBucket(policy, empty, 2, 1_000);
    expect(result.success).toBe(true);
    expect(result.remaining).toBe(1);
    const capped = evaluateTokenBucket(policy, empty, 1, 100_000);
    expect(capped.remaining).toBe(9);
  });
});

describe('configuration and metadata', () => {
  it('parses bounded duration units and rejects invalid limits', () => {
    expect(parseDuration('2m', 'window')).toBe(120_000);
    expect(parseDuration(1, 'window')).toBe(1);
    expect(() => parseDuration('0s', 'window')).toThrow(RateLimitConfigurationError);
    expect(() =>
      normalizePolicy({ algorithm: 'sliding-window', limit: 10_001, window: '1m' }),
    ).toThrow(RateLimitConfigurationError);
  });

  it('validates and freezes composite policies', () => {
    const policy = normalizePolicy({
      constraints: [
        { algorithm: 'fixed-window', limit: 10, window: '1s' },
        { algorithm: 'sliding-window', limit: 100, window: '1m' },
      ],
    });
    expect(policy.isComposite).toBe(true);
    expect(policy.constraints).toHaveLength(2);
    expect(Object.isFrozen(policy.constraints)).toBe(true);
  });

  it('rejects empty and oversized identities', () => {
    expect(() => validateIdentity('')).toThrow(RateLimitIdentityError);
    expect(() => validateIdentity('x'.repeat(1_025))).toThrow(RateLimitIdentityError);
    expect(() => validateIdentity('user:1')).not.toThrow();
  });

  it('emits standard headers and optional legacy headers', () => {
    const headers = makeRateLimitHeaders(100, 4, 30_000, 10_000, 3, true, false);
    expect(headers['RateLimit-Reset']).toBe('20');
    expect(headers['Retry-After']).toBe('3');
    expect(headers['X-RateLimit-Reset']).toBe('30');
  });
});
