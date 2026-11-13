import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
  test: {
    include: ['benchmarks/durable-object.bench.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
