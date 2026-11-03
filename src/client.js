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
      await new Promise(resolve => waiting.push(resolve))
      signal?.throwIfAborted()
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
      try {
        code = JSON.parse(response.text).error?.code
      } catch {
        code = undefined
      }
      const retryable = response.status === 429 || response.status === 502 || response.status === 503
      if (retryable && attempt < maxRetries) {
        const after = Number(response.headers['retry-after'])
        const wait = Number.isFinite(after) && after > 0 ? Math.min(after, 10) * 1000 : 400 * 2 ** attempt
        await sleep(wait + Math.random() * 200)
        continue
      }
      throw new DecisionError(`Decision API ${response.status}${code ? ` ${code}` : ''}`, response.status, code)
    }
  }

  /**
   * Ask questions about one input, or about several inputs at once.
   * @param {object} request
   * @param {string} request.model
   * @param {object} request.questions - shared by every input
   * @param {Array<{state: string, images?: string[]}>} request.inputs - at most {@link ITEMS_PER_REQUEST}
   * @param {AbortSignal} [request.signal]
   * @param {number} [request.timeoutMs] - per-call deadline (default: the client's)
   * @param {number} [request.retries] - per-call retries (default: the client's)
   * @returns {Promise<{answers: object[], ms: number, model: string, inputTokens: number, requestId?: string}>}
   *   answers in input order
   */
  async function ask({ model, questions, inputs, signal, timeoutMs: callTimeoutMs, retries: callRetries }) {
    if (inputs.length === 0 || inputs.length > ITEMS_PER_REQUEST) {
      throw new RangeError(`one request answers 1 to ${ITEMS_PER_REQUEST} inputs, got ${inputs.length}`)
    }
    const [first, ...rest] = inputs
    const body = { model, state: first.state, questions }
    if (first.images?.length) body.images = first.images
    if (rest.length > 0) {
      body.states = Object.fromEntries(rest.map((input, index) => [
        `i${index + 1}`,
        { state: input.state, questions, ...input.images?.length ? { images: input.images } : {} },
      ]))
    }
    await acquire(signal)
    const started = performance.now()
    try {
      const { json, requestId } = await post('/v1/decisions', body, signal, { timeoutMs: callTimeoutMs, retries: callRetries })
      const answers = [json.answers, ...rest.map((_, index) => json.states?.[`i${index + 1}`]?.answers ?? {})]
      let inputTokens = json.usage?.input_tokens ?? 0
      for (const entry of Object.values(json.states ?? {})) inputTokens += entry.usage?.input_tokens ?? 0
      return { answers, ms: performance.now() - started, model: json.model ?? model, inputTokens, requestId }
    } finally {
      release()
    }
  }

  /** Open the connection ahead of the first decision; failures are ignored. */
  function warm() {
    send('/api/info', 'GET', undefined, {}, AbortSignal.timeout(timeoutMs)).catch(() => {})
  }

  return { ask, warm, hasKey: async () => Boolean(await apiKey()), close: () => agent.destroy() }
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
      return { box: answer.box, confidence: round(answer.confidence) }
    default:
      return answer
  }
}
