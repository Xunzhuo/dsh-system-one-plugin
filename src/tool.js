/** The model-facing `system_one` tool: one rubric, many items, calibrated answers. */
import { writeFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ITEMS_PER_REQUEST, compactAnswer } from './client.js'
import { loadItems } from './items.js'
import { clip } from './trace.js'

const DESCRIPTION = `Ask System One, a fast decision model, typed questions about many items at once (text records, files' lines, or images) and get calibrated probabilities back in seconds, instead of reading the items yourself. Use it whenever the same judgment applies to many items: routing, labeling, filtering, triage, scoring, ranking, moderation, spotting problems in screenshots.

You write the rubric as questions; System One answers every question for every item, writes one result row per item to an output file (JSONL or CSV) and returns a summary. Read the output file afterwards only for the rows you need.

Question types:
- "choice": pick one option. criteria: an object of option name -> short description (2 or more options).
- "noul": yes or no, with no criteria: say in the instructions what counts as yes. The answer is the probability of yes.
- "score": an ordered scale. criteria: a list of level descriptions, lowest first (2 to 10). The answer is the expected level (0 = first).
- "box": where something is in an image (images only); instructions name the target.

Example questions: {"team": {"type": "choice", "instructions": "Which team should handle this ticket?", "criteria": {"billing": "Payments, invoices, refunds", "engineering": "Bugs, errors, outages", "sales": "Plans and pricing"}}, "urgency": {"type": "score", "instructions": "How urgent is this ticket?", "criteria": ["Low", "Normal", "Urgent"]}, "angry": {"type": "noul", "instructions": "Is the customer angry?"}}`

/** The type a question's criteria imply: a list of levels is a score, named options a choice, anything else yes/no. */
function impliedType(criteria) {
  if (Array.isArray(criteria)) return 'score'
  if (!criteria || typeof criteria !== 'object') return 'noul'
  return Object.keys(criteria).map(name => name.toLowerCase()).sort().join() === 'no,yes' ? 'noul' : 'choice'
}

export function parseQuestions(value) {
  const questions = typeof value === 'string' ? JSON.parse(value) : value
  if (!questions || typeof questions !== 'object' || Array.isArray(questions) || Object.keys(questions).length === 0) {
    throw new Error('questions must be an object of question id -> {type, instructions, criteria}')
  }
  for (const [id, asked] of Object.entries(questions)) {
    // System Two often leaves the type out of its first call
    const question = asked && typeof asked === 'object' && asked.type === undefined ? { ...asked, type: impliedType(asked.criteria) } : asked
    questions[id] = question
    if (!['choice', 'noul', 'score', 'box'].includes(question?.type)) throw new Error(`question "${id}" needs type choice, noul, score or box`)
    if (typeof question.instructions !== 'string' || !question.instructions.trim()) throw new Error(`question "${id}" needs instructions`)
    // the Decision API does not answer a noul question that carries criteria
    if (question.type === 'noul' && question.criteria !== undefined) {
      const { criteria, ...rest } = question
      const rules = typeof criteria === 'string' ? [criteria]
        : Array.isArray(criteria) ? criteria.map(String)
          : criteria && typeof criteria === 'object' ? Object.entries(criteria).map(([name, rule]) => `${name}: ${rule}`) : []
      questions[id] = { ...rest, instructions: [rest.instructions.trim(), ...rules].join('\n') }
    }
  }
  return questions
}

function summarize(questions, rows) {
  const summary = {}
  for (const [id, question] of Object.entries(questions)) {
    const answers = rows.map(row => ({ id: row.id, a: row.answers[id] })).filter(entry => entry.a && !entry.a.error)
    const failed = rows.length - answers.length
    if (question.type === 'choice') {
      const counts = {}
      for (const { a } of answers) counts[a.choice] = (counts[a.choice] ?? 0) + 1
      const unsure = answers.filter(({ a }) => a.confidence < 0.6).map(({ id: itemId }) => itemId)
      summary[id] = { type: 'choice', counts, unsure: unsure.slice(0, 12), unsureCount: unsure.length, failed }
    } else if (question.type === 'noul') {
      const sorted = [...answers].sort((x, y) => y.a.yes - x.a.yes)
      const yesCount = answers.filter(({ a }) => a.yes >= 0.5).length
      summary[id] = { type: 'noul', yes: yesCount, no: answers.length - yesCount, top: sorted.slice(0, 8).map(({ id: itemId, a }) => [itemId, a.yes]), failed }
    } else if (question.type === 'score') {
      const levels = question.criteria.map(() => 0)
      let total = 0
      for (const { a } of answers) {
        total += a.score
        levels[Math.min(levels.length - 1, Math.max(0, Math.round(a.score)))]++
      }
      const sorted = [...answers].sort((x, y) => y.a.score - x.a.score)
      summary[id] = {
        type: 'score',
        mean: answers.length ? Math.round((total / answers.length) * 100) / 100 : null,
        levels: Object.fromEntries(question.criteria.map((label, index) => [String(label).split(':')[0], levels[index]])),
        top: sorted.slice(0, 8).map(({ id: itemId, a }) => [itemId, a.score]),
        failed,
      }
    } else {
      summary[id] = { type: 'box', boxes: answers.slice(0, 12).map(({ id: itemId, a }) => [itemId, a.box, a.confidence]), failed }
    }
  }
  return summary
}

function flatRow(row, questions) {
  const flat = { id: row.id }
  for (const [id, question] of Object.entries(questions)) {
    const a = row.answers[id]
    if (!a || a.error) {
      flat[id] = 'error'
      continue
    }
    if (question.type === 'choice') {
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

function csvCell(value) {
  const text = value === undefined || value === null ? '' : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

async function writeResults(path, rows, questions) {
  if (extname(path).toLowerCase() === '.csv') {
    const flat = rows.map(row => flatRow(row, questions))
    const columns = [...new Set(flat.flatMap(row => Object.keys(row)))]
    const lines = [columns.join(','), ...flat.map(row => columns.map(column => csvCell(row[column])).join(','))]
    await writeFile(path, lines.join('\n') + '\n')
  } else {
    await writeFile(path, rows.map(row => JSON.stringify({ id: row.id, text: row.text, answers: row.answers })).join('\n') + '\n')
  }
}

function renderSummary(value) {
  const lines = [
    `System One (${value.model}) answered ${value.questions} question(s) for ${value.items} item(s) in ${value.seconds} s (${value.requests} requests). Results: ${value.output}`,
  ]
  for (const [id, s] of Object.entries(value.summary)) {
    if (s.type === 'choice') {
      lines.push(`- ${id}: ${Object.entries(s.counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}${s.unsureCount ? `; unsure (confidence < 0.6): ${s.unsureCount} [${s.unsure.join(', ')}]` : ''}`)
    } else if (s.type === 'noul') {
      lines.push(`- ${id}: yes ${s.yes}, no ${s.no}; highest: ${s.top.map(([itemId, p]) => `${itemId} (${p})`).join(', ')}`)
    } else if (s.type === 'score') {
      lines.push(`- ${id}: mean ${s.mean}; ${Object.entries(s.levels).map(([k, n]) => `${k} ${n}`).join(', ')}; highest: ${s.top.map(([itemId, v]) => `${itemId} (${v})`).join(', ')}`)
    } else {
      lines.push(`- ${id}: ${s.boxes.map(([itemId, box, c]) => `${itemId} ${JSON.stringify(box)} conf ${c}`).join('; ')}`)
    }
    if (s.failed) lines.push(`  (${s.failed} item(s) failed for ${id})`)
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
  return { systemOne: 1, ui, model, items, questions, requests, seconds, output, summary }
}

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
      questions: { type: 'json', required: true, description: 'Question id -> question object, as in the examples above.' },
      file: { type: 'string', description: 'Path to a .jsonl, .json (array), .csv, or .txt (one item per line) file holding the items.' },
      text_field: { type: 'string', description: 'For .jsonl/.json/.csv: the field holding each item\'s text. Default: all fields.' },
      id_field: { type: 'string', description: 'For .jsonl/.json/.csv: the field holding each item\'s id. Default: "id" when present, else the row number.' },
      items: { type: 'array', items: { type: 'string' }, description: 'Inline items, for short lists without a file.' },
      images: { type: 'array', items: { type: 'string' }, description: 'Image paths (PNG, JPEG, WebP); each image is one item.' },
      context: { type: 'string', description: 'Text placed before every item, such as what the items are.' },
      output: { type: 'string', description: 'Where to write one result row per item (.jsonl or .csv). Default: next to the input file, or ./system-one-results.jsonl.' },
      model: { type: 'string', description: `Decision model. Default ${config.model}; vllm-sr/d3-flash also answers box questions.` },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderSummary(value) }],
      presentationMeta: (_args, value) => presentation(value, config.systemOneUi),
    },
    async execute(args, exec) {
      const questions = parseQuestions(args.questions)
      const cwd = await workspaceOf(exec)
      const file = args.file ? resolve(cwd, args.file) : undefined
      const images = args.images?.map(path => resolve(cwd, path))
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
      const model = args.model || config.model
      const context = args.context?.trim()
      const inputs = items.map(item => ({
        state: [context, item.text].filter(Boolean).join('\n\n') || 'An image.',
        images: item.images,
      }))
      const hasImages = inputs.some(input => input.images)
      const perRequest = hasImages ? 1 : ITEMS_PER_REQUEST
      const batches = []
      for (let start = 0; start < inputs.length; start += perRequest) batches.push(start)
      const started = performance.now()
      const answered = await Promise.all(batches.map(async start => {
        const slice = inputs.slice(start, start + perRequest)
        const response = await client.ask({ model, questions, inputs: slice, signal: exec.signal })
        return { start, response }
      }))
      const seconds = Math.round((performance.now() - started) / 10) / 100
      const rows = items.map(item => ({ id: item.id, text: item.source ?? clip(item.text, 200), answers: {} }))
      let inputTokens = 0
      for (const { start, response } of answered) {
        inputTokens += response.inputTokens
        response.answers.forEach((answers, offset) => {
          rows[start + offset].answers = Object.fromEntries(Object.entries(answers ?? {}).map(([id, a]) => [id, compactAnswer(a)]))
        })
      }
      const output = resolve(cwd, args.output || (file ? `${file.replace(/\.[^./]+$/, '')}.s1.jsonl` : 'system-one-results.jsonl'))
      await writeResults(output, rows, questions)
      const summary = summarize(questions, rows)
      const value = {
        model,
        items: items.length,
        questions: Object.keys(questions).length,
        requests: batches.length,
        seconds,
        inputTokens,
        output,
        summary,
        preview: rows.slice(0, 3).map(row => flatRow(row, questions)),
      }
      trace({
        ev: 's1',
        reflex: 'tool',
        session: exec.agent?.session?.id,
        model,
        items: items.length,
        requests: batches.length,
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
