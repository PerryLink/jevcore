/**
 * Argument parsing: the paths a caller reaches without meaning to.
 *
 * Two of these are the ones a CLI usually gets wrong, and they are the two the
 * brief called out: **no arguments at all**, and `--help`. Both must work before
 * anything is resolved — no provider, no credential, no file — because a machine
 * that cannot run the command is exactly the machine where a person needs to read
 * what it would have done.
 */

import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { COMMANDS, parseInvocation } from '../src/args.js'
import { EXIT } from '../src/types.js'
import { UsageError } from '../src/usage.js'
import { createHarness, type Harness } from './helpers/harness.js'

let harness: Harness
beforeEach(() => {
  harness = createHarness()
})
afterEach(() => {
  harness.dispose()
})

describe('parseInvocation', () => {
  it('asks for help when there are no arguments at all', () => {
    expect(parseInvocation([])).toEqual({ kind: 'help', command: undefined })
  })

  it('treats --help, -h and a leading -help as the same request', () => {
    expect(parseInvocation(['--help'])).toEqual({ kind: 'help', command: undefined })
    expect(parseInvocation(['-h'])).toEqual({ kind: 'help', command: undefined })
  })

  it('answers a command help request before parsing that command flags', () => {
    // `--help` wins over a flag that would otherwise be unknown for this command,
    // which is the point: asking what a command does must not require already
    // knowing how to call it.
    expect(parseInvocation(['gate', '--help'])).toEqual({ kind: 'help', command: 'gate' })
    expect(parseInvocation(['ask', '--help', '--nonsense'])).toEqual({
      kind: 'help',
      command: 'ask',
    })
    expect(parseInvocation(['rank', '-h'])).toEqual({ kind: 'help', command: 'rank' })
  })

  it('reports the version', () => {
    expect(parseInvocation(['--version'])).toEqual({ kind: 'version' })
  })

  it('parses a command and its flags', () => {
    const invocation = parseInvocation(['check', '--claim', 'x', '--evidence', '-', '--json'])
    expect(invocation.kind).toBe('run')
    if (invocation.kind !== 'run') return
    expect(invocation.command).toBe('check')
    expect(invocation.args.values).toEqual({ claim: 'x', evidence: '-', json: true })
  })

  it('keeps every value of a repeatable flag', () => {
    const invocation = parseInvocation(['egress', '--feature', 'gate:safety', '--feature', 'tool:jev_ask'])
    expect(invocation.kind).toBe('run')
    if (invocation.kind !== 'run') return
    expect(invocation.args.values.feature).toEqual(['gate:safety', 'tool:jev_ask'])
  })

  it('refuses an unknown flag rather than ignoring it', () => {
    // The failure this prevents: a typo'd required input silently dropping out of
    // a CI job that then reports success.
    expect(() => parseInvocation(['check', '--claim', 'x', '--evidnce', 'y'])).toThrow(UsageError)
  })

  it('refuses an unknown command, naming the known ones', () => {
    expect(() => parseInvocation(['juggle'])).toThrow(/unknown command "juggle"/u)
    expect(() => parseInvocation(['juggle'])).toThrow(/ask, check, rank, gate, egress, models/u)
  })

  it('refuses positional operands, because every input is a named flag', () => {
    expect(() => parseInvocation(['check', 'a-claim'])).toThrow(/takes no positional arguments/u)
  })

  it('refuses a value-taking flag with no value', () => {
    expect(() => parseInvocation(['check', '--claim', 'x', '--evidence'])).toThrow(UsageError)
  })

  it('refuses a bare global flag where a command belongs', () => {
    expect(() => parseInvocation(['--mock'])).toThrow(/expected a command/u)
  })

  it('accepts every command in the published list', () => {
    for (const command of COMMANDS) {
      expect(parseInvocation([command]).kind).toBe('run')
    }
  })
})

describe('the help paths, end to end', () => {
  it('prints the command list and exits 0 for --help', async () => {
    const result = await harness.run(['--help'])
    expect(result.code).toBe(EXIT.OK)
    expect(result.stdout).toContain('Usage: jev <command> [flags]')
    for (const command of COMMANDS) expect(result.stdout).toContain(`  ${command}`)
    expect(result.stderr).toBe('')
  })

  it('prints a command help document and exits 0', async () => {
    const result = await harness.run(['gate', '--help'])
    expect(result.code).toBe(EXIT.OK)
    expect(result.stdout).toContain('jev gate - dry-run the safety gate')
    expect(result.stdout).toContain('--severity-block')
    expect(result.stdout).toContain('--args-json')
  })

  it('prints help on stderr and exits 64 when no command was given', async () => {
    // Not `OK`: a script that ran `jev` with nothing should not read that as
    // success, and the help still has to be readable by the person who typo'd.
    const result = await harness.run([])
    expect(result.code).toBe(EXIT.USAGE)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Usage: jev <command> [flags]')
  })

  it('prints the version and exits 0', async () => {
    const result = await harness.run(['--version'])
    expect(result.code).toBe(EXIT.OK)
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/u)
  })

  it('reports a usage failure as JSON when --json was asked for', async () => {
    // A command line that fails to parse has no parsed flags to read, so the JSON
    // request is honoured from the raw words — otherwise the mode in which a
    // consumer most needs a parseable report is the mode it cannot get one in.
    const result = await harness.run(['check', '--claim', 'x', '--json'])
    expect(result.code).toBe(EXIT.USAGE)
    const payload = result.json<{ ok: boolean; errorCode: string; exitCode: number }>()
    expect(payload.ok).toBe(false)
    expect(payload.errorCode).toBe('usage')
    expect(payload.exitCode).toBe(EXIT.USAGE)
    expect(result.stderr).toContain('--evidence is required')
  })
})
