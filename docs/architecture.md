# Architecture and guarantees

## Request path

1. The Worker application resolves a trusted logical identity.
2. The SDK hashes `[scope, identity]` with SHA-256. The original value is not sent to the Durable Object or stored.
3. The first digest byte chooses one of 256 named shard objects. The same identity always reaches that shard for a stable scope and binding.
4. The Worker sends the normalized policy, integer cost, policy version hash, and optional hashed idempotency key over Durable Object RPC.
5. The Durable Object validates the internal request, clamps the clock against persisted time, prunes expired rows, and computes all constraints within `transactionSync`.
6. It persists quota state only if every constraint accepts. The transaction commits before RPC returns. It then schedules the shard's earliest-expiry alarm.

The shard count is fixed at 256. Changing routing is a state migration: changing the name format or shard mapping without migrating data makes existing quota state unreachable. Do not edit it casually.

## Storage model

- `rate_limit_buckets`: one row for each active fixed-window or token-bucket policy constraint. Rows expire at the fixed-window boundary or when a token bucket is full again.
- `rate_limit_events`: one row per accepted sliding-window request, including its integer cost and exact expiry time.
- `rate_limit_idempotency`: cached decision by hashed key, retained for 24 hours by default; configurable up to 30 days.
- `rate_limit_identities`: per-owner expiry marker used for a fast active identity cap.
- `rate_limit_metadata`: monotonic last-seen Unix time for the shard.

The alarm deletes expired events, states, idempotency results, and owner markers. There is one alarm per shard and it is set to the earliest active expiry. Storage writes that create active state schedule the alarm after the state transaction. If a storage or alarm operation fails, the Durable Object returns a degraded `rate_limit_unavailable` result with `failureCode: "durable_object_storage"`; the SDK applies its configured failure mode. The transaction may already have committed before alarm scheduling fails, so retry operations with the same idempotency key. Expired rows are also deleted at the start of every decision.

## Atomicity

SQLite-backed Durable Objects have private, strongly consistent storage. Lucid RateLimit uses a synchronous transaction for state reads, evaluation, and writes. A request cannot consume a fixed-window counter and then fail to consume a sliding-window constraint: either the whole composite is accepted and written, or no quota state is written. Rejected requests can write an idempotency response when the caller supplied an idempotency key; that cache does not consume quota.

Separate calls for separate identities may map to different shards and cannot be atomically combined. A policy update changes the normalized policy version hash and therefore starts fresh state for that version. During a gradual deployment, old and new versions can both be in use and enforce separate state until the old version expires.

## Time

All algorithm timestamps are integer milliseconds since the Unix epoch. Fixed windows align to epoch multiples of their duration. Sliding events expire when `expires_at <= now`. Token buckets retain integer micro-tokens and a remainder numerator; refill calculations use `BigInt` intermediates and floor the earned micro-token units.

Each shard clamps a backward-moving wall clock to its last persisted timestamp. This prevents clock rollback from reopening quota, but a forward jump can make windows expire early and can hold the shard's effective clock ahead until real time catches up. The platform clock remains the source; no cross-region monotonic clock is claimed.

## Bounds and contention

Hard caps are 20,000 active identities, 64 policy states per identity, 250,000 exact sliding events per shard, and 250,000 idempotency records per shard (1,024 per identity). Idempotency retention defaults to 24 hours and is configurable from 1ms to 30 days. The exact sliding window also limits each policy to 10,000 units of configured request capacity, and each accepted request consumes at least one event. Reaching a bound raises a storage-capacity failure and follows `failureMode`; no quota is silently evicted to make room.

The 256 shards spread unrelated identities, but each object serializes its own operations. Hot identities naturally contend on their shard, and unrelated identities can collide on one. Increasing shard count requires an explicit state migration because routing changes bucket ownership. Sliding-window read and aggregation work is O(n); a denied decision also sorts active events to find the exact retry time, which is O(n log n). The per-policy event cap bounds both paths.

Cloudflare currently recommends SQLite-backed Durable Objects for new namespaces and describes `transactionSync()` for synchronous atomic read/modify/write operations. See the official [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) and [Durable Objects rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/).
