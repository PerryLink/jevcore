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
import { describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.js'

interface RegisteredService {
  ask(input: { feature: string; state: unknown; questions: unknown }): Promise<{ provider: string }>
  stats(): { calls: number; transmitted: number }
  transmitting: boolean
}

/** Minimal stand-ins for the two services the plugin injects. */
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

const mountPlugin = (config?: unknown) => {
  const ctx = new Context()
  const tools = fakeTools()
  ;(ctx as unknown as { tools: unknown }).tools = tools.service
  ;(ctx as unknown as { credentials: unknown }).credentials = fakeCredentials()
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
  return { ctx, tools, events }
}

describe('plugin module shape', () => {
  it('exports a name and its injections', () => {
    expect(plugin.name).toBe('dsh-jev')
    expect(plugin.inject).toContain('tools')
    expect(plugin.inject).toContain('credentials')
  })

  it('exports apply as a function', () => {
    expect(typeof plugin.apply).toBe('function')
  })

  it('does NOT export a Config symbol', () => {
    // Cordis treats `Config` as a Standard Schema and calls
    // `Config['~standard'].validate(...)` before the plugin starts. Exporting
    // anything else under that name crashes activation, so this is a
    // regression guard, not a style preference.
    expect(Object.keys(plugin)).not.toContain('Config')
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
    expect(() => mountPlugin({ provider: 'nonsense' })).toThrow(/must be "mock" or "live"/)
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
