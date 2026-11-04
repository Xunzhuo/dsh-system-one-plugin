/**
 * The free System Duo key (app.vllm-sr.ai), which both vllm-sr/auto, the LLM (System Two), and the decision models
 * (System One) take. The site hands it out for a small proof of work, the same one its "Get your API key" button runs
 * in the browser; the key is kept in DeepSeek Harness's credential store.
 */
import { createHash, hash as oneShot } from 'node:crypto'
import { closeSync, fchmodSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { setImmediate as nextTick } from 'node:timers/promises'

export const SERVICES = [
  {
    ref: 'VLLM_SR_API_KEY',
    name: 'System Duo',
    site: 'https://app.vllm-sr.ai',
    challenge: '/api/keys/challenge',
    create: '/api/keys',
    terms: 'https://app.vllm-sr.ai/terms',
    privacy: 'https://app.vllm-sr.ai/privacy',
  },
]

// The most proof of work a key is worth here (24 bits, 16 times the 20 the site asks for now: up to a few minutes),
// and the time one key may take.
export const MAX_DIFFICULTY = 24
const KEY_TIMEOUT_MS = 300000
const KEY_FORMAT = /^sk-vsr-[0-9A-Za-z]{20,}$/

const sha256 = typeof oneShot === 'function' ? data => oneShot('sha256', data, 'buffer') : data => createHash('sha256').update(data).digest()

export class KeyError extends Error {
  constructor(message, { status = 0, code = undefined, retryAfter = undefined, site = undefined } = {}) {
    super(message)
    this.name = 'KeyError'
    this.status = status
    this.code = code
    this.retryAfter = retryAfter
    this.site = site
  }
}

export function leadingZeroBits(digest) {
  let bits = 0
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8
      continue
    }
    return bits + Math.clz32(byte) - 24
  }
  return bits
}

/**
 * Find a decimal nonce such that SHA-256(challenge + ":" + nonce) starts with `difficulty` zero bits. The
 * search yields to the event loop between chunks, so a Web UI served by the same process stays responsive.
 */
export async function solve(challenge, difficulty, { signal, chunk = 20000 } = {}) {
  const prefix = `${challenge}:`
  for (let nonce = 0; ; ) {
    for (const end = nonce + chunk; nonce < end; nonce++) {
      if (leadingZeroBits(sha256(prefix + nonce)) >= difficulty) return String(nonce)
    }
    signal?.throwIfAborted()
    await nextTick()
  }
}

async function postJSON(url, body, { fetchImpl, signal, site }) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'vllm-sr-dsh' },
    body: JSON.stringify(body),
    signal,
  })
  const text = await response.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = undefined
  }
  if (!response.ok) {
    const error = data?.error ?? data ?? {}
    const retryAfter = Number(response.headers.get('retry-after')) || undefined
    throw new KeyError(error.message || `HTTP ${response.status} from ${site}`, { status: response.status, code: error.code, retryAfter, site })
  }
  return data
}

/** One new key from one site. A challenge that expired while it was being solved is fetched once more. */
export async function requestKey(service, { label = '@vllm-sr/dsh', fetchImpl = globalThis.fetch, signal, timeoutMs = KEY_TIMEOUT_MS } = {}) {
  const deadline = AbortSignal.timeout(timeoutMs)
  signal = signal ? AbortSignal.any([signal, deadline]) : deadline
  for (let attempt = 0; ; attempt++) {
    const challenge = await postJSON(service.site + service.challenge, {}, { fetchImpl, signal, site: service.site })
    if (typeof challenge?.challenge !== 'string' || typeof challenge?.difficulty !== 'number') {
      throw new KeyError(`unexpected challenge from ${service.site}`, { site: service.site })
    }
    if (challenge.difficulty > MAX_DIFFICULTY) {
      throw new KeyError(`${service.site} asks for ${challenge.difficulty} bits of proof of work, more than the ${MAX_DIFFICULTY} this plugin spends`, { site: service.site, code: 'difficulty_too_high' })
    }
    const nonce = await solve(challenge.challenge, challenge.difficulty, { signal })
    try {
      const created = await postJSON(service.site + service.create, { challenge: challenge.challenge, nonce, label, accept_terms: true }, { fetchImpl, signal, site: service.site })
      if (typeof created?.api_key !== 'string' || !KEY_FORMAT.test(created.api_key)) throw new KeyError(`no key in the answer from ${service.site}`, { site: service.site })
      return created.api_key
    } catch (error) {
      if (attempt === 0 && error?.code === 'challenge_expired') continue
      throw error
    }
  }
}

/** The NAME=value pairs of a dotenv file; a missing file reads as empty. */
export function readDotenv(path) {
  const values = new Map()
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return values
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!match) continue
    values.set(match[1], match[2].replace(/^(['"])(.*)\1$/, '$2'))
  }
  return values
}

/**
 * Add NAME=value to a dotenv file unless the name is already there. The file, new or not, is left readable by its
 * owner only.
 */
export function appendDotenv(path, name, value) {
  const current = readDotenv(path)
  if (current.has(name)) return false
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {}
  const fd = openSync(path, 'a', 0o600)
  try {
    fchmodSync(fd, 0o600)
    writeSync(fd, `${text && !text.endsWith('\n') ? '\n' : ''}${name}=${value}\n`)
  } finally {
    closeSync(fd)
  }
  return true
}

/**
 * Give every service that has no key yet a free one and store it.
 * @param {object} options
 * @param {(ref: string) => Promise<string | undefined>} options.resolve - the key a reference holds now
 * @param {(ref: string, value: string) => Promise<void>} options.store - keep a new key
 * @returns {Promise<{allocated: object[], failed: {service: object, error: Error}[]}>}
 */
export async function ensureKeys({ resolve, store, services = SERVICES, label, fetchImpl, signal }) {
  const allocated = []
  const failed = []
  await Promise.all(services.map(async service => {
    if (await resolve(service.ref)) return
    try {
      await store(service.ref, await requestKey(service, { label, fetchImpl, signal }))
      allocated.push(service)
    } catch (error) {
      failed.push({ service, error })
    }
  }))
  return { allocated, failed }
}

/**
 * What the session says about the keys a start fetched: the notice the model reads (and Trajectory shows), and the
 * record Chat draws as an inline line.
 * @param {object} outcome - ensureKeys' result
 * @param {object} where
 * @param {string} where.file - the dotenv file the key went to, as the user writes it (~/.dsh/.env)
 * @param {boolean} where.store - whether DeepSeek Harness's credential store holds it too
 * @returns {{text: string, summary: string, record: object} | undefined} nothing when no key was fetched or refused
 */
export function describeKeys({ allocated, failed }, { file, store }) {
  const host = site => new URL(site).host
  const lines = []
  if (allocated.length) {
    const s = allocated[0]
    const saved = store ? `DeepSeek Harness's credential store and ${file}` : file
    const later = store ? '' : ' A headless run reads keys when it starts, so vllm-sr/auto answers from the next run.'
    lines.push(`[System Duo] Free API key created for ${host(s.site)}, saved in ${saved}. Using it accepts the terms (${s.terms}); requests are logged to improve the services and to train models (${s.privacy}).${later}`)
  }
  const refused = failed.map(({ service, error }) => {
    // a DOMException's code is a legacy number (20 for an abort, 23 for a timeout); its name says what happened
    const why = typeof error.code === 'number' ? error.name : error.code ?? error.status ?? 'error'
    const message = String(error.message).slice(0, 160)
    lines.push(`[System Duo] No free API key from ${host(service.site)} (${why}: ${message}). Get one at ${service.site} and save it as ${service.ref}.`)
    return { service, why, message }
  })
  if (lines.length === 0) return undefined
  const s = allocated[0]
  const record = s
    ? { reflex: 'key', verdict: 'created', site: host(s.site), saved: file, store, terms: s.terms, privacy: s.privacy }
    : { reflex: 'key', verdict: 'failed', site: host(refused[0].service.site), url: refused[0].service.site, ref: refused[0].service.ref, error: { code: String(refused[0].why), message: refused[0].message } }
  return {
    text: lines.join('\n'),
    summary: s ? `Free API key created for ${host(s.site)}` : `No free API key from ${host(refused[0].service.site)}`,
    record,
  }
}
