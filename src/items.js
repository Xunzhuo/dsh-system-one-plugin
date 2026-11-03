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

function recordText(record, textField) {
  if (typeof record === 'string') return record
  if (textField) {
    const value = record[textField]
    if (value === undefined) throw new Error(`text_field "${textField}" is not a field of the items`)
    return typeof value === 'string' ? value : JSON.stringify(value)
  }
  return Object.entries(record).map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`).join('\n')
}

function recordId(record, idField, index) {
  if (typeof record !== 'string') {
    if (idField && record[idField] !== undefined) return String(record[idField])
    if (record.id !== undefined) return String(record.id)
  }
  return String(index + 1)
}

/**
 * @returns {Promise<Array<{id: string, text: string, images?: string[], source?: string}>>}
 */
export async function loadItems({ file, items, images, textField, idField, maxItems, maxChars }) {
  const out = []
  if (images?.length) {
    for (const [index, path] of images.entries()) {
      const type = IMAGE_TYPES[extname(path).toLowerCase()]
      if (!type) throw new Error(`unsupported image type: ${path} (use PNG, JPEG or WebP)`)
      const data = await readFile(path)
      out.push({ id: path.split('/').pop() ?? String(index + 1), text: '', images: [`data:${type};base64,${data.toString('base64')}`], source: relative(process.cwd(), path) || path })
    }
  }
  if (file) {
    const raw = await readFile(file, 'utf8')
    const ext = extname(file).toLowerCase()
    let records
    if (ext === '.jsonl' || ext === '.ndjson') {
      records = raw.split('\n').filter(line => line.trim()).map((line, index) => {
        try {
          return JSON.parse(line)
        } catch {
          throw new Error(`${file}:${index + 1} is not valid JSON`)
        }
      })
    } else if (ext === '.json') {
      const parsed = JSON.parse(raw)
      records = Array.isArray(parsed) ? parsed : Object.values(parsed)
    } else if (ext === '.csv') {
      records = parseCsv(raw)
    } else {
      records = raw.split('\n').map(line => line.trim()).filter(Boolean)
    }
    records.forEach((record, index) => {
      out.push({ id: recordId(record, idField, index), text: recordText(record, textField) })
    })
  }
  for (const [index, text] of (items ?? []).entries()) out.push({ id: String(index + 1), text })
  if (out.length === 0) throw new Error('nothing to judge: pass file, items, or images')
  if (out.length > maxItems) throw new Error(`${out.length} items is more than the limit of ${maxItems}`)
  for (const item of out) {
    if (item.text.length > maxChars) item.text = `${item.text.slice(0, maxChars)}…`
  }
  return out
}
