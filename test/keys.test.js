import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { test } from 'node:test'
import { ensureKeys, leadingZeroBits, requestKey, solve } from '../src/keys.js'

function bits(challenge, nonce) {
  return leadingZeroBits(createHash('sha256').update(`${challenge}:${nonce}`).digest())
}

// a key site in miniature: challenge, proof check, terms check, optional failures
async function fakeSite({ difficulty = 8, expireFirst = false, limited = false } = {}) {
  const issued = []
  let creates = 0
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const send = (status, data, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers })
        res.end(JSON.stringify(data))
      }
      if (req.url === '/api/keys/challenge') {
        const challenge = `v1.test.${difficulty}.${issued.length}`
        issued.push(challenge)
        return send(200, { challenge, difficulty, algorithm: 'sha256' })
      }
      if (req.url === '/api/keys') {
        const { challenge, nonce, label, accept_terms: terms } = JSON.parse(body)
        creates++
        if (limited) return send(429, { error: { code: 'key_creation_limited', message: 'this network has created many keys recently' } }, { 'retry-after': '120' })
        if (expireFirst && creates === 1) return send(400, { error: { code: 'challenge_expired', message: 'expired' } })
        if (!issued.includes(challenge) || bits(challenge, nonce) < difficulty) return send(400, { error: { code: 'invalid_proof', message: 'bad proof' } })
        if (terms !== true) return send(400, { error: { code: 'terms_not_accepted', message: 'accept the terms' } })
        return send(201, { api_key: `sk-test-${label}-${creates}` })
      }
      send(404, { error: { code: 'not_found', message: req.url } })
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const site = `http://127.0.0.1:${server.address().port}`
  return {
    service: { ref: 'TEST_KEY', name: 'test', site, challenge: '/api/keys/challenge', create: '/api/keys' },
    stats: () => ({ challenges: issued.length, creates }),
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

test('the solver finds a nonce with enough zero bits', async () => {
  const nonce = await solve('v1.example.12', 12)
  assert.ok(bits('v1.example.12', nonce) >= 12)
  assert.equal(leadingZeroBits(Buffer.from([0, 0, 0x0f, 0xff])), 20)
  assert.equal(leadingZeroBits(Buffer.from([0x80])), 0)
})

test('a key comes back for a valid proof with the terms accepted', async () => {
  const site = await fakeSite()
  try {
    assert.equal(await requestKey(site.service, { label: 'unit' }), 'sk-test-unit-1')
  } finally {
    await site.close()
  }
})

test('an expired challenge is fetched once more', async () => {
  const site = await fakeSite({ expireFirst: true })
  try {
    assert.equal(await requestKey(site.service, { label: 'unit' }), 'sk-test-unit-2')
    assert.deepEqual(site.stats(), { challenges: 2, creates: 2 })
  } finally {
    await site.close()
  }
})

test('only missing keys are fetched, and a refusal is reported with its reason', async () => {
  const good = await fakeSite()
  const limited = await fakeSite({ limited: true })
  const stored = new Map([['HAVE_KEY', 'sk-existing']])
  try {
    const result = await ensureKeys({
      resolve: async ref => stored.get(ref),
      store: async (ref, value) => { stored.set(ref, value) },
      services: [
        { ...good.service, ref: 'HAVE_KEY' },
        { ...good.service, ref: 'NEW_KEY' },
        { ...limited.service, ref: 'LIMITED_KEY' },
      ],
      label: 'unit',
    })
    assert.equal(stored.get('HAVE_KEY'), 'sk-existing')
    assert.equal(stored.get('NEW_KEY'), 'sk-test-unit-1')
    assert.equal(stored.has('LIMITED_KEY'), false)
    assert.deepEqual(result.allocated.map(s => s.ref), ['NEW_KEY'])
    assert.equal(result.failed.length, 1)
    assert.equal(result.failed[0].error.code, 'key_creation_limited')
    assert.equal(result.failed[0].error.retryAfter, 120)
    assert.equal(good.stats().challenges, 1)
  } finally {
    await good.close()
    await limited.close()
  }
})
