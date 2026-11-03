import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import { createDecisionClient } from '../src/client.js'

function fakeApi(handler) {
  return new Promise(resolve => {
    const server = http.createServer((request, response) => {
      const chunks = []
      request.on('data', chunk => chunks.push(chunk))
      request.on('end', () => handler(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'), request, response))
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }))
  })
}

const answer = state => ({ injection: { type: 'noul', noul: state.includes('attack') ? 0.99 : 0.01 } })

test('batches inputs into state + states and returns answers in input order', async () => {
  let seen
  const { server, url } = await fakeApi((body, request, response) => {
    seen = { auth: request.headers.authorization, body }
    const states = Object.fromEntries(Object.entries(body.states ?? {}).map(([k, v]) => [k, { answers: answer(v.state), usage: { input_tokens: 10 } }]))
    response.end(JSON.stringify({ answers: answer(body.state), states, model: body.model, usage: { input_tokens: 10 } }))
  })
  process.env.S1_TEST_KEY = 'sk-vsr-test'
  const client = createDecisionClient({ baseURL: url, apiKeyEnv: 'S1_TEST_KEY' })
  const r = await client.ask({ model: 'm', questions: { injection: { type: 'noul', instructions: 'q' } }, inputs: [{ state: 'clean' }, { state: 'attack' }, { state: 'clean too' }] })
  assert.equal(seen.auth, 'Bearer sk-vsr-test')
  assert.equal(seen.body.state, 'clean')
  assert.deepEqual(Object.keys(seen.body.states), ['i1', 'i2'])
  assert.deepEqual(r.answers.map(a => a.injection.noul), [0.01, 0.99, 0.01])
  assert.equal(r.inputTokens, 30)
  client.close()
  server.close()
})

test('retries a 429 after Retry-After, then succeeds', async () => {
  let calls = 0
  const { server, url } = await fakeApi((body, request, response) => {
    calls++
    if (calls === 1) {
      response.writeHead(429, { 'retry-after': '0.05', 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { code: 'rate_limit_exceeded' } }))
      return
    }
    response.end(JSON.stringify({ answers: answer(body.state), model: body.model }))
  })
  process.env.S1_TEST_KEY = 'sk-vsr-test'
  const client = createDecisionClient({ baseURL: url, apiKeyEnv: 'S1_TEST_KEY' })
  const r = await client.ask({ model: 'm', questions: {}, inputs: [{ state: 'attack' }] })
  assert.equal(calls, 2)
  assert.equal(r.answers[0].injection.noul, 0.99)
  client.close()
  server.close()
})

test('an unreachable API fails fast with the hook limits', async () => {
  process.env.S1_TEST_KEY = 'sk-vsr-test'
  const client = createDecisionClient({ baseURL: 'http://127.0.0.1:9', apiKeyEnv: 'S1_TEST_KEY' })
  const started = Date.now()
  await assert.rejects(client.ask({ model: 'm', questions: {}, inputs: [{ state: 'x' }], timeoutMs: 2000, retries: 1 }), /unreachable/)
  assert.ok(Date.now() - started < 3000)
  client.close()
})

test('a caller cancelled while it waits for a slot leaves the queue and the next caller gets the slot', async () => {
  const held = []
  const { server, url } = await fakeApi((body, request, response) => {
    held.push(() => response.end(JSON.stringify({ answers: answer(body.state), model: body.model, usage: { input_tokens: 1 } })))
  })
  process.env.S1_TEST_KEY = 'sk-vsr-test'
  const client = createDecisionClient({ baseURL: url, apiKeyEnv: 'S1_TEST_KEY', maxConcurrency: 1 })
  const ask = (state, signal) => client.ask({ model: 'm', questions: {}, inputs: [{ state }], signal })
  const first = ask('first')
  while (held.length === 0) await new Promise(resolve => setTimeout(resolve, 5))
  const cancelled = new AbortController()
  const second = ask('second', cancelled.signal)
  const third = ask('third')
  cancelled.abort()
  await assert.rejects(second, { name: 'AbortError' })
  held.shift()()
  await first
  while (held.length === 0) await new Promise(resolve => setTimeout(resolve, 5))
  held.shift()()
  const r = await Promise.race([third, new Promise((_, reject) => setTimeout(() => reject(new Error('the third caller never got the slot')), 2000))])
  assert.equal(r.answers.length, 1)
  client.close()
  server.close()
})

test('a missing key is a clear error', async () => {
  delete process.env.S1_NO_KEY
  const client = createDecisionClient({ baseURL: 'http://127.0.0.1:9', apiKeyEnv: 'S1_NO_KEY' })
  await assert.rejects(client.ask({ model: 'm', questions: {}, inputs: [{ state: 'x' }] }), /no System One key/)
  client.close()
})
