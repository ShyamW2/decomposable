import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['kernel/**/*.test.ts', 'plugins/**/*.test.ts', 'harmony/**/*.test.ts'],
    // Plugin contract tests spawn real child processes and bind real sockets;
    // running files in parallel makes leak detection meaningless.
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
})
