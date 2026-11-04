/** Read the items a `system_one` call judges: records from a file, inline texts, or images. */
import { readFile } from 'node:fs/promises'
import { extname, relative } from 'node:path'

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

/** Minimal RFC 4180 CSV parser: quoted fields, escaped quotes, newlines inside quotes. */
export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') {
        quoted = false
      } else {
        field += c
      }
    } else if (c === '"') {
      quoted = true
    } else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      field = ''
      if (row.some(cell => cell !== '')) rows.push(row)
      row = []
    } else {
      field += c
    }
  }
  row.push(field)
  if (row.some(cell => cell !== '')) rows.push(row)
  if (rows.length === 0) return []
  const [header, ...body] = rows
  return body.map(cells => Object.fromEntries(header.map((name, index) => [name.trim(), cells[index] ?? ''])))
}

/**
 * What System One reads of a record, and where each field sits in it (`segments`, UTF-16 ranges; `json` for a field
 * that is not a string and reads as its JSON), so that the words a span question marks can be traced back to their field.
 */
function recordText(record, textField) {
  if (typeof record === 'string') return { text: record, segments: [{ start: 0, end: record.length }] }
  const shown = value => (typeof value === 'string' ? { value } : { value: JSON.stringify(value) ?? '', json: true })
  if (textField) {
    if (record[textField] === undefined) throw new Error(`text_field "${textField}" is not a field of the items; they have ${Object.keys(record).map(key => `"${key}"`).join(', ')}`)
    const { value, json } = shown(record[textField])
    return { text: value, segments: [{ field: textField, start: 0, end: value.length, ...(json ? { json } : {}) }] }
  }
  let text = ''
  const segments = []
  for (const [key, field] of Object.entries(record)) {
    if (text) text += '\n'
    text += `${key}: `
    const { value, json } = shown(field)
    segments.push({ field: key, start: text.length, end: text.length + value.length, ...(json ? { json } : {}) })
    text += value
  }
  return { text, segments }
}

// an item's id, and the field it came from
function recordId(record, idField, index) {
  if (typeof record !== 'string') {
    if (idField && record[idField] !== undefined) return { id: String(record[idField]), idField }
    if (record.id !== undefined) return { id: String(record.id), idField: 'id' }
  }
  return { id: String(index + 1) }
}

/** The format of a file of items, from its extension. */
export function formatOf(file) {
  const ext = extname(file).toLowerCase()
  return ext === '.jsonl' || ext === '.ndjson' ? 'jsonl' : ext === '.json' ? 'json' : ext === '.csv' ? 'csv' : 'lines'
}

/**
 * @param {object} options - `cwd` is the directory image sources are shown relative to
 * @returns {Promise<Array<{id: string, idField?: string, text: string, images?: string[], source?: string, path?: string, record?: object | string,
 *   segments?: Array<{field?: string, start: number, end: number, json?: boolean}>, key?: string, line?: number, cut?: boolean}>>}
 *   `record` is what the item was read from, `idField` the field its id came from, `key` its key in a JSON object,
 *   `line` its line in a file of lines, and `cut` says that its text was longer than `maxChars`
 */
export async function loadItems({ file, items, images, textField, idField, maxItems, maxChars, cwd = process.cwd() }) {
  const out = []
  if (images?.length) {
    for (const [index, path] of images.entries()) {
      const type = IMAGE_TYPES[extname(path).toLowerCase()]
      if (!type) throw new Error(`unsupported image type: ${path} (use PNG, JPEG or WebP)`)
      const data = await readFile(path)
      out.push({ id: path.split('/').pop() ?? String(index + 1), text: '', images: [`data:${type};base64,${data.toString('base64')}`], source: relative(cwd, path) || path, path })
    }
  }
  if (file) {
    const raw = await readFile(file, 'utf8')
    const format = formatOf(file)
    let records
    let keys
    let lines
    if (format === 'jsonl') {
      records = raw.split('\n').filter(line => line.trim()).map((line, index) => {
        try {
          return JSON.parse(line)
        } catch {
          throw new Error(`${file}:${index + 1} is not valid JSON`)
        }
      })
    } else if (format === 'json') {
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) keys = Object.keys(parsed)
      records = Array.isArray(parsed) ? parsed : Object.values(parsed)
    } else if (format === 'csv') {
      records = parseCsv(raw)
    } else {
      lines = []
      records = []
      raw.split('\n').forEach((line, at) => {
        if (!line.trim()) return
        lines.push(at)
        records.push(line.trim())
      })
    }
    records.forEach((record, index) => {
      const { text, segments } = recordText(record, textField)
      out.push({ ...recordId(record, idField, index), text, record, segments, ...(keys ? { key: keys[index] } : {}), ...(lines ? { line: lines[index] } : {}) })
    })
  }
  for (const [index, text] of (items ?? []).entries()) out.push({ id: String(index + 1), text, record: text, segments: [{ start: 0, end: text.length }] })
  if (out.length === 0) throw new Error('nothing to judge: pass file, items, or images')
  if (out.length > maxItems) throw new Error(`${out.length} items is more than the limit of ${maxItems}`)
  for (const item of out) {
    if (item.text.length > maxChars) {
      item.text = `${item.text.slice(0, maxChars)}…`
      item.cut = true
    }
  }
  return out
}
