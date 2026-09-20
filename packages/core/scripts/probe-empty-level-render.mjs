/**
 * A score level may be undescribed.
 *
 * The empty string is the supported way to hold a position in a scale without
 * describing it, which the live API accepts — verified: `["No impact", "",
 * "Users blocked"]` comes back with `legend` `{"2": "Users blocked"}`, so `high`
 * keeps its index where a dropped level would have moved it.
 *
 * That makes presentation a real question: if the model's answer lands on the
 * undescribed level, what should a caller see? Emitting `answer: ''` is
 * indistinguishable from "no answer was returned", so the renderer falls back to
 * the level's index and says why.
 *
 * Usage: node scripts/probe-empty-level-render.mjs
 */

import { MockProvider, renderAnswer } from 'jevcore'

// A score answer sitting on the undescribed middle level.
const answer = {
  type: 'score',
  score: 1.02,
  legend: { '0': 'No impact at all', '1': '', '2': 'Totally blocked' },
  probabilities: { '0': 0.04, '1': 0.9, '2': 0.06 },
  confidence: 0.9,
}

const rendered = renderAnswer('sev', answer)
console.log('rendered:', JSON.stringify(rendered, null, 2))
console.log('')

const problems = []
if (rendered.answer === '') problems.push('answer is an empty string, which reads as "no answer"')
if (rendered.answer === undefined) problems.push('answer is missing entirely')
if (rendered.note === undefined) problems.push('no note explaining that the level is undescribed')
if (rendered.score !== 1.02) problems.push('the numeric score was not preserved')

// The described cases must be unaffected.
const described = renderAnswer('sev', {
  ...answer,
  probabilities: { '0': 0.9, '1': 0.05, '2': 0.05 },
})
if (described.answer !== 'No impact at all') problems.push('a described level no longer renders its label')
if (described.note !== undefined) problems.push('a described level gained a note it does not need')

// Sanity: the mock still produces renderable score answers.
const mock = await new MockProvider().answer({
  state: 'x',
  questions: { q: { type: 'score', instructions: 'How bad?', criteria: ['none', '', 'bad'] } },
})
const mockRendered = renderAnswer('q', mock.answers.q)
if (typeof mockRendered.score !== 'number') problems.push('the mock score answer did not render a score')

if (problems.length > 0) {
  console.log('FAIL:')
  for (const problem of problems) console.log('  -', problem)
  process.exit(1)
}
console.log('PASS: an undescribed level renders its index plus a note, and described levels are unchanged.')
