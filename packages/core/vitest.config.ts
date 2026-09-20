import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // No test in this package may need a credential or a socket. The live
    // provider is exercised through an injected stub SDK instead.
    env: {
      TYPESAFE_API_KEY: '',
    },
  },
})
