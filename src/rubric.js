/**
 * The system_one tool's questions: what System Two writes, checked and completed, and the requests that answer them.
 * Choice, noul, score and box questions go to the decision model; span questions (custom labels and the presets) and
 * the router's signals go to the span model.
 *
 * System Two writes a rubric in many shapes. A shape that can mean one thing only is read as that thing, and the
 * reading is said in a note the result carries; a question that still cannot be asked is refused before any request,
 * with how to write it.
 */
import { ROUTER_SIGNALS } from './questions.js'

export const PRESETS = ['pii', 'halu', 'evidence']
const DECISION_TYPES = ['choice', 'noul', 'score', 'box']
const TYPES = [...DECISION_TYPES, 'span']
// the fields the Decision API reads of a question; it refuses a question that carries any other
const DECISION_FIELDS = ['type', 'instructions', 'criteria']
const SPAN_FIELDS = ['type', 'criteria', 'instructions', 'over', 'threshold']
// where System Two sometimes writes a question's instructions, and a box question's target
const INSTRUCTION_FIELDS = ['question', 'description', 'prompt', 'query']
const TARGET_FIELDS = ['target', 'what', 'find', 'id']
// where it sometimes writes the options, levels and labels it means as criteria
const CRITERIA_FIELDS = {
  choice: ['options', 'choices', 'labels', 'categories', 'classes', 'values'],
  score: ['levels', 'scale', 'options', 'choices'],
  span: ['labels', 'entities', 'tags', 'classes', 'categories'],
}

// the same name in any case and with any separators: "Yes/No", "yes_no" and "yesno" are one name
const squash = name => String(name).toLowerCase().replace(/[^a-z0-9]/g, '')
const lookup = table => Object.fromEntries(Object.entries(table).flatMap(([canonical, names]) => [canonical, ...names].map(name => [squash(name), canonical])))
const TYPE_NAMES = lookup({
  choice: ['classification', 'classify', 'category', 'categorical', 'multiclass', 'enum', 'select'],
  noul: ['yesno', 'yes_no', 'boolean', 'bool', 'binary', 'truefalse'],
  score: ['scale', 'rating', 'likert', 'ordinal'],
  box: ['bbox', 'bounding_box', 'boundingbox', 'locate', 'localize'],
  span: ['spans', 'extract', 'extraction', 'ner', 'entities', 'highlight'],
})
const PRESET_NAMES = lookup({ pii: ['personal_data', 'personal_info', 'pii_detection'], halu: ['hallucination', 'hallucinations', 'unsupported'], evidence: ['citations', 'citation', 'backing'] })
const SIGNAL_NAMES = lookup({
  ...Object.fromEntries(Object.keys(ROUTER_SIGNALS).map(name => [name, []])),
  attack: ['jailbreak', 'prompt_injection', 'injection'],
  p_harm: ['harm', 'harmful', 'unsafe', 'harmful_request'],
  r_harm: ['response_harm', 'answer_harm', 'reply_harm', 'harmful_answer', 'harmful_response'],
  r_refusal: ['refusal', 'refused'],
  factcheck: ['fact_check', 'fact_checking'],
  domain: ['subject', 'subject_area'],
})

const EXAMPLE = '{"team": {"type": "choice", "instructions": "Which team should handle it?", "criteria": {"billing": "invoices, refunds", "engineering": "bugs, errors"}}, "marks": {"type": "span", "criteria": {"ERROR": "an error code or message the customer quotes"}}}'
const SPAN_EXAMPLE = '{"type": "span", "criteria": {"ERROR": "an error code or message the customer quotes", "COMPETITOR": "another product the customer names"}}'

const pick = (question, fields) => Object.fromEntries(fields.filter(key => question[key] !== undefined).map(key => [key, question[key]]))
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const text = value => (typeof value === 'string' && value.trim() ? value.trim() : undefined)
const quoted = list => list.map(name => `"${name}"`).join(', ')

/**
 * JSON text as JSON.parse reads it, except for an object key written twice with an object each time: System Two
 * sometimes writes a question's criteria under its id and its type under the same id again. Two such objects that
 * never disagree are joined; two that do are both kept, the second under the next free name (`id_2`).
 * @returns {{value: unknown, joined: string[], renamed: Array<[string, string]>}}
 */
export function parseJson(source) {
  const joined = []
  const renamed = []
  let at = 0
  const fail = () => {
    throw new SyntaxError('invalid JSON')
  }
  const space = () => {
    while (at < source.length && (source[at] === ' ' || source[at] === '\t' || source[at] === '\n' || source[at] === '\r')) at++
  }
  const SCALAR = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y
  const string = () => {
    let end = at + 1
    while (end < source.length && source[end] !== '"') end += source[end] === '\\' ? 2 : 1
    if (end >= source.length) fail()
    const value = JSON.parse(source.slice(at, end + 1))
    at = end + 1
    return value
  }
  const put = (object, key, value) => Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true })
  // whether two objects say nothing against each other: every key they share holds the same value
  const agree = (earlier, later) => Object.entries(later).every(([key, value]) => !Object.hasOwn(earlier, key)
    || (isObject(earlier[key]) && isObject(value) ? agree(earlier[key], value) : JSON.stringify(earlier[key]) === JSON.stringify(value)))
  const join = (earlier, later) => {
    const out = { ...earlier }
    for (const [key, value] of Object.entries(later)) put(out, key, isObject(out[key]) && isObject(value) ? join(out[key], value) : value)
    return out
  }
  const value = () => {
    space()
    if (source[at] === '{') {
      at++
      const out = {}
      space()
      if (source[at] === '}') {
        at++
        return out
      }
      for (;;) {
        space()
        if (source[at] !== '"') fail()
        const key = string()
        space()
        if (source[at] !== ':') fail()
        at++
        const item = value()
        if (Object.hasOwn(out, key) && isObject(out[key]) && isObject(item)) {
          if (agree(out[key], item)) {
            joined.push(key)
            put(out, key, join(out[key], item))
          } else {
            let other = `${key}_2`
            for (let n = 3; Object.hasOwn(out, other); n++) other = `${key}_${n}`
            renamed.push([key, other])
            put(out, other, item)
          }
        } else put(out, key, item)
        space()
        if (source[at] === ',') {
          at++
          continue
        }
        if (source[at] === '}') {
          at++
          return out
        }
        fail()
      }
    }
    if (source[at] === '[') {
      at++
      const out = []
      space()
      if (source[at] === ']') {
        at++
        return out
      }
      for (;;) {
        out.push(value())
        space()
        if (source[at] === ',') {
          at++
          continue
        }
        if (source[at] === ']') {
          at++
          return out
        }
        fail()
      }
    }
    if (source[at] === '"') return string()
    SCALAR.lastIndex = at
    const scalar = SCALAR.exec(source)
    if (!scalar) fail()
    at += scalar[0].length
    return JSON.parse(scalar[0])
  }
  try {
    const parsed = value()
    space()
    if (at < source.length) fail()
    return { value: parsed, joined, renamed }
  } catch {
    // JSON.parse's own message says where the text goes wrong
    return { value: JSON.parse(source), joined: [], renamed: [] }
  }
}

/**
 * JSON text System Two cut short of its last closing brackets, or ended with one too many, as the JSON it meant: the
 * brackets still open are closed, or the extra ones after a whole value dropped. Text cut inside a string, or anything
 * else after a whole value, is left as it is (and stays invalid).
 * @returns {{text: string, said: string} | undefined}
 */
export function mendJson(source) {
  const open = []
  let inString = false
  let end
  for (let at = 0; at < source.length; at++) {
    const c = source[at]
    if (inString) {
      if (c === '\\') at++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '{' || c === '[') open.push(c === '{' ? '}' : ']')
    else if (c === '}' || c === ']') {
      if (open.pop() !== c) return undefined
      if (open.length === 0 && end === undefined) end = at + 1
    }
    if (end !== undefined) {
      const rest = source.slice(end)
      return /^[\s}\]]+$/.test(rest) ? { text: source.slice(0, end), said: 'the brackets after its end were dropped' } : undefined
    }
  }
  if (inString || open.length === 0) return undefined
  return { text: source.trimEnd().replace(/,$/, '') + open.reverse().join(''), said: `it ended before its last ${open.length === 1 ? 'bracket' : `${open.length} brackets`}, which were closed` }
}

/**
 * A JSON argument that ran into the next arguments: a model's tool-call markup left inside it, as
 * `{...}, images</arg_key><arg_value>["a.png", "b.png"]`. Returns the argument's own text and the arguments written
 * after it (each value as JSON where it parses), or undefined for text without that markup.
 * @returns {{head: string, leaked: Record<string, unknown>} | undefined}
 */
export function splitArguments(text) {
  if (typeof text !== 'string' || !text.includes('</arg_key>')) return undefined
  const start = text.search(/,?\s*(?:<arg_key>)?\s*[A-Za-z_][A-Za-z0-9_]*\s*<\/arg_key>/)
  if (start < 0) return undefined
  const leaked = {}
  const tail = text.slice(start)
  for (const [, key, raw] of tail.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*<\/arg_key>\s*<arg_value>([\s\S]*?)(?=<\/arg_value>|,?\s*(?:<arg_key>)?\s*[A-Za-z_][A-Za-z0-9_]*\s*<\/arg_key>|$)/g)) {
    const value = raw.trim()
    try {
      leaked[key] = JSON.parse(value)
    } catch {
      leaked[key] = value
    }
  }
  return { head: text.slice(0, start).trim(), leaked }
}

/** The type a question's criteria imply: a list of levels is a score, named options a choice, anything else yes/no. */
function impliedType(criteria) {
  if (Array.isArray(criteria)) return 'score'
  if (!isObject(criteria)) return 'noul'
  return Object.keys(criteria).map(name => name.toLowerCase()).sort().join() === 'no,yes' ? 'noul' : 'choice'
}

/** A span question's labels: the names of its criteria. */
export function labelsOf(criteria) {
  if (Array.isArray(criteria)) return criteria.map(String).filter(Boolean)
  if (isObject(criteria)) return Object.keys(criteria)
  return []
}

/** What kind of question it is: a decision (choice, noul, score, box), a span question, or a router signal. */
export const kindOf = question => (question.signal ? 'signal' : question.preset || question.type === 'span' ? 'span' : 'decision')

// a question that asks for words: "Mark the words of …", "Extract …", "Highlight …"
const ASKS_FOR_WORDS = /^\s*(?:mark|highlight|underline|extract|tag|find the (?:words|phrases|spans))\b/i
const LABEL = /^[A-Z][A-Z0-9_]*$/
// "ERROR: an error code", "ERROR = an error code", "ERROR - an error code"
const NAMED = /^\s*([A-Za-z][\w -]{0,40}?)\s*(?::|=|\s-\s)\s*(\S[\s\S]*)$/

/**
 * A choice that can only be a label set: one option (a choice needs two), or options named as labels (ERROR,
 * COMPETITOR) under instructions that ask for words. System Two sometimes writes a span question so.
 */
function labelSet(question) {
  if (question.type !== 'choice' || !isObject(question.criteria)) return false
  const names = Object.keys(question.criteria)
  return names.length === 1 || (names.every(name => LABEL.test(name)) && ASKS_FOR_WORDS.test(question.instructions ?? ''))
}

// a list written as text: one entry a line, or between semicolons or bars; commas only when there is nothing else
const split = value => value.split(/[\n;|]/.test(value) ? /[\n;|]+/ : /,/).map(entry => entry.trim()).filter(Boolean)

/** Options or labels written as a list or as text, as the object of name -> description a choice or span question takes. */
function named(value) {
  const entries = (typeof value === 'string' ? split(value) : Array.isArray(value) ? value : []).flatMap(entry => {
    if (isObject(entry)) {
      const name = text(entry.label) ?? text(entry.name) ?? text(entry.id) ?? text(entry.option) ?? text(entry.value)
      const said = text(entry.description) ?? text(entry.what) ?? text(entry.instructions) ?? text(entry.meaning) ?? text(entry.definition)
      if (name) return [[name, said ?? name]]
      return Object.entries(entry).filter(([, rule]) => typeof rule === 'string').map(([key, rule]) => [key, rule])
    }
    const line = String(entry).trim()
    if (!line) return []
    const pair = line.match(NAMED)
    return [pair ? [pair[1].trim(), pair[2].trim()] : [line, line]]
  })
  return entries.length ? Object.fromEntries(entries) : undefined
}

/** A score's levels written as an object or as text, as the list, lowest first, a score question takes. */
function levels(value) {
  if (typeof value === 'string') return split(value)
  if (isObject(value)) return Object.entries(value).map(([name, rule]) => (typeof rule === 'string' && rule.trim() ? `${name}: ${rule.trim()}` : name))
  if (Array.isArray(value)) {
    return value.map(level => (isObject(level) ? [text(level.level) ?? text(level.name) ?? text(level.label) ?? (Number.isFinite(level.level) ? String(level.level) : undefined), text(level.description) ?? text(level.what)].filter(Boolean).join(': ') : String(level)))
  }
  return value
}

/** A threshold as the documented number between 0 and 1: from a numeric string, a percentage, or {"min": 0.5}. */
function threshold(id, value, notes) {
  if (value === undefined || value === null || value === '') return undefined
  let number = value
  if (isObject(value)) number = [value.min, value.value, value.probability, value.p, value.threshold].find(entry => entry !== undefined)
  if (typeof number === 'string' && /^\s*\d+(?:\.\d+)?\s*%?\s*$/.test(number)) number = Number.parseFloat(number) / (number.includes('%') ? 100 : 1)
  // a whole number of percent, as 60
  if (typeof number === 'number' && Number.isInteger(number) && number > 1 && number <= 100) {
    notes.push(`${id}: threshold ${number} read as ${number / 100}`)
    number /= 100
  }
  if (number === 0) return undefined
  if (!(typeof number === 'number' && number > 0 && number < 1)) throw new Error(`question "${id}": threshold must be a number between 0 and 1, as "threshold": 0.5`)
  if (number !== value) notes.push(`${id}: threshold read as ${number}`)
  return number
}

/** The id a question written alone, in place of the object of questions, takes. */
function idOf(question) {
  if (question.preset) return String(question.preset)
  if (question.signal) return String(question.signal)
  const type = TYPE_NAMES[squash(question.type ?? '')] ?? (question.criteria !== undefined ? impliedType(question.criteria) : 'noul')
  return type === 'span' ? 'labels' : type
}

// what marks a question written alone, rather than the object of questions it belongs in
const QUESTION_MARKS = ['criteria', 'preset', 'signal', 'options', 'choices', 'levels']
function aQuestion(value) {
  if (!isObject(value)) return false
  if (QUESTION_MARKS.some(key => value[key] !== undefined)) return true
  return typeof value.type === 'string' && TYPE_NAMES[squash(value.type)] !== undefined && ['instructions', ...INSTRUCTION_FIELDS].some(key => text(value[key]))
}

/** One question, read leniently: its type, preset or signal, instructions and criteria in the forms the API takes. */
function readQuestion(id, asked, notes) {
  let question = { ...asked }
  const said = what => notes.push(`${id}: ${what}`)

  // a type written as another name for one: "yes_no", "classification", "rating", a preset's or a signal's name
  if (typeof question.type === 'string') {
    const name = squash(question.type)
    if (TYPE_NAMES[name]) {
      if (TYPE_NAMES[name] !== question.type) said(`type "${question.type}" read as ${TYPE_NAMES[name]}`)
      question.type = TYPE_NAMES[name]
    } else if (name === 'preset' || (PRESET_NAMES[name] && question.preset === undefined)) {
      question.preset ??= question.name ?? question.type
      delete question.type
    } else if (name === 'signal' || (SIGNAL_NAMES[name] && question.signal === undefined)) {
      question.signal ??= name === 'signal' ? (question.name ?? id) : question.type
      delete question.type
    }
  }

  if (question.preset !== undefined) {
    const preset = PRESET_NAMES[squash(question.preset)]
    if (!preset) throw new Error(`question "${id}": preset must be ${PRESETS.join(', ')}; "${question.preset}" is none of them`)
    if (preset !== question.preset) said(`preset "${question.preset}" read as ${preset}`)
    const kept = threshold(id, question.threshold, notes)
    if (question.labels !== undefined && (preset !== 'pii' || !(Array.isArray(question.labels) || question.labels === 'all'))) {
      throw new Error(`question "${id}": labels (a list, or "all") picks the labels of preset pii`)
    }
    const labels = Array.isArray(question.labels) ? question.labels.map(String) : question.labels
    return Object.fromEntries(Object.entries({ preset, threshold: kept, labels }).filter(([, value]) => value !== undefined))
  }

  if (question.signal !== undefined) {
    const signal = SIGNAL_NAMES[squash(question.signal)]
    if (!signal) throw new Error(`question "${id}": signal must be one of ${Object.keys(ROUTER_SIGNALS).join(', ')}; "${question.signal}" is none of them`)
    if (signal !== question.signal) said(`signal "${question.signal}" read as ${signal}`)
    return { signal }
  }

  // instructions written under another name
  if (!text(question.instructions)) {
    const aliases = question.type === 'box' ? [...INSTRUCTION_FIELDS, ...TARGET_FIELDS] : INSTRUCTION_FIELDS
    const written = aliases.find(key => text(question[key]))
    if (written) question.instructions = question[written].trim()
  }

  // options, levels or labels written under another name than criteria; without a type, the name says which
  if (question.criteria === undefined) {
    const fields = question.type ? CRITERIA_FIELDS[question.type] ?? [] : [...new Set([...CRITERIA_FIELDS.choice, ...CRITERIA_FIELDS.score, ...CRITERIA_FIELDS.span])]
    const written = fields.find(key => question[key] !== undefined && question[key] !== null && question[key] !== '')
    if (written) {
      question.criteria = question[written]
      said(`${written} read as its criteria`)
      if (!question.type) {
        const capitals = labelsOf(question.criteria).length > 0 && labelsOf(question.criteria).every(name => LABEL.test(name))
        question.type = ['levels', 'scale'].includes(written) ? 'score'
          : ['entities', 'tags'].includes(written) || (written === 'labels' && capitals) ? 'span' : 'choice'
      }
    }
  }
  // the labels of a span question written as its own fields, beside its instructions
  if (question.criteria === undefined && (question.type === 'span' || question.type === undefined)) {
    const own = Object.entries(question).filter(([key, rule]) => LABEL.test(key) && (text(rule) || text(rule?.description)))
    if (own.length && (question.type === 'span' || own.length === Object.keys(question).filter(key => key !== 'instructions' && key !== 'threshold' && key !== 'over').length)) {
      question.criteria = Object.fromEntries(own.map(([key, rule]) => [key, text(rule) ?? text(rule.description)]))
      question.type = 'span'
      said(`labels ${own.map(([key]) => key).join(', ')} read as its criteria`)
    }
  }

  // System Two often leaves the type out of its first call
  if (question.type === undefined) question.type = impliedType(question.criteria)
  if (labelSet(question)) question.type = 'span'
  if (!TYPES.includes(question.type)) {
    throw new Error(`question "${id}": type ${JSON.stringify(question.type)} is none of choice, noul, score, box or span; or ask a preset, as {"preset": "pii"}, or a router signal, as {"signal": "attack"}`)
  }

  // criteria in the shape each type takes (a choice's plain list of option names is one: the API reads it)
  const plainList = Array.isArray(question.criteria) && question.criteria.every(entry => typeof entry === 'string' && !NAMED.test(entry))
  if (question.type === 'choice' && question.criteria !== undefined && !isObject(question.criteria) && !plainList) {
    const options = named(question.criteria)
    if (options) {
      question.criteria = options
      said('its options read as criteria {name: description}')
    }
  }
  if (question.type === 'score' && question.criteria !== undefined && !Array.isArray(question.criteria)) {
    const list = levels(question.criteria)
    if (Array.isArray(list) && list.length) {
      question.criteria = list
      said('its levels read as a list, lowest first')
    }
  }
  if (question.type === 'score' && Array.isArray(question.criteria)) question.criteria = levels(question.criteria)
  if (question.type === 'span' && question.criteria !== undefined && !isObject(question.criteria)) {
    const asList = Array.isArray(question.criteria) && question.criteria.every(entry => typeof entry === 'string' && !NAMED.test(entry))
    if (!asList) {
      const labels = named(question.criteria)
      if (labels) question.criteria = labels
    }
  }

  // the Decision API refuses a choice without options as malformed, item by item
  if (question.type === 'choice' && labelsOf(question.criteria).length < 2) {
    throw new Error(`question "${id}": a choice question needs criteria naming two or more options, as {"billing": "invoices, refunds", "engineering": "bugs, errors"}`)
  }
  if (question.type === 'span') {
    if (labelsOf(question.criteria).length === 0) {
      throw new Error(`question "${id}": a span question names all its labels in criteria, each with what it marks, as ${SPAN_EXAMPLE}; instructions, if any, only say what the items are`)
    }
    question.threshold = threshold(id, question.threshold, notes)
    return pick(question, SPAN_FIELDS)
  }
  if (!text(question.instructions)) {
    throw new Error(question.type === 'box'
      ? `question "${id}" needs instructions naming what to box, as {"type": "box", "instructions": "the Pay now button"}`
      : `question "${id}" needs instructions`)
  }
  question.instructions = question.instructions.trim()
  question = pick(question, DECISION_FIELDS)
  // the Decision API does not answer a noul question that carries criteria
  if (question.type === 'noul' && question.criteria !== undefined) {
    const { criteria, ...rest } = question
    const rules = typeof criteria === 'string' ? [criteria]
      : Array.isArray(criteria) ? criteria.map(String)
        : isObject(criteria) ? Object.entries(criteria).map(([name, rule]) => `${name}: ${rule}`) : []
    question = { ...rest, instructions: [rest.instructions, ...rules].join('\n') }
  }
  return question
}

/**
 * System Two's questions, checked and completed, with notes on what was read in a form other than the documented one:
 * every question gets its type, a noul's criteria join its instructions.
 * @returns {{questions: Record<string, object>, notes: string[]}}
 */
export function readQuestions(value, { called = 'questions' } = {}) {
  const notes = []
  let questions = value
  if (typeof value === 'string') {
    let parsed
    try {
      parsed = parseJson(value.trim())
    } catch (error) {
      const mended = mendJson(value.trim())
      try {
        if (!mended) throw error
        parsed = parseJson(mended.text)
        notes.push(`${called} was not quite JSON: ${mended.said}`)
      } catch {
        throw new Error(`${called} is not valid JSON (${error.message}): write an object of question id -> question, as ${EXAMPLE}`)
      }
    }
    questions = parsed.value
    for (const key of new Set(parsed.joined)) notes.push(`"${key}" was written twice: its two parts were read as one`)
    for (const [key, other] of parsed.renamed) notes.push(`"${key}" was written twice as two questions: the second is asked as "${other}"`)
    // the object written as JSON text twice over
    if (typeof questions === 'string' && /^\s*[[{]/.test(questions)) {
      try {
        questions = parseJson(questions.trim()).value
      } catch {}
    }
  }
  // a list of questions, each naming its id
  if (Array.isArray(questions)) {
    const listed = {}
    questions.forEach((entry, index) => {
      if (!isObject(entry)) throw new Error(`questions[${index}] must be a question object, as {"id": "angry", "type": "noul", "instructions": "Is the customer angry?"}`)
      const { id, name, key, ...question } = entry
      let own = text(id) ?? text(name) ?? text(key) ?? (aQuestion(question) ? idOf(question) : `q${index + 1}`)
      for (let n = 2; Object.hasOwn(listed, own); n++) own = `${text(id) ?? text(name) ?? text(key) ?? idOf(question)}_${n}`
      listed[own] = question
    })
    notes.push(`${called} were a list: read as ${quoted(Object.keys(listed))}`)
    questions = listed
  }
  if (!isObject(questions) || Object.keys(questions).length === 0) {
    throw new Error(`${called} must be an object of question id -> {type, instructions, criteria}, as ${EXAMPLE}`)
  }
  // one question written alone, in place of the object of questions
  if (aQuestion(questions) && !Object.entries(questions).some(([key, entry]) => !QUESTION_MARKS.includes(key) && key !== 'labels' && aQuestion(entry))) {
    const id = idOf(questions)
    notes.push(`${called} held one question, not an object of questions: read as {"${id}": {...}}`)
    questions = { [id]: questions }
  }
  // a type, threshold, "over" or instructions written beside the questions is theirs, as
  // {"type": "span", "threshold": 0.5, "ERROR": {...}}
  const shared = {}
  for (const key of ['type', 'threshold', 'over', 'instructions']) {
    if (questions[key] !== undefined && !isObject(questions[key]) && !Array.isArray(questions[key])) {
      const { [key]: written, ...rest } = questions
      shared[key] = written
      questions = rest
    }
  }
  if (Object.keys(questions).length === 0) throw new Error(`${called} must be an object of question id -> {type, instructions, criteria}, as ${EXAMPLE}`)
  // a threshold written beside its question, as {"marks": {...}, "marks_threshold": 0.5}, is that question's
  for (const [id, entry] of Object.entries(questions)) {
    const owner = id.endsWith('_threshold') ? id.slice(0, -'_threshold'.length) : undefined
    if (!isObject(entry) && owner && isObject(questions[owner])) {
      questions = { ...questions, [owner]: { threshold: entry, ...questions[owner] } }
      delete questions[id]
    }
  }
  const out = {}
  for (const [id, entry] of Object.entries(questions)) {
    let asked = entry
    // a question written as its words alone is a yes/no question
    if (typeof asked === 'string' && asked.trim()) {
      notes.push(`${id}: read as a yes/no question`)
      asked = { type: 'noul', instructions: asked }
    }
    // a question wrapped in its type, as {"where": {"box": {"type": "box", "instructions": "the spike"}}}
    if (isObject(asked) && Object.keys(asked).length === 1) {
      const [[wrapper, inner]] = Object.entries(asked)
      const type = TYPE_NAMES[squash(wrapper)]
      if (isObject(inner) && (aQuestion(inner) || (type && inner.type === undefined && Object.keys(inner).length > 0))) {
        notes.push(`${id}: the question inside "${wrapper}" read as the question`)
        asked = type && inner.type === undefined && inner.preset === undefined && inner.signal === undefined ? { type, ...inner } : inner
      }
    }
    // labels written alone, as ["ERROR", "COMPETITOR"]
    if (Array.isArray(asked) && asked.length && asked.every(label => typeof label === 'string' && LABEL.test(label))) {
      notes.push(`${id}: read as a span question with the labels ${asked.join(', ')}`)
      asked = { type: 'span', criteria: asked }
    }
    if (!isObject(asked)) {
      throw new Error(`questions: "${id}" is ${JSON.stringify(asked)}, not a question. Each entry of questions is a question object under its own id, as ${EXAMPLE}; a threshold goes inside its span question, as {"type": "span", "criteria": {...}, "threshold": 0.5}`)
    }
    const typed = shared.type !== undefined && asked.type === undefined && asked.preset === undefined && asked.signal === undefined
    if (typed) asked = { ...asked, type: shared.type }
    if (text(shared.instructions) && !text(asked.instructions) && !INSTRUCTION_FIELDS.some(key => text(asked[key]))) {
      asked = { ...asked, instructions: shared.instructions }
      notes.push(`${id}: the instructions beside the questions read as its instructions`)
    }
    const question = readQuestion(id, asked, notes)
    if (kindOf(question) === 'span' && !question.signal) {
      if (shared.threshold !== undefined && question.threshold === undefined) {
        const kept = threshold(id, shared.threshold, notes)
        if (kept !== undefined) {
          question.threshold = kept
          notes.push(`${id}: the threshold beside the questions, ${kept}, read as its threshold`)
        }
      }
      if (typeof shared.over === 'string' && question.over === undefined && !question.preset) question.over = shared.over
    }
    out[id] = question
  }
  return { questions: out, notes }
}

/** System Two's questions, checked and completed: every question gets its type, a noul's criteria join its instructions. */
export function parseQuestions(value) {
  return readQuestions(value).questions
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

/** Why a question cannot be asked of these items at all: a span question of images, a box question of text. */
export function unanswerable(question, { images = false } = {}) {
  if (images && kindOf(question) !== 'decision') return 'span questions, presets and signals read text, not images'
  if (!images && question.type === 'box') return 'a box question reads images'
  return undefined
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
    if (images && kind !== 'decision') throw new Error(`question "${id}": span questions, presets and signals read text, not images; ask a choice, noul, score or box question of images`)
    if (!images && question.type === 'box') throw new Error(`question "${id}": a box question needs images: pass images, or ask a choice, noul, score or span question of text`)
    let over
    if (question.preset === 'halu' || question.preset === 'evidence') {
      if (!parts?.includes('context') || !parts.includes('answer')) {
        throw new Error(`question "${id}": preset ${question.preset} checks each item against sources: pass sources (the files the items should agree with), or state_fields with "context" and "answer"`)
      }
    }
    if (question.preset === 'pii' && parts) throw new Error(`question "${id}": preset pii reads each item's text; ask it without sources or state_fields`)
    if (kind === 'span') over = overOf(id, question, parts)
    let wire = id
    // a signal that reads one text, asked of records whose state_fields name the user's request, reads that request
    let plain
    if (kind === 'signal') {
      const needs = ROUTER_SIGNALS[question.signal].parts
      if (needs && !needs.every(part => parts?.includes(part))) throw new Error(`question "${id}": signal ${question.signal} reads ${needs.join(' and ')}: pass state_fields with those parts, as {"user": "question", "answer": "reply"}`)
      if (!needs && parts) {
        if (!parts.includes('user')) throw new Error(`question "${id}": signal ${question.signal} reads one text: ask it in a call without sources and state_fields, or name the request it reads as the "user" part of state_fields`)
        plain = 'user'
      }
      if (signals.has(question.signal)) throw new Error(`question "${id}": signal ${question.signal} is asked twice`)
      signals.add(question.signal)
      wire = question.signal
    } else {
      // an id that names a signal would reach that signal's head instead of this question
      while (taken.has(wire) || Object.hasOwn(ROUTER_SIGNALS, wire)) wire = `${wire}_`
      taken.add(wire)
    }
    asked[id] = { kind, wire, ...(over ? { over } : {}), ...(plain ? { plain } : {}), question: wireOf(question, over) }
  }
  // one request group per model, and one more for the signals that read one part of each item as their text
  const groups = new Map()
  for (const [id, entry] of Object.entries(asked)) {
    const by = entry.kind === 'decision' ? model : spanModel
    const key = entry.plain ? `${by}\n${entry.plain}` : by
    if (!groups.has(key)) groups.set(key, { model: by, questions: {}, ids: {}, ...(entry.plain ? { reads: entry.plain } : {}) })
    const group = groups.get(key)
    group.questions[entry.wire] = entry.question
    group.ids[entry.wire] = id
  }
  for (const entry of Object.values(asked)) delete entry.question
  return { groups: [...groups.values()], asked }
}
