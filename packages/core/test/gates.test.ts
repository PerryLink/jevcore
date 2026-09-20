import { describe, expect, it, vi } from 'vitest'
import { EGRESS_FEATURES, EgressContract, type EgressFeature } from '../src/egress.js'
import { createContextGate, CONTEXT_QUESTIONS, resultText } from '../src/gates/context.js'
import {
  createSafetyGate,
  DEFAULT_GATED_TOOL_PATTERNS,
  HAZARD_QUESTIONS,
  isGated,
  serializeArguments,
} from '../src/gates/safety.js'
import { MockProvider } from '../src/provider/mock.js'
import { JevService } from '../src/service.js'
import { JevProviderError, type JevAnswer, type JevProvider } from '../src/types.js'

const allOn = (): Record<EgressFeature, boolean> =>
  Object.fromEntries(EGRESS_FEATURES.map((feature) => [feature, true])) as Record<EgressFeature, boolean>

const service = (provider: JevProvider = new MockProvider()) =>
  new JevService({
    provider,
    egress: new EgressContract({ transmitting: true, enabled: allOn() }, 'https://api.typesafe.ai'),
  })

/** A provider that answers every question with the given noul probability. */
const answering = (noul: number, confidence = 0.9): JevProvider => ({
  id: 'fixed',
  answer: async (_request, _signal) => ({
    model: 'm',
    provider: 'fixed',
    latencyMs: 1,
    answers: Object.fromEntries(
      Object.keys(HAZARD_QUESTIONS).map((key) => [
        key,
        { type: 'noul', noul, confidence } as JevAnswer,
      ]),
    ),
  }),
})

describe('gated tool selection', () => {
  it('gates execution and file-mutating tools', () => {
    for (const name of ['pwsh', 'bash', 'write', 'edit_to_file', 'run_code', 'git_status']) {
      expect(isGated(name)).toBe(true)
    }
  })

  it('does not gate read-only tools', () => {
    for (const name of ['read', 'glob', 'grep', 'ask_user_question']) {
      expect(isGated(name)).toBe(false)
    }
  })

  it('gates an MCP tool whose name mentions a shell', () => {
    expect(isGated('mcp__server__shell_exec')).toBe(true)
  })

  it('matches case-insensitively', () => {
    expect(isGated('PowerShell')).toBe(true)
  })

  it('exposes its patterns so the coverage is reviewable', () => {
    expect(DEFAULT_GATED_TOOL_PATTERNS.length).toBeGreaterThan(0)
  })
})

describe('argument serialization', () => {
  it('serializes ordinary arguments', () => {
    expect(serializeArguments({ a: 1 })).toBe('{"a":1}')
  })

  it('survives a cyclic argument object without denying the call', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(serializeArguments(cyclic)).toContain('could not be serialized')
  })
})

describe('safety gate decisions', () => {
  const gate = (provider: JevProvider, onUndecided: 'ask' | 'allow' | 'deny' = 'ask') =>
    createSafetyGate({ service: service(provider), onUndecided, minConfidence: 0.7 })

  it('allows a tool it does not gate without calling Jev', async () => {
    const answer = vi.fn()
    const spy: JevProvider = { id: 'spy', answer }
    const decision = await gate(spy)({ name: 'read', args: { path: 'x' } })
    expect(decision.kind).toBe('allow')
    expect(answer).not.toHaveBeenCalled()
  })

  it('asks the human when a hazard is raised', async () => {
    const decision = await gate(answering(0.95))({ name: 'pwsh', args: { command: 'rm -rf /' } })
    expect(decision.kind).toBe('ask')
    expect(decision.reason).toContain('safety gate')
    expect(decision.raised?.length).toBeGreaterThan(0)
  })

  it('allows a clearly safe call', async () => {
    const decision = await gate(answering(0.01))({ name: 'pwsh', args: { command: 'ls' } })
    expect(decision.kind).toBe('allow')
  })

  it('fails closed on undecided when configured to deny', async () => {
    const decision = await gate(answering(0.5, 0.1), 'deny')({
      name: 'pwsh',
      args: { command: 'ls' },
    })
    expect(decision.kind).toBe('deny')
  })

  it('fails open on undecided only when explicitly configured to', async () => {
    const decision = await gate(answering(0.5, 0.1), 'allow')({
      name: 'pwsh',
      args: { command: 'ls' },
    })
    expect(decision.kind).toBe('allow')
  })

  it('defaults an undecided call to ask, never to allow', async () => {
    const decision = await gate(answering(0.5, 0.1))({ name: 'pwsh', args: { command: 'ls' } })
    expect(decision.kind).toBe('ask')
  })

  it('does not treat a low-confidence hazard answer as a raised hazard', async () => {
    // High probability but low confidence: not reportable as a raised hazard.
    const decision = await gate(answering(0.99, 0.2))({ name: 'pwsh', args: { command: 'x' } })
    expect(decision.raised).toBeUndefined()
  })

  it('never runs when the egress contract forbids it', async () => {
    const answer = vi.fn()
    const spy: JevProvider = { id: 'spy', answer }
    const svc = new JevService({
      provider: spy,
      egress: new EgressContract(
        { transmitting: true, enabled: { ...allOn(), 'gate:safety': false } },
        'https://api.typesafe.ai',
      ),
    })
    const decision = await createSafetyGate({ service: svc, onUndecided: 'deny' })({
      name: 'pwsh',
      args: { command: 'rm -rf /' },
    })
    expect(decision.kind).toBe('allow')
    expect(answer).not.toHaveBeenCalled()
  })

  it('routes an unreachable judge through the undecided policy rather than allowing', async () => {
    const failing: JevProvider = {
      id: 'failing',
      answer: async () => {
        throw new JevProviderError('down', 'upstream-unreachable')
      },
    }
    expect((await gate(failing, 'ask')({ name: 'pwsh', args: {} })).kind).toBe('ask')
    expect((await gate(failing, 'deny')({ name: 'pwsh', args: {} })).kind).toBe('deny')
  })

  it('reports the failure code it could not recover from', async () => {
    const failing: JevProvider = {
      id: 'failing',
      answer: async () => {
        throw new JevProviderError('down', 'no-credential')
      },
    }
    const decision = await gate(failing)({ name: 'pwsh', args: {} })
    expect(decision.reason).toContain('no-credential')
  })

  it('includes the supplied context in what it judges', async () => {
    let seen: unknown
    const capture: JevProvider = {
      id: 'capture',
      answer: async (request) => {
        seen = request.state
        return { model: 'm', provider: 'capture', latencyMs: 1, answers: {} }
      },
    }
    await createSafetyGate({
      service: service(capture),
      onUndecided: 'ask',
      describeContext: () => 'workspace: C:/work',
    })({ name: 'pwsh', args: { command: 'ls' } })
    expect(JSON.stringify(seen)).toContain('C:/work')
  })
})

describe('the hazard list is the disclosure', () => {
  it('asks exactly the declared hazards', async () => {
    let seen: Record<string, unknown> = {}
    const capture: JevProvider = {
      id: 'capture',
      answer: async (request) => {
        seen = request.questions as Record<string, unknown>
        return { model: 'm', provider: 'capture', latencyMs: 1, answers: {} }
      },
    }
    await createSafetyGate({ service: service(capture), onUndecided: 'ask' })({
      name: 'pwsh',
      args: { command: 'ls' },
    })
    expect(Object.keys(seen).sort()).toEqual(Object.keys(HAZARD_QUESTIONS).sort())
  })

  it('declares every hazard as a noul question', () => {
    for (const question of Object.values(HAZARD_QUESTIONS)) {
      expect(question.type).toBe('noul')
    }
  })
})

describe('context gate', () => {
  /** A provider that answers every context question with the given probability. */
  const answeringContext = (noul: number, confidence = 0.9): JevProvider => ({
    id: 'fixed',
    answer: async () => ({
      model: 'm',
      provider: 'fixed',
      latencyMs: 1,
      answers: Object.fromEntries(
        Object.keys(CONTEXT_QUESTIONS).map((key) => [
          key,
          { type: 'noul', noul, confidence } as JevAnswer,
        ]),
      ),
    }),
  })

  const gate = (provider: JevProvider, goal?: string) =>
    createContextGate({
      service: service(provider),
      ...(goal === undefined ? {} : { describeGoal: () => goal }),
    })

  const big = (text: string) => [{ type: 'text', text }]

  it('flattens result content to text', () => {
    expect(resultText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb')
    expect(resultText([{ type: 'image' }])).toBe('')
    expect(resultText(undefined)).toBe('')
  })

  it('does not judge a small result at all', async () => {
    const answer = vi.fn()
    const spy: JevProvider = { id: 'spy', answer }
    const decision = await gate(spy, 'goal')({ toolName: 'read', content: big('short') })
    expect(decision.block).toBe(false)
    expect(answer).not.toHaveBeenCalled()
  })

  it('keeps a large result judged relevant', async () => {
    const decision = await gate(answeringContext(0.95), 'a goal')({
      toolName: 'read',
      content: big('x'.repeat(5_000)),
    })
    expect(decision.block).toBe(false)
  })

  it('withholds a large result judged irrelevant, with corrective feedback', async () => {
    const decision = await gate(answeringContext(0.05), 'a goal')({
      toolName: 'read',
      content: big('x'.repeat(5_000)),
    })
    expect(decision.block).toBe(true)
    expect(decision.feedback).toContain('not relevant')
    expect(decision.feedback).toContain('narrower query')
  })

  it('does not ask about relevance when no goal is available', async () => {
    let seen: Record<string, unknown> = {}
    const capture: JevProvider = {
      id: 'capture',
      answer: async (request) => {
        seen = request.questions as Record<string, unknown>
        return { model: 'm', provider: 'capture', latencyMs: 1, answers: {} }
      },
    }
    await gate(capture)({ toolName: 'read', content: big('x'.repeat(5_000)) })
    expect(Object.keys(seen)).toEqual(['adds_information'])
  })

  it('fails open when the judge is unreachable, so no result is lost', async () => {
    const failing: JevProvider = {
      id: 'failing',
      answer: async () => {
        throw new JevProviderError('down', 'upstream-unreachable')
      },
    }
    const decision = await gate(failing, 'a goal')({
      toolName: 'read',
      content: big('x'.repeat(5_000)),
    })
    expect(decision.block).toBe(false)
    expect(decision.reason).toContain('upstream-unreachable')
  })

  it('never runs when the egress contract forbids it', async () => {
    const answer = vi.fn()
    const spy: JevProvider = { id: 'spy', answer }
    const svc = new JevService({
      provider: spy,
      egress: new EgressContract(
        { transmitting: true, enabled: { ...allOn(), 'gate:context': false } },
        'https://api.typesafe.ai',
      ),
    })
    const decision = await createContextGate({ service: svc, describeGoal: () => 'g' })({
      toolName: 'read',
      content: big('x'.repeat(5_000)),
    })
    expect(decision.block).toBe(false)
    expect(answer).not.toHaveBeenCalled()
  })

  it('declares two questions and asks both when a goal exists', () => {
    expect(Object.keys(CONTEXT_QUESTIONS).sort()).toEqual(['adds_information', 'is_relevant'])
  })
})
