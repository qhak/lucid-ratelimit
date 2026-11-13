export type Duration = number | `${number}${'ms' | 's' | 'm' | 'h' | 'd'}`;

export interface FixedWindowPolicy {
  readonly algorithm: 'fixed-window';
  readonly limit: number;
  readonly window: Duration;
}

export interface SlidingWindowPolicy {
  readonly algorithm: 'sliding-window';
  readonly limit: number;
  readonly window: Duration;
}

export interface TokenBucketPolicy {
  readonly algorithm: 'token-bucket';
  readonly capacity: number;
  readonly refillRate: number;
  readonly refillInterval: Duration;
}

export type AlgorithmPolicy = FixedWindowPolicy | SlidingWindowPolicy | TokenBucketPolicy;

export interface CompositePolicy {
  readonly constraints: readonly AlgorithmPolicy[];
}

export type RateLimitPolicy = AlgorithmPolicy | CompositePolicy;

export interface RateLimitConstraintResult {
  readonly algorithm: AlgorithmPolicy['algorithm'];
  readonly success: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly reset: number;
  readonly retryAfter: number;
  readonly reason?: string;
}

export type RateLimitFailureCode = 'durable_object_unavailable' | 'durable_object_storage';

export interface RateLimitResult {
  readonly success: boolean;
  /** False means no authoritative decision was made, as in fail-open/closed degradation. */
  readonly enforced: boolean;
  readonly degraded: boolean;
  readonly limit: number;
  readonly remaining: number;
  /** Unix epoch timestamp in milliseconds. */
  readonly reset: number;
  /** Whole seconds until this request cost can be admitted; zero when allowed. */
  readonly retryAfter: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly policy?: string;
  readonly reason?: string;
  readonly failureCode?: RateLimitFailureCode;
  readonly constraints?: readonly RateLimitConstraintResult[];
}

export interface RateLimitEvent {
  readonly algorithm: AlgorithmPolicy['algorithm'] | 'composite';
  readonly policy: string;
  readonly success: boolean;
  readonly enforced: boolean;
  readonly degraded: boolean;
  readonly cost: number;
  readonly limit: number;
  readonly remaining: number;
  readonly reset: number;
  readonly retryAfter: number;
  readonly durationMs: number;
  readonly timestamp: number;
  readonly reason?: string;
  readonly failureCode?: RateLimitFailureCode;
}

export interface RateLimitNamespaceLike<Id extends string | object = string | object> {
  idFromName(name: string): Id;
  get(id: Id): RateLimitStubLike;
}

export interface RateLimitStubLike {
  limit(request: DurableLimitRequest): Promise<RateLimitResult>;
}

export interface DurableLimitRequest {
  /** SHA-256 digest of scope and identity; raw identifiers never cross into storage. */
  readonly bucketKey: string;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly policy: NormalizedPolicy;
  readonly cost: number;
  readonly legacyHeaders: boolean;
  readonly idempotencyTtlMs: number;
  readonly failureMode: 'closed' | 'open';
  readonly idempotencyKey?: string;
}

export interface RateLimitOptions<
  Policies extends Record<string, RateLimitPolicy> = Record<string, never>,
> {
  /** A Cloudflare Durable Object namespace binding. */
  readonly namespace: RateLimitNamespaceLike;
  /** Application isolation inside a shared binding. Keep this stable across deployments. */
  readonly scope?: string;
  /** Default single policy; mutually exclusive with `policies`. */
  readonly algorithm?: AlgorithmPolicy['algorithm'];
  readonly limit?: number;
  readonly window?: Duration;
  readonly capacity?: number;
  readonly refillRate?: number;
  readonly refillInterval?: Duration;
  /** Named policy map. Each policy gets a versioned, isolated state record. */
  readonly policies?: Policies;
  readonly defaultPolicy?: keyof Policies & string;
  readonly failureMode?: 'closed' | 'open';
  readonly legacyHeaders?: boolean;
  /** Retention for replaying an idempotent decision; defaults to 24 hours. */
  readonly idempotencyRetention?: Duration;
  readonly onDecision?: (event: RateLimitEvent) => void;
  readonly onError?: (error: Error) => void;
}

export interface LimitOptions<PolicyName extends string = string> {
  readonly policy?: PolicyName;
  readonly cost?: number;
  /** Stable key to make an uncertain retry return the original decision (24-hour retention). */
  readonly idempotencyKey?: string;
}

export interface NormalizedAlgorithmPolicy {
  readonly algorithm: AlgorithmPolicy['algorithm'];
  readonly limit: number;
  readonly windowMs?: number;
  readonly capacity?: number;
  readonly refillRate?: number;
  readonly refillIntervalMs?: number;
}

export interface NormalizedPolicy {
  readonly constraints: readonly NormalizedAlgorithmPolicy[];
  readonly isComposite: boolean;
}

export interface PersistedBucketState {
  readonly algorithm: AlgorithmPolicy['algorithm'];
  readonly count?: number;
  readonly windowStart?: number;
  readonly tokensMicros?: number;
  readonly lastRefillAt?: number;
  readonly refillRemainder?: number;
}

export interface SlidingWindowEvent {
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly cost: number;
}

export interface AlgorithmDecision extends RateLimitConstraintResult {
  readonly nextState?: PersistedBucketState;
  readonly recordEvent?: boolean;
}
