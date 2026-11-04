/**
 * Span answers (Vela 3.0 models, contract 3.2): `spans.<id> = [{label, start, end, text, probability}]`, with offsets in
 * Unicode code points into the text the question read, `end` exclusive. JavaScript strings index UTF-16 units, so every
 * span is moved onto them and checked against its own text before it is used.
 */

/** UTF-16 index of each code point boundary of `text` (one more entry than code points). */
function boundaries(text) {
  const at = [0]
  let index = 0
  for (const char of text) {
    index += char.length
    at.push(index)
  }
  return at
}

/**
 * The spans of one answer that really cut `text` where they say, as UTF-16 ranges, sorted and without overlaps (the
 * more probable of two overlapping spans wins). A span whose offsets miss is found again by its text, nearest first.
 * @param {Array<{label: string, start: number, end: number, text: string, probability: number}>} spans
 * @param {string} text - what the question read
 * @param {object} [options]
 * @param {number} [options.min] - the lowest probability kept
 * @returns {Array<{label: string, start: number, end: number, text: string, probability: number}>}
 */
export function placeSpans(spans, text, { min = 0 } = {}) {
  if (!Array.isArray(spans) || typeof text !== 'string' || text.length === 0) return []
  const at = boundaries(text)
  const placed = []
  for (const span of spans) {
    if (!span || typeof span.text !== 'string' || span.text.length === 0) continue
    const probability = typeof span.probability === 'number' && Number.isFinite(span.probability) ? span.probability : 0
    if (probability < min) continue
    let start = Number.isSafeInteger(span.start) && span.start >= 0 && span.start < at.length ? at[span.start] : -1
    let end = Number.isSafeInteger(span.end) && span.end > 0 && span.end < at.length ? at[span.end] : -1
    if (start < 0 || end <= start || text.slice(start, end) !== span.text) {
      const near = start >= 0 ? start : 0
      const after = text.indexOf(span.text, near)
      const before = text.lastIndexOf(span.text, near)
      const found = after < 0 ? before : before < 0 ? after : near - before <= after - near ? before : after
      if (found < 0) continue
      start = found
      end = found + span.text.length
    }
    placed.push({ label: String(span.label ?? ''), start, end, text: span.text, probability })
  }
  placed.sort((a, b) => a.start - b.start || b.probability - a.probability)
  const kept = []
  for (const span of placed) {
    const last = kept.at(-1)
    if (last && span.start < last.end) {
      if (span.probability > last.probability) kept[kept.length - 1] = span
      continue
    }
    kept.push(span)
  }
  return kept
}

/** `text` with each span replaced by what `mask(span)` returns. */
export function replaceSpans(text, spans, mask) {
  let out = ''
  let cursor = 0
  for (const span of spans) {
    out += text.slice(cursor, span.start) + mask(span)
    cursor = span.end
  }
  return out + text.slice(cursor)
}

/** Personal data masked by its label, as `[EMAIL_ADDRESS]`. */
export const maskLabel = span => `[${span.label || 'PII'}]`

const EDGE = /[\s,;:.!?]/

/**
 * A personal-data span without the spaces and punctuation at its edges, which the model may include, as in ", 2200
 * Mission Street,": masked as they are, the sentence around them would lose its commas. Null when nothing is left.
 */
export function trimSpan(span, text) {
  let { start, end } = span
  while (start < end && EDGE.test(text[start])) start++
  while (end > start && EDGE.test(text[end - 1])) end--
  if (start === end) return null
  return start === span.start && end === span.end ? span : { ...span, start, end, text: text.slice(start, end) }
}

const PLACEHOLDER = /\[[A-Z][A-Z0-9_]*\]/g

/**
 * Whether a span marks only placeholders text already masked, as `[EMAIL_ADDRESS]`: a span model reading a redacted
 * copy marks them again, each under its own label.
 */
export function onPlaceholder(span, text) {
  const covered = [...text.matchAll(PLACEHOLDER)].filter(match => match.index < span.end && match.index + match[0].length > span.start)
  if (covered.length === 0) return false
  let rest = ''
  let cursor = span.start
  for (const match of covered) {
    rest += text.slice(cursor, Math.max(cursor, match.index))
    cursor = Math.max(cursor, match.index + match[0].length)
  }
  rest += text.slice(Math.min(cursor, span.end), span.end)
  return !/[\p{L}\p{N}]/u.test(rest)
}

/**
 * `text` with the `hidden` spans replaced by their `[LABEL]`, and `spans` moved onto the new text, so that an excerpt
 * of what one question marked does not show what another found to be personal. A hidden span that overlaps one of
 * `spans` stays as it is.
 */
export function maskAround(text, spans, hidden) {
  const cuts = hidden.filter(cut => !spans.some(span => span.start < cut.end && span.end > cut.start)).sort((a, b) => a.start - b.start)
  let out = ''
  let cursor = 0
  const moves = []
  for (const cut of cuts) {
    if (cut.start < cursor) continue
    out += text.slice(cursor, cut.start) + maskLabel(cut)
    cursor = cut.end
    moves.push({ at: cut.end, by: out.length - cut.end })
  }
  out += text.slice(cursor)
  const moved = index => index + (moves.findLast(move => move.at <= index)?.by ?? 0)
  return { text: out, spans: spans.map(span => ({ ...span, start: moved(span.start), end: moved(span.end) })) }
}

/**
 * Up to `max` short excerpts of `text` around the spans, for Chat: plain parts and marked parts. With `hide`, a marked
 * part carries only its label, so personal data never leaves the text it was found in. With `rank`, the excerpts with
 * the most probable spans come first, still marking every span they show.
 * @returns {Array<Array<{text?: string, mark?: {label: string, probability: number, text?: string}}>>}
 */
export function excerpts(text, spans, { around = 48, max = 3, hide = false, clip = 160, rank = false } = {}) {
  const groups = []
  for (const span of spans) {
    let from = Math.max(0, span.start - around)
    let to = Math.min(text.length, span.end + around)
    // an excerpt starts and ends between words when there is a space to cut at
    if (from > 0 && /\S/.test(text[from - 1])) {
      const space = text.slice(from, span.start).search(/\s/)
      if (space >= 0) from += space + 1
    }
    if (to < text.length && /\S/.test(text[to])) {
      const tail = text.slice(span.end, to)
      const space = Math.max(tail.lastIndexOf(' '), tail.lastIndexOf('\n'), tail.lastIndexOf('\t'))
      if (space >= 0) to = span.end + space
    }
    const last = groups.at(-1)
    if (last && from <= last.to) {
      last.to = Math.max(last.to, to)
      last.spans.push(span)
    } else {
      groups.push({ from, to, spans: [span] })
    }
  }
  const flat = value => value.replace(/\s+/g, ' ')
  const best = group => Math.max(...group.spans.map(span => span.probability))
  return (rank ? [...groups].sort((x, y) => best(y) - best(x)) : groups).slice(0, max).map(group => {
    const parts = []
    let cursor = group.from
    if (group.from > 0) parts.push({ text: '…' })
    for (const span of group.spans) {
      if (span.start > cursor) parts.push({ text: flat(text.slice(cursor, span.start)) })
      const shown = flat(span.text)
      parts.push({ mark: { label: span.label, probability: Math.round(span.probability * 1000) / 1000, ...(hide ? {} : { text: shown.length > clip ? `${shown.slice(0, clip - 1)}…` : shown }) } })
      cursor = span.end
    }
    if (group.to > cursor) parts.push({ text: flat(text.slice(cursor, group.to)) })
    if (group.to < text.length) parts.push({ text: '…' })
    return parts
  })
}

// merge ranges that touch or overlap, keeping the higher probability
function merged(spans, text) {
  const out = []
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1)
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end)
      last.probability = Math.max(last.probability, span.probability)
      last.text = text.slice(last.start, last.end)
    } else {
      out.push({ ...span, text: text.slice(span.start, span.end) })
    }
  }
  return out
}

/**
 * Each span grown to the whole sentence it sits in: an injection is a sentence of orders, and a span model may mark
 * only its loudest words. A sentence ends after `.`, `!` or `?`, at a blank line, and at a line that holds only a
 * delimiter (`<!--`, `-->`, a code fence).
 */
export function toSentences(text, spans) {
  const stops = [0, text.length]
  for (const match of text.matchAll(/[.!?](?=\s)/g)) stops.push(match.index + 1)
  for (const pattern of [/\n[ \t]*\n/g, /^[ \t]*(?:<!--|-->|```|~~~)[^\n]*$/gm]) {
    for (const match of text.matchAll(pattern)) stops.push(match.index, match.index + match[0].length)
  }
  stops.sort((a, b) => a - b)
  const grown = spans.map(span => {
    let start = stops.filter(stop => stop <= span.start).pop()
    const end = stops.find(stop => stop >= span.end)
    while (start < span.start && /\s/.test(text[start])) start++
    return { ...span, start, end }
  })
  return merged(grown, text)
}

/** Each span grown to the shell command it sits in (between `&&`, `||`, `;`, `|` and line breaks). */
export function toCommands(command, spans) {
  const stops = [0, command.length]
  for (const match of command.matchAll(/&&|\|\||[;|\n]/g)) stops.push(match.index, match.index + match[0].length)
  stops.sort((a, b) => a - b)
  const grown = spans.map(span => {
    let start = stops.filter(stop => stop <= span.start).pop()
    let end = stops.find(stop => stop >= span.end)
    while (start < end && /\s/.test(command[start])) start++
    while (end > start && /\s/.test(command[end - 1])) end--
    return { ...span, start, end }
  })
  return merged(grown, command)
}

/**
 * A text without the line numbers some tools print before each line (`12: `), and the way back: `at(index)` is where a
 * position of the plain text sits in the numbered one. A text whose lines are not numbered comes back as it is.
 */
export function unnumber(text) {
  const lines = text.split('\n')
  const filled = lines.filter(line => line.length > 0)
  if (filled.length === 0 || filled.filter(line => /^\d+: ?/.test(line)).length < filled.length * 0.8) return { text, at: index => index }
  const plainStarts = []
  const numberedStarts = []
  const cut = []
  let plain = 0
  let numbered = 0
  const out = lines.map(line => {
    const bare = line.replace(/^\d+: ?/, '')
    plainStarts.push(plain)
    numberedStarts.push(numbered)
    cut.push(line.length - bare.length)
    plain += bare.length + 1
    numbered += line.length + 1
    return bare
  })
  const at = index => {
    let line = 0
    while (line + 1 < plainStarts.length && plainStarts[line + 1] <= index) line++
    return numberedStarts[line] + cut[line] + (index - plainStarts[line])
  }
  return { text: out.join('\n'), at }
}

/** How many spans of each label, most first. */
export function labelCounts(spans) {
  const counts = {}
  for (const span of spans) counts[span.label || 'PII'] = (counts[span.label || 'PII'] ?? 0) + 1
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]))
}

/**
 * Cut `text` into windows of at most `size` UTF-16 units that end at line breaks where they can, for questions whose
 * target is limited. @returns {Array<{start: number, text: string}>}
 */
export function windows(text, size) {
  const out = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(text.length, start + size)
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end)
      if (nl > start + size / 2) end = nl + 1
    }
    out.push({ start, text: text.slice(start, end) })
    start = end
  }
  return out
}
