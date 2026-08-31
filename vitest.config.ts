import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The Worker's local runtime state and build output hold no tests and are
    // slow to crawl on Windows.
    exclude: ['node_modules/**', '.wrangler/**', 'dist/**'],
    watch: false,
    environment: 'node',
  },
});
