/** The paths a System One tool call names, checked before anything is asked, so System Two can correct one at once. */
import { readdir, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path'

const SHOWN = 12

/** What is at a path: 'file', 'directory', or undefined when nothing is. */
export async function kindAt(path) {
  try {
    const info = await stat(path)
    return info.isDirectory() ? 'directory' : 'file'
  } catch {
    return undefined
  }
}

/**
 * Why a path a call names is no file to read, and what the nearest folder that exists does hold: the files with the
 * same extension first, as "metrics/charts/ holds active-users.png, api-error-rate.png, … (16)".
 */
export async function noFile(cwd, path, what) {
  const full = resolve(cwd, path)
  if ((await kindAt(full)) === 'directory') return `${what} ${path} is a folder, not a file${await holding(cwd, full, extname(full))}`
  let folder = dirname(full)
  while ((await kindAt(folder)) !== 'directory' && dirname(folder) !== folder) folder = dirname(folder)
  return `${what} ${path} does not exist${await holding(cwd, folder, extname(full))}`
}

async function holding(cwd, folder, ext) {
  // only the working directory's own folders are listed
  const inside = relative(cwd, folder)
  if (inside.startsWith('..') || isAbsolute(inside)) return ''
  let entries
  try {
    entries = await readdir(folder, { withFileTypes: true })
  } catch {
    return ''
  }
  const names = entries.filter(entry => !entry.name.startsWith('.')).map(entry => `${entry.name}${entry.isDirectory() ? '/' : ''}`).sort()
  const alike = ext ? names.filter(name => extname(name).toLowerCase() === ext.toLowerCase()) : []
  const listed = alike.length ? alike : names
  const where = inside ? `${inside}/` : 'the working directory'
  if (listed.length === 0) return `; ${where} is empty`
  return `; ${where} holds ${listed.slice(0, SHOWN).join(', ')}${listed.length > SHOWN ? `, … (${listed.length})` : ''}`
}

/** Throws noFile's reason unless the path is a file. */
export async function mustBeFile(cwd, path, what) {
  if ((await kindAt(resolve(cwd, path))) !== 'file') throw new Error(await noFile(cwd, path, what))
}
