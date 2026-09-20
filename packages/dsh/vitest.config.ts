import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Every test here must pass with no network access and no TYPESAFE_API_KEY.
    // The offline path is the default contract; CI holds it to that.
    env: {
      TYPESAFE_API_KEY: '',
    },
  },
})
