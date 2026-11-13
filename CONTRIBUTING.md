# Contributing

Thanks for helping improve Lucid RateLimit. Changes to coordination, storage, or failure behavior need tests that exercise the actual invariant, not only the public result shape.

## Development

Requirements: Node.js 20+ and npm.

```sh
npm install
npm run build
npm run typecheck
npm run lint
npm test
npm run bench
```

Worker integration tests run through `@cloudflare/vitest-plugin` and local `workerd`. They do not require Cloudflare credentials. `npm run bench:do` is an opt-in local Worker-to-DO timing run.

## Pull requests

- Keep the public API and runtime dependency surface small.
- Add deterministic algorithm tests for boundary and weighted-cost behavior.
- Add Worker integration tests for persistence or concurrency changes.
- Document consistency, failure, storage, and clock implications.
- Run formatting, lint, type checks, tests, and package builds.
- Add a Changesets entry for user-visible package changes:

```sh
npm run changeset
```

Do not include credentials or production identifiers in fixtures or logs. Do not publish packages or deploy Workers from a pull request.
