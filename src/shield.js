/**
 * The injection shield: screen tool output passage by passage, then zoom into
 * flagged passages to find what carries the injection, and remove only that:
 * the exact spans when a span model answers, else the lines. Lines the harness
 * itself writes are masked while scoring and never removed.
 */
import { ITEMS_PER_REQUEST, yes } from './client.js'
import { INJECTION_SPANS, SHIELD, SHIELD_FOCUS } from './questions.js'
import { excerpts, placeSpans, replaceSpans, toSentences, unnumber } from './spans.js'

/** Exact templates of the annotations DeepSeek Harness adds to shell output. */
const HARNESS_LINES = [
  /^\[(stdout|stderr)\]$/,
  /^\[sandbox: file access denied under [\w-]+ mode\]$/,
  /^\[sandbox: escalation available — retry this exact \w+ once with sandbox_permissions \(the narrowest wider mode that suffices\) \+ justification; the approval prompt asks the user\]$/,
  /^\[sandbox: the sandbox runner itself failed under [\w-]+ mode — the command did not run; this is a sandbox problem, not a command failure\]$/,
]

export const isHarnessLine = line => HARNESS_LINES.some(pattern => pattern.test(line.trim()))

/**
 * Group line indices into passages of about `size` characters, ending at line
 * breaks and preferably at blank lines. Lines longer than `size` stay whole.
 * @returns {Array<[number, number]>} half-open line ranges
 */
export function passageRanges(lines, size) {
  const ranges = []
  let start = 0
  let length = 0
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const breakHere = (line.trim() === '' && length > size * 0.6) || (length > 0 && length + line.length + 1 > size)
    if (breakHere) {
      ranges.push([start, index])
      start = index
      length = 0
    }
    length += line.length + 1
  }
  if (start < lines.length) ranges.push([start, lines.length])
  return ranges.filter(([from, to]) => lines.slice(from, to).some(line => line.trim()))
}

async function scoreAll(client, model, questions, states, signal, limits = {}) {
  const batches = []
  for (let start = 0; start < states.length; start += ITEMS_PER_REQUEST) batches.push(states.slice(start, start + ITEMS_PER_REQUEST))
  const responses = await Promise.all(batches.map(batch => client.ask({ model, questions, inputs: batch.map(state => ({ state })), signal, ...limits })))
  return {
    model: responses[0]?.model ?? model,
    scores: responses.flatMap(response => response.answers.map(answers => yes(answers.injection) ?? 0)),
  }
}

export const SPAN_MARK = '[System One removed injected text]'

// The exact spans that give orders, in each flagged passage, from a span model; a passage it fails on gets none.
async function injectedSpans({ client, model, about, passages, signal, timeoutMs, retries }) {
  const found = passages.map(() => [])
  let answeredBy
  for (let start = 0; start < passages.length; start += ITEMS_PER_REQUEST) {
    const batch = passages.slice(start, start + ITEMS_PER_REQUEST)
    const response = await client.ask({ model, questions: INJECTION_SPANS, inputs: batch.map(passage => ({ state: { request: about, passage } })), signal, timeoutMs, retries })
    answeredBy = response.model
    batch.forEach((passage, offset) => {
      found[start + offset] = placeSpans(response.spans[offset]?.injected, passage)
    })
  }
  return { model: answeredBy ?? model, found }
}

/**
 * @param {object} options
 * @param {{ask: Function}} options.client
 * @param {string} options.model
 * @param {string} options.prefix - what the user asked and where the text came from
 * @param {string} options.text
 * @param {number} options.threshold
 * @param {number} options.chunkChars
 * @param {AbortSignal} [options.signal]
 * @param {{model: string, about: string}} [options.spans] - a span model that finds the injected text itself
 * @returns {Promise<{model: string, passages: number, maxP: number, flagged: object[], removed: object[], removedLines: number,
 *   removedSpans: number, removedChars: number, spanModel?: string, spanMs?: number, text: string}>}
 *   `maxP` is the highest injection probability of any passage
 */
export async function screen({ client, model, prefix, text, threshold, chunkChars, signal, timeoutMs, retries, spans }) {
  const lines = text.split('\n')
  const lineStart = []
  for (let index = 0, at = 0; index < lines.length; index++) {
    lineStart.push(at)
    at += lines[index].length + 1
  }
  const masked = lines.map(line => (isHarnessLine(line) ? '[harness note]' : line))
  const ranges = passageRanges(masked, chunkChars)
  const quote = (from, to, marks) => {
    const body = marks
      ? [...masked.slice(from, marks[0]), '⟦', ...masked.slice(marks[0], marks[1]), '⟧', ...masked.slice(marks[1], to)]
      : masked.slice(from, to)
    return `${prefix}\n"""\n${body.join('\n')}\n"""`
  }
  const first = await scoreAll(client, model, SHIELD, ranges.map(([from, to]) => quote(from, to)), signal, { timeoutMs, retries })
  const flagged = ranges.map(([from, to], index) => ({ from, to, p: first.scores[index], text: lines.slice(from, to).join('\n') })).filter(entry => entry.p >= threshold)

  // With a span model: the text that gives orders, in each flagged passage, grown to whole sentences. The passage is
  // scored again without them, and a cut that leaves an injection behind, or a failure, leaves the lines below.
  let spanModel
  let spanMs
  if (spans && flagged.length) {
    const started = performance.now()
    try {
      // the span model reads a file's text without the read tool's line numbers; each cut is mapped back onto them
      const plain = flagged.map(entry => unnumber(entry.text))
      const answer = await injectedSpans({ client, model: spans.model, about: spans.about, passages: plain.map(view => view.text), signal, timeoutMs, retries })
      spanModel = answer.model
      const cuts = flagged.map((entry, index) => {
        const grown = toSentences(plain[index].text, answer.found[index])
        // the harness's own lines are never removed
        if (!grown.length || grown.some(span => span.text.split('\n').some(isHarnessLine))) return undefined
        entry.plain = { text: plain[index].text, spans: grown }
        return grown.map(span => {
          const start = plain[index].at(span.start)
          const end = plain[index].at(span.end)
          return { ...span, start, end, text: entry.text.slice(start, end) }
        })
      })
      const tried = flagged.map((entry, index) => ({ entry, cut: cuts[index] })).filter(item => item.cut)
      if (tried.length) {
        const unmask = value => value.split('\n').map(line => (isHarnessLine(line) ? '[harness note]' : line)).join('\n')
        const again = await scoreAll(client, model, SHIELD, tried.map(({ entry, cut }) => `${prefix}\n"""\n${unmask(replaceSpans(entry.text, cut, () => SPAN_MARK))}\n"""`), signal, { timeoutMs, retries })
        tried.forEach(({ entry, cut }, index) => {
          if (again.scores[index] < threshold) entry.spans = cut
          else entry.spansLeft = again.scores[index]
        })
      }
    } catch (error) {
      if (signal?.aborted) throw error
    }
    spanMs = performance.now() - started
  }

  // Otherwise a second look inside each flagged passage: which groups of lines carry it?
  const GROUP = 3
  await Promise.all(flagged.filter(entry => !entry.spans).map(async entry => {
    const groups = []
    for (let start = entry.from; start < entry.to; start += GROUP) groups.push([start, Math.min(entry.to, start + GROUP)])
    let hits = []
    if (groups.length > 1) {
      const zoom = await scoreAll(client, model, SHIELD_FOCUS, groups.map(group => quote(entry.from, entry.to, group)), signal, { timeoutMs, retries }).catch(() => undefined)
      hits = zoom ? groups.map(([start, end], index) => ({ start, end, p: zoom.scores[index] })).filter(group => group.p >= threshold) : []
    }
    entry.lines = hits.length ? hits : [{ start: entry.from, end: entry.to, p: entry.p }]
  }))

  // Every removal as a range of the original text and what replaces it.
  const lineEnd = index => (index < lines.length ? lineStart[index] : text.length)
  const cuts = []
  for (const entry of flagged) {
    if (entry.spans) {
      for (const span of entry.spans) {
        const at = lineStart[entry.from]
        cuts.push({ start: at + span.start, end: at + span.end, p: span.probability, replacement: SPAN_MARK, spans: 1, chars: span.end - span.start })
      }
      continue
    }
    const merged = []
    for (const range of [...entry.lines].sort((a, b) => a.start - b.start)) {
      const last = merged.at(-1)
      if (last && last.end >= range.start) {
        last.end = Math.max(last.end, range.end)
        last.p = Math.max(last.p, range.p)
      } else {
        merged.push({ ...range })
      }
    }
    for (const range of merged) {
      const kept = lines.slice(range.start, range.end).filter(isHarnessLine)
      const dropped = range.end - range.start - kept.length
      if (dropped === 0) continue
      const body = [`[System One removed ${dropped} line(s) here: they give orders to AI agents (p ${range.p.toFixed(2)})]`, ...kept].join('\n')
      cuts.push({ start: lineStart[range.start], end: lineEnd(range.end), p: range.p, replacement: range.end < lines.length ? `${body}\n` : body, lines: dropped, startLine: range.start, endLine: range.end })
    }
  }
  cuts.sort((a, b) => a.start - b.start)
  let out = ''
  let cursor = 0
  for (const cut of cuts) {
    out += text.slice(cursor, cut.start) + cut.replacement
    cursor = cut.end
  }
  out += text.slice(cursor)
  const removedLines = cuts.reduce((sum, cut) => sum + (cut.lines ?? 0), 0)
  const removedSpans = cuts.reduce((sum, cut) => sum + (cut.spans ?? 0), 0)

  return {
    model: first.model,
    passages: ranges.length,
    maxP: first.scores.reduce((max, p) => Math.max(max, p), 0),
    flagged: flagged.map(entry => ({
      p: entry.p,
      text: entry.text,
      lines: (entry.lines ?? []).map(range => ({ p: range.p, text: lines.slice(range.start, range.end).join('\n') })),
      spans: (entry.spans ? entry.plain.spans : []).map(span => ({ label: span.label, p: span.probability, text: span.text })),
      excerpts: entry.spans ? excerpts(entry.plain.text, entry.plain.spans, { around: 60, max: 2 }) : [],
    })),
    removed: cuts.map(cut => (cut.lines ? { start: cut.startLine, end: cut.endLine, p: cut.p } : { span: true, start: cut.start, end: cut.end, p: cut.p })),
    removedLines,
    removedSpans,
    removedChars: cuts.reduce((sum, cut) => sum + (cut.chars ?? 0), 0),
    spanModel,
    spanMs,
    text: cuts.length > 0 ? out : text,
  }
}
