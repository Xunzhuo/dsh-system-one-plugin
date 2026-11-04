/**
 * The system_one tool's questions: what System Two writes, checked and completed, and the requests that answer them.
 * Choice, noul, score and box questions go to the decision model; span questions (custom labels and the presets) and
 * the router's signals go to the span model.
 */
import { ROUTER_SIGNALS } from './questions.js'

export const PRESETS = ['pii', 'halu', 'evidence']
const DECISION_TYPES = ['choice', 'noul', 'score', 'box']
// the fields the Decision API reads of a question; it refuses a question that carries any other
const DECISION_FIELDS = ['type', 'instructions', 'criteria']
const SPAN_FIELDS = ['type', 'criteria', 'instructions', 'over', 'threshold']
// where System Two sometimes writes a question's instructions, and a box question's target
const INSTRUCTION_FIELDS = ['question', 'description', 'prompt']
const TARGET_FIELDS = ['target', 'what', 'find', 'id']

const pick = (question, fields) => Object.fromEntries(fields.filter(key => question[key] !== undefined).map(key => [key, question[key]]))

/** The type a question's criteria imply: a list of levels is a score, named options a choice, anything else yes/no. */
function impliedType(criteria) {
  if (Array.isArray(criteria)) return 'score'
  if (!criteria || typeof criteria !== 'object') return 'noul'
  return Object.keys(criteria).map(name => name.toLowerCase()).sort().join() === 'no,yes' ? 'noul' : 'choice'
}

/** A span question's labels: the names of its criteria. */
export function labelsOf(criteria) {
  if (Array.isArray(criteria)) return criteria.map(String).filter(Boolean)
  if (criteria && typeof criteria === 'object') return Object.keys(criteria)
  return []
}

function checkThreshold(id, threshold) {
  if (threshold !== undefined && !(typeof threshold === 'number' && threshold > 0 && threshold < 1)) {
    throw new Error(`question "${id}": threshold must be a number between 0 and 1`)
  }
}

/** What kind of question it is: a decision (choice, noul, score, box), a span question, or a router signal. */
export const kindOf = question => (question.signal ? 'signal' : question.preset || question.type === 'span' ? 'span' : 'decision')

// a question that asks for words: "Mark the words of …", "Extract …", "Highlight …"
const ASKS_FOR_WORDS = /^\s*(?:mark|highlight|underline|extract|tag|find the (?:words|phrases|spans))\b/i
const LABEL = /^[A-Z][A-Z0-9_]*$/

/**
 * A choice that can only be a label set: one option (a choice needs two), or options named as labels (ERROR,
 * COMPETITOR) under instructions that ask for words. System Two sometimes writes a span question so.
 */
function labelSet(question) {
  if (question.type !== 'choice' || !question.criteria || typeof question.criteria !== 'object' || Array.isArray(question.criteria)) return false
  const names = Object.keys(question.criteria)
  return names.length === 1 || (names.every(name => LABEL.test(name)) && ASKS_FOR_WORDS.test(question.instructions ?? ''))
}

/** System Two's questions, checked and completed: every question gets its type, a noul's criteria join its instructions. */
export function parseQuestions(value) {
  let questions = typeof value === 'string' ? JSON.parse(value) : value
  if (!questions || typeof questions !== 'object' || Array.isArray(questions) || Object.keys(questions).length === 0) {
    throw new Error('questions must be an object of question id -> {type, instructions, criteria}')
  }
  // a type written beside the questions, as {"type": "span", "ERROR": {...}}, is the type of those that have none
  if (typeof questions.type === 'string') {
    const { type, ...rest } = questions
    questions = Object.fromEntries(Object.entries(rest).map(([id, question]) => [id, question && typeof question === 'object' && !Array.isArray(question) && question.type === undefined ? { ...question, type } : question]))
    if (Object.keys(questions).length === 0) throw new Error('questions must be an object of question id -> {type, instructions, criteria}')
  }
  // a threshold written beside its question, as {"marks": {...}, "marks_threshold": 0.5}, is that question's
  for (const [id, value] of Object.entries(questions)) {
    const owner = id.endsWith('_threshold') ? id.slice(0, -'_threshold'.length) : undefined
    if (typeof value === 'number' && owner && questions[owner] && typeof questions[owner] === 'object' && !Array.isArray(questions[owner])) {
      questions = { ...questions, [owner]: { threshold: value, ...questions[owner] } }
      delete questions[id]
    }
  }
  const out = {}
  for (const [id, asked] of Object.entries(questions)) {
    if (!asked || typeof asked !== 'object' || Array.isArray(asked)) throw new Error(`question "${id}" must be an object`)
    let question = { ...asked }
    // {"preset": "pii"}, {"type": "pii"} and {"type": "span", "preset": "pii"} ask the same thing
    if (PRESETS.includes(question.type) && question.preset === undefined) question.preset = question.type
    if (question.preset !== undefined) {
      if (!PRESETS.includes(question.preset)) throw new Error(`question "${id}": preset must be ${PRESETS.join(', ')}`)
      checkThreshold(id, question.threshold)
      if (question.labels !== undefined && (question.preset !== 'pii' || !(Array.isArray(question.labels) || question.labels === 'all'))) {
        throw new Error(`question "${id}": labels (a list, or "all") picks the labels of preset pii`)
      }
      const labels = Array.isArray(question.labels) ? question.labels.map(String) : question.labels
      out[id] = Object.fromEntries(Object.entries({ preset: question.preset, threshold: question.threshold, labels }).filter(([, v]) => v !== undefined))
      continue
    }
    if (question.type === 'signal' || question.signal !== undefined) {
      const signal = question.signal ?? id
      if (!Object.hasOwn(ROUTER_SIGNALS, signal)) throw new Error(`question "${id}": signal must be one of ${Object.keys(ROUTER_SIGNALS).join(', ')}`)
      out[id] = { signal }
      continue
    }
    // System Two often leaves the type out of its first call
    if (question.type === undefined) question.type = impliedType(question.criteria)
    if (labelSet(question)) question.type = 'span'
    if (![...DECISION_TYPES, 'span'].includes(question.type)) throw new Error(`question "${id}" needs type choice, noul, score, box or span, a preset or a signal`)
    // the Decision API refuses a choice without options as malformed, item by item
    if (question.type === 'choice' && labelsOf(question.criteria).length < 2) {
      throw new Error(`question "${id}": a choice question needs criteria naming two or more options, as {"billing": "invoices, refunds", "engineering": "bugs, errors"}`)
    }
    if (question.type === 'span') {
      if (labelsOf(question.criteria).length === 0) throw new Error(`question "${id}": a span question needs criteria naming its labels, as {"LABEL": "what it marks"} or ["LABEL"]`)
      checkThreshold(id, question.threshold)
      out[id] = pick(question, SPAN_FIELDS)
      continue
    }
    if (typeof question.instructions !== 'string' || !question.instructions.trim()) {
      const aliases = question.type === 'box' ? [...INSTRUCTION_FIELDS, ...TARGET_FIELDS] : INSTRUCTION_FIELDS
      const written = aliases.map(key => question[key]).find(value => typeof value === 'string' && value.trim())
      if (!written) {
        throw new Error(question.type === 'box'
          ? `question "${id}" needs instructions naming what to box, as {"type": "box", "instructions": "the Pay now button"}`
          : `question "${id}" needs instructions`)
      }
      question.instructions = written.trim()
    }
    question = pick(question, DECISION_FIELDS)
    // the Decision API does not answer a noul question that carries criteria
    if (question.type === 'noul' && question.criteria !== undefined) {
      const { criteria, ...rest } = question
      const rules = typeof criteria === 'string' ? [criteria]
        : Array.isArray(criteria) ? criteria.map(String)
          : criteria && typeof criteria === 'object' ? Object.entries(criteria).map(([name, rule]) => `${name}: ${rule}`) : []
      question = { ...rest, instructions: [rest.instructions.trim(), ...rules].join('\n') }
    }
    out[id] = question
  }
  return out
}

/** The part of the state a span question reads: one text, or a field of a structured state. */
function overOf(id, question, parts) {
  if (!parts) return undefined
  if (question.preset === 'halu') return 'answer'
  if (question.preset === 'evidence') return 'context'
  const over = question.over ?? (parts.includes('answer') ? 'answer' : undefined)
  if (!over || !parts.includes(over)) throw new Error(`question "${id}": set "over" to the part of each item it reads (${parts.join(', ')})`)
  return over
}

function wireOf(question, over) {
  const threshold = question.threshold === undefined ? {} : { threshold: question.threshold }
  if (question.signal) {
    const { instructions, criteria } = ROUTER_SIGNALS[question.signal]
    return { type: 'choice', instructions, criteria }
  }
  if (question.preset === 'evidence') return { type: 'span', criteria: ['evidence'], over: 'context', ...threshold }
  if (question.preset) return { preset: question.preset, ...threshold }
  if (question.type === 'span') {
    const { type, criteria, instructions } = question
    return { type, criteria, ...(instructions ? { instructions } : {}), ...(over ? { over } : {}), ...threshold }
  }
  return question
}

/**
 * The requests that answer a call's questions.
 * @param {Record<string, object>} questions - parseQuestions' result
 * @param {object} options
 * @param {string} options.model - answers the decision questions
 * @param {string} options.spanModel - answers the span questions and the signals
 * @param {string[]} [options.parts] - the parts of each item's structured state; none when each item is one text
 * @param {boolean} [options.images] - whether the items are images
 * @returns {{groups: Array<{model: string, questions: object, ids: Record<string, string>}>, asked: Record<string, {kind: string, wire: string, over?: string}>}}
 *   `ids` maps a group's wire ids back to System Two's question ids
 */
export function planQuestions(questions, { model, spanModel, parts, images = false }) {
  const asked = {}
  const taken = new Set(Object.values(questions).filter(question => question.signal).map(question => question.signal))
  const signals = new Set()
  for (const [id, question] of Object.entries(questions)) {
    const kind = kindOf(question)
    if (images && kind !== 'decision') throw new Error(`question "${id}": span questions, presets and signals read text, not images`)
    if (!images && question.type === 'box') throw new Error(`question "${id}": a box question needs images`)
    let over
    if (question.preset === 'halu' || question.preset === 'evidence') {
      if (!parts?.includes('context') || !parts.includes('answer')) {
        throw new Error(`question "${id}": preset ${question.preset} checks each item against sources: pass sources (the files the items should agree with), or state_fields with "context" and "answer"`)
      }
    }
    if (question.preset === 'pii' && parts) throw new Error(`question "${id}": preset pii reads each item's text; ask it without sources or state_fields`)
    if (kind === 'span') over = overOf(id, question, parts)
    let wire = id
    if (kind === 'signal') {
      const needs = ROUTER_SIGNALS[question.signal].parts
      if (needs && !needs.every(part => parts?.includes(part))) throw new Error(`question "${id}": signal ${question.signal} reads ${needs.join(' and ')}: pass state_fields with those parts`)
      if (!needs && parts) throw new Error(`question "${id}": signal ${question.signal} reads one text; ask it without sources or state_fields`)
      if (signals.has(question.signal)) throw new Error(`question "${id}": signal ${question.signal} is asked twice`)
      signals.add(question.signal)
      wire = question.signal
    } else {
      // an id that names a signal would reach that signal's head instead of this question
      while (taken.has(wire) || Object.hasOwn(ROUTER_SIGNALS, wire)) wire = `${wire}_`
      taken.add(wire)
    }
    asked[id] = { kind, wire, ...(over ? { over } : {}), question: wireOf(question, over) }
  }
  const groups = new Map()
  for (const [id, entry] of Object.entries(asked)) {
    const by = entry.kind === 'decision' ? model : spanModel
    if (!groups.has(by)) groups.set(by, { model: by, questions: {}, ids: {} })
    const group = groups.get(by)
    group.questions[entry.wire] = entry.question
    group.ids[entry.wire] = id
  }
  for (const entry of Object.values(asked)) delete entry.question
  return { groups: [...groups.values()], asked }
}
