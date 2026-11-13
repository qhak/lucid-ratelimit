import type {
  AlgorithmPolicy,
  Duration,
  NormalizedAlgorithmPolicy,
  NormalizedPolicy,
  RateLimitOptions,
  RateLimitPolicy,
} from './types.js';

const MAX_LIMIT = 1_000_000;
const MAX_SLIDING_LIMIT = 10_000;
const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_CONSTRAINTS = 8;
const MAX_POLICIES = 32;
const DURATION_PATTERN = /^([1-9]\d*)(ms|s|m|h|d)$/i;

export class RateLimitConfigurationError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitConfigurationError';
  }
}

export class RateLimitIdentityError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitIdentityError';
  }
}

export class RateLimitUnavailableError extends Error {
  constructor(message = 'The rate-limit authority is unavailable', options?: ErrorOptions) {
    super(message, options);
    this.name = 'RateLimitUnavailableError';
  }
}

export function parseDuration(value: Duration, name: string): number {
  let durationMs: number;
  if (typeof value === 'number') {
    durationMs = value;
  } else {
    const match = DURATION_PATTERN.exec(value);
    if (!match) {
      throw new RateLimitConfigurationError(
        `${name} must be an integer millisecond value or a duration such as "1s" or "5m".`,
      );
    }
    const quantity = Number(match[1]);
    const unit = match[2]?.toLowerCase();
    const multiplier =
      unit === 'ms'
        ? 1
        : unit === 's'
          ? 1_000
          : unit === 'm'
            ? 60_000
            : unit === 'h'
              ? 3_600_000
              : 86_400_000;
    durationMs = quantity * multiplier;
  }

  if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > MAX_WINDOW_MS) {
    throw new RateLimitConfigurationError(`${name} must be between 1ms and 30 days.`);
  }
  return durationMs;
}

function positiveInteger(value: unknown, name: string, maximum = MAX_LIMIT): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new RateLimitConfigurationError(
      `${name} must be a positive integer no greater than ${maximum}.`,
    );
  }
  return value as number;
}

function normalizeAlgorithm(policy: AlgorithmPolicy, name: string): NormalizedAlgorithmPolicy {
  if (policy === null || typeof policy !== 'object') {
    throw new RateLimitConfigurationError(`${name} must be a policy object.`);
  }

  switch (policy.algorithm) {
    case 'fixed-window':
      return Object.freeze({
        algorithm: policy.algorithm,
        limit: positiveInteger(policy.limit, `${name}.limit`),
        windowMs: parseDuration(policy.window, `${name}.window`),
      });
    case 'sliding-window':
      return Object.freeze({
        algorithm: policy.algorithm,
        limit: positiveInteger(policy.limit, `${name}.limit`, MAX_SLIDING_LIMIT),
        windowMs: parseDuration(policy.window, `${name}.window`),
      });
    case 'token-bucket':
      return Object.freeze({
        algorithm: policy.algorithm,
        limit: positiveInteger(policy.capacity, `${name}.capacity`),
        capacity: positiveInteger(policy.capacity, `${name}.capacity`),
        refillRate: positiveInteger(policy.refillRate, `${name}.refillRate`),
        refillIntervalMs: parseDuration(policy.refillInterval, `${name}.refillInterval`),
      });
    default:
      throw new RateLimitConfigurationError(`${name}.algorithm is not supported.`);
  }
}

export function normalizePolicy(policy: RateLimitPolicy, name = 'policy'): NormalizedPolicy {
  if (policy === null || typeof policy !== 'object') {
    throw new RateLimitConfigurationError(`${name} must be a policy object.`);
  }
  if ('constraints' in policy) {
    if (
      !Array.isArray(policy.constraints) ||
      policy.constraints.length < 1 ||
      policy.constraints.length > MAX_CONSTRAINTS
    ) {
      throw new RateLimitConfigurationError(
        `${name}.constraints must contain between 1 and ${MAX_CONSTRAINTS} policies.`,
      );
    }
    const constraints = policy.constraints.map((constraint, index) =>
      normalizeAlgorithm(constraint, `${name}.constraints[${index}]`),
    );
    return Object.freeze({ constraints: Object.freeze(constraints), isComposite: true });
  }
  return Object.freeze({
    constraints: Object.freeze([normalizeAlgorithm(policy, name)]),
    isComposite: false,
  });
}

export function policySourceFromOptions<Policies extends Record<string, RateLimitPolicy>>(
  options: RateLimitOptions<Policies>,
): Readonly<Record<string, RateLimitPolicy>> {
  if (options.policies !== undefined) {
    if (
      options.algorithm !== undefined ||
      options.limit !== undefined ||
      options.window !== undefined ||
      options.capacity !== undefined
    ) {
      throw new RateLimitConfigurationError(
        'Use either `policies` or a top-level algorithm policy, not both.',
      );
    }
    const policies = options.policies;
    if (policies === null || typeof policies !== 'object' || Array.isArray(policies)) {
      throw new RateLimitConfigurationError('policies must be an object of named policies.');
    }
    const entries = Object.entries(policies);
    if (entries.length < 1 || entries.length > MAX_POLICIES) {
      throw new RateLimitConfigurationError(
        `policies must contain between 1 and ${MAX_POLICIES} entries.`,
      );
    }
    for (const [name] of entries) {
      if (name.length < 1 || name.length > 128 || /[\u0000-\u001f\u007f]/u.test(name)) {
        throw new RateLimitConfigurationError(
          'Policy names must be 1–128 characters without control characters.',
        );
      }
    }
    return Object.freeze(Object.fromEntries(entries));
  }

  if (options.algorithm === undefined) {
    throw new RateLimitConfigurationError('Set `algorithm` or provide named `policies`.');
  }
  const policy: RateLimitPolicy =
    options.algorithm === 'token-bucket'
      ? {
          algorithm: 'token-bucket',
          capacity: options.capacity as number,
          refillRate: options.refillRate as number,
          refillInterval: options.refillInterval as Duration,
        }
      : {
          algorithm: options.algorithm,
          limit: options.limit as number,
          window: options.window as Duration,
        };
  return Object.freeze({ default: policy });
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${fields.join(',')}}`;
}

export function validateIdentity(identity: unknown): asserts identity is string {
  if (typeof identity !== 'string' || identity.length === 0) {
    throw new RateLimitIdentityError('Identity must be a non-empty string.');
  }
  if (new TextEncoder().encode(identity).byteLength > 1_024) {
    throw new RateLimitIdentityError('Identity exceeds the 1,024-byte limit.');
  }
}

export function validateCost(cost: unknown): asserts cost is number {
  if (!Number.isSafeInteger(cost) || (cost as number) < 1 || (cost as number) > MAX_LIMIT) {
    throw new RateLimitConfigurationError(
      'cost must be a positive integer no greater than 1,000,000.',
    );
  }
}

export const MAX_IDEMPOTENCY_KEY_BYTES = 128;

export function validateIdempotencyKey(key: string | undefined): void {
  if (key === undefined) return;
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    new TextEncoder().encode(key).byteLength > MAX_IDEMPOTENCY_KEY_BYTES
  ) {
    throw new RateLimitConfigurationError(
      'idempotencyKey must be a non-empty string of at most 128 UTF-8 bytes.',
    );
  }
}
