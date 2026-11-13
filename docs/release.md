# Release preparation

The repository is not published. Before an initial release:

1. Confirm the npm scope is controlled by the publishing account. A registry 404 means no public version was found; it does not reserve the name.
2. If necessary, change `name` in `packages/core/package.json`, `packages/middleware/package.json`, and the middleware dependency, then update imports and examples.
3. Confirm the GitHub repository URL, topics, and issue settings after creating the repository. These external settings are intentionally not created here.
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
