/**
 * The injection shield: screen tool output passage by passage, then zoom into
 * flagged passages to find the lines that carry the injection, and remove only
 * those. Lines the harness itself writes are masked while scoring and never
 * removed.
 */
import { ITEMS_PER_REQUEST, yes } from './client.js'
import { SHIELD, SHIELD_FOCUS } from './questions.js'

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

/**
 * @param {object} options
 * @param {{ask: Function}} options.client
 * @param {string} options.model
 * @param {string} options.prefix - what the user asked and where the text came from
 * @param {string} options.text
 * @param {number} options.threshold
 * @param {number} options.chunkChars
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{model: string, passages: number, flagged: object[], removed: Array<{start: number, end: number, p: number}>, removedLines: number, text: string}>}
 */
export async function screen({ client, model, prefix, text, threshold, chunkChars, signal, timeoutMs, retries }) {
  const lines = text.split('\n')
  const masked = lines.map(line => (isHarnessLine(line) ? '[harness note]' : line))
  const ranges = passageRanges(masked, chunkChars)
  const quote = (from, to, marks) => {
    const body = marks
      ? [...masked.slice(from, marks[0]), '⟦', ...masked.slice(marks[0], marks[1]), '⟧', ...masked.slice(marks[1], to)]
      : masked.slice(from, to)
    return `${prefix}\n"""\n${body.join('\n')}\n"""`
  }
  const first = await scoreAll(client, model, SHIELD, ranges.map(([from, to]) => quote(from, to)), signal, { timeoutMs, retries })
  const flagged = ranges.map(([from, to], index) => ({ from, to, p: first.scores[index] })).filter(entry => entry.p >= threshold)

  // Second look, only inside flagged passages: which groups of lines carry it?
  const GROUP = 3
  const removed = []
  await Promise.all(flagged.map(async entry => {
    const groups = []
    for (let start = entry.from; start < entry.to; start += GROUP) groups.push([start, Math.min(entry.to, start + GROUP)])
    let hits = []
    if (groups.length > 1) {
      const zoom = await scoreAll(client, model, SHIELD_FOCUS, groups.map(group => quote(entry.from, entry.to, group)), signal, { timeoutMs, retries }).catch(() => undefined)
      hits = zoom ? groups.map(([start, end], index) => ({ start, end, p: zoom.scores[index] })).filter(group => group.p >= threshold) : []
    }
    entry.lines = hits.length ? hits : [{ start: entry.from, end: entry.to, p: entry.p }]
    removed.push(...entry.lines)
  }))

  removed.sort((a, b) => a.start - b.start)
  const merged = []
  for (const range of removed) {
    const last = merged.at(-1)
    if (last && last.end >= range.start) {
      last.end = Math.max(last.end, range.end)
      last.p = Math.max(last.p, range.p)
    } else {
      merged.push({ ...range })
    }
  }

  const out = []
  let removedLines = 0
  let cursor = 0
  for (const range of merged) {
    out.push(...lines.slice(cursor, range.start))
    const kept = []
    let dropped = 0
    for (let index = range.start; index < range.end; index++) {
      if (isHarnessLine(lines[index])) kept.push(lines[index])
      else dropped++
    }
    if (dropped > 0) out.push(`[System One removed ${dropped} line(s) here: they give orders to AI agents (p ${range.p.toFixed(2)})]`)
    out.push(...kept)
    removedLines += dropped
    cursor = range.end
  }
  out.push(...lines.slice(cursor))

  return {
    model: first.model,
    passages: ranges.length,
    flagged: flagged.map(entry => ({
      p: entry.p,
      text: lines.slice(entry.from, entry.to).join('\n'),
      lines: entry.lines.map(range => ({ p: range.p, text: lines.slice(range.start, range.end).join('\n') })),
    })),
    removed: merged,
    removedLines,
    text: removedLines > 0 ? out.join('\n') : text,
  }
}
