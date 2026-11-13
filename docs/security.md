# Security notes

## Identity trust

The library hashes the identity but cannot determine whether the application authenticated it correctly. Use a stable internal user, tenant, or API-key record ID. Do not use an unvalidated `Authorization` value as the identity. The middleware requires an identity resolver and does not default to `X-Forwarded-For`, `X-Real-IP`, or another client-controlled header.

For Cloudflare-proxied traffic, `CF-Connecting-IP` is provided by the Cloudflare edge. If another proxy sits in front, configure it to overwrite a trusted client-IP header and prevent clients from reaching the Worker by an alternate route. Authenticate user and API-key identities before rate limiting.

## Data minimization

Identity strings are limited to 1,024 UTF-8 bytes and SHA-256 hashed before routing. Policy names are hashed before storage. Idempotency keys are limited to 128 UTF-8 bytes and hashed before storage. Decision hooks receive algorithm, policy name, result metadata, timing, and timestamp, but not the identity or idempotency key. Do not embed secrets in policy names or application scope.

## High cardinality and denial of service

An attacker who can choose many identities can consume shard slots. Hard caps bound active identities and event/cache rows, and capacity exhaustion follows the configured failure mode. Choose `failureMode: 'closed'` for authentication, billing, and other security-sensitive routes. Keep identity resolvers tied to authenticated subjects where possible; IP limiting is only a supplemental control.

Each exact sliding-window request uses a persisted event row. The 10,000 limit and per-shard event caps bound worst-case event growth. Fixed-window and token-bucket policies use bounded state rows. The package does not claim to replace Cloudflare WAF, bot management, or DDoS controls.

## Failure and replay

Fail-open explicitly allows requests without authoritative enforcement and returns `enforced: false`, `degraded: true`, and no quota headers. Do not treat that result as a successful quota check. A lost RPC response can leave a committed decision whose response was not observed. Reuse a stable idempotency key on retries that represent the same operation. Idempotency retention is 24 hours; reusing a key with a different policy or cost is an error.

The Durable Object and storage namespace are security boundaries controlled by the deployment. Do not expose application-specific RPC bindings to untrusted code. A multi-constraint operation is atomic only within its one shard object; no cross-shard transaction is provided.
