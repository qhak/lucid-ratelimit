import { DurableObject } from 'cloudflare:workers';
import { evaluateAlgorithm } from '../algorithms/index.js';
import type {
  AlgorithmDecision,
  DurableLimitRequest,
  NormalizedAlgorithmPolicy,
  NormalizedPolicy,
  PersistedBucketState,
  RateLimitConstraintResult,
  RateLimitResult,
  SlidingWindowEvent,
} from '../types.js';
import {
  RateLimitConfigurationError,
  RateLimitIdentityError,
  validateCost,
} from '../validation.js';
import { makeRateLimitHeaders } from '../utils/headers.js';

const MAX_IDEMPOTENCY_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_IDEMPOTENCY_ROWS_PER_IDENTITY = 1_024;
const MAX_IDEMPOTENCY_ROWS_PER_SHARD = 250_000;
const MAX_SLIDING_EVENTS_PER_SHARD = 250_000;
const MAX_POLICY_STATES_PER_IDENTITY = 64;
const MAX_IDENTITIES_PER_SHARD = 20_000;
const MAX_LIMIT = 1_000_000;
const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
const TOKEN_SCALE = 1_000_000;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

type Environment = Record<string, unknown>;

interface ClockRow extends Record<string, SqlStorageValue> {
  value: number;
}

interface BucketRow extends Record<string, SqlStorageValue> {
  state_json: string;
}

interface EventRow extends Record<string, SqlStorageValue> {
  created_at: number;
  expires_at: number;
  cost: number;
}

interface IdempotencyRow extends Record<string, SqlStorageValue> {
  signature: string;
  result_json: string;
}

interface ExpiryRow extends Record<string, SqlStorageValue> {
  expires_at: number | null;
}

interface TransactionResult {
  readonly result: RateLimitResult;
  readonly nextExpiry: number | null;
}

export class RateLimitStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RateLimitStorageError';
  }
}

export class RateLimitDurableObject extends DurableObject<Environment> {
  private alarmUpdate: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Environment) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS rate_limit_buckets (
        owner_key TEXT NOT NULL,
        state_key TEXT NOT NULL,
        algorithm TEXT NOT NULL,
        state_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (owner_key, state_key)
      );
      CREATE INDEX IF NOT EXISTS rate_limit_buckets_expiry ON rate_limit_buckets(expires_at);
      CREATE INDEX IF NOT EXISTS rate_limit_buckets_owner_expiry ON rate_limit_buckets(owner_key, expires_at);
      CREATE TABLE IF NOT EXISTS rate_limit_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_key TEXT NOT NULL,
        state_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        cost INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS rate_limit_events_bucket_expiry
        ON rate_limit_events(owner_key, state_key, expires_at, created_at);
      CREATE INDEX IF NOT EXISTS rate_limit_events_expiry ON rate_limit_events(expires_at);
      CREATE TABLE IF NOT EXISTS rate_limit_idempotency (
        owner_key TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        signature TEXT NOT NULL,
        result_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY(owner_key, key_hash)
      );
      CREATE INDEX IF NOT EXISTS rate_limit_idempotency_expiry ON rate_limit_idempotency(owner_key, expires_at);
      CREATE TABLE IF NOT EXISTS rate_limit_identities (
        owner_key TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS rate_limit_identities_expiry ON rate_limit_identities(expires_at);
      CREATE TABLE IF NOT EXISTS rate_limit_metadata (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
    `);
  }

  async limit(request: DurableLimitRequest): Promise<RateLimitResult> {
    const safeRequest = validateRequest(request);
    try {
      const transactionResult = this.ctx.storage.transactionSync(() =>
        this.evaluateAndPersist(safeRequest),
      );
      await this.scheduleCleanup(transactionResult.nextExpiry);
      return transactionResult.result;
    } catch (error) {
      if (error instanceof RateLimitConfigurationError || error instanceof RateLimitIdentityError)
        throw error;
      return {
        success: safeRequest.failureMode === 'open',
        enforced: false,
        degraded: true,
        limit: Math.min(...safeRequest.policy.constraints.map((constraint) => constraint.limit)),
        remaining: 0,
        reset: Date.now(),
        retryAfter: safeRequest.failureMode === 'open' ? 0 : 1,
        headers: safeRequest.failureMode === 'open' ? {} : { 'Retry-After': '1' },
        reason: 'rate_limit_unavailable',
        failureCode: 'durable_object_storage',
      };
    }
  }

  override async alarm(): Promise<void> {
    try {
      const nextExpiry = this.ctx.storage.transactionSync(() => {
        const now = this.advanceClock();
        this.deleteExpired(now);
        return this.readNextExpiry();
      });
      await this.scheduleCleanup(nextExpiry);
    } catch (error) {
      throw new RateLimitStorageError('Rate-limit expiration cleanup failed.', { cause: error });
    }
  }

  private evaluateAndPersist(request: DurableLimitRequest): TransactionResult {
    const now = this.advanceClock();
    this.deleteExpired(now);

    const policyKey = `${request.policyId}:${request.policyVersion}`;
    const signature = `${policyKey}:${request.cost}:${request.legacyHeaders ? 'legacy' : 'standard'}`;
    if (request.idempotencyKey !== undefined) {
      const prior = this.ctx.storage.sql
        .exec<IdempotencyRow>(
          'SELECT signature, result_json FROM rate_limit_idempotency WHERE owner_key = ? AND key_hash = ? AND expires_at > ?',
          request.bucketKey,
          request.idempotencyKey,
          now,
        )
        .toArray()[0];
      if (prior) {
        if (prior.signature !== signature) {
          return {
            result: {
              success: false,
              enforced: true,
              degraded: false,
              limit: 0,
              remaining: 0,
              reset: now,
              retryAfter: 0,
              headers: {},
              reason: 'idempotency_conflict',
            },
            nextExpiry: this.readNextExpiry(),
          };
        }
        return {
          result: JSON.parse(prior.result_json) as RateLimitResult,
          nextExpiry: this.readNextExpiry(),
        };
      }
      const count =
        this.ctx.storage.sql
          .exec<{ count: number }>(
            'SELECT COUNT(*) AS count FROM rate_limit_idempotency WHERE owner_key = ?',
            request.bucketKey,
          )
          .toArray()[0]?.count ?? 0;
      if (count >= MAX_IDEMPOTENCY_ROWS_PER_IDENTITY) {
        throw new RateLimitStorageError('Too many active idempotency keys for this identity.');
      }
      const shardCount =
        this.ctx.storage.sql
          .exec<{ count: number }>('SELECT COUNT(*) AS count FROM rate_limit_idempotency')
          .toArray()[0]?.count ?? 0;
      if (shardCount >= MAX_IDEMPOTENCY_ROWS_PER_SHARD) {
        throw new RateLimitStorageError(
          'This Durable Object shard has reached its idempotency record limit.',
        );
      }
    }

    const evaluations = request.policy.constraints.map((constraint, index) => {
      const stateKey = `${policyKey}:${index}`;
      let state: PersistedBucketState | undefined;
      let events: SlidingWindowEvent[] = [];
      if (constraint.algorithm === 'sliding-window') {
        events = this.ctx.storage.sql
          .exec<EventRow>(
            'SELECT created_at, expires_at, cost FROM rate_limit_events WHERE owner_key = ? AND state_key = ? AND expires_at > ? ORDER BY created_at ASC',
            request.bucketKey,
            stateKey,
            now,
          )
          .toArray()
          .map((row) => ({ createdAt: row.created_at, expiresAt: row.expires_at, cost: row.cost }));
      } else {
        const row = this.ctx.storage.sql
          .exec<BucketRow>(
            'SELECT state_json FROM rate_limit_buckets WHERE owner_key = ? AND state_key = ? AND expires_at > ?',
            request.bucketKey,
            stateKey,
            now,
          )
          .toArray()[0];
        if (row) state = JSON.parse(row.state_json) as PersistedBucketState;
      }
      return {
        stateKey,
        constraint,
        decision: evaluateAlgorithm(constraint, state, events, request.cost, now),
      };
    });

    const success = evaluations.every((evaluation) => evaluation.decision.success);
    const constraintResults = evaluations.map(({ decision }) =>
      publicConstraintResult(decision, success ? 0 : decision.success ? request.cost : 0),
    );
    const permanent = evaluations.find(
      ({ decision }) =>
        decision.reason === 'cost_exceeds_limit' || decision.reason === 'cost_exceeds_capacity',
    );
    const limiting =
      permanent ??
      (success
        ? [...evaluations].sort(
            (left, right) =>
              left.decision.remaining / left.decision.limit -
              right.decision.remaining / right.decision.limit,
          )[0]
        : [...evaluations]
            .filter(({ decision }) => !decision.success)
            .sort((left, right) => right.decision.retryAfter - left.decision.retryAfter)[0]);
    const selected = limiting?.decision ?? evaluations[0]?.decision;
    if (!selected)
      throw new RateLimitConfigurationError('A policy must contain at least one constraint.');
    const retryAfter = success
      ? 0
      : permanent
        ? 0
        : Math.max(
            ...evaluations
              .filter(({ decision }) => !decision.success)
              .map(({ decision }) => decision.retryAfter),
          );
    const reason = permanent?.decision.reason ?? (success ? undefined : 'rate_limited');
    const result: RateLimitResult = {
      success,
      enforced: true,
      degraded: false,
      limit: selected.limit,
      remaining: selected.remaining,
      reset: selected.reset,
      retryAfter,
      headers: makeRateLimitHeaders(
        selected.limit,
        selected.remaining,
        selected.reset,
        now,
        retryAfter,
        request.legacyHeaders,
        success,
      ),
      ...(reason === undefined ? {} : { reason }),
      ...(request.policy.isComposite ? { constraints: constraintResults } : {}),
    };

    if (success) {
      this.ensureIdentityCapacity(request.bucketKey);
      for (const { stateKey, constraint, decision } of evaluations) {
        this.ensureStateCapacity(request.bucketKey, stateKey);
        if (constraint.algorithm === 'sliding-window') this.ensureSlidingEventCapacity();
        this.persistAccepted(request.bucketKey, stateKey, constraint, decision, request.cost, now);
      }
    }
    if (request.idempotencyKey !== undefined) {
      if (!success) this.ensureIdentityCapacity(request.bucketKey);
      this.ctx.storage.sql.exec(
        'INSERT INTO rate_limit_idempotency (owner_key, key_hash, signature, result_json, expires_at) VALUES (?, ?, ?, ?, ?)',
        request.bucketKey,
        request.idempotencyKey,
        signature,
        JSON.stringify(result),
        now + request.idempotencyTtlMs,
      );
    }
    this.refreshIdentityExpiry(request.bucketKey);
    return { result, nextExpiry: this.readNextExpiry() };
  }

  private persistAccepted(
    ownerKey: string,
    stateKey: string,
    policy: NormalizedAlgorithmPolicy,
    decision: AlgorithmDecision,
    cost: number,
    now: number,
  ): void {
    if (policy.algorithm === 'sliding-window') {
      const expiresAt = now + (policy.windowMs as number);
      this.ctx.storage.sql.exec(
        'INSERT INTO rate_limit_events (owner_key, state_key, created_at, expires_at, cost) VALUES (?, ?, ?, ?, ?)',
        ownerKey,
        stateKey,
        now,
        expiresAt,
        cost,
      );
      return;
    }
    const state = decision.nextState;
    if (!state)
      throw new RateLimitStorageError('Successful decision did not include next bucket state.');
    const expiresAt = decision.reset;
    this.ctx.storage.sql.exec(
      `INSERT INTO rate_limit_buckets (owner_key, state_key, algorithm, state_json, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(owner_key, state_key) DO UPDATE SET
         algorithm = excluded.algorithm,
         state_json = excluded.state_json,
         expires_at = excluded.expires_at`,
      ownerKey,
      stateKey,
      policy.algorithm,
      JSON.stringify(state),
      expiresAt,
    );
  }

  private advanceClock(): number {
    const previous =
      this.ctx.storage.sql
        .exec<ClockRow>("SELECT value FROM rate_limit_metadata WHERE key = 'last_now_ms'")
        .toArray()[0]?.value ?? 0;
    const now = Math.max(Date.now(), previous);
    this.ctx.storage.sql.exec(
      `INSERT INTO rate_limit_metadata (key, value) VALUES ('last_now_ms', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value
       WHERE excluded.value > rate_limit_metadata.value`,
      now,
    );
    return now;
  }

  private deleteExpired(now: number): void {
    this.ctx.storage.sql.exec('DELETE FROM rate_limit_events WHERE expires_at <= ?', now);
    this.ctx.storage.sql.exec('DELETE FROM rate_limit_buckets WHERE expires_at <= ?', now);
    this.ctx.storage.sql.exec('DELETE FROM rate_limit_idempotency WHERE expires_at <= ?', now);
    this.ctx.storage.sql.exec('DELETE FROM rate_limit_identities WHERE expires_at <= ?', now);
  }

  private ensureIdentityCapacity(ownerKey: string): void {
    const exists = this.ctx.storage.sql
      .exec<{ found: number }>(
        'SELECT 1 AS found FROM rate_limit_identities WHERE owner_key = ?',
        ownerKey,
      )
      .toArray()[0];
    if (exists) return;
    const count =
      this.ctx.storage.sql
        .exec<{ count: number }>('SELECT COUNT(*) AS count FROM rate_limit_identities')
        .toArray()[0]?.count ?? 0;
    if (count >= MAX_IDENTITIES_PER_SHARD) {
      throw new RateLimitStorageError(
        'This Durable Object shard has reached its active identity limit.',
      );
    }
  }

  private ensureStateCapacity(ownerKey: string, stateKey: string): void {
    const existing = this.ctx.storage.sql
      .exec<{ found: number }>(
        `
      SELECT 1 AS found FROM (
        SELECT state_key FROM rate_limit_buckets WHERE owner_key = ? AND state_key = ?
        UNION ALL SELECT state_key FROM rate_limit_events WHERE owner_key = ? AND state_key = ? LIMIT 1
      )
    `,
        ownerKey,
        stateKey,
        ownerKey,
        stateKey,
      )
      .toArray()[0];
    if (existing) return;
    const count =
      this.ctx.storage.sql
        .exec<{ count: number }>(
          `
      SELECT COUNT(DISTINCT state_key) AS count FROM (
        SELECT state_key FROM rate_limit_buckets WHERE owner_key = ?
        UNION ALL SELECT state_key FROM rate_limit_events WHERE owner_key = ?
      )
    `,
          ownerKey,
          ownerKey,
        )
        .toArray()[0]?.count ?? 0;
    if (count >= MAX_POLICY_STATES_PER_IDENTITY) {
      throw new RateLimitStorageError('This identity has reached its active policy-state limit.');
    }
  }

  private ensureSlidingEventCapacity(): void {
    const count =
      this.ctx.storage.sql
        .exec<{ count: number }>('SELECT COUNT(*) AS count FROM rate_limit_events')
        .toArray()[0]?.count ?? 0;
    if (count >= MAX_SLIDING_EVENTS_PER_SHARD) {
      throw new RateLimitStorageError(
        'This Durable Object shard has reached its sliding-window event limit.',
      );
    }
  }

  private refreshIdentityExpiry(ownerKey: string): void {
    const expiry = this.ctx.storage.sql
      .exec<ExpiryRow>(
        `
      SELECT MAX(expires_at) AS expires_at FROM (
        SELECT expires_at FROM rate_limit_events WHERE owner_key = ?
        UNION ALL SELECT expires_at FROM rate_limit_buckets WHERE owner_key = ?
        UNION ALL SELECT expires_at FROM rate_limit_idempotency WHERE owner_key = ?
      )
    `,
        ownerKey,
        ownerKey,
        ownerKey,
      )
      .toArray()[0]?.expires_at;
    if (expiry === null || expiry === undefined) return;
    this.ctx.storage.sql.exec(
      `INSERT INTO rate_limit_identities (owner_key, expires_at) VALUES (?, ?)
       ON CONFLICT(owner_key) DO UPDATE SET expires_at = excluded.expires_at
       WHERE excluded.expires_at > rate_limit_identities.expires_at`,
      ownerKey,
      expiry,
    );
  }

  private readNextExpiry(): number | null {
    const row = this.ctx.storage.sql
      .exec<ExpiryRow>(
        `
      SELECT MIN(expires_at) AS expires_at FROM (
        SELECT expires_at FROM rate_limit_events
        UNION ALL SELECT expires_at FROM rate_limit_buckets
        UNION ALL SELECT expires_at FROM rate_limit_idempotency
        UNION ALL SELECT expires_at FROM rate_limit_identities
      )
    `,
      )
      .toArray()[0];
    return row?.expires_at === null || row?.expires_at === undefined
      ? null
      : Number(row.expires_at);
  }

  private scheduleCleanup(nextExpiry: number | null): Promise<void> {
    const update = this.alarmUpdate.then(async () => {
      const scheduled = await this.ctx.storage.getAlarm();
      if (nextExpiry === null) {
        if (scheduled !== null) await this.ctx.storage.deleteAlarm();
      } else if (scheduled === null || nextExpiry < scheduled) {
        await this.ctx.storage.setAlarm(nextExpiry);
      }
    });
    this.alarmUpdate = update.catch(() => undefined);
    return update;
  }
}

function validateRequest(input: DurableLimitRequest): DurableLimitRequest {
  if (
    !input ||
    typeof input !== 'object' ||
    !HASH_PATTERN.test(input.bucketKey) ||
    !HASH_PATTERN.test(input.policyId) ||
    !HASH_PATTERN.test(input.policyVersion)
  ) {
    throw new RateLimitConfigurationError('Malformed internal rate-limit request.');
  }
  validateCost(input.cost);
  if (typeof input.legacyHeaders !== 'boolean')
    throw new RateLimitConfigurationError('legacyHeaders must be boolean.');
  if (input.failureMode !== 'closed' && input.failureMode !== 'open') {
    throw new RateLimitConfigurationError('Malformed failure mode.');
  }
  if (
    !Number.isSafeInteger(input.idempotencyTtlMs) ||
    input.idempotencyTtlMs < 1 ||
    input.idempotencyTtlMs > MAX_IDEMPOTENCY_TTL_MS
  ) {
    throw new RateLimitConfigurationError('Malformed idempotency retention value.');
  }
  if (input.idempotencyKey !== undefined && !HASH_PATTERN.test(input.idempotencyKey)) {
    throw new RateLimitIdentityError('Malformed idempotency key digest.');
  }
  const policy = input.policy as NormalizedPolicy;
  if (
    !policy ||
    typeof policy !== 'object' ||
    typeof policy.isComposite !== 'boolean' ||
    !Array.isArray(policy.constraints) ||
    policy.constraints.length < 1 ||
    policy.constraints.length > 8
  ) {
    throw new RateLimitConfigurationError('Malformed normalized rate-limit policy.');
  }
  const constraints = policy.constraints.map((constraint) =>
    validateNormalizedConstraint(constraint),
  );
  if (!policy.isComposite && constraints.length !== 1)
    throw new RateLimitConfigurationError('A single policy must contain one constraint.');
  return {
    ...input,
    policy: Object.freeze({
      isComposite: policy.isComposite,
      constraints: Object.freeze(constraints),
    }),
  };
}

function validateNormalizedConstraint(value: NormalizedAlgorithmPolicy): NormalizedAlgorithmPolicy {
  if (
    !value ||
    typeof value !== 'object' ||
    !Number.isSafeInteger(value.limit) ||
    value.limit < 1 ||
    value.limit > MAX_LIMIT
  ) {
    throw new RateLimitConfigurationError('Malformed normalized policy limit.');
  }
  if (value.algorithm === 'fixed-window' || value.algorithm === 'sliding-window') {
    const max = value.algorithm === 'sliding-window' ? 10_000 : MAX_LIMIT;
    const windowMs = value.windowMs;
    if (
      value.limit > max ||
      !Number.isSafeInteger(windowMs) ||
      (windowMs as number) < 1 ||
      (windowMs as number) > MAX_WINDOW_MS
    ) {
      throw new RateLimitConfigurationError('Malformed normalized window policy.');
    }
    return Object.freeze({
      algorithm: value.algorithm,
      limit: value.limit,
      windowMs: windowMs as number,
    });
  }
  if (value.algorithm === 'token-bucket') {
    const capacity = value.capacity;
    const refillRate = value.refillRate;
    const refillIntervalMs = value.refillIntervalMs;
    if (
      value.limit > MAX_LIMIT ||
      capacity !== value.limit ||
      !Number.isSafeInteger(refillRate) ||
      (refillRate as number) < 1 ||
      (refillRate as number) > MAX_LIMIT ||
      !Number.isSafeInteger(refillIntervalMs) ||
      (refillIntervalMs as number) < 1 ||
      (refillIntervalMs as number) > MAX_WINDOW_MS
    ) {
      throw new RateLimitConfigurationError('Malformed normalized token-bucket policy.');
    }
    if ((capacity as number) * TOKEN_SCALE > Number.MAX_SAFE_INTEGER)
      throw new RateLimitConfigurationError('Token capacity exceeds the supported precision.');
    return Object.freeze({
      algorithm: value.algorithm,
      limit: value.limit,
      capacity: capacity as number,
      refillRate: refillRate as number,
      refillIntervalMs: refillIntervalMs as number,
    });
  }
  throw new RateLimitConfigurationError('Unsupported rate-limit algorithm.');
}

function publicConstraintResult(
  decision: AlgorithmDecision,
  unconsumedCost: number,
): RateLimitConstraintResult {
  return {
    algorithm: decision.algorithm,
    success: decision.success,
    limit: decision.limit,
    remaining: decision.remaining + unconsumedCost,
    reset: decision.reset,
    retryAfter: decision.retryAfter,
    ...(decision.reason === undefined ? {} : { reason: decision.reason }),
  };
}
