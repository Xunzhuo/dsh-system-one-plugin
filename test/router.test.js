import assert from 'node:assert/strict'
import { test } from 'node:test'
import { holdFetch, inCall, routeOf, routerHeaders, traceMember, withinCall } from '../src/router.js'

const SESSION = 'session-473a4bd6-0f0f-4272-acb2-9dee8e9da4a2'
const CHAT = 'http://relay:9090/v1/chat/completions'

test('a router request names its session twice, and asks for the trace only when told', () => {
  assert.deepEqual(routerHeaders({ session: SESSION, trace: true }), { 'x-session-id': SESSION, 'x-conversation-id': SESSION, 'x-vsr-debug': 'true' })
  assert.deepEqual(routerHeaders({ session: SESSION }), { 'x-session-id': SESSION, 'x-conversation-id': SESSION })
  assert.deepEqual(routerHeaders({ trace: true }), { 'x-vsr-debug': 'true' })
  for (const session of ['', 'a b', 'x'.repeat(201), 'session\nx-evil: 1', undefined, 42]) assert.deepEqual(routerHeaders({ session }), {}, String(session))
})

test('the trace\'s members are read at its top level only', () => {
  const trace = 'confidence=0.91, algorithm=static, signals=("conversation:tool_loop" "keywords:reasoning=off, x"), reasoning=on;why="a, b", session_phase=tool_loop'
  assert.equal(traceMember(trace, 'reasoning'), 'on')
  assert.equal(traceMember(trace, 'session_phase'), 'tool_loop')
  assert.equal(traceMember(trace, 'algorithm'), 'static')
  assert.equal(traceMember(trace, 'signals'), undefined, 'an inner list is not a token')
  assert.equal(traceMember('signals=("reasoning=on")', 'reasoning'), undefined)
  assert.equal(traceMember('reasoning', 'reasoning'), undefined)
  assert.equal(traceMember(undefined, 'reasoning'), undefined)
})

test('the route is read from the answer\'s headers: the model, then the decision and reasoning it names', () => {
  const headers = values => new Headers(values)
  assert.deepEqual(routeOf(headers({ 'x-vsr-selected-model': 'deepseek/deepseek-v4.1-flash', 'x-vsr-selected-decision': 'agentic', 'x-vsr-trace': 'algorithm=static, reasoning=on' })),
    { model: 'deepseek/deepseek-v4.1-flash', decision: 'agentic', reasoning: 'on' })
  assert.deepEqual(routeOf(headers({ 'x-vsr-selected-model': 'qwen/qwen3.8-27b', 'x-vsr-selected-reasoning': 'high', 'x-vsr-trace': 'reasoning=off' })),
    { model: 'qwen/qwen3.8-27b', reasoning: 'high' }, 'a named effort wins over the trace')
  assert.deepEqual(routeOf(headers({ 'x-vsr-selected-model': 'zai/glm-5.3-flash' })), { model: 'zai/glm-5.3-flash' })
  assert.equal(routeOf(headers({ 'x-vsr-selected-decision': 'agentic' })), undefined, 'no model, no route')
  assert.deepEqual(routeOf(headers({ 'x-vsr-selected-model': 'zai/glm-5.3-flash', 'x-vsr-selected-decision': '<b>x</b>' })), { model: 'zai/glm-5.3-flash' })
  assert.equal(routeOf(headers({ 'x-vsr-selected-model': 'a'.repeat(161) })), undefined)
})

// A stand-in for the global fetch: it keeps each request's headers and answers with the router's headers.
function fakeFetch(answer = { 'x-vsr-selected-model': 'deepseek/deepseek-v4.1-flash', 'x-vsr-selected-decision': 'agentic', 'x-vsr-trace': 'reasoning=on' }) {
  const seen = []
  const fetch = async (input, init) => {
    seen.push({ url: String(input?.url ?? input), method: init?.method ?? input?.method ?? 'GET', headers: Object.fromEntries(new Headers(init?.headers ?? input?.headers)) })
    return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream', ...answer } })
  }
  return { fetch, seen }
}

// A chunk stream as DeepSeek Harness's LLM service hands it on: generators over generators, and the model request
// started from a detached task as pi-ai starts it.
async function* adapterStream(url = CHAT, init = { method: 'POST', headers: { authorization: 'Bearer sk-vsr-test', 'content-type': 'application/json' }, body: '{}' }) {
  await Promise.resolve()
  const started = (async () => {
    await new Promise(resolve => setTimeout(resolve, 1))
    const response = await globalThis.fetch(url, init)
    return response.status
  })()
  yield { type: 'start' }
  yield { type: 'finish', status: await started }
}
async function* llmStream(inner) {
  for await (const chunk of inner) yield chunk
}

test('fetch is wrapped while held: inside a router call its chat request gets the headers, outside nothing changes', async t => {
  const before = globalThis.fetch
  const fake = fakeFetch()
  globalThis.fetch = fake.fetch
  t.after(() => {
    globalThis.fetch = before
  })
  const release = holdFetch()
  const again = holdFetch()
  assert.notEqual(globalThis.fetch, fake.fetch)

  const routes = []
  const call = { session: SESSION, trace: true, seen: route => routes.push(route) }
  const chunks = []
  for await (const chunk of withinCall(call, inCall(call, () => llmStream(adapterStream())))) chunks.push(chunk)
  assert.deepEqual(chunks, [{ type: 'start' }, { type: 'finish', status: 200 }])
  assert.deepEqual(fake.seen[0].headers, { authorization: 'Bearer sk-vsr-test', 'content-type': 'application/json', 'x-session-id': SESSION, 'x-conversation-id': SESSION, 'x-vsr-debug': 'true' })
  assert.deepEqual(routes, [{ model: 'deepseek/deepseek-v4.1-flash', decision: 'agentic', reasoning: 'on' }])

  // a header the request already has stays as it is
  for await (const chunk of withinCall(call, llmStream(adapterStream(CHAT, { method: 'POST', headers: new Headers({ 'x-session-id': 'set-by-dsh' }), body: '{}' })))) chunks.push(chunk)
  assert.equal(fake.seen[1].headers['x-session-id'], 'set-by-dsh')
  assert.equal(fake.seen[1].headers['x-conversation-id'], SESSION)

  // outside a router call, and inside one for anything but its chat request, fetch passes through untouched
  await globalThis.fetch(CHAT, { method: 'POST', headers: { a: '1' } })
  for await (const chunk of withinCall(call, llmStream(adapterStream('http://relay:9090/v1/models', { method: 'GET' })))) chunks.push(chunk)
  for await (const chunk of withinCall(call, llmStream(adapterStream('http://relay:9090/v1/systemone', { method: 'POST' })))) chunks.push(chunk)
  assert.deepEqual(fake.seen.slice(2).map(entry => Object.keys(entry.headers).filter(name => name.startsWith('x-'))), [[], [], []])
  assert.equal(routes.length, 2)

  // a request as a Request object
  await inCall(call, () => globalThis.fetch(new Request(CHAT, { method: 'POST', headers: { b: '2' }, body: '{}' })))
  assert.deepEqual([fake.seen.at(-1).headers.b, fake.seen.at(-1).headers['x-session-id']], ['2', SESSION])

  release()
  release()
  assert.notEqual(globalThis.fetch, fake.fetch, 'another holder keeps it')
  again()
  assert.equal(globalThis.fetch, fake.fetch, 'the last holder restores it')
})

test('an answer that is not a success records no route, and its stream ends as it would have', async t => {
  const before = globalThis.fetch
  globalThis.fetch = async () => new Response('{"error":{}}', { status: 429, headers: { 'x-vsr-selected-model': 'deepseek/deepseek-v4.1-flash' } })
  const release = holdFetch()
  t.after(() => {
    release()
    globalThis.fetch = before
  })
  const routes = []
  const call = { session: SESSION, seen: route => routes.push(route) }
  const chunks = []
  for await (const chunk of withinCall(call, llmStream(adapterStream()))) chunks.push(chunk)
  assert.deepEqual(chunks.at(-1), { type: 'finish', status: 429 })
  assert.deepEqual(routes, [])
})

test('a stream the consumer stops early is closed inside the call', async () => {
  let closed
  async function* inner() {
    try {
      yield 1
      yield 2
    } finally {
      closed = true
    }
  }
  for await (const chunk of withinCall({ session: SESSION }, inner())) {
    assert.equal(chunk, 1)
    break
  }
  assert.equal(closed, true)
  assert.throws(() => inCall({}, () => { throw new Error('no adapter') }), /no adapter/, 'what the waterfall throws at once still throws at once')
})
