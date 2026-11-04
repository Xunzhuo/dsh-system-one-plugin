/** Redaction: the words span questions marked in each item, replaced by their label, in a copy of the items. */
import { readFile, writeFile } from 'node:fs/promises'
import { maskLabel, replaceSpans } from './spans.js'

export function csvCell(value) {
  const text = value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

// a part of a person's name that names them alone, as "Priya" of "Priya Raman"
const NAME_PART = /^\p{Lu}[\p{L}'’-]{2,}$/u
const WORD = /[\p{L}\p{N}]/u

// A marked string is masked wherever else it occurs in the item, as the model may mark a name only once; so is each
// part of a marked person's name, as a whole word ("Thanks Priya" after "Priya Raman").
export function everywhere(text, spans) {
  const out = [...spans]
  for (const span of spans) {
    const value = text.slice(span.start, span.end)
    const parts = span.label === 'PERSON' ? value.split(/\s+/).filter(part => NAME_PART.test(part) && part !== value.trim()) : []
    for (const [needle, whole] of [[value, false], ...parts.map(part => [part, true])]) {
      if (needle.trim().length < 3) continue
      for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
        if (whole && (WORD.test(text[at - 1] ?? '') || WORD.test(text[at + needle.length] ?? ''))) continue
        out.push({ ...span, start: at, end: at + needle.length })
      }
    }
  }
  return out
}

// overlapping spans become one, under the label of the first
export function joined(spans) {
  const out = []
  for (const span of [...spans].sort((a, b) => a.start - b.start || b.end - a.end)) {
    const last = out.at(-1)
    if (last && span.start < last.end) last.end = Math.max(last.end, span.end)
    else out.push({ ...span })
  }
  return out
}

/**
 * An item with `spans` (UTF-16 ranges of its text) replaced by `[LABEL]`: its text, and its record with each field's
 * part of the spans replaced (items.js `segments`). A field that is not a string is masked in its JSON, which stays
 * that field's value when it no longer parses. The item's id stays, so the copy's rows still match the results.
 * `replaced` counts the places masked: each span, and each other place where its words recur.
 */
export function redactItem(item, spans) {
  const id = item.segments?.find(segment => segment.field !== undefined && segment.field === item.idField)
  const cuts = joined(everywhere(item.text, spans).filter(span => !id || span.end <= id.start || span.start >= id.end))
  const text = replaceSpans(item.text, cuts, maskLabel)
  if (typeof item.record !== 'object' || item.record === null) return { text, record: text, replaced: cuts.length }
  const record = { ...item.record }
  for (const segment of item.segments ?? []) {
    if (segment.field === undefined) continue
    const inside = cuts
      .filter(span => span.start < segment.end && span.end > segment.start)
      .map(span => ({ ...span, start: Math.max(span.start, segment.start) - segment.start, end: Math.min(span.end, segment.end) - segment.start }))
    if (inside.length === 0) continue
    if (!segment.json) {
      record[segment.field] = replaceSpans(record[segment.field], inside, maskLabel)
      continue
    }
    const masked = replaceSpans(JSON.stringify(record[segment.field]), inside, maskLabel)
    try {
      record[segment.field] = JSON.parse(masked)
    } catch {
      record[segment.field] = masked
    }
  }
  return { text, record, replaced: cuts.length }
}

/**
 * The redacted copy of a file of items, in the file's format; `records` holds each item's redacted record. A file of
 * lines keeps its other lines as they were.
 */
export async function writeRedacted({ file, format, output, items, records }) {
  let body
  if (format === 'jsonl') body = `${records.map(record => JSON.stringify(record)).join('\n')}\n`
  else if (format === 'json') {
    const keyed = items.length > 0 && items.every(item => item.key !== undefined)
    body = `${JSON.stringify(keyed ? Object.fromEntries(items.map((item, index) => [item.key, records[index]])) : records, null, 2)}\n`
  } else if (format === 'csv') {
    const columns = [...new Set(records.flatMap(record => Object.keys(record)))]
    body = `${[columns.map(csvCell).join(','), ...records.map(record => columns.map(column => csvCell(record[column])).join(','))].join('\n')}\n`
  } else if (file) {
    const lines = (await readFile(file, 'utf8')).split('\n')
    items.forEach((item, index) => {
      if (item.line !== undefined) lines[item.line] = lines[item.line].replace(item.record, () => records[index])
    })
    body = lines.join('\n')
  } else {
    body = `${records.join('\n')}\n`
  }
  await writeFile(output, body)
}
