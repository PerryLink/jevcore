/**
 * Type-level conformance with the vendor SDKs.
 *
 * The provider tests use stubs, which proves our side of the contract but not
 * that the vendor would accept it. This file makes our question and answer
 * shapes *assign* to the SDK's own types, so a drift in either direction is a
 * compile error rather than a runtime surprise on the one route that costs
 * money and transmits data.
 *
 * The two SDKs disagree in ways worth pinning down here:
 *
 *  - TypeSafe's `Usage` is snake_case (`input_tokens`); OpenRouter's is
 *    camelCase (`inputTokens`). Reading the wrong spelling does not throw — it
 *    silently reports no usage.
 *  - TypeSafe's `ScoreCriteria` is `readonly [EntryType, EntryType, ...]`, an
 *    ordered tuple of at least two entries. A score question that sends a keyed
 *    map is rejected, which is how this file came to exist.
 *
 * Both SDKs are dev dependencies of this package, so these assertions run in CI
 * without a credential and without a socket.
 */

import { describe, expect, it } from 'vitest'
import type {
  ChoiceQuestion as SafeChoiceQuestion,
  NoulQuestion as SafeNoulQuestion,
  ScoreCriteria,
  ScoreQuestion as SafeScoreQuestion,
  Usage as SafeUsage,
} from '@typesafe-ai/sdk'
import { assertValidQuestion, choice, noul, score } from '../src/primitives.js'
import type { CategoricalAnswer, NoulAnswer, ScoreAnswer } from '../src/types.js'

describe('conformance with the TypeSafe SDK', () => {
  it('our question shapes are accepted as the SDK types', () => {
    // A compile error here means a question this project can build is one the
    // API would reject.
    const safeNoul: SafeNoulQuestion = noul('Is this urgent?')
    const safeChoice: SafeChoiceQuestion = choice('Which team?', { billing: 'Payments' })
    // The SDK encodes "at least two levels" as a tuple, which an array cannot be
    // statically known to satisfy — the length is checked at runtime by
    // `assertValidQuestion`. The assertion here is limited to element shape.
    const safeScore: SafeScoreQuestion = score('How risky?', { low: 'none', high: 'severe' }) as {
      type: 'score'
      instructions: string
      criteria: ScoreCriteria
    }

    expect(safeNoul.type).toBe('noul')
    expect(safeChoice.type).toBe('choice')
    expect(safeScore.type).toBe('score')
    // The tuple requires at least two entries, so a scale is never degenerate.
    expect(safeScore.criteria).toEqual(['none', 'severe'])
  })

  it('a score sends an ordered array, never a keyed map', () => {
    const question = score('How risky?', { low: 'none', medium: 'some', high: 'severe' })
    expect(Array.isArray(question.criteria)).toBe(true)
    expect(question.criteria).toEqual(['none', 'some', 'severe'])
  })

  it('the SDK and this package agree that a scale needs two described levels', () => {
    // The SDK encodes it as a tuple; we enforce it at runtime in
    // `assertValidQuestion`, because a caller can pass a map the type system
    // has already accepted.
    expect(() => assertValidQuestion('q', score('How risky?', { low: 'none', high: 'severe' }))).not.toThrow()
    expect(() => assertValidQuestion('q', score('How risky?', { low: 'none' }))).toThrow(
      /at least two/,
    )
    // A `null` level is refused at construction, before validation runs. Both
    // layers matter: construction stops the silent renumbering, and validation
    // catches a question assembled by other means.
    expect(() => score('How risky?', { low: 'none', high: null })).toThrow(/have no description/)
  })

  it('the docs permit a null score level but the live API rejects it', () => {
    // Recorded here because it is the one place this package deliberately does
    // NOT follow the published shape. `/primitives/advanced` lists score
    // criteria entries as accepting "string, object, array, or null", and the
    // SDK types `ScoreCriteria` over `EntryType`, which includes null. The live
    // endpoint answers 422 instead:
    //
    //   questions.q.score.criteria.1.str: Input should be a valid string
    //
    // So a null entry cannot be sent, and dropping it would renumber the scale.
    // Refusing it locally is the only behaviour that is neither wrong nor a
    // wasted round-trip.
    const documentedButRejected = { low: 'none', medium: null, high: 'severe' }
    expect(() => score('How risky?', documentedButRejected)).toThrow(/have no description/)
  })

  it('integer-like level names are refused rather than silently reordered', () => {
    // `Object.keys` lifts integer-like keys ahead of the rest, which would
    // produce a scale in an order the caller never wrote.
    expect(() => score('How risky?', { 10: 'ten', 2: 'two' })).toThrow(/integer-like/)
  })

  it('our answers carry the fields the SDK reports', () => {
    const noulAnswer: NoulAnswer = { type: 'noul', noul: 0.9 }
    const choiceAnswer: CategoricalAnswer = {
      type: 'choice',
      choice: 'billing',
      probabilities: { billing: 0.7, technical: 0.3 },
    }
    const scoreAnswer: ScoreAnswer = {
      type: 'score',
      score: 1.4,
      legend: { '0': 'none', '1': 'some', '2': 'severe' },
      probabilities: { '0': 0.1, '1': 0.5, '2': 0.4 },
    }

    expect(noulAnswer.noul).toBe(0.9)
    expect(choiceAnswer.choice).toBe('billing')
    // The legend keys are stringified rubric indices, matching `ScoreLegend`.
    expect(Object.keys(scoreAnswer.legend)).toEqual(['0', '1', '2'])
  })

  it('usage is snake_case on the wire and camelCase after SDK deserialization', () => {
    // Not a shape we build, but the two we must read. The SDK's zod schema
    // requires `input_tokens`; its TypeScript type declares `inputTokens`, and
    // `decisionsResponseUsageFromJSON` remaps one to the other. `readUsage`
    // accepts both, because reading the wrong spelling reports no usage at all
    // rather than failing.
    const wire = { input_tokens: 120, output_tokens: 8 }
    const deserialized: SafeUsage = { input_tokens: 120, output_tokens: 8 }
    expect(wire.input_tokens).toBe(120)
    expect(deserialized.output_tokens).toBe(8)
  })
})

describe('conformance with the OpenRouter route', () => {
  it('builds the plain System One body, with no OpenRouter-specific wrapper', () => {
    // This block used to parse our payload against `@openrouter/sdk`'s zod
    // schemas for `POST /api/alpha/decisions`. That route is no longer used: the
    // OpenRouter provider runs the official TypeSafe client against
    // `https://openrouter.ai/api`, which serves the same `/v1/systemone` the
    // TypeSafe route does. So the contract to conform to is the documented System
    // One one, and the request is the plain body — the old shape wrapped
    // everything in `decisionsRequest` because only the alpha route wanted that.
    const body = {
      model: 'jev-latest',
      state: 'x',
      questions: {
        urgent: noul('Is this urgent?'),
        team: choice('Which team?', { billing: 'Payments', technical: 'Bugs' }),
        risk: score('How risky?', { low: 'none', high: 'severe' }),
      },
    }
    expect(Object.keys(body).sort()).toEqual(['model', 'questions', 'state'])
    // A score question sends an ordered array of descriptions: a level's position
    // is its score, and a keyed map is rejected by the live API.
    expect(body.questions.risk.criteria).toEqual(['none', 'severe'])
    expect(Array.isArray(body.questions.risk.criteria)).toBe(true)
    expect(body.questions.risk.type).toBe('score')
    expect(body.questions.urgent.type).toBe('noul')
    expect(body.questions.team.type).toBe('choice')
  })
})
