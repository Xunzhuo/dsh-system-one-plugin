/**
 * Decision API client. A decision model answers typed questions (choice, noul,
 * score, box) about an input with calibrated probabilities, from one forward
 * pass per question. Connections are reused: a fresh TLS handshake costs more
 * than the decision itself.
 */
import { readFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { homedir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'

/** Inputs answered by one request: the top-level state plus `limits.max_states` more. */
export const ITEMS_PER_REQUEST = 9

/**
 * The input tokens a request may estimate, with room to spare: the Decision API counts every question as reading its
 * state again, about one token per UTF-8 byte, and refuses a request over the model's `max_request_tokens` (131,072
 * for the published models) with 400 request_too_long.
 */
export const REQUEST_TOKENS = 112000

/** What one question over `state` adds to a request's estimate. */
export const stateCost = state => Buffer.byteLength(typeof state === 'string' ? state : JSON.stringify(state ?? '')) + 160

/**
 * Consecutive slices of `states`, at most {@link ITEMS_PER_REQUEST} each, whose `questions` questions per state stay
 * within {@link REQUEST_TOKENS}.
 * @returns {Array<{start: number, count: number}>}
 */
export function requestSlices(states, questions) {
  const slices = []
  let start = 0
  while (start < states.length) {
    let count = 0
    let cost = 0
    while (start + count < states.length && count < ITEMS_PER_REQUEST) {
      const next = stateCost(states[start + count]) * Math.max(1, questions)
      if (count > 0 && cost + next > REQUEST_TOKENS) break
      cost += next
      count++
    }
    slices.push({ start, count })
    start += count
  }
  return slices
}

export class DecisionError extends Error {
  constructor(message, status = 0, code = undefined) {
    super(message)
    this.name = 'DecisionError'
    this.status = status
    this.code = code
  }
}

function expandHome(path) {
  return path?.startsWith('~/') ? homedir() + path.slice(1) : path
}

/**
 * @param {object} options
 * @param {string} options.baseURL
 * @param {string} options.apiKeyEnv - environment variable holding the key
 * @param {string} [options.apiKeyFile] - mode-600 file holding the key, read when the variable is unset
 * @param {() => Promise<string | undefined>} [options.resolveKey] - the key from DeepSeek Harness's credential store, asked first
 * @param {number} [options.maxConcurrency]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.retries]
 */
export function createDecisionClient(options) {
  const baseURL = options.baseURL.replace(/\/+$/, '')
  const maxConcurrency = options.maxConcurrency ?? 12
  const timeoutMs = options.timeoutMs ?? 30000
  const retries = options.retries ?? 3
  const endpoint = new URL(baseURL)
  const transport = endpoint.protocol === 'http:' ? http : https
  // Agent steps are seconds apart; fetch's default pool would close the
  // socket in between and pay a new TLS handshake on every decision.
  const agent = new transport.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: maxConcurrency, scheduling: 'lifo' })
  let active = 0
  const waiting = []

  function send(path, method, payload, headers, signal) {
    return new Promise((resolve, reject) => {
      const request = transport.request(new URL(baseURL + path), { method, agent, headers, signal }, response => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }))
        response.on('error', reject)
      })
      request.on('error', reject)
      request.end(payload)
    })
  }

  async function apiKey() {
    const stored = await options.resolveKey?.()
    if (stored) return stored.trim()
    const fromEnv = process.env[options.apiKeyEnv]
    if (fromEnv) return fromEnv.trim()
    if (options.apiKeyFile) {
      try {
        return readFileSync(expandHome(options.apiKeyFile), 'utf8').trim()
      } catch {
        return undefined
      }
    }
    return undefined
  }

  async function acquire(signal) {
    while (active >= maxConcurrency) {
      signal?.throwIfAborted()
      // A cancelled caller leaves the queue at once: a wakeup it took without taking the slot would be lost for good.
      await new Promise((resolve, reject) => {
        const wake = () => {
          signal?.removeEventListener('abort', cancel)
          resolve()
        }
        const cancel = () => {
          const at = waiting.indexOf(wake)
          if (at >= 0) waiting.splice(at, 1)
          reject(signal.reason)
        }
        waiting.push(wake)
        signal?.addEventListener('abort', cancel, { once: true })
      })
    }
    active++
  }

  function release() {
    active--
    waiting.shift()?.()
  }

  async function post(path, body, signal, limits = {}) {
    const deadlineMs = limits.timeoutMs ?? timeoutMs
    const maxRetries = limits.retries ?? retries
    const maxWaitMs = limits.waitMs ?? 10000
    const key = await apiKey()
    if (!key) throw new DecisionError(`no System One key: set ${options.apiKeyEnv}, or get a free System Duo key at https://app.vllm-sr.ai`, 401, 'missing_api_key')
    const payload = JSON.stringify(body)
    const headers = {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    }
    for (let attempt = 0; ; attempt++) {
      const deadline = AbortSignal.timeout(deadlineMs)
      let response
      try {
        response = await send(path, 'POST', payload, headers, signal ? AbortSignal.any([signal, deadline]) : deadline)
      } catch (error) {
        if (signal?.aborted) throw error
        if (attempt < maxRetries) {
          await sleep(300 * 2 ** attempt)
          continue
        }
        throw new DecisionError(`Decision API unreachable: ${error.message}`, 0, 'network')
      }
      if (response.status >= 200 && response.status < 300) {
        return { json: JSON.parse(response.text), requestId: response.headers['x-request-id'] }
      }
      let code
      let said
      try {
        const error = JSON.parse(response.text).error
        code = error?.code
        said = typeof error?.message === 'string' ? error.message.replace(/\s+/g, ' ').trim().slice(0, 240) : undefined
      } catch {
        code = undefined
      }
      // a daily quota is spent until 00:00 UTC; a per-minute budget, concurrency or capacity comes back soon
      const retryable = (response.status === 429 && code !== 'quota_exceeded') || response.status === 502 || response.status === 503
      if (retryable && attempt < maxRetries) {
        const after = Number(response.headers['retry-after'])
        const wait = Number.isFinite(after) && after > 0 ? Math.min(after * 1000, maxWaitMs) : 400 * 2 ** attempt
        await sleep(wait + Math.random() * 200, undefined, signal ? { signal } : undefined)
        continue
      }
      // a refused request says why, so that a call System Two wrote can be corrected
      const why = said && response.status >= 400 && response.status < 500 && response.status !== 401 && response.status !== 429 ? `: ${said}` : ''
      throw new DecisionError(`Decision API ${response.status}${code ? ` ${code}` : ''}${why}`, response.status, code)
    }
  }

  /**
   * Ask questions about one input, or about several inputs at once.
   * @param {object} request
   * @param {string} request.model
   * @param {object} request.questions - shared by every input that brings no questions of its own
   * @param {Array<{state: string | object, images?: string[], questions?: object}>} request.inputs - at most {@link ITEMS_PER_REQUEST}
   * @param {AbortSignal} [request.signal]
   * @param {number} [request.timeoutMs] - per-call deadline (default: the client's)
   * @param {number} [request.retries] - per-call retries (default: the client's)
   * @param {number} [request.waitMs] - the longest wait before a retry after a 429, 502 or 503: the gateway's
   *   Retry-After, up to this (default 10 s)
   * @returns {Promise<{answers: object[], spans: object[], thresholds: object[], ms: number, model: string, inputTokens: number, requestId?: string}>}
   *   answers, span answers and the thresholds applied, in input order
   */
  async function ask({ model, questions, inputs, signal, timeoutMs: callTimeoutMs, retries: callRetries, waitMs }) {
    if (inputs.length === 0 || inputs.length > ITEMS_PER_REQUEST) {
      throw new RangeError(`one request answers 1 to ${ITEMS_PER_REQUEST} inputs, got ${inputs.length}`)
    }
    const [first, ...rest] = inputs
    const body = { model, state: first.state, questions: first.questions ?? questions }
    if (first.images?.length) body.images = first.images
    if (rest.length > 0) {
      body.states = Object.fromEntries(rest.map((input, index) => [
        `i${index + 1}`,
        { state: input.state, questions: input.questions ?? questions, ...input.images?.length ? { images: input.images } : {} },
      ]))
    }
    await acquire(signal)
    const started = performance.now()
    try {
      const { json, requestId } = await post('/v1/decisions', body, signal, { timeoutMs: callTimeoutMs, retries: callRetries, waitMs })
      const each = field => [json[field] ?? {}, ...rest.map((_, index) => json.states?.[`i${index + 1}`]?.[field] ?? {})]
      let inputTokens = json.usage?.input_tokens ?? 0
      for (const entry of Object.values(json.states ?? {})) inputTokens += entry.usage?.input_tokens ?? 0
      return { answers: each('answers'), spans: each('spans'), thresholds: each('thresholds'), ms: performance.now() - started, model: json.model ?? model, inputTokens, requestId }
    } finally {
      release()
    }
  }

  /** Open the connection ahead of the first decision; failures are ignored. */
  function warm() {
    send('/api/info', 'GET', undefined, {}, AbortSignal.timeout(timeoutMs)).catch(() => {})
  }

  /** The published models' cards (no key needed): `[{id, question_types, presets}]`. */
  async function models(signal) {
    const response = await send('/v1/systemone/models', 'GET', undefined, { accept: 'application/json' }, signal ?? AbortSignal.timeout(timeoutMs))
    if (response.status !== 200) throw new DecisionError(`Decision API ${response.status} listing models`, response.status)
    const cards = JSON.parse(response.text)?.data
    return Array.isArray(cards) ? cards : []
  }

  return { ask, warm, models, hasKey: async () => Boolean(await apiKey()), close: () => agent.destroy() }
}

/**
 * Whether an error says System One could not answer at all (unreachable, overloaded, out of quota, no or a refused
 * key) rather than that a call asked for something it cannot answer.
 */
export function unavailable(error) {
  if (!(error instanceof DecisionError)) return false
  return error.status === 0 || error.status === 401 || error.status === 403 || error.status === 429 || error.status >= 500
}

/** What System Two reads when a tool call found System One unavailable after its retries: why, and to go on. */
export function unavailableText(error) {
  const why = error.status === 429 && error.code === 'quota_exceeded' ? 'the key\'s daily quota is spent until 00:00 UTC'
    : error.status === 429 ? 'it is busy'
      : error.status === 401 ? 'it has no valid key'
        : error.status === 403 ? 'the key may not use this model'
          : 'it could not be reached'
  return `System One is unavailable: ${why} (${error.message}). Go on without it: do this step another way, or tell the user.`
}

/** Probability that a noul answer is yes, or undefined when the question failed. */
export function yes(answer) {
  return typeof answer?.noul === 'number' ? answer.noul : undefined
}

/** Compact, readable copy of one answer for traces and model-facing text. */
export function compactAnswer(answer) {
  if (!answer || answer.error) return { error: answer?.error ?? 'missing', reason: answer?.reason }
  const round = value => Math.round(value * 1000) / 1000
  switch (answer.type) {
    case 'choice':
      return {
        choice: answer.choice,
        confidence: round(answer.confidence),
        p: Object.fromEntries(Object.entries(answer.probabilities ?? {}).map(([k, v]) => [k, round(v)])),
      }
    case 'noul':
      return { yes: round(answer.noul) }
    case 'score':
      return {
        score: round(answer.score),
        confidence: round(answer.confidence),
        p: Object.fromEntries(Object.entries(answer.probabilities ?? {}).map(([k, v]) => [answer.legend?.[k] ?? k, round(v)])),
      }
    case 'box':
      return { box: Object.fromEntries(Object.entries(answer.box ?? {}).map(([k, v]) => [k, Math.round(v * 10000) / 10000])), confidence: round(answer.confidence) }
    default:
      return answer
  }
}
