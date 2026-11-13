# Lucid Analytics event hook

The core package does not depend on a Lucid Analytics client. `src/adapter.ts` shows a small, synchronous bridge from the rate-limit decision hook into an application-owned analytics queue. Adapt its `record` call to the queue API available in your Lucid Analytics deployment. The example deliberately omits identities and idempotency keys.

Keep the queue operation non-blocking and ensure it does not throw. `onDecision` runs after a quota decision and before the SDK returns it; if the hook throws, the decision remains committed and the error propagates to the caller.
