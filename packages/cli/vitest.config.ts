import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // No test in this package may need a credential or a socket. The live route
    // is exercised through a stub SDK module named by an environment variable,
    // and the CLI's own tests pass an explicit environment object rather than
    // reading this one - so a developer's real key in the shell cannot turn a
    // test into a network call.
    env: {
      TYPESAFE_API_KEY: '',
      OPENROUTER_API_KEY: '',
    },
  },
})
