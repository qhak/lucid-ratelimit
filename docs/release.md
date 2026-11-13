# Release preparation

The source repository is public at [github.com/qhak/lucid-ratelimit](https://github.com/qhak/lucid-ratelimit); the npm packages have not been published. Before an initial npm release:

1. Confirm the npm scope is controlled by the publishing account. A registry 404 means no public version was found; it does not reserve the name.
2. If necessary, change `name` in `packages/core/package.json`, `packages/middleware/package.json`, and the middleware dependency, then update imports and examples.
3. Confirm the GitHub repository topics and issue settings before inviting contributors. The repository has issues enabled and topics for Cloudflare Workers, Durable Objects, rate limiting, TypeScript, and edge computing.
4. Create a Changesets entry, run all checks, inspect package contents, and review the generated version changes.
5. Publish only after maintainers explicitly approve publication.

Commands from the repository root:

```sh
npm install
npm run changeset
npm run release:check
npm pack --dry-run --workspace @lucid/ratelimit
npm pack --dry-run --workspace @lucid/ratelimit-middleware
npx changeset version
npm install
npm run release:check
```

When publication is explicitly approved and the npm scope is confirmed:

```sh
npm publish --workspace @lucid/ratelimit --access public
npm publish --workspace @lucid/ratelimit-middleware --access public
```

Publish the core package before the middleware package. No publish or deploy command is run by this repository's CI.
