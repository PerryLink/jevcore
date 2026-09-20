/**
 * The published surface must actually publish what the changelog promises.
 *
 * `CHANGELOG.md` named `DEFAULT_REQUEST_TIMEOUT_MS`, `DEFAULT_REQUEST_MAX_RETRIES`,
 * `MAX_SCORE_LEVELS`, `MAX_CHOICE_OPTIONS`, `isEmptyEntry`, `NoulCriteria` and
 * `EntryType` as newly available, but none of them were re-exported from this
 * package's entry module — and `package.json`'s `exports` map allows `.` only, so
 * there was no second path a caller could reach them through. They existed, were
 * typed, were documented, and were unreachable.
 *
 * `NoulCriteria` is the one that hurt: it is the type of `noul()`'s second
 * argument, so a caller could not name the thing it was already passing. The DSH
 * package needed it and could not import it.
 *
 * Every import here is from `../src/index.js` rather than from the defining
 * module, because the defect was precisely the gap between the two.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REQUEST_MAX_RETRIES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_CHOICE_OPTIONS,
  MAX_SCORE_LEVELS,
  isEmptyEntry,
  noul,
  type EntryType,
  type NoulCriteria,
  type NoulQuestion,
} from '../src/index.js'

describe('the changelog-named symbols are reachable from the package entry', () => {
  it('exports the documented score and choice ceilings as numbers', () => {
    // Numbers, not literal types: a named limit exists to be compared against.
    expect(MAX_SCORE_LEVELS).toBe(10)
    expect(MAX_CHOICE_OPTIONS).toBe(255)
  })

  it('exports the transport defaults', () => {
    expect(Number.isInteger(DEFAULT_REQUEST_TIMEOUT_MS)).toBe(true)
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBeGreaterThan(0)
    expect(Number.isInteger(DEFAULT_REQUEST_MAX_RETRIES)).toBe(true)
    expect(DEFAULT_REQUEST_MAX_RETRIES).toBeGreaterThanOrEqual(0)
  })

  it('exports the empty-guidance predicate, which is what it says', () => {
    expect(isEmptyEntry('')).toBe(true)
    expect(isEmptyEntry('   ')).toBe(true)
    expect(isEmptyEntry({})).toBe(true)
    expect(isEmptyEntry([])).toBe(true)
    expect(isEmptyEntry(null)).toBe(true)
    expect(isEmptyEntry('ask something')).toBe(false)
    expect(isEmptyEntry({ question: 'ask something' })).toBe(false)
  })

  it('lets a caller name the type of noul()\'s second argument', () => {
    // The compile-time half of the defect: this assignment only type-checks when
    // `NoulCriteria` is exported. The runtime half asserts the value arrives.
    const criteria: NoulCriteria = { true: 'explicitly time-sensitive', false: 'no urgency' }
    const question: NoulQuestion = noul('Does this convey urgency?', criteria)
    expect(question.criteria).toEqual(criteria)
  })

  it('accepts structured guidance through the exported EntryType', () => {
    const structured: EntryType = {
      question: 'Is the resume for the same person as `potential_duplicate`?',
      potential_duplicate: { name: 'John Smith' },
    }
    expect(noul(structured).instructions).toEqual(structured)
  })
})
