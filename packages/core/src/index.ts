import type {
  DurableLimitRequest,
  LimitOptions,
  NormalizedPolicy,
  RateLimitEvent,
  RateLimitFailureCode,
  RateLimitNamespaceLike,
  RateLimitOptions,
  RateLimitPolicy,
  RateLimitResult,
  RateLimitStubLike,
} from './types.js';
import { sha256 } from './utils/hash.js';
import {
  normalizePolicy,
  parseDuration,
  policySourceFromOptions,
  stableStringify,
  validateCost,
  validateIdempotencyKey,
  validateIdentity,
  RateLimitConfigurationError,
  RateLimitUnavailableError,
} from './validation.js';

export type {
  AlgorithmPolicy,
  CompositePolicy,
  Duration,
  FixedWindowPolicy,
  LimitOptions,
  RateLimitConstraintResult,
  RateLimitEvent,
  RateLimitFailureCode,
  RateLimitNamespaceLike,
  RateLimitOptions,
  RateLimitPolicy,
  RateLimitResult,
  SlidingWindowPolicy,
  TokenBucketPolicy,
} from './types.js';
export {
  RateLimitConfigurationError,
  RateLimitIdentityError,
  RateLimitUnavailableError,
} from './validation.js';

interface PreparedPolicy {
  readonly normalized: NormalizedPolicy;
  readonly version: Promise<string>;
}

const FALLBACK_RETRY_SECONDS = 1;
const MAX_SCOPE_BYTES = 128;

export class RateLimit<Policies extends Record<string, RateLimitPolicy> = Record<string, never>> {
  private readonly namespace: RateLimitNamespaceLike;
  private readonly scope: string;
  private readonly policies = new Map<string, PreparedPolicy>();
  private readonly defaultPolicyName: string;
  private readonly failureMode: 'closed' | 'open';
  private readonly legacyHeaders: boolean;
  private readonly idempotencyTtlMs: number;
  private readonly onDecision: ((event: RateLimitEvent) => void) | undefined;
  private readonly onError: ((error: Error) => void) | undefined;

  constructor(options: RateLimitOptions<Policies>) {
    if (!options || typeof options !== 'object')
      throw new RateLimitConfigurationError('Options must be an object.');
    if (
      !options.namespace ||
      typeof options.namespace.idFromName !== 'function' ||
      typeof options.namespace.get !== 'function'
    ) {
      throw new RateLimitConfigurationError(
        'namespace must be a Durable Object namespace binding.',
      );
    }
    const scope = options.scope ?? 'lucid-ratelimit';
    if (
      typeof scope !== 'string' ||
      scope.length === 0 ||
      new TextEncoder().encode(scope).byteLength > MAX_SCOPE_BYTES
    ) {
      throw new RateLimitConfigurationError(
        `scope must be a non-empty string of at most ${MAX_SCOPE_BYTES} UTF-8 bytes.`,
      );
    }

    this.namespace = options.namespace;
    this.scope = scope;
    if (
      options.failureMode !== undefined &&
      options.failureMode !== 'closed' &&
      options.failureMode !== 'open'
    ) {
      throw new RateLimitConfigurationError('failureMode must be "closed" or "open".');
    }
    if (options.legacyHeaders !== undefined && typeof options.legacyHeaders !== 'boolean') {
      throw new RateLimitConfigurationError('legacyHeaders must be boolean.');
    }
    if (options.onDecision !== undefined && typeof options.onDecision !== 'function') {
      throw new RateLimitConfigurationError('onDecision must be a function.');
    }
    if (options.onError !== undefined && typeof options.onError !== 'function') {
      throw new RateLimitConfigurationError('onError must be a function.');
    }
    this.failureMode = options.failureMode ?? 'closed';
    this.legacyHeaders = options.legacyHeaders ?? false;
    this.idempotencyTtlMs =
      options.idempotencyRetention === undefined
        ? 24 * 60 * 60 * 1_000
        : parseDuration(options.idempotencyRetention, 'idempotencyRetention');
    this.onDecision = options.onDecision;
    this.onError = options.onError;

    const sources = policySourceFromOptions(options);
    for (const [name, policy] of Object.entries(sources)) {
      const normalized = normalizePolicy(policy, `policies.${name}`);
      this.policies.set(name, {
        normalized,
        version: sha256(stableStringify(normalized)),
      });
    }
    const configuredDefault = options.defaultPolicy;
    if (configuredDefault !== undefined && !this.policies.has(configuredDefault)) {
      throw new RateLimitConfigurationError(
        `defaultPolicy "${configuredDefault}" is not present in policies.`,
      );
    }
    if (configuredDefault === undefined && this.policies.size > 1) {
      throw new RateLimitConfigurationError(
        'Set defaultPolicy when more than one named policy is configured.',
      );
    }
    this.defaultPolicyName = configuredDefault ?? (this.policies.keys().next().value as string);
  }

  async limit<PolicyName extends keyof Policies & string>(
    identity: string,
    options: LimitOptions<PolicyName> = {},
  ): Promise<RateLimitResult> {
    validateIdentity(identity);
    const cost = options.cost ?? 1;
    validateCost(cost);
    validateIdempotencyKey(options.idempotencyKey);

    const policyName = options.policy ?? this.defaultPolicyName;
    const prepared = this.policies.get(policyName);
    if (!prepared)
      throw new RateLimitConfigurationError(`Unknown rate-limit policy "${policyName}".`);
    const startedAt = performance.now();
    const timestamp = Date.now();
    const identityDigest = await sha256(JSON.stringify([this.scope, identity]));
    const policyId = await sha256(policyName);
    const policyVersion = await prepared.version;
    const idempotencyKey =
      options.idempotencyKey === undefined ? undefined : await sha256(options.idempotencyKey);

    let result: RateLimitResult;
    let unavailableError: RateLimitUnavailableError | undefined;
    try {
      const shardId = `lucid-ratelimit:v1:${identityDigest.slice(0, 2)}`;
      const durableObjectId = this.namespace.idFromName(shardId);
      const stub = this.namespace.get(durableObjectId) as RateLimitStubLike;
      const request: DurableLimitRequest = {
        bucketKey: identityDigest,
        policyId,
        policyVersion,
        policy: prepared.normalized,
        cost,
        legacyHeaders: this.legacyHeaders,
        idempotencyTtlMs: this.idempotencyTtlMs,
        failureMode: this.failureMode,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      };
      result = await stub.limit(request);
      if (result.reason === 'idempotency_conflict') {
        throw new RateLimitConfigurationError(
          'An idempotency key was reused with a different policy or cost.',
        );
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'RateLimitConfigurationError') {
        throw new RateLimitConfigurationError(error.message);
      }
      const failureCode: RateLimitFailureCode = 'durable_object_unavailable';
      unavailableError = new RateLimitUnavailableError(
        'Could not obtain an authoritative Durable Object decision.',
        { cause: error },
      );
      result = {
        ...buildLocalFailureResult(
          prepared.normalized,
          timestamp,
          policyName,
          this.failureMode,
          failureCode,
        ),
      };
    }

    if (unavailableError || (!result.enforced && result.reason === 'rate_limit_unavailable')) {
      this.onError?.(
        unavailableError ??
          new RateLimitUnavailableError(
            result.failureCode === 'durable_object_storage'
              ? 'The Durable Object storage or alarm operation failed.'
              : 'The Durable Object is unavailable.',
          ),
      );
    }

    result = { ...result, policy: policyName };
    const event: RateLimitEvent = {
      algorithm: prepared.normalized.isComposite
        ? 'composite'
        : (prepared.normalized.constraints[0]?.algorithm ?? 'fixed-window'),
      policy: policyName,
      success: result.success,
      enforced: result.enforced,
      degraded: result.degraded,
      cost,
      limit: result.limit,
      remaining: result.remaining,
      reset: result.reset,
      retryAfter: result.retryAfter,
      durationMs: Math.max(0, performance.now() - startedAt),
      timestamp,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      ...(result.failureCode === undefined ? {} : { failureCode: result.failureCode }),
    };
    this.onDecision?.(event);
    return result;
  }
}

function buildLocalFailureResult(
  policy: NormalizedPolicy,
  now: number,
  policyName: string,
  mode: 'open' | 'closed',
  failureCode: RateLimitFailureCode,
): RateLimitResult {
  const limit = Math.min(...policy.constraints.map((constraint) => constraint.limit));
  const success = mode === 'open';
  return {
    success,
    enforced: false,
    degraded: true,
    limit,
    remaining: 0,
    reset: now,
    retryAfter: success ? 0 : FALLBACK_RETRY_SECONDS,
    headers: success ? {} : { 'Retry-After': String(FALLBACK_RETRY_SECONDS) },
    policy: policyName,
    reason: 'rate_limit_unavailable',
    failureCode,
  };
}
