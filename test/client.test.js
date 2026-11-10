import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import { ITEMS_PER_REQUEST, REQUEST_TOKENS, createDecisionClient, requestSlices, stateCost } from '../src/client.js'

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

test('batches several inputs into states entries, nothing of a standard request beside them, and returns answers in input order', async () => {
  let seen
  const { server, url } = await fakeApi((body, request, response) => {
    seen = { auth: request.headers.authorization, body }
    const states = Object.fromEntries(Object.entries(body.states ?? {}).map(([k, v]) => [k, { model: body.model, answers: answer(v.state), usage: { input_tokens: 10 } }]))
    // a batch's usage counts every entry
    response.end(JSON.stringify({ model: body.model, states, usage: { input_tokens: 10 * Object.keys(states).length } }))
  })
  process.env.S1_TEST_KEY = 'sk-vsr-test'
  const client = createDecisionClient({ baseURL: url, apiKeyEnv: 'S1_TEST_KEY' })
  const r = await client.ask({ model: 'm', questions: { injection: { type: 'noul', instructions: 'q' } }, inputs: [{ state: 'clean' }, { state: 'attack' }, { state: 'clean too' }] })
  assert.equal(seen.auth, 'Bearer sk-vsr-test')
  assert.deepEqual(Object.keys(seen.body).sort(), ['model', 'states'])
  assert.deepEqual(Object.keys(seen.body.states), ['1', '2', '3'])
  assert.deepEqual(seen.body.states['1'], { state: 'clean', questions: { injection: { type: 'noul', instructions: 'q' } } })
  assert.deepEqual(r.answers.map(a => a.injection.noul), [0.01, 0.99, 0.01])
  assert.equal(r.inputTokens, 30)
  client.close()
  server.close()
})

test('asks about one input with a standard request', async () => {
  let seen
  const { server, url } = await fakeApi((body, request, response) => {
    seen = body
    response.end(JSON.stringify({ model: body.model, answers: answer(body.state), usage: { input_tokens: 12 } }))
  })
  process.env.S1_TEST_KEY = 'sk-vsr-test'
  const client = createDecisionClient({ baseURL: url, apiKeyEnv: 'S1_TEST_KEY' })
  const r = await client.ask({ model: 'm', questions: { injection: { type: 'noul', instructions: 'q' } }, inputs: [{ state: 'attack', images: ['data:image/png;base64,AA=='] }] })
  assert.deepEqual(seen, { model: 'm', state: 'attack', questions: { injection: { type: 'noul', instructions: 'q' } }, images: ['data:image/png;base64,AA=='] })
  assert.deepEqual(r.answers.map(a => a.injection.noul), [0.99])
  assert.equal(r.inputTokens, 12)
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

test('a call may wait longer for a spent budget: Retry-After up to its waitMs, more retries, and a cancel ends the wait', async () => {
  // each request takes the next answer: a Retry-After for a 429, or none for an answer
  let plan = []
  let calls = 0
  const { server, url } = await fakeApi((body, request, response) => {
    calls++
    const after = plan.shift()
    if (after) {
      response.writeHead(429, { 'retry-after': after, 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { code: 'rate_limit_exceeded' } }))
      return
    }
    response.end(JSON.stringify({ answers: answer(body.state), model: body.model }))
  })
  process.env.S1_TEST_KEY = 'sk-vsr-test'
  const client = createDecisionClient({ baseURL: url, apiKeyEnv: 'S1_TEST_KEY' })
  const ask = limits => client.ask({ model: 'm', questions: {}, inputs: [{ state: 'attack' }], ...limits })

  // four 429s in a row: three retries give up, six get through
  plan = ['0.01', '0.01', '0.01', '0.01']
  await assert.rejects(ask({}), /429 rate_limit_exceeded/)
  plan = ['0.01', '0.01', '0.01', '0.01']
  calls = 0
  const r = await ask({ retries: 6 })
  assert.deepEqual([calls, r.answers[0].injection.noul], [5, 0.99])

  // Retry-After is honoured up to waitMs, and no further
  for (const [waitMs, slow] of [[1000, true], [50, false]]) {
    plan = ['0.5']
    const started = Date.now()
    await ask({ waitMs })
    assert.equal(Date.now() - started >= 500, slow, `waitMs ${waitMs}`)
  }

  // a spent daily quota fails at once
  calls = 0
  const quota = await fakeApi((body, request, response) => {
    calls++
    response.writeHead(429, { 'retry-after': '20000', 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { code: 'quota_exceeded' } }))
  })
  const daily = createDecisionClient({ baseURL: quota.url, apiKeyEnv: 'S1_TEST_KEY' })
  await assert.rejects(daily.ask({ model: 'm', questions: {}, inputs: [{ state: 'x' }], retries: 6, waitMs: 60000 }), /429 quota_exceeded/)
  assert.equal(calls, 1)
  daily.close()
  quota.server.close()

  // a long wait ends when the call is cancelled
  plan = ['5']
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 50)
  const started = Date.now()
  await assert.rejects(ask({ waitMs: 60000, signal: controller.signal }), /abort/i)
  assert.ok(Date.now() - started < 1000)
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

test('a caller cancelled while it waits for a slot leaves the queue and the next caller gets the slot', { timeout: 5000 }, async t => {
  const held = []
  const { server, url } = await fakeApi((body, request, response) => {
    held.push(() => response.end(JSON.stringify({ answers: answer(body.state), model: body.model, usage: { input_tokens: 1 } })))
  })
  process.env.S1_TEST_KEY = 'sk-vsr-test'
  const client = createDecisionClient({ baseURL: url, apiKeyEnv: 'S1_TEST_KEY', maxConcurrency: 1 })
  t.after(() => {
    client.close()
    server.closeAllConnections()
    server.close()
  })
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
  const r = await third
  assert.equal(r.answers.length, 1)
})

test('a missing key is a clear error', async () => {
  delete process.env.S1_NO_KEY
  const client = createDecisionClient({ baseURL: 'http://127.0.0.1:9', apiKeyEnv: 'S1_NO_KEY' })
  await assert.rejects(client.ask({ model: 'm', questions: {}, inputs: [{ state: 'x' }] }), /no System One key/)
  client.close()
})

test('requests are cut so that every question reading its state again stays within the token estimate', () => {
  // short states: nine to a request
  assert.deepEqual(requestSlices(Array.from({ length: 20 }, () => 'a short ticket'), 4), [{ start: 0, count: 9 }, { start: 9, count: 9 }, { start: 18, count: 2 }])
  // long states, three questions each: as many as fit, and a state too heavy to share a request goes alone
  const long = 'x'.repeat(20000)
  const slices = requestSlices([long, long, long, 'x'.repeat(60000), long], 3)
  assert.deepEqual(slices, [{ start: 0, count: 1 }, { start: 1, count: 1 }, { start: 2, count: 1 }, { start: 3, count: 1 }, { start: 4, count: 1 }])
  assert.deepEqual(requestSlices([long, long, long], 1), [{ start: 0, count: 3 }])
  for (const { start, count } of requestSlices(Array.from({ length: 30 }, (_, i) => 'y'.repeat(1000 * (i + 1))), 2)) {
    const cost = Array.from({ length: count }, (_, k) => stateCost('y'.repeat(1000 * (start + k + 1))) * 2).reduce((a, b) => a + b, 0)
    assert.ok(count === 1 || cost <= REQUEST_TOKENS, `${start}+${count}: ${cost}`)
    assert.ok(count <= ITEMS_PER_REQUEST)
  }
  // bytes, not characters: three bytes a character in Chinese text
  assert.equal(stateCost('数据'), 6 + 160)
  assert.equal(stateCost({ user: 'a', answer: 'b' }), JSON.stringify({ user: 'a', answer: 'b' }).length + 160)
})
