import { describe, expect, it, vi } from 'vitest'
import { SEVERITY_LEVELS, type SeverityLevel } from '../src/config.js'
import {
  EGRESS_FEATURES,
  EGRESS_FIELDS,
  EgressContract,
  type EgressFeature,
} from '../src/egress.js'
import { createContextGate, CONTEXT_QUESTIONS, resultText } from '../src/gates/context.js'
import {
  createSafetyGate,
  DEFAULT_GATED_TOOL_PATTERNS,
  HAZARD_QUESTIONS,
  SAFETY_FEATURE,
  SAFETY_QUESTIONS,
  SEVERITY_QUESTION_ID,
  SEVERITY_QUESTIONS,
  isGated,
  serializeArguments,
} from '../src/gates/safety.js'
import { MockProvider } from '../src/provider/mock.js'
import { redact } from '../src/redact.js'
import { JevService } from '../src/service.js'
import { JevProviderError, type JevAnswer, type JevProvider } from '../src/types.js'

const allOn = (): Record<EgressFeature, boolean> =>
  Object.fromEntries(EGRESS_FEATURES.map((feature) => [feature, true])) as Record<EgressFeature, boolean>

const service = (provider: JevProvider = new MockProvider()) =>
  new JevService({
    provider,
    egress: new EgressContract({ transmitting: true, enabled: allOn() }, 'https://api.typesafe.ai'),
  })

/**
 * A score answer naming one rung of the declared ladder.
 *
 * The legend is built from the declared rubric so a fixture cannot quietly use a
 * scale the gate does not send; `probabilities` is a point mass on the rung the
 * fixture names, which is what makes it `decided` under the default floors.
 */
const severityAnswer = (level: SeverityLevel, confidence = 0.9): JevAnswer => {
  const index = SEVERITY_LEVELS.indexOf(level)
  const question = SEVERITY_QUESTIONS[SEVERITY_QUESTION_ID]
  const criteria = question?.type === 'score' ? question.criteria : []
  return {
    type: 'score',
    score: index,
    legend: Object.fromEntries(criteria.map((description, i) => [String(i), description])),
    probabilities: { [String(index)]: 0.95 },
    confidence,
  }
}

/**
 * A provider that answers every question with the given noul probability and the
 * severity score at the given level.
 *
 * Severity is answered here rather than left out on purpose: an unanswered
 * severity is undecided, and undecided is asked about rather than waved through,
 * so a fixture that omitted it would exercise that one path in every test
 * instead of the path each test names.
 */
const answering = (noul: number, severity: SeverityLevel = 'none'): JevProvider => ({
  id: 'fixed',
  answer: async (_request, _signal) => ({
    model: 'm',
    provider: 'fixed',
    latencyMs: 1,
    answers: {
      ...Object.fromEntries(
        Object.keys(HAZARD_QUESTIONS).map((key) => [key, { type: 'noul', noul } as JevAnswer]),
      ),
      [SEVERITY_QUESTION_ID]: severityAnswer(severity),
    },
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
    const decision = await gate(answering(0.5), 'deny')({
      name: 'pwsh',
      args: { command: 'ls' },
    })
    expect(decision.kind).toBe('deny')
  })

  it('fails open on undecided only when explicitly configured to', async () => {
    const decision = await gate(answering(0.5), 'allow')({
      name: 'pwsh',
      args: { command: 'ls' },
    })
    expect(decision.kind).toBe('allow')
  })

  it('defaults an undecided call to ask, never to allow', async () => {
    const decision = await gate(answering(0.5))({ name: 'pwsh', args: { command: 'ls' } })
    expect(decision.kind).toBe('ask')
  })

  it('judges a hazard on its probability, since a noul carries nothing else', async () => {
    // This replaced a test asserting that a high probability with a low
    // confidence was not a raised hazard. That confidence was supplied by this
    // package rather than by Jev — see `NoulAnswer` — and it made the two routes
    // behave oppositely: absent on live, 0.5 on the mock, which is below the
    // default floor, so every hazard resolved `undecided`. What decides now is
    // the probability floor alone.
    const decisive = await gate(answering(0.99))({ name: 'pwsh', args: { command: 'x' } })
    expect(decisive.raised).toBeDefined()

    const weak = await gate(answering(0.55))({ name: 'pwsh', args: { command: 'x' } })
    expect(weak.raised).toBeUndefined()
  })

  it('honours an operator floor of 0.9 rather than the default one', async () => {
    // Regression guard: `decide` re-tested the probability against a literal
    // fallback after `applyPolicy` had already enforced the configured floor, so
    // raising minProbability to 0.9 still flagged a 0.8 hazard as raised.
    const strict = createSafetyGate({
      service: service(answering(0.8)),
      onUndecided: 'ask',
      minConfidence: 0.7,
      minProbability: 0.9,
    })
    const decision = await strict({ name: 'pwsh', args: { command: 'ls' } })
    expect(decision.raised).toBeUndefined()
    expect(decision.kind).toBe('ask')
    expect(decision.reason).toContain('could not judge')
  })

  it('still raises a hazard that clears a raised floor', async () => {
    const strict = createSafetyGate({
      service: service(answering(0.95)),
      onUndecided: 'ask',
      minConfidence: 0.7,
      minProbability: 0.9,
    })
    const decision = await strict({ name: 'pwsh', args: { command: 'rm -rf /' } })
    expect(decision.raised?.length).toBeGreaterThan(0)
  })

  it('honours a relaxed floor by raising what the default floor would not', async () => {
    // 0.55 resolves to a decided `true`, but sits below the 0.7 default, so only
    // a relaxed floor should treat it as a raised hazard.
    const relaxed = createSafetyGate({
      service: service(answering(0.55)),
      onUndecided: 'ask',
      minConfidence: 0.7,
      minProbability: 0.5,
    })
    const decision = await relaxed({ name: 'pwsh', args: { command: 'ls' } })
    expect(decision.raised?.length).toBeGreaterThan(0)

    // The same answer under the default floor is undecided, not raised.
    const byDefault = await gate(answering(0.55))({ name: 'pwsh', args: { command: 'ls' } })
    expect(byDefault.raised).toBeUndefined()
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

describe('the declaration is the disclosure', () => {
  it('asks exactly the declared questions', async () => {
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
    expect(Object.keys(seen).sort()).toEqual(Object.keys(SAFETY_QUESTIONS).sort())
  })

  it('declares the hazards and the severity score, and nothing else', () => {
    expect(Object.keys(HAZARD_QUESTIONS)).toHaveLength(5)
    expect(Object.keys(SEVERITY_QUESTIONS)).toEqual([SEVERITY_QUESTION_ID])
    // The batch is the two declarations, so a question added to the gate without
    // being declared here cannot reach the wire unnoticed.
    expect(Object.keys(SAFETY_QUESTIONS).sort()).toEqual(
      [...Object.keys(HAZARD_QUESTIONS), SEVERITY_QUESTION_ID].sort(),
    )
  })

  it('declares every hazard as a noul question', () => {
    for (const question of Object.values(HAZARD_QUESTIONS)) {
      expect(question.type).toBe('noul')
    }
  })

  it('declares the severity question as a score over the declared ladder', () => {
    const question = SEVERITY_QUESTIONS[SEVERITY_QUESTION_ID]
    if (question?.type !== 'score') throw new Error('the severity question must be a score')
    expect(question.criteria).toHaveLength(SEVERITY_LEVELS.length)
    // One description per rung, all different: a repeated or missing description
    // would make two positions in the scale indistinguishable.
    expect(new Set(question.criteria).size).toBe(SEVERITY_LEVELS.length)
  })

  it('fits inside the questions cap it declares for egress', () => {
    // Not decoration. `measure` *refuses* an over-cap question map, and the
    // gate's catch turns that refusal into an undecided verdict on every judged
    // call — a gate that asks about everything, or under `onUndecided: allow`
    // one that allows everything, with nothing in the config to explain it. The
    // budget is asserted here so a future rubric expansion fails loudly instead.
    //
    // Measured twice: once with redaction bypassed, which is the declared size
    // and the number this test is really about, and once through the real
    // redaction pass, which is what actually leaves. A redaction rule that
    // fired on a question would shrink the second number and hide an over-cap
    // declaration behind it.
    const identityRedact = (value: unknown) => ({
      value: value as never,
      summary: { redactions: 0, rules: [], fields: [], values: 0 },
    })
    const cap = EGRESS_FIELDS[SAFETY_FEATURE].find((field) => field.field === 'questions')?.maxChars
    expect(cap).toBeDefined()
    const contract = new EgressContract(
      { transmitting: true, enabled: allOn() },
      'https://api.typesafe.ai',
    )
    const state = { tool: 'pwsh', arguments: '{}' }
    const declared = contract.measure({
      feature: SAFETY_FEATURE,
      state,
      questions: SAFETY_QUESTIONS,
      redact: identityRedact,
    })
    const sent = contract.measure({
      feature: SAFETY_FEATURE,
      state,
      questions: SAFETY_QUESTIONS,
      redact,
    })
    expect(declared.questionsChars).toBeLessThanOrEqual(cap ?? 0)
    expect(sent.questionsChars).toBeLessThanOrEqual(cap ?? 0)
  })
})

describe('context gate', () => {
  /** A provider that answers every context question with the given probability. */
  const answeringContext = (noul: number): JevProvider => ({
    id: 'fixed',
    answer: async () => ({
      model: 'm',
      provider: 'fixed',
      latencyMs: 1,
      answers: Object.fromEntries(
        Object.keys(CONTEXT_QUESTIONS).map((key) => [
          key,
          { type: 'noul', noul } as JevAnswer,
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

  it('does not judge a result that carries no text, however large it is', async () => {
    // A result can be big without being text: an attachment block, or a binary
    // payload. There is nothing for the gate to read, so it must stay out of the
    // way rather than call Jev with an empty state and guess.
    const answer = vi.fn()
    const spy: JevProvider = { id: 'spy', answer }
    const decision = await gate(spy, 'goal')({
      toolName: 'screenshot',
      content: [{ type: 'image' }, { type: 'text', text: '   ' }],
    })
    expect(decision.block).toBe(false)
    expect(answer).not.toHaveBeenCalled()
  })

  it('leaves an attachment-only result alone even with a goal set', async () => {
    const answer = vi.fn()
    const spy: JevProvider = { id: 'spy', answer }
    await gate(spy, 'a goal')({ toolName: 'screenshot', content: [{ type: 'image' }] })
    expect(answer).not.toHaveBeenCalled()
  })

  it('judges only the text of a mixed result', async () => {
    // A block that is not text must not reach the transmitted state: a base64
    // blob sent as text would be billed as input and would leak an image.
    let seen: unknown
    const capture: JevProvider = {
      id: 'capture',
      answer: async (request) => {
        seen = request.state
        return { model: 'm', provider: 'capture', latencyMs: 1, answers: {} }
      },
    }
    await gate(capture, 'a goal')({
      toolName: 'mixed',
      content: [
        { type: 'image', data: 'BLOB_SHOULD_NOT_APPEAR' },
        { type: 'text', text: 'x'.repeat(5_000) },
      ],
    })
    expect(JSON.stringify(seen)).not.toContain('BLOB_SHOULD_NOT_APPEAR')
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
