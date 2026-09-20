/**
 * A stub `@typesafe-ai/sdk`, for the tests that exercise a transmitting route.
 *
 * The CLI reaches the live route through `LiveProvider`/`OpenRouterProvider`,
 * which construct the vendor client. Those providers take an injected SDK loader
 * (`LiveProviderOptions.loadSdk`), and the CLI's only seam onto it is the
 * `JEV_CLI_SDK` environment variable — so the tests write a real module to a
 * temporary directory, point the variable at it, and get a transport they
 * control. No test in this package opens a socket, and none needs a credential
 * that is real.
 *
 * **Why a file on disk rather than a mock of the module graph.** Vitest's
 * `vi.mock` rewrites the *test file's* imports; the CLI imports the SDK through a
 * dynamic `import()` of a variable specifier inside `jevcore`, which no static
 * mock can reach. A real file is not a workaround for that — it is the same
 * mechanism the seam is designed around, exercised exactly as a user of the seam
 * would exercise it.
 *
 * The module is written as `.mjs`, not `.ts`, so Node loads the same bytes the
 * test wrote: a TypeScript stub would need a transform step between the test and
 * the import, which is one more thing that can differ from what actually runs.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CliEnv } from '../../src/types.js'

/**
 * The stub's source. `answer` and `modelList` are mutable statics so a test can
 * change what the transport does without writing a second module — Node caches
 * an imported module, so the CLI sees the reassignment at call time.
 */
const SOURCE = `export class TypeSafeClient {
  static answer = async () => ({ model: 'jev-1.13.0', answers: {}, latency_ms: 1 })
  static modelList = async () => []
  static throws = undefined
  /** The last request the CLI sent, so a test can assert on what leaves. */
  static lastRequest = undefined

  constructor(config) {
    this.config = config
  }

  async systemOne(request) {
    TypeSafeClient.lastRequest = request
    if (TypeSafeClient.throws !== undefined) throw TypeSafeClient.throws
    return TypeSafeClient.answer()
  }

  models = {
    list: async () => {
      if (TypeSafeClient.throws !== undefined) throw TypeSafeClient.throws
      return TypeSafeClient.modelList()
    },
  }
}
`

/** The module namespace the CLI will see, with the mutable statics typed. */
export interface StubSdk {
  readonly TypeSafeClient: {
    answer: () => Promise<unknown>
    modelList: () => Promise<unknown>
    throws: unknown
    lastRequest: unknown
  }
}

/** A stub installed for one test file. */
export interface StubHarness {
  /** Point `JEV_CLI_SDK` at the stub and remove the whole-call budget. */
  readonly env: (overrides?: Readonly<Record<string, string | undefined>>) => CliEnv['env']
  /** The module's statics, so a test can decide what the transport does. */
  readonly sdk: StubSdk
  /** Delete the temporary directory. */
  readonly dispose: () => void
}

/**
 * Install the stub, and return the handle a test uses to configure it.
 *
 * The directory name carries the calling file's name so a failure that leaves one
 * behind says which test file did it.
 */
export const installStubSdk = async (label: string): Promise<StubHarness> => {
  const dir = path.join(
    process.env.TEMP ?? process.env.TMPDIR ?? '/tmp',
    `jev-cli-${label}-${process.pid}-${Date.now()}`,
  )
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'sdk-stub.mjs')
  writeFileSync(file, SOURCE, 'utf8')

  const sdk = (await import(pathToFileURL(file).href)) as unknown as StubSdk

  return {
    sdk,
    env: (overrides = {}) => ({
      // The routing variables a transmitting run needs. `JEV_CLI_TOTAL_BUDGET_MS`
      // is `0` so a stub that throws is classified at once rather than after the
      // provider's own 40s ceiling — the same seam `packages/core`'s provider
      // tests use, and it changes no behaviour a test asserts on.
      JEV_CLI_SDK: file,
      JEV_CLI_TOTAL_BUDGET_MS: '0',
      TYPESAFE_API_KEY: 'stub-key-not-a-secret',
      ...overrides,
    }),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  }
}
