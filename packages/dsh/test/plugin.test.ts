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
import { EGRESS_FEATURES, EgressContract } from '@dsh-jev/core'
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

const mountPlugin = (config?: unknown, options: { withSkills?: boolean } = {}) => {
  const ctx = new Context()
  const tools = fakeTools()
  const skills = fakeSkills()
  // `ctx.get('skills')` reads through Cordis's reflect registry, so the fake has
  // to be registered the same way a real provider would be — a plain property
  // assignment is invisible to `get`.
  ctx.provide('tools', tools.service)
  ctx.provide('credentials', fakeCredentials())
  // Omitted by default so a test asserts the plugin still loads without the
  // skill subsystem present — the whole point of declaring it optional.
  if (options.withSkills === true) {
    ctx.provide('skills', skills.service)
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
    expect(plugin.name).toBe('dsh-jev')
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
