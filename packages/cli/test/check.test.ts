/**
 * `jev check` — the verdict, the probabilities, and the three exit codes.
 *
 * The exit code is the part of this command a CI job depends on, so it is tested
 * through the whole surface rather than through the mapping function alone: a
 * correct mapping that the dispatcher forgot to return would pass the unit test
 * and fail every workflow.
 *
 * Every case here runs offline. Probabilities come from a stub transport, which
 * is what makes the verdicts exact: the offline mock answers from a hash of the
 * input, so a test against it could only assert that *some* verdict came back.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { EXIT } from '../src/types.js'
import { createHarness, type Harness } from './helpers/harness.js'
import { installStubSdk, type StubHarness } from './helpers/stub-sdk.js'

let harness: Harness
let stub: StubHarness

beforeAll(async () => {
  stub = await installStubSdk('check')
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

/** The question id each field of the stub's answer map is keyed by. */
const QUESTION_OF: Readonly<Record<string, string>> = {
  supports: 'supports_claim',
  contradicts: 'contradicts_claim',
  sufficient: 'evidence_is_sufficient',
}

/** Point the stub at one triple of probabilities and run `check`. */
const check = async (
  probabilities: { supports?: number; contradicts?: number; sufficient?: number },
  extra: readonly string[] = [],
) => {
  stub.sdk.TypeSafeClient.throws = undefined
  stub.sdk.TypeSafeClient.answer = async () => ({
    model: 'jev-1.13.0',
    answers: Object.fromEntries(
      Object.entries(probabilities).map(([key, value]) => [
        QUESTION_OF[key] as string,
        { type: 'noul', noul: value },
      ]),
    ),
  })
  const evidence = harness.file('evidence.txt', 'The evidence under test.')
  return harness.run(
    ['check', '--claim', 'the claim', '--evidence', evidence, '--provider', 'live', ...extra],
    { env: stub.env() },
  )
}

describe('verdicts and exit codes', () => {
  it('exits 0 for supported', async () => {
    const result = await check({ supports: 0.95, contradicts: 0.05, sufficient: 0.9 })
    expect(result.code).toBe(EXIT.OK)
    expect(result.stdout).toContain('verdict: supported')
  })

  it('exits 1 for contradicted', async () => {
    const result = await check({ supports: 0.05, contradicts: 0.95, sufficient: 0.9 })
    expect(result.code).toBe(EXIT.FAIL)
    expect(result.stdout).toContain('verdict: contradicted')
  })

  it('exits 3 for conflicted, because that is a finding about the evidence', async () => {
    const result = await check({ supports: 0.95, contradicts: 0.95, sufficient: 0.9 })
    expect(result.code).toBe(EXIT.NO_VERDICT)
    expect(result.stdout).toContain('verdict: conflicted')
  })

  it('exits 3 for insufficient', async () => {
    const result = await check({ supports: 0.95, contradicts: 0.05, sufficient: 0.2 })
    expect(result.code).toBe(EXIT.NO_VERDICT)
    expect(result.stdout).toContain('verdict: insufficient')
  })

  it('exits 3 for undecided — evidence that settles the question and points nowhere', async () => {
    // The verdict that used to be reported as `insufficient` while the payload
    // printed `sufficient: 0.99` beside it.
    const result = await check({ supports: 0.4, contradicts: 0.3, sufficient: 0.99 })
    expect(result.code).toBe(EXIT.NO_VERDICT)
    expect(result.stdout).toContain('verdict: undecided')
  })

  it('exits 3 for unknown, and reports the missing measurement as a question mark', async () => {
    const result = await check({ sufficient: 0.9 })
    expect(result.code).toBe(EXIT.NO_VERDICT)
    expect(result.stdout).toContain('verdict: unknown')
    expect(result.stdout).toContain('supports=?')
    expect(result.stdout).toContain('contradicts=?')
  })

  it('prints all three probabilities beside the verdict', async () => {
    const result = await check({ supports: 0.95, contradicts: 0.05, sufficient: 0.9 })
    expect(result.stdout).toContain('supports=0.95')
    expect(result.stdout).toContain('contradicts=0.05')
    expect(result.stdout).toContain('sufficient=0.90')
  })
})

describe('--json', () => {
  it('is stable, parses, and carries the verdict and its probabilities', async () => {
    const result = await check({ supports: 0.95, contradicts: 0.05, sufficient: 0.9 }, ['--json'])
    const payload = result.json<{
      ok: boolean
      command: string
      provider: string
      model: string
      latencyMs: number
      data: {
        verdict: string
        probabilities: Record<string, number>
        thresholds: Record<string, number>
        exitCode: number
      }
    }>()

    expect(payload.ok).toBe(true)
    expect(payload.command).toBe('check')
    expect(payload.provider).toBe('live')
    expect(payload.model).toBe('jev-1.13.0')
    expect(typeof payload.latencyMs).toBe('number')
    expect(payload.data.verdict).toBe('supported')
    expect(payload.data.probabilities).toEqual({ supports: 0.95, contradicts: 0.05, sufficient: 0.9 })
    expect(payload.data.thresholds).toEqual({ support: 0.7, contradiction: 0.7, sufficiency: 0.5 })
    expect(payload.data.exitCode).toBe(EXIT.OK)
    // The exit code in the payload and the process exit code are the same number,
    // which is what lets a caller that cannot read `$?` still branch.
    expect(payload.data.exitCode).toBe(result.code)
  })

  it('omits a probability that was never measured rather than writing a zero', async () => {
    const result = await check({ sufficient: 0.9 }, ['--json'])
    const payload = result.json<{ data: { probabilities: Record<string, number> } }>()
    expect(payload.data.probabilities).toEqual({ sufficient: 0.9 })
    expect('supports' in payload.data.probabilities).toBe(false)
  })

  it('keeps stdout a single JSON document, with every note on stderr', async () => {
    const result = await check({ supports: 0.95, contradicts: 0.05, sufficient: 0.9 }, ['--json'])
    expect(() => JSON.parse(result.stdout)).not.toThrow()
    // The provenance and egress lines are diagnostics, and a second document on
    // stdout would break every consumer of the first.
    expect(result.stderr).toContain('provider=live')
    expect(result.stderr).toContain('egress: state=')
  })
})

describe('failure paths', () => {
  it('reads evidence from standard input with "-"', async () => {
    stub.sdk.TypeSafeClient.answer = async () => ({
      model: 'jev-1.13.0',
      answers: {
        supports_claim: { type: 'noul', noul: 0.95 },
        contradicts_claim: { type: 'noul', noul: 0.05 },
        evidence_is_sufficient: { type: 'noul', noul: 0.9 },
      },
    })
    const result = await harness.run(
      ['check', '--claim', 'c', '--evidence', '-', '--provider', 'live'],
      { env: stub.env(), stdin: 'piped evidence' },
    )
    expect(result.code).toBe(EXIT.OK)
  })

  it('exits 1 with no credential and no --mock, naming the variable', async () => {
    const evidence = harness.file('evidence.txt', 'e')
    const result = await harness.run(
      ['check', '--claim', 'c', '--evidence', evidence, '--provider', 'live'],
      { env: { TYPESAFE_API_KEY: '' } },
    )
    expect(result.code).toBe(EXIT.FAIL)
    expect(result.stderr).toContain('no credential was found for TYPESAFE_API_KEY')
    expect(result.stderr).not.toContain('undefined')
  })

  it('reports a transport failure as its own error code, with no request body echoed', async () => {
    stub.sdk.TypeSafeClient.throws = Object.assign(new Error('socket closed'), { status: 529 })
    const evidence = harness.file('evidence.txt', 'e')
    const result = await harness.run(
      ['check', '--claim', 'c', '--evidence', evidence, '--provider', 'live', '--json'],
      { env: stub.env() },
    )
    expect(result.code).toBe(EXIT.FAIL)
    const payload = result.json<{ ok: boolean; errorCode: string }>()
    expect(payload.ok).toBe(false)
    expect(payload.errorCode).toBe('overloaded')
    expect(result.stderr).not.toContain('socket closed')
    stub.sdk.TypeSafeClient.throws = undefined
  })

  it('never prints the credential, on any path', async () => {
    const secret = 'sk-live-DO-NOT-PRINT-abc123'
    const evidence = harness.file('evidence.txt', 'e')
    const result = await harness.run(
      ['check', '--claim', 'c', '--evidence', evidence, '--provider', 'live', '--json'],
      { env: { ...stub.env(), TYPESAFE_API_KEY: secret } },
    )
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret)
    // The source is reported; the value is not.
    expect(result.stderr).toContain('credential from environment')
  })
})
