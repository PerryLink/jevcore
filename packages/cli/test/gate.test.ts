/**
 * `jev gate` — the dry run, the exit codes, and the one promise that matters:
 * nothing is executed.
 *
 * The gate's own decision is the core's, so these tests assert the *wiring*: that
 * the command enables the safety feature (without which the gate allows
 * everything), that it reports the decision as an exit code, and that it never
 * runs the call it is judging.
 *
 * Two kinds of fixture, for two different reasons:
 *
 *  - **The offline mock**, where the point is that a realistic call is judged at
 *    all. `git {}` raises `history_rewrite` at 0.9018, above the core's 0.7 floor,
 *    so the gate asks. The number comes from running the mock directly and is
 *    stable because the mock is deterministic by construction.
 *  - **A stub transport**, where the point is an exact outcome. The mock derives
 *    every probability from a hash of the state, so a harmlessly-named call
 *    routinely comes back with one hazard undecided — which the gate, correctly,
 *    turns into an `ask`. `allow` is therefore not reachable from a guessed
 *    fixture; it is reachable from a stated one.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { EXIT } from '../src/types.js'
import { blocksAt, exitForDecision, severityOfDecision } from '../src/commands/gate.js'
import { createHarness, type Harness } from './helpers/harness.js'
import { installStubSdk, type StubHarness } from './helpers/stub-sdk.js'

let harness: Harness
let stub: StubHarness

beforeAll(async () => {
  stub = await installStubSdk('gate')
})
afterAll(() => {
  stub.dispose()
})
beforeEach(() => {
  harness = createHarness()
})
afterEach(() => {
  harness.dispose()
})

/** A tool call the mock raises `history_rewrite` on. */
const RAISED = { tool: 'git', args: '{}' }

/** The hazard ids the gate asks about. */
const HAZARDS = [
  'irreversible_destruction',
  'privilege_escalation',
  'credential_exposure',
  'external_side_effect',
  'history_rewrite',
] as const

/**
 * Answer every hazard with one probability, so a test states the judgment instead
 * of guessing it, and answer the severity question low.
 *
 * The severity answer is not optional even for a test about hazards. The core
 * asks for a severity beside them, and a severity it could not read is *undecided*
 * — which the gate, correctly, turns into an `ask`. Omitting it here would test
 * that behaviour rather than the one under test.
 *
 * The ladder is five rungs; index `1` is `low`, answered with its probability at
 * the selected position so `applyPolicy` reads the expected score as decided.
 */
const answerHazards = (probability: number): void => {
  stub.sdk.TypeSafeClient.answer = async () => ({
    model: 'jev-1.13.0',
    answers: {
      ...Object.fromEntries(HAZARDS.map((hazard) => [hazard, { type: 'noul', noul: probability }])),
      severity: {
        type: 'score',
        score: 1,
        legend: Object.fromEntries(
          ['none', 'low', 'moderate', 'high', 'critical'].map((level, index) => [
            String(index),
            level,
          ]),
        ),
        probabilities: { '0': 0.1, '1': 0.8, '2': 0.05, '3': 0.03, '4': 0.02 },
      },
    },
  })
}

/** Run `gate` against the stub transport. */
const gateWithStub = (extra: readonly string[] = []) =>
  harness.run(
    ['gate', '--tool', 'pwsh', '--args-json', '{"command":"echo hello"}', '--provider', 'live', ...extra],
    { env: stub.env() },
  )

describe('the decisions a clean and a hazardous call get', () => {
  it('allows a call whose every hazard was answered and cleared, and exits 0', async () => {
    answerHazards(0.02)
    const result = await gateWithStub()
    expect(result.code).toBe(EXIT.OK)
    expect(result.stdout).toContain('decision: allow')
    expect(result.stdout).toContain('no hazard was raised')
  })

  it('asks for a call whose hazard cleared its floor, and exits 2', async () => {
    const result = await harness.run(['gate', '--tool', RAISED.tool, '--args-json', RAISED.args])
    expect(result.code).toBe(EXIT.ASK)
    expect(result.stdout).toContain('decision: ask')
    expect(result.stdout).toContain('history_rewrite')
  })

  it('keeps the block level that was asked for in the report', async () => {
    const result = await harness.run([
      'gate', '--tool', RAISED.tool, '--args-json', RAISED.args, '--severity-block', 'critical',
    ])
    expect(result.stdout).toContain('(blocks at critical)')
  })

  it('refuses a severity level that does not exist, listing the ladder', async () => {
    const result = await harness.run([
      'gate', '--tool', RAISED.tool, '--args-json', RAISED.args, '--severity-block', 'apocalyptic',
    ])
    expect(result.code).toBe(EXIT.USAGE)
    expect(result.stderr).toContain(
      '--severity-block must be one of none, low, moderate, high, critical',
    )
  })
})

describe('the severity escalation, as a function of what the core measured', () => {
  it('compares a level against the block line positionally', () => {
    expect(blocksAt('high', 'high')).toBe(true)
    expect(blocksAt('critical', 'high')).toBe(true)
    expect(blocksAt('moderate', 'high')).toBe(false)
  })

  it('denies an ask whose measured severity reaches the block level', () => {
    expect(exitForDecision('ask', 'high', 'high')).toBe(EXIT.FAIL)
    expect(exitForDecision('ask', 'critical', 'high')).toBe(EXIT.FAIL)
  })

  it('leaves an ask at 2 when the measured severity is below the block level', () => {
    expect(exitForDecision('ask', 'moderate', 'high')).toBe(EXIT.ASK)
    expect(exitForDecision('ask', 'none', 'high')).toBe(EXIT.ASK)
  })

  it('never denies on a severity the gate did not measure', () => {
    // A core that reports no level must not have one invented for it: the
    // comparison needs a measurement, and "could not tell" is not a low number.
    expect(exitForDecision('ask', undefined, 'none')).toBe(EXIT.ASK)
  })

  it('leaves a denial at 1 and an allow at 0 whatever the severity says', () => {
    expect(exitForDecision('deny', 'none', 'critical')).toBe(EXIT.FAIL)
    expect(exitForDecision('allow', 'critical', 'none')).toBe(EXIT.OK)
  })

  it('reads a measured level from the core, and nothing from an absent or unknown one', () => {
    expect(severityOfDecision({ kind: 'ask', severity: 'critical' } as never)).toBe('critical')
    expect(severityOfDecision({ kind: 'ask' } as never)).toBeUndefined()
    expect(severityOfDecision({ kind: 'ask', severity: 'catastrophic' } as never)).toBeUndefined()
  })
})

describe('what the gate would even look at', () => {
  it('reports a tool outside the denylist as not gated, and allows it without a judgment', async () => {
    const result = await harness.run([
      'gate', '--tool', 'list_dir', '--args-json', '{}', '--json',
    ])
    expect(result.code).toBe(EXIT.OK)
    const payload = result.json<{
      data: { gated: boolean; decision: string; toolPatterns: string[] }
    }>()
    expect(payload.data.gated).toBe(false)
    expect(payload.data.decision).toBe('allow')
    expect(payload.data.toolPatterns).toContain('pwsh')
  })

  it('matches the denylist by substring, so an mcp-namespaced shell is gated too', async () => {
    const result = await harness.run([
      'gate', '--tool', 'mcp__host__shell', '--args-json', '{"command":"rm -rf /"}', '--json',
    ])
    expect(result.json<{ data: { gated: boolean } }>().data.gated).toBe(true)
  })
})

describe('the dry-run guarantee', () => {
  it('does not execute anything, even for a call that would be destructive', async () => {
    const target = path.join(harness.dir, 'must-not-exist.txt')
    const result = await harness.run([
      'gate',
      '--tool',
      'write',
      '--args-json',
      JSON.stringify({ path: target, content: 'written by a tool call' }),
    ])
    expect(result.code).toBe(EXIT.ASK)
    expect(existsSync(target)).toBe(false)
    expect(result.stdout).toContain('nothing was executed')
  })

  it('treats the arguments as data, not as something to evaluate', async () => {
    // A shell string that would create a file if anything ran it.
    const marker = path.join(harness.dir, 'shell-marker.txt')
    await harness.run([
      'gate',
      '--tool',
      'pwsh',
      '--args-json',
      JSON.stringify({ command: `New-Item -Path '${marker}' -ItemType File` }),
    ])
    expect(existsSync(marker)).toBe(false)
  })
})

describe('arguments and JSON output', () => {
  it('reads arguments from a file', async () => {
    answerHazards(0.02)
    const argsFile = harness.json('args.json', { command: 'echo hello' })
    const result = await harness.run(
      ['gate', '--tool', 'pwsh', '--args', argsFile, '--provider', 'live'],
      { env: stub.env() },
    )
    expect(result.code).toBe(EXIT.OK)
  })

  it('reads arguments from standard input', async () => {
    answerHazards(0.02)
    const result = await harness.run(
      ['gate', '--tool', 'pwsh', '--args', '-', '--provider', 'live'],
      { env: stub.env(), stdin: '{"command":"echo hello"}' },
    )
    expect(result.code).toBe(EXIT.OK)
  })

  it('refuses both spellings of the arguments at once', async () => {
    const argsFile = harness.json('args.json', { a: 1 })
    const result = await harness.run([
      'gate', '--tool', 'pwsh', '--args', argsFile, '--args-json', '{"b":2}',
    ])
    expect(result.code).toBe(EXIT.USAGE)
    expect(result.stderr).toContain('both name the tool arguments')
  })

  it('requires the arguments, and says how to pass an empty set', async () => {
    const result = await harness.run(['gate', '--tool', 'pwsh'])
    expect(result.code).toBe(EXIT.USAGE)
    expect(result.stderr).toContain('--args-json "{}"')
  })

  it('emits a stable JSON document', async () => {
    const result = await harness.run([
      'gate', '--tool', RAISED.tool, '--args-json', RAISED.args, '--json',
    ])
    const payload = result.json<{
      ok: boolean
      command: string
      provider: string
      latencyMs: number
      data: {
        tool: string
        gated: boolean
        decision: string
        exitCode: number
        severity: string
        severityMeasured: boolean
        blockAt: string
        raised: string[]
        reason?: string
        argumentsChars: number
        toolPatterns: string[]
        credential: string
      }
    }>()

    expect(payload.ok).toBe(true)
    expect(payload.command).toBe('gate')
    expect(payload.provider).toBe('mock')
    expect(payload.data.tool).toBe('git')
    expect(payload.data.gated).toBe(true)
    expect(payload.data.decision).toBe('ask')
    expect(payload.data.exitCode).toBe(EXIT.ASK)
    expect(payload.data.exitCode).toBe(result.code)
    expect(payload.data.blockAt).toBe('high')
    expect(payload.data.raised).toContain('history_rewrite')
    // Whether the level beside it was measured or read off the raised hazards is
    // stated, because a consumer comparing levels across runs has to know.
    expect(typeof payload.data.severityMeasured).toBe('boolean')
    expect(payload.data.argumentsChars).toBeGreaterThan(0)
    expect(payload.data.credential).toBe('none')
  })

  it('keeps stdout a single JSON document', async () => {
    const result = await harness.run([
      'gate', '--tool', 'git', '--args-json', '{}', '--json',
    ])
    expect(() => JSON.parse(result.stdout)).not.toThrow()
    expect(result.stderr).toContain('provider=mock')
  })
})
