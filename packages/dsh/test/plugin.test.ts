/**
 * Integration check: does the plugin actually activate on a real Cordis
 * context, and does it behave as the egress contract claims?
 *
 * This is the test that would have caught the `Config` export bug before an
 * install: cordis resolves a plugin's `Config` as a Standard Schema, so a
 * plugin that exports documentation under that name throws during
 * `_resolveConfig` and never activates.
 *
 * It also asserts the two properties the project is built on:
 *   - registering the plugin makes no network call;
 *   - the tools it exposes are callable and return mock-labelled answers.
 */

import { Context } from '@deepseek-ai/cordis'
import {
  EGRESS_FEATURES,
  EgressContract,
  JevService,
  MockProvider,
  type EgressFeature,
  type JevCallRecord,
  type JevProvider,
} from 'jevcore'
import { describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.js'

interface RegisteredService {
  ask(input: { feature: string; state: unknown; questions: unknown }): Promise<{ provider: string }>
  stats(): { calls: number; transmitted: number }
  transmitting: boolean
}

/** Minimal stand-ins for the services the plugin injects. */
const fakeTools = () => {
  const registered: { name: string }[] = []
  return {
    registered,
    service: {
      register(definition: { name: string }) {
        registered.push(definition)
        return () => undefined
      },
    },
  }
}

const fakeCredentials = () => ({
  resolve: async () => undefined,
})

const fakeSkills = () => {
  const registered: { name?: string; description?: string; content?: string }[] = []
  return {
    registered,
    service: {
      register(registration: { name?: string; description?: string; content?: string }) {
        registered.push(registration)
        return () => undefined
      },
    },
  }
}

const mountPlugin = (
  config?: unknown,
  options: { withSkills?: boolean; withApproval?: boolean; captureLogs?: string[] } = {},
) => {
  const ctx = new Context()
  const tools = fakeTools()
  const skills = fakeSkills()
  // `ctx.get('skills')` reads through Cordis's reflect registry, so the fake has
  // to be registered the same way a real provider would be — a plain property
  // assignment is invisible to `get`. The same is true of the approval service
  // below, which is why the plugin's detection is exercised against this
  // registry rather than against a stub of our own.
  ctx.provide('tools', tools.service)
  ctx.provide('credentials', fakeCredentials())
  // Omitted by default so a test asserts the plugin still loads without the
  // skill subsystem present — the whole point of declaring it optional.
  if (options.withSkills === true) {
    ctx.provide('skills', skills.service)
  }
  // A stand-in for `ApprovalService`, which is a Cordis service like any other
  // (`packages/interaction/user-approval/src/index.ts`, `super(ctx, 'approval')`)
  // and mounted as an ordinary host row (`packages/bundle/base/cordis.patch.yml`).
  if (options.withApproval === true) {
    ctx.provide('approval', { request: async () => 'allowed-once' as const })
  }
  // Installed before `apply` so a message emitted during activation is captured.
  // Cordis drops WARN below an exporter's threshold — its default is INFO, and
  // `warn` is level 2 — so an exporter has to ask for it by name. DSH's own boot
  // does exactly this (`packages/boot/app-boot/src/index.ts`), which is why a
  // plugin's `logger.warn` reaches an operator there.
  if (options.captureLogs !== undefined) {
    const messages = options.captureLogs
    ctx.logger.exporter({
      levels: { default: 2 },
      export: (message) => {
        messages.push(String((message.args as unknown[])[0]))
      },
    })
  }
  const events: string[] = []
  // Record which events are subscribed so a gate that is off can be proven to
  // register nothing at all, rather than merely to behave passively.
  const originalOn = ctx.on.bind(ctx) as unknown as (event: string, listener: unknown) => unknown
  ;(ctx as unknown as { on: unknown }).on = (event: string, listener: unknown) => {
    events.push(event)
    return originalOn(event, listener)
  }
  if (config === undefined) plugin.apply(ctx as never)
  else plugin.apply(ctx as never, config as never)
  return { ctx, tools, skills, events }
}

describe('plugin module shape', () => {
  it('exports a name and its injections', () => {
    expect(plugin.name).toBe('jevcore')
    expect(plugin.inject).toContain('tools')
    expect(plugin.inject).toContain('credentials')
  })

  it('does NOT list skills in inject, because any inject key blocks activation', () => {
    // Every key in `inject` makes the fiber wait for that service, so listing
    // `skills` leaves the plugin `pending` forever wherever the skill subsystem
    // is not composed. It is looked up at runtime instead.
    expect(plugin.inject).not.toContain('skills')
    expect(plugin.inject.filter((entry) => typeof entry !== 'string')).toEqual([])
  })

  it('exports apply as a function', () => {
    expect(typeof plugin.apply).toBe('function')
  })

  it('exports Config as a Standard Schema, because Cordis requires the protocol', () => {
    // Cordis calls `Config['~standard'].validate(config)` before the plugin
    // starts. Exporting anything else under this name - documentation, a plain
    // default object - fails activation with "Cannot read properties of
    // undefined (reading 'validate')". This guards the protocol shape.
    expect(plugin.Config).toBeDefined()
    const standard = (plugin.Config as { '~standard'?: unknown })['~standard']
    expect(standard).toBeDefined()
    expect(typeof (standard as { validate?: unknown }).validate).toBe('function')
  })

  it('validates a good config through the schema', () => {
    const result = ((plugin.Config as unknown) as { '~standard': { validate(v: unknown): { value?: unknown; issues?: unknown } } })['~standard'].validate({
      provider: 'mock',
    })
    expect(result.issues).toBeUndefined()
    expect(result.value).toMatchObject({ provider: 'mock' })
  })

  it('reports a bad config through the schema as issues, not a thrown value', () => {
    // The protocol returns issues; throwing through it would surface as an
    // unhandled loader error instead of a readable diagnostic.
    const result = ((plugin.Config as unknown) as { '~standard': { validate(v: unknown): { value?: unknown; issues?: { message: string }[] } } })['~standard'].validate({
      provider: 'nonsense',
    })
    expect(result.value).toBeUndefined()
    expect(result.issues?.[0]?.message).toMatch(/must be "mock", "live", or "openrouter"/)
  })

  it('exposes its config shape under a non-reserved name', () => {
    expect(plugin.CONFIG_DOC.provider).toBe('mock')
  })
})

describe('activation on a real cordis context', () => {
  it('registers without throwing', () => {
    expect(() => mountPlugin()).not.toThrow()
  })

  it('publishes the jev service', () => {
    const { ctx } = mountPlugin()
    const service = ctx.get('jev') as RegisteredService | undefined
    expect(service).toBeDefined()
    expect(typeof service?.ask).toBe('function')
  })

  it('registers exactly three tools', () => {
    const { tools } = mountPlugin()
    expect(tools.registered.map((tool) => tool.name).sort()).toEqual([
      'jev_ask',
      'jev_check',
      'jev_rank',
    ])
  })

  it('enables exactly the five egress switches, and no feature goes unwired', () => {
    // A feature added to EGRESS_FEATURES but not wired here would silently keep
    // its own default, and the plugin's posture would stop matching what the
    // README says it is. This is the invariant that catches that.
    const { ctx } = mountPlugin()
    const jev = ctx.get('jev') as { egress: EgressContract }
    const wired = EGRESS_FEATURES.filter((feature) => jev.egress.lines().some((l) => l.feature === feature))
    expect(wired.sort()).toEqual([...EGRESS_FEATURES].sort())
    expect(wired).toHaveLength(5)
  })

  it('keeps the three tools reachable and both gates off under the default config', () => {
    const { ctx } = mountPlugin()
    const jev = ctx.get('jev') as { egress: EgressContract }
    const enabled = Object.fromEntries(jev.egress.lines().map((l) => [l.feature, l.enabled]))
    expect(enabled).toEqual({
      'tool:jev_ask': true,
      'tool:jev_rank': true,
      'tool:jev_check': true,
      'gate:safety': false,
      'gate:context': false,
    })
  })

  it('enables only the gate that configuration turns on', () => {
    const { ctx } = mountPlugin({ gates: { safety: { enabled: true } } })
    const jev = ctx.get('jev') as { egress: EgressContract }
    const enabled = Object.fromEntries(jev.egress.lines().map((l) => [l.feature, l.enabled]))
    expect(enabled['gate:safety']).toBe(true)
    // The other gate must not come along for the ride.
    expect(enabled['gate:context']).toBe(false)
  })

  it('loads without the skills registry present', () => {
    // The registry is optional; a profile without it must still get the tools.
    expect(() => mountPlugin()).not.toThrow()
    const { tools } = mountPlugin()
    expect(tools.registered).toHaveLength(3)
  })

  it('registers the bundled skill when the registry is present', () => {
    const { skills } = mountPlugin(undefined, { withSkills: true })
    expect(skills.registered).toHaveLength(1)
    expect(skills.registered[0]?.name).toBe('typesafe-ai-dsh')
    expect(skills.registered[0]?.description?.length ?? 0).toBeGreaterThan(40)
    expect(skills.registered[0]?.content?.length ?? 0).toBeGreaterThan(500)
  })

  it('registers no skill when the registry is absent', () => {
    const { skills } = mountPlugin()
    expect(skills.registered).toEqual([])
  })

  it('registers no event listeners while both gates are off', () => {
    const { events } = mountPlugin()
    expect(events).toEqual([])
  })

  it('registers the safety gate listener only when enabled', () => {
    const { events } = mountPlugin({ gates: { safety: { enabled: true } } })
    expect(events).toContain('tools/pre-execute')
  })

  it('registers the context gate listener only when enabled', () => {
    const { events } = mountPlugin({ gates: { context: { enabled: true } } })
    expect(events).toContain('tools/post-execute')
  })

  it('registers both gate listeners when both are enabled', () => {
    const { events } = mountPlugin({ gates: { safety: { enabled: true }, context: { enabled: true } } })
    expect(events.sort()).toEqual(['tools/post-execute', 'tools/pre-execute'])
  })

  it('rejects an invalid configuration at load time', () => {
    expect(() => mountPlugin({ provider: 'nonsense' })).toThrow(/must be "mock", "live", or "openrouter"/)
  })
})

describe('the service works through the mounted plugin', () => {
  it('answers through the mock provider', async () => {
    const { ctx } = mountPlugin()
    const service = ctx.get('jev') as RegisteredService
    const result = await service.ask({
      feature: 'tool:jev_ask',
      state: 'help',
      questions: { q: { type: 'noul', instructions: 'ok?' } },
    })
    expect(result.provider).toBe('mock')
  })

  it('reports itself as not transmitting by default', () => {
    const { ctx } = mountPlugin()
    expect((ctx.get('jev') as RegisteredService).transmitting).toBe(false)
  })

  it('refuses to transmit when a live provider has no credential', async () => {
    const { ctx } = mountPlugin({ provider: 'live' })
    const service = ctx.get('jev') as RegisteredService
    await expect(
      service.ask({
        feature: 'tool:jev_ask',
        state: 'help',
        questions: { q: { type: 'noul', instructions: 'ok?' } },
      }),
    ).rejects.toThrow(/no credential found/)
  })
})

describe('no network call on the default path', () => {
  it('does not fetch while mounting or answering', async () => {
    const spy = vi.fn(() => {
      throw new Error('the default path must not call fetch')
    })
    const original = globalThis.fetch
    globalThis.fetch = spy as unknown as typeof fetch
    try {
      const { ctx } = mountPlugin()
      const service = ctx.get('jev') as RegisteredService
      await service.ask({
        feature: 'tool:jev_ask',
        state: 'help',
        questions: { q: { type: 'noul', instructions: 'ok?' } },
      })
      expect(spy).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = original
    }
  })
})

const allOn = (): Record<EgressFeature, boolean> =>
  Object.fromEntries(EGRESS_FEATURES.map((feature) => [feature, true])) as Record<
    EgressFeature,
    boolean
  >

describe('the registered tool definitions', () => {
  it('opt every tool into the host parallel pool', () => {
    const { tools } = mountPlugin()
    // The registry reads this field off the registered definition; a definition
    // that does not declare it is treated as `exclusive` and serialized.
    for (const tool of tools.registered) {
      expect(typeof (tool as { isConcurrencySafe?: unknown }).isConcurrencySafe).toBe('function')
    }
  })
})

describe('the safety gate and the approval seam', () => {
  /**
   * What these tests do and do not establish.
   *
   * They establish the plugin's half against a real Cordis context: `provide()`
   * is what makes `ctx.get('approval')` resolve, resolution walks up through
   * `extend()`, and the warning fires on absence and only while the gate is on.
   *
   * They cannot establish the host's half — that a deployment which composes no
   * ApprovalService is the same thing the tool runtime's own `ctx.get('approval')`
   * sees. That link is evidence, not test: the service is an ordinary Cordis
   * service (`packages/interaction/user-approval/src/index.ts`, `super(ctx,
   * 'approval')`) mounted as a plain host row, and five shipped DSH packages read
   * it from their own plugin contexts (`tool-fs`, `tool-pwsh`, `tool-bash`,
   * `subagent`, `plugin-manager`).
   */
  const approvalWarnings = (logs: readonly string[]): string[] =>
    logs.filter((line) => line.includes('approval service'))

  it('detects an approval channel through the same registry the tool runtime reads', () => {
    // The detection itself, against a real Cordis context: `provide` is what makes
    // `ctx.get('approval')` resolve, so this proves the check keys on the service
    // registry rather than on a property the test happened to set.
    const without = new Context()
    const with_ = new Context()
    with_.provide('approval', { request: async () => 'allowed-once' as const })

    expect(plugin.hasApprovalChannel(without)).toBe(false)
    expect(plugin.hasApprovalChannel(with_)).toBe(true)
    // And it resolves across contexts, which is the shape DSH actually has: the
    // service is provided on the host root while a plugin runs on a context
    // extended from it. This is the only part of the detection a test here can
    // reach — see the note on the two warnings tests for what it cannot.
    expect(plugin.hasApprovalChannel(with_.extend())).toBe(true)
    expect(plugin.hasApprovalChannel(without.extend())).toBe(false)
  })

  it('warns at startup when the gate is enabled and nothing can approve an ask', () => {
    const logs: string[] = []
    mountPlugin({ gates: { safety: { enabled: true } } }, { captureLogs: logs })

    const warnings = approvalWarnings(logs)
    expect(warnings).toHaveLength(1)
    // The message has to name the consequence, not just the missing service: an
    // operator's symptom is a refused tool call carrying an "approve" reason.
    expect(warnings[0]).toContain('denial')
    expect(warnings[0]).toContain('dsh-user-approval')
  })

  it('stays silent when an approval service is mounted', () => {
    const logs: string[] = []
    mountPlugin(
      { gates: { safety: { enabled: true } } },
      { captureLogs: logs, withApproval: true },
    )
    expect(approvalWarnings(logs)).toEqual([])
  })

  it('stays silent when the gate is off, because no ask can be produced', () => {
    // Exactly when the gate is on: a plugin that warns about a seam it never
    // reaches is noise, and noise is how a real warning gets ignored.
    const logs: string[] = []
    mountPlugin(undefined, { captureLogs: logs })
    expect(approvalWarnings(logs)).toEqual([])
  })
})

describe('the recent() window', () => {
  /**
   * A hand-built record, because the point of these tests is the *order* of a
   * history rather than what the service recorded.
   *
   * `seq` is stamped in call order here, deliberately independent of `at`: the two
   * disagree in exactly the case these tests are about, because `at` is the send
   * time while the core assigns `seq` when the call finishes. In the built core
   * `seq` is required and `recent()` is already ordered by it
   * (`packages/core/src/service.ts`, `readonly seq: number`), which is why the
   * fixture carries it and why the assertions below are about what this package
   * adds on top of that order rather than about producing an order at all.
   */
  let nextSeq = 1
  const record = (at: number, feature: EgressFeature = 'tool:jev_ask'): JevCallRecord => ({
    seq: nextSeq++,
    feature,
    at,
    latencyMs: 0,
    ok: true,
    redactionRules: [],
    redactions: 0,
    stateChars: 0,
    truncated: false,
  })

  it('orders calls by when they were sent, not by when they finished', () => {
    // The service appends its history in `record()`, which runs when a call
    // *finishes*, and the core now orders `recent()` by that append order (`seq`).
    // Send order is a different order, and this is the function that recovers it.
    const recorded = [record(200, 'tool:jev_check'), record(100)]
    expect(plugin.orderRecent(recorded).map((entry) => entry.at)).toEqual([100, 200])
    // What the history itself reports: append order, so the later *send* first.
    expect(recorded.map((entry) => entry.seq)).toEqual([1, 2])
  })

  it('copies, so ordering a history never rewrites it', () => {
    // `recent()` returns a frozen copy now (`Object.freeze([...this.history])`), so
    // this is belt-and-braces rather than the only thing standing between a caller
    // and the service's history. It still asserts the property that matters: a
    // caller that reverses what it was given cannot rewrite what other readers see.
    const recorded = [record(2), record(1)]
    const ordered = plugin.orderRecent(recorded)
    expect(ordered).not.toBe(recorded)
    ordered.reverse()
    expect(recorded.map((entry) => entry.at)).toEqual([2, 1])
  })

  it('gives the history an order that does not depend on the wall clock', async () => {
    // The property `seq` exists for, and the reason `recent()` is now trustworthy
    // without help: `at` has millisecond resolution, so two concurrent calls
    // routinely stamp the same value, while `seq` strictly increases in the order
    // records are appended. Asserted with no spacing at all, so a tie is the
    // expected case rather than a flaky one.
    const service = new JevService({
      provider: new MockProvider(),
      egress: new EgressContract(
        { transmitting: true, enabled: allOn() },
        'https://api.typesafe.ai',
      ),
    })
    const questions = { q: { type: 'noul' as const, instructions: 'ok?' } }
    await Promise.all([
      service.ask({ feature: 'tool:jev_ask', state: 'a', questions }),
      service.ask({ feature: 'tool:jev_ask', state: 'b', questions }),
    ])

    const records = service.recent()
    expect(records.map((entry) => entry.seq)).toEqual([1, 2])
    // Frozen, not the live array: a consumer cannot reorder the history in place.
    expect(Object.isFrozen(records)).toBe(true)
  })

  it('reports two overlapping calls in send order whichever finishes first', async () => {
    let releaseFirst: () => void = () => undefined
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const provider: JevProvider = {
      id: 'paced',
      answer: async (request) => {
        // The first call blocks until the second has already been recorded.
        if (JSON.stringify(request.state) === '"first"') await firstMayFinish
        return { model: 'paced', provider: 'paced', latencyMs: 1, answers: {} }
      },
    }
    const service = new JevService({
      provider,
      egress: new EgressContract(
        { transmitting: true, enabled: allOn() },
        'https://api.typesafe.ai',
      ),
    })
    const questions = { q: { type: 'noul' as const, instructions: 'ok?' } }

    const first = service.ask({ feature: 'tool:jev_ask', state: 'first', questions })
    // The sends are held more than a millisecond apart because this test asserts
    // *send* order, and `at` is the only key that carries it — `seq` orders the
    // history by completion instead. Two sends inside one millisecond would be
    // indistinguishable by `at`, and the sort would fall back to append order,
    // which is the opposite of what is asserted here.
    await new Promise((resolve) => setTimeout(resolve, 10))
    const second = service.ask({ feature: 'tool:jev_ask', state: 'second', questions })
    await second
    releaseFirst()
    await first

    // Completion order is second-then-first, and the history reports exactly that;
    // the reported order is send order, which is what this package adds.
    const recorded = service.recent()
    expect(recorded[0]?.at).toBeGreaterThan(recorded[1]?.at ?? 0)
    expect(recorded[0]?.seq).toBeLessThan(recorded[1]?.seq ?? 0)
    const ordered = plugin.orderRecent(recorded)
    expect(ordered[0]?.at).toBeLessThan(ordered[1]?.at ?? 0)
  })

  it('is wired into the service the plugin publishes', async () => {
    const { ctx } = mountPlugin()
    const service = ctx.get('jev') as RegisteredService & { recent(): readonly JevCallRecord[] }
    await service.ask({
      feature: 'tool:jev_ask',
      state: 'a',
      questions: { q: { type: 'noul', instructions: 'ok?' } },
    })
    await service.ask({
      feature: 'tool:jev_ask',
      state: 'b',
      questions: { q: { type: 'noul', instructions: 'ok?' } },
    })
    const at = service.recent().map((entry) => entry.at)
    expect(at).toHaveLength(2)
    expect(at).toEqual([...at].sort((left, right) => left - right))
  })
})
