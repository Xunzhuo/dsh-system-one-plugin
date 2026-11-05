/** The model-facing `system_one` tool: one rubric, many items, calibrated answers. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { REQUEST_TOKENS, compactAnswer, requestSlices, stateCost, unavailable, unavailableText } from './client.js'
import { formatOf, loadItems } from './items.js'
import { kindAt, mustBeFile, noFile } from './paths.js'
import { annotatePng, imageSize } from './png.js'
import { ROUTER_SIGNALS, SENSITIVE_LABELS } from './questions.js'
import { csvCell, everywhere, joined, redactItem, writeRedacted } from './redact.js'
import { kindOf, planQuestions, readQuestions, splitArguments, unanswerable } from './rubric.js'
import { excerpts, labelCounts, maskAround, notPersonal, placeSpans, trimSpan } from './spans.js'
import { clip } from './trace.js'

export { parseQuestions } from './rubric.js'

// what the sources of one call may hold
const SOURCE_CHARS = 24000
// a box answer at least this confident found its target
export const FOUND_AT = 0.4
// a word that is more likely unsupported than not, and personal data as the privacy reflex masks it (privacyAt); a
// question's threshold says otherwise
const HALU_AT = 0.5
const PII_AT = 0.5
const IMAGES_SHOWN = 12
// a batch waits out a spent per-minute budget (the key's, or its network address's) as the gateway's Retry-After
// says, rather than fail; the reflexes keep their short limits
const BATCH_LIMITS = { retries: 6, waitMs: 60000 }
// the signals that look for jailbreaks, harm and refusals: the items they read are often what System Two should not
// read, so their results keep ids and answers only
const SAFETY_SIGNALS = new Set(['attack', 'p_harm', 'r_harm', 'r_refusal'])

// one question of each kind, as the description and the questions parameter show them
export const EXAMPLE_QUESTIONS = {
  team: { type: 'choice', instructions: 'Which team should handle this ticket?', criteria: { billing: 'payments, invoices, refunds', engineering: 'bugs, errors, outages', sales: 'plans and pricing' } },
  angry: { type: 'noul', instructions: 'Is the customer angry?' },
  urgency: { type: 'score', instructions: 'How urgent is this ticket?', criteria: ['1 = can wait', '2 = this week', '3 = today'] },
  marks: { type: 'span', criteria: { ERROR: 'an error code or message the customer quotes', COMPETITOR: 'another product the customer names' }, threshold: 0.5 },
  personal: { preset: 'pii' },
  jailbreak: { signal: 'attack' },
}
const asJson = value => JSON.stringify(value)

const DESCRIPTION = `Ask System One, a fast decision model, typed questions about many items at once (the records of a JSONL, JSON or CSV file, the lines of a text file, a list of strings, or images) and get calibrated probabilities back in seconds, instead of reading the items yourself. Use it whenever the same judgment applies to many items: routing, labeling, filtering, triage, scoring, ranking, moderation, finding personal data, checking claims against sources, spotting problems in screenshots.

System One answers every question for every item, writes one result row per item to an output file (JSONL or CSV) and returns a summary. Read the output file afterwards only for the rows you need.

questions is one object: each key is an id you choose, each value one question. The kinds, one example each:
- choice: pick one option; criteria names 2 or more options, each with a short description. ${asJson({ team: EXAMPLE_QUESTIONS.team })}
- noul: yes or no, without criteria; instructions say what counts as yes; the answer is the probability of yes. ${asJson({ angry: EXAMPLE_QUESTIONS.angry })}
- score: an ordered scale; criteria lists 2 to 10 levels, lowest first; the answer is the expected level, from 0, or on the levels' own numbers when each starts with one. ${asJson({ urgency: EXAMPLE_QUESTIONS.urgency })}
- box (images only): where something is; instructions name it; the answer is a box in fractions of the image with a confidence (below 0.4: not found). ${asJson({ where: { type: 'box', instructions: 'the spike in the plotted line' } })}
- span: the words of each text that carry your labels (error codes, product names, requests, quotes), not one category per item; criteria names every label with what it marks; threshold (0 to 1, optional) drops less probable marks. ${asJson({ marks: EXAMPLE_QUESTIONS.marks })}
- preset: ${asJson({ personal: EXAMPLE_QUESTIONS.personal })} marks personal data (${SENSITIVE_LABELS.join(', ')}; "labels" picks others it knows, such as ORGANIZATION, DATE_TIME and GPE, or "all"); {"preset": "halu"} the words of each item its sources do not support; {"preset": "evidence"} the words of the sources that back each item. halu and evidence need sources.
- signal: the vLLM Semantic Router's trained questions. ${asJson({ jailbreak: EXAMPLE_QUESTIONS.jailbreak })} asks attack (jailbreak or benign); also p_harm (unsafe or safe request), domain (subject area), factcheck, feedback, modality, scenario; r_harm and r_refusal judge an answer to a user request (records with fields "user" and "answer", or state_fields).

Rules:
- Every field of a question goes inside that question, under its own id: type, instructions, criteria, threshold. Use each id once; nothing else goes beside the questions.
- A span question lists all its labels in criteria; its instructions, if any, only say what to look for. Describe each label precisely, and say in context what the items are and whose (e.g. "Support tickets sent to Lumen Cloud"), so a label such as COMPETITOR knows which product is yours.
- box questions read images; span questions, presets and signals read text.
- redact copies the items with what preset pii marked replaced by its [LABEL] (else what your span questions marked); annotate copies the images with the boxes found.
Span questions, presets and signals are answered by span_model; choice, noul, score and box questions by model.

For one screenshot you act on (where to click, whether an action worked), use system_one_screen.`

// the tool's parameters, for arguments that ran into questions (splitArguments)
const PARAMETERS = Object.fromEntries(['questions', 'file', 'text_field', 'id_field', 'items', 'images', 'context', 'sources', 'state_fields', 'redact', 'annotate', 'output', 'model', 'span_model'].map(name => [name, true]))

/** Where a call's rows go by default: beside its file, or beside the one folder its images are in. */
function defaultOutput(cwd, file, images) {
  if (file) return `${file.replace(/\.[^./]+$/, '')}.s1.jsonl`
  const folders = [...new Set((images ?? []).map(path => dirname(path)))]
  const within = folders.length === 1 ? relative(cwd, folders[0]) : ''
  return within && !within.startsWith('..') && !isAbsolute(within) ? `${folders[0]}.s1.jsonl` : 'system-one-results.jsonl'
}

/**
 * The number of a score question's first level when its levels carry their own numbers, as ["1 = vague", "2 = clear",
 * "3 = concrete"]: its answers are then given on that numbering. 0 otherwise: the model's answer counts levels from 0.
 */
function levelBase(criteria) {
  const numbers = (Array.isArray(criteria) ? criteria : []).map(level => String(level).match(/^\s*(\d+)(?!\d|[.,]\d)/)?.[1])
  if (numbers.length < 2 || numbers.some(number => number === undefined)) return 0
  const first = Number(numbers[0])
  return numbers.every((number, index) => Number(number) === first + index) ? first : 0
}

function summarize(questions, rows, asked) {
  const summary = {}
  for (const [id, question] of Object.entries(questions)) {
    const answers = rows.map(row => ({ id: row.id, a: row.answers[id] })).filter(entry => entry.a && !entry.a.error)
    const failed = rows.length - answers.length
    // why they failed, once, so that System Two can fix the question
    const why = failed ? rows.map(row => row.answers[id]).find(a => a?.error) : undefined
    const error = why ? clip([why.error, why.reason].filter(value => typeof value === 'string' && value).join(': '), 200) : undefined
    const kind = asked[id].kind
    if (kind === 'span') {
      const labels = {}
      for (const { a } of answers) for (const [label, n] of Object.entries(a.labels)) labels[label] = (labels[label] ?? 0) + n
      const marked = answers.filter(({ a }) => a.n > 0)
      const top = [...marked].sort((x, y) => y.a.n - x.a.n || y.a.p - x.a.p)
      summary[id] = {
        type: 'span',
        ...(question.preset ? { preset: question.preset } : {}),
        labels: Object.fromEntries(Object.entries(labels).sort((x, y) => y[1] - x[1])),
        items: marked.length,
        of: answers.length,
        top: top.slice(0, 8).map(({ id: itemId, a }) => [itemId, a.n]),
        // personal data stays in the results file, not in what System Two reads
        ...(question.preset === 'pii' ? {} : {
          examples: top.slice(0, 6).map(({ id: itemId, a }) => {
            const best = a.spans.reduce((x, y) => (y.p > x.p ? y : x))
            return [itemId, best.label, clip(best.text.replace(/\s+/g, ' ').trim(), 120), best.p, ...(best.source ? [placeOf(best)] : [])]
          }),
        }),
        failed,
        ...(error ? { error } : {}),
      }
    } else if (question.type === 'choice' || question.signal) {
      const counts = {}
      for (const { a } of answers) counts[a.choice] = (counts[a.choice] ?? 0) + 1
      const unsure = answers.filter(({ a }) => a.confidence < 0.6).map(({ id: itemId }) => itemId)
      summary[id] = { type: 'choice', ...(question.signal ? { signal: question.signal } : {}), counts, unsure: unsure.slice(0, 12), unsureCount: unsure.length, failed, ...(error ? { error } : {}) }
    } else if (question.type === 'noul') {
      const sorted = [...answers].sort((x, y) => y.a.yes - x.a.yes)
      const yesCount = answers.filter(({ a }) => a.yes >= 0.5).length
      summary[id] = { type: 'noul', yes: yesCount, no: answers.length - yesCount, top: sorted.slice(0, 8).map(({ id: itemId, a }) => [itemId, a.yes]), failed, ...(error ? { error } : {}) }
    } else if (question.type === 'score') {
      const levels = question.criteria.map(() => 0)
      const base = levelBase(question.criteria)
      let total = 0
      for (const { a } of answers) {
        total += a.score
        levels[Math.min(levels.length - 1, Math.max(0, Math.round(a.score - base)))]++
      }
      const sorted = [...answers].sort((x, y) => y.a.score - x.a.score)
      summary[id] = {
        type: 'score',
        mean: answers.length ? Math.round((total / answers.length) * 100) / 100 : null,
        levels: Object.fromEntries(question.criteria.map((label, index) => [String(label).split(':')[0], levels[index]])),
        top: sorted.slice(0, 8).map(({ id: itemId, a }) => [itemId, a.score]),
        failed,
        ...(error ? { error } : {}),
      }
    } else {
      const seen = answers.filter(({ a }) => a.box && a.confidence >= FOUND_AT)
      const corners = ({ left, top, right, bottom }) => [left, top, right, bottom].map(value => Math.round(value * 1000) / 1000)
      summary[id] = { type: 'box', found: seen.length, of: answers.length, boxes: seen.slice(0, 12).map(({ id: itemId, a }) => [itemId, corners(a.box), a.confidence]), failed, ...(error ? { error } : {}) }
    }
  }
  return summary
}

function flatRow(row, questions, asked) {
  const flat = { id: row.id }
  for (const [id, question] of Object.entries(questions)) {
    const a = row.answers[id]
    if (!a || a.error) {
      flat[id] = 'error'
      continue
    }
    if (asked[id].kind === 'span') {
      flat[id] = a.n
      if (a.n) flat[`${id}_labels`] = Object.entries(a.labels).map(([label, n]) => `${label} ${n}`).join('; ')
      if (a.n && question.preset !== 'pii') flat[`${id}_spans`] = a.spans.map(span => `${span.label}: ${span.text}`).join(' | ')
    } else if (question.type === 'choice' || question.signal) {
      flat[id] = a.choice
      flat[`${id}_confidence`] = a.confidence
    } else if (question.type === 'noul') {
      flat[`${id}_yes`] = a.yes
    } else if (question.type === 'score') {
      flat[id] = a.score
    } else {
      flat[id] = JSON.stringify(a.box)
      flat[`${id}_confidence`] = a.confidence
    }
  }
  return flat
}

async function writeResults(path, rows, questions, asked) {
  if (extname(path).toLowerCase() === '.csv') {
    const flat = rows.map(row => flatRow(row, questions, asked))
    const columns = [...new Set(flat.flatMap(row => Object.keys(row)))]
    const lines = [columns.join(','), ...flat.map(row => columns.map(column => csvCell(row[column])).join(','))]
    await writeFile(path, lines.join('\n') + '\n')
  } else {
    await writeFile(path, rows.map(row => JSON.stringify({ id: row.id, text: row.text, answers: row.answers })).join('\n') + '\n')
  }
}

const listed = (entries, max = 8) => entries.slice(0, max).join(', ') + (entries.length > max ? ', …' : '')

function renderSummary(value) {
  const models = value.spanModel ? `${value.model} and ${value.spanModel}` : value.model
  const lines = [
    `System One (${models}) answered ${value.questions} question(s) for ${value.items} item(s) in ${value.seconds} s (${value.requests} requests). Results: ${value.output}`,
  ]
  // what the call was read as, where it was written another way, so a wrong reading can be put right
  if (value.notes?.length) lines.push(`Notes: ${value.notes.join('; ')}.`)
  for (const [id, s] of Object.entries(value.summary)) {
    if (s.type === 'span') {
      const counts = Object.entries(s.labels).map(([label, n]) => `${label} ${n}`)
      const items = `${s.items} of ${s.of} item(s)`
      if (s.preset === 'halu') lines.push(`- ${id}: words the sources do not support in ${items}${s.examples.length ? `: ${listed(s.examples.map(([itemId, , text]) => `${itemId} ("${text}")`), 6)}` : ''}`)
      else if (s.preset === 'evidence') lines.push(`- ${id}: backed by the sources: ${items}${s.examples.length ? `; e.g. ${listed(s.examples.map(([itemId, , text, , where]) => `${itemId}: "${text}"${where ? ` (${where})` : ''}`), 3)}` : ''}`)
      else if (s.preset === 'pii') lines.push(`- ${id}: personal data in ${items}${counts.length ? `: ${counts.join(', ')}; most in ${listed(s.top.map(([itemId, n]) => `${itemId} (${n})`))}` : ''}`)
      else lines.push(`- ${id}: ${counts.length ? counts.join(', ') : 'nothing marked'} in ${items}${s.examples.length ? `; e.g. ${listed(s.examples.map(([itemId, label, text]) => `${itemId} ${label} "${text}"`), 4)}` : ''}`)
    } else if (s.type === 'choice') {
      lines.push(`- ${id}${s.signal ? ` (signal ${s.signal})` : ''}: ${Object.entries(s.counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}${s.unsureCount ? `; unsure (confidence < 0.6): ${s.unsureCount} [${s.unsure.join(', ')}]` : ''}`)
    } else if (s.type === 'noul') {
      lines.push(`- ${id}: yes ${s.yes}, no ${s.no}; highest: ${s.top.map(([itemId, p]) => `${itemId} (${p})`).join(', ')}`)
    } else if (s.type === 'score') {
      lines.push(`- ${id}: mean ${s.mean}; ${Object.entries(s.levels).map(([k, n]) => `${k} ${n}`).join(', ')}; highest: ${s.top.map(([itemId, v]) => `${itemId} (${v})`).join(', ')}`)
    } else {
      lines.push(`- ${id}: found in ${s.found} of ${s.of} item(s)${s.boxes.length ? ` (box as [left, top, right, bottom], fractions of the image): ${s.boxes.map(([itemId, box, c]) => `${itemId} [${box.join(', ')}] conf ${c}`).join('; ')}` : ''}`)
    }
    if (s.failed) lines.push(`  (${s.failed} item(s) failed for ${id}${s.error ? `: ${s.error}` : ''})`)
  }
  if (value.redacted) lines.push(`Redacted copy: ${value.redacted.output} (${value.redacted.spans} span(s) in ${value.redacted.items} item(s) replaced by their [LABEL])`)
  if (value.annotated) {
    lines.push(`Annotated copies (boxes in red): ${value.annotated.files.length ? value.annotated.files.join(', ') : 'none: no box was found'}${value.annotated.skipped.length ? `; not drawn (not PNG): ${value.annotated.skipped.join(', ')}` : ''}`)
  }
  if (value.preview.length) {
    lines.push('First rows:')
    for (const row of value.preview) lines.push(`  ${JSON.stringify(row)}`)
  }
  return lines.join('\n')
}

/** The result's facts as the Web UI's system_one row draws them (web/client.js), kept on the call's result. */
export function presentation(value, ui) {
  if (ui === 'off') return { systemOne: 1, ui }
  const { model, items, questions, requests, seconds, output, summary } = value
  const extra = Object.fromEntries(['spanModel', 'examples', 'images', 'redacted', 'annotated', 'sources'].filter(key => value[key] !== undefined).map(key => [key, value[key]]))
  return { systemOne: 1, ui, model, items, questions, requests, seconds, output, summary, ...extra }
}

/** The parts of each item's state from `state_fields`: {"part": "field"}, or a list of fields that keep their names. */
function fieldsOf(value) {
  if (value === undefined || value === null || value === '') return undefined
  let parsed = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      parsed = value.split(',').map(name => name.trim()).filter(Boolean)
    }
  }
  const map = Array.isArray(parsed) ? Object.fromEntries(parsed.map(name => [String(name), String(name)]))
    : parsed && typeof parsed === 'object' ? Object.fromEntries(Object.entries(parsed).map(([part, field]) => [part, String(field)])) : undefined
  if (!map || Object.keys(map).length === 0) throw new Error('state_fields names the parts of each item: {"part": "field"}, or a list of fields')
  return map
}

/** The sources' text, as one context with a `[path]` line before each file, and where each file starts in it. */
async function readSources(paths, cwd, before) {
  const blocks = []
  let context = before ? `${before}\n\n` : ''
  for (const [index, path] of paths.entries()) {
    const full = resolve(cwd, path)
    const text = (await readFile(full, 'utf8')).trim()
    const shown = relative(cwd, full) || full
    if (index > 0) context += '\n\n'
    context += `[${shown}]\n`
    blocks.push({ source: shown, start: context.length, text })
    context += text
  }
  if (context.length > SOURCE_CHARS) throw new Error(`the sources hold ${context.length} characters, and System One reads at most ${SOURCE_CHARS}: pass fewer or shorter files`)
  return { context, blocks }
}

function sourceAt(blocks, index) {
  const block = [...blocks].reverse().find(entry => entry.start <= index)
  if (!block) return undefined
  return { source: block.source, line: 1 + (block.text.slice(0, index - block.start).match(/\n/g)?.length ?? 0) }
}

/** Where an evidence span is: a source's file and line, or the record's own field that it read before the sources. */
const placeOf = span => (span.line ? `${span.source}:${span.line}` : span.source)

const round3 = value => Math.round(value * 1000) / 1000

/**
 * @param {object} deps
 * @param {ReturnType<import('./client.js').createDecisionClient>} deps.client
 * @param {(entry: object) => void} deps.trace
 * @param {object} deps.config
 * @param {(exec: object) => Promise<string>} [deps.workspaceOf] - the calling session's working directory, which
 *   relative paths resolve against
 */
export function systemOneTool({ client, trace, config, workspaceOf = async () => process.cwd() }) {
  return defineTool({
    name: config.toolName,
    description: DESCRIPTION,
    parameters: {
      questions: {
        type: 'json',
        required: true,
        description: 'One object: question id -> question ({"type": "choice" | "noul" | "score" | "box" | "span", "instructions": ..., "criteria": ...}, {"preset": "pii" | "halu" | "evidence"} or {"signal": ...}), as the description shows. Each question\'s fields go inside it.',
        examples: [EXAMPLE_QUESTIONS],
      },
      file: { type: 'string', description: 'Path to a .jsonl, .json (array), .csv, or .txt (one item per line) file holding the items.' },
      text_field: { type: 'string', description: 'For .jsonl/.json/.csv: the field holding each item\'s text, or several, as "subject,body". Default: all fields.' },
      id_field: { type: 'string', description: 'For .jsonl/.json/.csv: the field holding each item\'s id. Default: "id" when present, else the row number.' },
      items: { type: 'array', items: { type: 'string' }, description: 'Inline items, for short lists without a file.' },
      images: { type: 'array', items: { type: 'string' }, description: 'Image paths (PNG, JPEG, WebP); each image is one item.' },
      context: { type: 'string', description: 'Text placed before every item: what the items are and whose (e.g. "Support tickets sent to Lumen Cloud, a data product"). It helps every question.' },
      sources: { type: 'array', items: { type: 'string' }, description: 'Files the items should agree with (docs, a policy, a changelog). Each item is checked against them: preset halu marks what they do not support, preset evidence the words of the sources that back the item.' },
      state_fields: {
        type: 'json',
        description: 'For records: the parts System One reads of each item, as {"part": "field"}: "context" and "answer" for halu and evidence (with sources, a record\'s "context", as the message a reply answers, is read before them), "user" and "answer" for the signals r_harm and r_refusal.',
        examples: [{ user: 'question', answer: 'reply' }],
      },
      redact: {
        oneOf: [{ type: 'boolean' }, { type: 'string' }, { type: 'null' }],
        description: 'Write a copy of the items with what preset pii marked (else what the span questions marked) replaced by its [LABEL], in the input\'s format: true for <file>.redacted.<ext>, or a path. Without a pii or span question, personal data is what it replaces.',
      },
      annotate: {
        oneOf: [{ type: 'boolean' }, { type: 'string' }, { type: 'null' }],
        description: 'For images with box questions: a directory for copies of the images with the boxes found drawn in red (PNG), or true for a copy beside each image (<name>.annotated.png).',
      },
      output: { type: 'string', description: 'Where to write one result row per item (.jsonl or .csv), or a folder for them. Default: <file>.s1.jsonl beside the input file, <folder>.s1.jsonl beside the images\' folder, or ./system-one-results.jsonl.' },
      model: { type: 'string', description: `Decision model for choice, noul, score and box questions. Default ${config.model}.` },
      span_model: { type: 'string', description: `Model for span questions, presets and signals. Default ${config.spanModel}.` },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderSummary(value) }],
      presentationMeta: (_args, value) => presentation(value, config.systemOneUi),
    },
    async execute(args, exec) {
      const notes = []
      // the arguments System Two's tool-call markup ran into the questions, read as the arguments they are
      const split = splitArguments(args.questions)
      if (split) {
        const known = Object.keys(split.leaked).filter(key => Object.hasOwn(PARAMETERS, key) && key !== 'questions' && args[key] === undefined)
        args = { ...args, questions: split.head, ...Object.fromEntries(known.map(key => [key, split.leaked[key]])) }
        notes.push(`questions ran into the next arguments${known.length ? `: ${known.join(', ')} read from them` : ''}`)
      }
      const read = readQuestions(args.questions)
      let questions = read.questions
      notes.push(...read.notes)
      const cwd = await workspaceOf(exec)
      const file = args.file ? resolve(cwd, args.file) : undefined
      if (file) await mustBeFile(cwd, args.file, 'file')
      // an image that is not there is left out, and said; a call none of whose images is there is refused
      let images
      if (Array.isArray(args.images) && args.images.length) {
        const found = []
        const missing = []
        for (const path of args.images) ((await kindAt(resolve(cwd, String(path)))) === 'file' ? found : missing).push(String(path))
        if (found.length === 0) throw new Error(await noFile(cwd, missing[0], `image${missing.length > 1 ? ` (and ${missing.length - 1} more)` : ''}`))
        if (missing.length) notes.push(`left out ${missing.length} image(s) that do not exist: ${listed(missing, 6)}`)
        images = found.map(path => resolve(cwd, path))
      }
      // the results and the redacted copy each take a file of their own, never the input's
      let output = resolve(cwd, args.output || defaultOutput(cwd, file, images))
      if ((await kindAt(output)) === 'directory' || /[\\/]$/.test(args.output ?? '')) output = join(output, basename(defaultOutput(cwd, file, images)))
      if (output === file) throw new Error('output is where the results go: give it a path other than the input file')
      let copies = args.redact !== undefined && args.redact !== false && args.redact !== 'false' && args.redact !== null && args.redact !== ''
      const copyTo = !copies ? undefined : typeof args.redact === 'string' && args.redact !== 'true'
        ? resolve(cwd, args.redact)
        : file ? `${file.slice(0, file.length - extname(file).length)}.redacted${extname(file)}` : resolve(cwd, 'system-one-redacted.txt')
      if (copyTo && copyTo === file) throw new Error('redact writes a copy: give it a path other than the input file')
      // one path for both: the copy, which was asked for by name, takes it, and the results go where they go by default
      if (copyTo && copyTo === output) {
        const fallback = resolve(cwd, defaultOutput(cwd, file, images))
        if (fallback === copyTo || fallback === file) throw new Error('redact writes a copy beside the results: give it a path other than output')
        output = fallback
        notes.push(`output and redact named one file: the redacted copy is written there, the results to ${relative(cwd, output) || output}`)
      }
      const items = await loadItems({
        file,
        items: args.items,
        images,
        textField: args.text_field,
        idField: args.id_field,
        maxItems: config.toolMaxItems,
        maxChars: config.toolMaxChars,
        cwd,
      })
      const hasImages = items.some(item => item.images)
      // a question these items cannot answer at all (a span question of images, a box question of text) is left out
      // when others remain, and said
      const cannot = Object.entries(questions).map(([id, question]) => [id, unanswerable(question, { images: hasImages })]).filter(([, why]) => why)
      if (cannot.length && cannot.length < Object.keys(questions).length) {
        questions = Object.fromEntries(Object.entries(questions).filter(([id]) => !cannot.some(([gone]) => gone === id)))
        for (const [id, why] of cannot) notes.push(`not asked: ${id} (${why})`)
      }
      const sourcePaths = (Array.isArray(args.sources) ? args.sources : typeof args.sources === 'string' ? [args.sources] : []).filter(Boolean)
      for (const path of sourcePaths) await mustBeFile(cwd, path, 'source')
      const grounded = sourcePaths.length > 0
      // a signal that judges a reply reads the records' own "user" and "answer" fields when state_fields names none
      const needs = [...new Set(Object.values(questions).flatMap(question => ROUTER_SIGNALS[question.signal]?.parts ?? []))]
      const own = needs.length > 0 && !grounded && items.every(item => typeof item.record === 'object' && item.record !== null && needs.every(part => item.record[part] !== undefined))
      const fields = fieldsOf(args.state_fields) ?? (own ? Object.fromEntries(needs.map(part => [part, part])) : undefined)
      if ((fields || grounded) && hasImages) throw new Error('sources and state_fields read text items, not images')
      const parts = fields || grounded ? [...new Set([...Object.keys(fields ?? {}), ...(grounded ? ['context', 'answer'] : [])])] : undefined
      // a redacted copy replaces what pii or the call's own labels mark in each item's text: without either, it is
      // personal data; where no copy can be made, the questions are answered and the copy is left out, and said
      if (copies) {
        const marking = Object.values(questions).filter(question => kindOf(question) === 'span' && !question.signal && question.preset !== 'halu' && question.preset !== 'evidence')
        const cut = items.find(item => item.cut)
        const none = hasImages ? 'the items are images'
          : parts ? 'halu, evidence, sources and state_fields mark words against sources, not words to replace'
            : cut ? `item ${cut.id} is longer than ${config.toolMaxChars} characters, and a copy needs each item whole` : undefined
        if (none) {
          copies = false
          notes.push(`no redacted copy: ${none}`)
        } else if (marking.length === 0) {
          let id = 'pii'
          while (Object.hasOwn(questions, id)) id = `${id}_`
          questions = { ...questions, [id]: { preset: 'pii' } }
          notes.push(`redact: no pii or span question said what to replace, so ${id} ({"preset": "pii"}) marks the personal data it replaces`)
        }
      }
      const model = args.model || config.model
      const spanModel = args.span_model || config.spanModel
      const { groups, asked } = planQuestions(questions, { model, spanModel, parts, images: hasImages })
      const boxIds = Object.entries(questions).filter(([, question]) => question.type === 'box').map(([id]) => id)
      // where the annotated copies go: beside each image, into a folder, or (for one image) into a file
      let annotateTo
      if (args.annotate !== undefined && args.annotate !== null && args.annotate !== false && args.annotate !== 'false' && args.annotate !== '') {
        if (!hasImages || boxIds.length === 0) {
          notes.push('nothing annotated: annotate draws the boxes that box questions find on images; add one, as {"where": {"type": "box", "instructions": "the spike, drop or flatline"}}')
        } else if (args.annotate === true || args.annotate === 'true') {
          annotateTo = { beside: true }
        } else {
          const to = resolve(cwd, String(args.annotate))
          const at = await kindAt(to)
          if (/\.png$/i.test(to) && items.length === 1 && at !== 'directory') annotateTo = { file: to }
          else if (at === 'file') throw new Error(`annotate names a folder for the annotated copies, and ${args.annotate} is a file: name a folder, as "metrics/annotated/", or pass true for a copy beside each image`)
          else annotateTo = { dir: to }
        }
      }
      const context = args.context?.trim()
      const sources = grounded ? await readSources(sourcePaths, cwd, context) : undefined

      const states = items.map(item => {
        if (!parts) return { state: [context, item.text].filter(Boolean).join('\n\n') || 'An image.', shift: context && item.text ? context.length + 2 : 0, images: item.images }
        const state = {}
        if (fields) {
          if (typeof item.record !== 'object' || item.record === null) throw new Error('state_fields reads the fields of records: pass a .jsonl, .json or .csv file')
          for (const [part, field] of Object.entries(fields)) {
            const value = item.record[field]
            if (value === undefined) throw new Error(`state_fields: "${field}" is not a field of item ${item.id}`)
            state[part] = (typeof value === 'string' ? value : JSON.stringify(value)).slice(0, config.toolMaxChars)
          }
        }
        if (grounded) {
          // a record's own context, as the customer's message a reply answers, reads before the sources
          const own = state.context === undefined ? '' : `${state.context}\n\n`
          state.context = own + sources.context
          state.answer ??= item.text
          return { state, shift: 0, sourcesAt: own.length }
        }
        return { state, shift: 0 }
      })
      // each request stays within the Decision API's estimate, which counts an item's state once for every question
      const jobs = []
      for (const group of groups) {
        const asks = Object.keys(group.questions).length
        // a group of signals that read one part of each item reads that part as its text
        const texts = group.reads ? states.map(entry => ({ ...entry, state: String(entry.state[group.reads] ?? '') })) : states
        if (!hasImages) {
          const heaviest = Math.max(...texts.map(({ state }) => stateCost(state)))
          if (heaviest * asks > REQUEST_TOKENS) {
            throw new Error(`${asks} question(s) of ${group.model} over an item of about ${heaviest} bytes are more than one request may read (${REQUEST_TOKENS} tokens, each question reading the item again): ask fewer questions per call, or pass shorter items or sources`)
          }
        }
        const slices = hasImages ? texts.map((_, start) => ({ start, count: 1 })) : requestSlices(texts.map(({ state }) => state), asks)
        for (const { start, count } of slices) jobs.push({ group, start, count, texts })
      }
      const started = performance.now()
      let answered
      try {
        answered = await Promise.all(jobs.map(async ({ group, start, count, texts }) => {
          const slice = texts.slice(start, start + count).map(({ state, images: attached }) => ({ state, images: attached }))
          const response = await client.ask({ model: group.model, questions: group.questions, inputs: slice, signal: exec.signal, ...BATCH_LIMITS })
          return { group, start, response }
        }))
      } catch (error) {
        throw unavailable(error) ? new Error(unavailableText(error)) : error
      }
      const seconds = Math.round((performance.now() - started) / 10) / 100

      const rows = items.map(item => ({ id: item.id, text: item.source ?? clip(item.text, 200), answers: {} }))
      // the spans of each item, whole, for redaction and Chat: rows keep no personal data's text
      const found = items.map(() => ({}))
      let inputTokens = 0
      for (const { group, start, response } of answered) {
        inputTokens += response.inputTokens
        response.answers.forEach((answers, offset) => {
          const index = start + offset
          for (const [wire, id] of Object.entries(group.ids)) {
            const entry = asked[id]
            const answer = answers?.[wire]
            if (entry.kind !== 'span') {
              const compact = compactAnswer(answer)
              const base = questions[id].type === 'score' ? levelBase(questions[id].criteria) : 0
              rows[index].answers[id] = base && typeof compact.score === 'number' ? { ...compact, score: round3(compact.score + base) } : compact
              continue
            }
            if (answer?.error || (!answer && !Array.isArray(response.spans[offset]?.[wire]))) {
              rows[index].answers[id] = compactAnswer(answer)
              continue
            }
            const { state, shift } = states[index]
            const read = typeof state === 'string' ? state : state[entry.over] ?? ''
            const question = questions[id]
            let spans = placeSpans(response.spans[offset]?.[wire], read, { min: question.threshold ?? (question.preset === 'halu' ? HALU_AT : question.preset === 'pii' ? config.privacyAt ?? PII_AT : 0) })
              .filter(span => span.start >= shift)
              .map(span => ({ ...span, start: span.start - shift, end: span.end - shift }))
            const kept = question.preset !== 'pii' || question.labels === 'all' ? undefined : question.labels ?? config.privacyLabels ?? SENSITIVE_LABELS
            if (kept) spans = spans.filter(span => kept.includes(span.label))
            if (question.preset === 'pii') spans = spans.map(span => trimSpan(span, items[index].text)).filter(Boolean)
            // an item's id names it, whatever it looks like
            const named = typeof state === 'string' ? items[index].segments?.find(segment => segment.field !== undefined && segment.field === items[index].idField) : undefined
            spans = spans.filter(span => !(named && span.start < named.end && span.end > named.start) && !(question.preset === 'pii' && notPersonal(span, items[index].text)))
            const at = states[index].sourcesAt
            if (question.preset === 'evidence' && at !== undefined && entry.over === 'context') {
              spans = spans.map(span => ({ ...span, ...(span.start >= at ? sourceAt(sources.blocks, span.start - at) : { source: fields.context }) }))
            }
            found[index][id] = spans
            rows[index].answers[id] = {
              n: spans.length,
              p: round3(Math.max(0, ...spans.map(span => span.probability))),
              labels: labelCounts(spans),
              spans: spans.map(span => ({
                label: span.label,
                start: span.start,
                end: span.end,
                ...(question.preset === 'pii' ? {} : { text: clip(span.text, 300) }),
                p: round3(span.probability),
                ...(span.source ? { source: span.source, line: span.line } : {}),
              })),
            }
          }
        })
      }
      // a call that looks for personal data keeps it out of the results' text as well
      const personalIds = Object.keys(questions).filter(id => questions[id].preset === 'pii')
      const personalOf = index => personalIds.flatMap(id => found[index][id] ?? [])
      for (const [index, item] of items.entries()) {
        const spans = personalOf(index)
        if (spans.length && item.source === undefined) rows[index].text = clip(redactItem(item, spans).text, 200)
      }
      // and one that looks for jailbreaks or harm keeps their words out: System Two reading the results reads no attack
      if (Object.values(questions).some(question => SAFETY_SIGNALS.has(question.signal))) for (const row of rows) delete row.text

      let redacted
      if (copies) {
        // personal data when the call looks for it, else what its own labels mark
        const marks = Object.entries(questions).filter(([id, question]) => asked[id].kind === 'span' && question.preset !== 'halu' && question.preset !== 'evidence')
        const personal = marks.filter(([, question]) => question.preset === 'pii')
        const marking = (personal.length ? personal : marks).map(([id]) => id)
        const out = copyTo
        let spanCount = 0
        let changed = 0
        const records = items.map((item, index) => {
          const spans = marking.flatMap(id => found[index][id] ?? [])
          if (spans.length === 0) return item.record
          const copy = redactItem(item, spans)
          spanCount += copy.replaced
          if (copy.replaced) changed++
          return copy.record
        })
        await mkdir(dirname(out), { recursive: true })
        await writeRedacted({ file, format: file ? formatOf(file) : 'lines', output: out, items, records })
        redacted = { output: out, items: changed, spans: spanCount }
      }

      let annotated
      if (annotateTo) {
        const dir = annotateTo.dir ?? dirname(annotateTo.file ?? items[0].path)
        await mkdir(dir, { recursive: true })
        annotated = { dir, files: [], skipped: [] }
        for (const [index, item] of items.entries()) {
          const boxes = boxIds.map(id => rows[index].answers[id]).filter(a => a?.box && a.confidence >= FOUND_AT)
          if (!item.path || boxes.length === 0) continue
          const bytes = await readFile(item.path)
          if (imageSize(bytes)?.type !== 'png') {
            annotated.skipped.push(item.source)
            continue
          }
          let out = annotateTo.file ?? (annotateTo.beside ? item.path : join(dir, basename(item.path)))
          if (out === item.path) out = `${out.slice(0, -extname(out).length)}.annotated.png`
          await writeFile(out, annotatePng(bytes, boxes.map(a => ({ box: a.box }))))
          annotated.files.push(relative(cwd, out) || out)
        }
      }

      await mkdir(dirname(output), { recursive: true })
      await writeResults(output, rows, questions, asked)
      const summary = summarize(questions, rows, asked)

      // for Chat: a few marked items per span question, and the images with their boxes
      const examples = {}
      for (const [id, question] of Object.entries(questions)) {
        if (asked[id].kind !== 'span') continue
        const kind = question.preset === 'pii' ? 'masked' : question.preset === 'halu' ? 'unsupported' : question.preset === 'evidence' ? 'evidence' : 'labels'
        const picked = items.map((item, index) => ({ item, index, spans: found[index][id] ?? [] }))
          .filter(entry => entry.spans.length)
          .sort((x, y) => Math.max(...y.spans.map(span => span.probability)) - Math.max(...x.spans.map(span => span.probability)))
          .slice(0, 3)
        if (picked.length === 0) continue
        examples[id] = picked.map(({ item, index, spans }) => {
          let read = asked[id].over && typeof states[index].state === 'object' ? states[index].state[asked[id].over] : item.text
          // personal data wherever it recurs, as the redacted copy and the results file have it
          let shown = kind === 'masked' ? joined(everywhere(read, spans)) : spans
          const personal = kind === 'labels' && personalIds.length ? personalOf(index) : []
          if (personal.length) ({ text: read, spans: shown } = maskAround(read, spans, read === item.text ? joined(everywhere(read, personal)) : personal))
          // evidence reads as a passage of its own file, or of the record's own context
          const block = kind === 'evidence' && spans[0].line !== undefined ? sources?.blocks.find(entry => entry.source === spans[0].source) : undefined
          if (block) {
            const start = states[index].sourcesAt + block.start
            read = block.text
            shown = spans.filter(span => span.source === block.source && span.line !== undefined).map(span => ({ ...span, start: span.start - start, end: span.end - start }))
          } else if (kind === 'evidence' && spans[0].source !== undefined) {
            read = read.slice(0, states[index].sourcesAt).trimEnd()
            shown = spans.filter(span => span.line === undefined && span.source === spans[0].source)
          }
          return {
            id: item.id,
            kind,
            parts: excerpts(read, shown, { hide: kind === 'masked', around: kind === 'evidence' ? 28 : 40, max: 1, clip: 120, rank: true })[0],
            ...(spans[0].source ? { source: placeOf(spans[0]) } : {}),
          }
        })
      }
      const shownImages = hasImages
        ? items.slice(0, IMAGES_SHOWN).map((item, index) => ({
          id: item.id,
          path: item.path,
          boxes: boxIds.map(id => ({ id, ...rows[index].answers[id] })).filter(a => a.box && a.confidence >= FOUND_AT).map(({ id, box, confidence }) => ({ id, box, confidence })),
          answers: Object.fromEntries(Object.entries(rows[index].answers).filter(([id]) => questions[id].type !== 'box').slice(0, 3)),
        }))
        : undefined
      const used = [...new Set(groups.map(group => group.model))]
      const value = {
        model: used.includes(model) ? model : used[0],
        ...(used.length > 1 ? { spanModel } : {}),
        items: items.length,
        questions: Object.keys(questions).length,
        requests: jobs.length,
        seconds,
        inputTokens,
        output,
        summary,
        preview: rows.slice(0, 3).map(row => flatRow(row, questions, asked)),
        ...(Object.keys(examples).length ? { examples } : {}),
        ...(shownImages ? { images: shownImages } : {}),
        ...(redacted ? { redacted } : {}),
        ...(annotated ? { annotated } : {}),
        ...(sources ? { sources: sources.blocks.map(block => block.source) } : {}),
        ...(notes.length ? { notes } : {}),
      }
      trace({
        ev: 's1',
        reflex: 'tool',
        session: exec.agent?.session?.id,
        model: value.model,
        spanModel: value.spanModel,
        items: items.length,
        requests: jobs.length,
        ms: Math.round(seconds * 1000),
        inputTokens,
        questions,
        summary,
        output,
      })
      return value
    },
  })
}
