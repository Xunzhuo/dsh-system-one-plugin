/**
 * System Two through vLLM Semantic Router. Each agent request on the router's provider route names its agent session
 * (`x-session-id`, and `x-conversation-id` with the same value), so the router keeps the session's turns together:
 * its Router Learning protection holds a session on one model. It also asks for the routing trace (`x-vsr-debug`).
 * The answer's routing headers name the model the router picked, which Chat shows under each turn (web/client.js).
 *
 * DeepSeek Harness 0.2.2 sets request headers through its `llm-pi-ai/request-headers` waterfall, 0.2.1 has no such
 * seam, and neither hands a plugin the answer's headers. So each router request runs in an async context that the
 * `llm/stream` waterfall opens, and a wrapper of the global `fetch` acts only inside one, on its chat completions
 * call: it adds the headers the request lacks and reads the answer's routing headers. Every other fetch passes
 * through untouched.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

const calls = new AsyncLocalStorage()

// a session id as DeepSeek Harness makes them (session-<uuid>); anything else is not sent
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
// a routing header's value as the router writes it: a model, decision or recipe name, or a reasoning token
const ROUTE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,159}$/

/**
 * The headers one router request carries.
 * @param {{ session?: string, trace?: boolean }} call
 * @returns {Record<string, string>}
 */
export function routerHeaders(call) {
  const headers = {}
  if (typeof call?.session === 'string' && SESSION_ID.test(call.session)) {
    headers['x-session-id'] = call.session
    headers['x-conversation-id'] = call.session
  }
  if (call?.trace) headers['x-vsr-debug'] = 'true'
  return headers
}

/**
 * One top-level member of an RFC 8941 dictionary, as `x-vsr-trace` holds them: its value when it is a token, such
 * as `reasoning=on`, without parameters.
 */
export function traceMember(trace, name) {
  if (typeof trace !== 'string') return undefined
  const members = []
  let depth = 0
  let quoted = false
  let start = 0
  for (let at = 0; at < trace.length; at++) {
    const char = trace[at]
    if (quoted) {
      if (char === '\\') at++
      else if (char === '"') quoted = false
    } else if (char === '"') quoted = true
    else if (char === '(') depth++
    else if (char === ')') depth--
    else if (char === ',' && depth === 0) {
      members.push(trace.slice(start, at))
      start = at + 1
    }
  }
  members.push(trace.slice(start))
  for (const member of members) {
    const equals = member.indexOf('=')
    if (equals < 0 || member.slice(0, equals).trim() !== name) continue
    const value = member.slice(equals + 1).split(';')[0].trim()
    return /^[A-Za-z*][A-Za-z0-9_.:/%*+-]*$/.test(value) ? value : undefined
  }
  return undefined
}

/**
 * What the router says it picked, from an answer's headers: the model, and the decision and reasoning when it
 * names them (`x-vsr-selected-reasoning`, else the trace's `reasoning`).
 * @param {Headers} headers
 * @returns {{ model: string, decision?: string, reasoning?: string } | undefined}
 */
export function routeOf(headers) {
  const value = name => {
    const said = headers?.get?.(name)?.trim()
    return said && ROUTE_VALUE.test(said) ? said : undefined
  }
  const model = value('x-vsr-selected-model')
  if (!model) return undefined
  const decision = value('x-vsr-selected-decision')
  const traced = traceMember(headers.get('x-vsr-trace'), 'reasoning')
  const reasoning = value('x-vsr-selected-reasoning') ?? (traced && ROUTE_VALUE.test(traced) ? traced : undefined)
  return { model, ...(decision ? { decision } : {}), ...(reasoning ? { reasoning } : {}) }
}

/**
 * Runs `fn` inside the call's async context: the rest of the `llm/stream` waterfall, at once, so that what it throws
 * reaches DeepSeek Harness as before.
 * @param {object} call - what the fetch wrapper needs: `session`, `trace`, and `seen(route)` for the answer
 */
export const inCall = (call, fn) => calls.run(call, fn)

/**
 * The chunk stream with its every step inside the call's async context, so that the request its adapter makes is
 * known to be this call's.
 * @param {object} call
 * @param {AsyncIterable<unknown>} stream
 */
export async function* withinCall(call, stream) {
  const iterator = calls.run(call, () => stream[Symbol.asyncIterator]())
  let done = false
  try {
    while (true) {
      const result = await calls.run(call, () => iterator.next())
      if (result.done) {
        done = true
        return result.value
      }
      yield result.value
    }
  } finally {
    if (!done && typeof iterator.return === 'function') await calls.run(call, () => iterator.return())
  }
}

/** The call whose async context this is, if any. */
export const currentCall = () => calls.getStore()

const isRequest = value => typeof Request === 'function' && value instanceof Request

function isChat(input, init) {
  const method = String(init?.method ?? (isRequest(input) ? input.method : 'GET')).toUpperCase()
  if (method !== 'POST') return false
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url
  try {
    return /\/chat\/completions\/?$/.test(new URL(url).pathname)
  } catch {
    return false
  }
}

async function routed(original, call, input, init) {
  const headers = new Headers(init?.headers ?? (isRequest(input) ? input.headers : undefined))
  for (const [name, value] of Object.entries(routerHeaders(call))) {
    if (!headers.has(name)) headers.set(name, value)
  }
  const response = await original(input, { ...init, headers })
  if (response?.ok && typeof call.seen === 'function') {
    try {
      const route = routeOf(response.headers)
      if (route) call.seen(route)
    } catch {
      // the answer goes on to DeepSeek Harness whatever its headers say
    }
  }
  return response
}

let holders = 0
let release

function wrapFetch() {
  const original = globalThis.fetch
  if (typeof original !== 'function') return undefined
  const wrapped = function fetch(input, init) {
    const call = calls.getStore()
    if (!call || !isChat(input, init)) return original(input, init)
    return routed(original, call, input, init)
  }
  globalThis.fetch = wrapped
  return () => {
    // a wrapper installed over this one keeps it: it only passes through outside a router call
    if (globalThis.fetch === wrapped) globalThis.fetch = original
  }
}

/**
 * Wraps `fetch` while any plugin instance holds it.
 * @returns {() => void} lets go; the last holder restores `fetch`
 */
export function holdFetch() {
  if (holders++ === 0) release = wrapFetch()
  let held = true
  return () => {
    if (!held) return
    held = false
    if (--holders === 0) {
      release?.()
      release = undefined
    }
  }
}
