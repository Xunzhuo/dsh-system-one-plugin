/**
 * The free System Duo key (app.vllm-sr.ai): one key for both vllm-sr/auto, the LLM (System Two), and the
 * decision models (System One). The site hands it out for a small proof of work, the same one its "Get your API
 * key" button runs in the browser; the key is kept in DeepSeek Harness's credential store.
 */
import { createHash, hash as oneShot } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
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
    headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'dsh-system-one' },
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
export async function requestKey(service, { label = 'dsh-system-one', fetchImpl = globalThis.fetch, signal } = {}) {
  for (let attempt = 0; ; attempt++) {
    const challenge = await postJSON(service.site + service.challenge, {}, { fetchImpl, signal, site: service.site })
    if (typeof challenge?.challenge !== 'string' || typeof challenge?.difficulty !== 'number') {
      throw new KeyError(`unexpected challenge from ${service.site}`, { site: service.site })
    }
    const nonce = await solve(challenge.challenge, challenge.difficulty, { signal })
    try {
      const created = await postJSON(service.site + service.create, { challenge: challenge.challenge, nonce, label, accept_terms: true }, { fetchImpl, signal, site: service.site })
      if (typeof created?.api_key !== 'string') throw new KeyError(`no key in the answer from ${service.site}`, { site: service.site })
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
 * Add NAME=value to a dotenv file unless the name is already there. A new file is created readable by its owner
 * only; an existing file keeps its mode.
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
