# Operations

## Wrangler binding

Export the class from the Worker's module and bind it to the class name:

```ts
export { RateLimitDurableObject } from '@lucid/ratelimit/durable-object';
```

```jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "RATE_LIMITER", "class_name": "RateLimitDurableObject" }],
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["RateLimitDurableObject"] }],
}
```

Keep the class name and binding stable after deployment. Add a new, unique migration tag when adding or renaming Durable Object classes. Do not create another binding for each user or policy.

## Failure behavior

`failureMode: 'closed'` returns a denied, degraded result when the SDK cannot get a DO response. The 429 middleware includes `Retry-After: 1`; it omits quota headers because no quota decision was made. `failureMode: 'open'` returns an allowed degraded result with no quota headers. The `onError` callback can send a bounded metric or alert. It receives no identity.

If the storage transaction committed but the alarm write or response path failed, an unkeyed retry may consume quota again. Use the same idempotency key on a retry to replay the stored decision. Alarm cleanup is maintenance; every decision also deletes expired rows before evaluating policy.

## Policy changes

Policy state keys include the policy name hash and normalized policy hash. Any limit, duration, algorithm, capacity, refill rate, or constraint-order change creates a new state. This is an intentional quota reset. If you need continuous quota state across policy edits, coordinate a planned migration; this release does not migrate one algorithm's state to another. Idempotency cache retention is configurable through `idempotencyRetention` and is separate from quota window retention.

## Local development

```sh
npm install
npm run build
npm test
cd examples/basic-worker
npx wrangler dev
```

Worker Vitest tests use local `workerd` through `@cloudflare/vitest-plugin`; they do not contact a Cloudflare account. Wrangler deployment is not part of the test or release commands.
