import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Every test in this repository must pass with no network access and no
    // TYPESAFE_API_KEY. A test that needs either is a test that belongs in a
    // live-verification script instead.
    env: {
      TYPESAFE_API_KEY: '',
    },
  },
})
