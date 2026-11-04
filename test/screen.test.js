import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createDecisionClient } from '../src/client.js'
import { BLUE, RED, decodePng, encodePng } from '../src/png.js'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-tools') return { url: `data:text/javascript,${encodeURIComponent('export const defineTool = definition => definition')}`, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})
const { screenPresentation, screenTool } = await import('../src/screen.js')

// a vision model that sees a Save button, no error, the Billing page, and a saved email after "Save"
function fakeVision() {
  const asked = []
  const server = http.createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      asked.push(body)
      const answers = {}
      for (const [id, question] of Object.entries(body.questions)) {
        if (question.type === 'box') {
          const save = /Save/.test(question.instructions)
          answers[id] = { type: 'box', box: save ? { left: 0.25, top: 0.5, right: 0.75, bottom: 0.75 } : { left: 0, top: 0, right: 0.1, bottom: 0.1 }, confidence: save ? 0.97 : 0.05 }
        } else if (question.type === 'choice') answers[id] = { type: 'choice', choice: 'billing', confidence: 0.9, probabilities: { billing: 0.9, settings: 0.1 } }
        else if (id === 'succeeded') answers[id] = { type: 'noul', noul: body.images.length === 2 && /Save/.test(question.instructions) ? 0.93 : 0.08 }
        else if (id === 'expected') answers[id] = { type: 'noul', noul: 0.91 }
        else answers[id] = { type: 'noul', noul: 0.04 }
      }
      response.end(JSON.stringify({ model: body.model, answers }))
    })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, asked })))
}

async function setup(t) {
  process.env.S1_SCREEN_KEY = 'sk-vsr-test'
  const workspace = await mkdtemp(join(tmpdir(), 's1-screen-'))
  await mkdir(join(workspace, 'shots'))
  const shot = shade => encodePng({ width: 200, height: 100, data: Buffer.alloc(200 * 100 * 4, shade) })
  await writeFile(join(workspace, 'shots/01.png'), shot(250))
  await writeFile(join(workspace, 'shots/02.png'), shot(255))
  await writeFile(join(workspace, 'shots/03.jpg'), Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 100, 0x00, 200, 0x03]), Buffer.alloc(40)]))
  await writeFile(join(workspace, 'notes.txt'), 'not an image')
  const { server, url, asked } = await fakeVision()
  const client = createDecisionClient({ baseURL: url, apiKeyEnv: 'S1_SCREEN_KEY' })
  const traced = []
  const tool = screenTool({ client, trace: entry => traced.push(entry), config: { screenModel: 'vllm-sr/vela3-turbo', systemOneUi: 'card' }, workspaceOf: async () => workspace })
  t.after(async () => {
    client.close()
    server.close()
    await rm(workspace, { recursive: true, force: true })
  })
  return { workspace, asked, traced, tool, run: args => tool.execute(args, { agent: { session: { id: 's' } } }), rendered: value => tool.output.render({}, value)[0].text }
}

test('a screen step: where to click, what the screen shows, and whether the last action worked', async t => {
  const { workspace, asked, traced, tool, run, rendered } = await setup(t)
  const value = await run({
    image: 'shots/02.png',
    find: { save: 'the Save button of the billing form', error: 'an error message' },
    check: { page: { instructions: 'Which page is shown?', criteria: { billing: 'Billing', settings: 'Settings' } }, broken: { instructions: 'Does the screen show an error?' } },
    expect: 'the Billing page with a notice that the email was saved.',
    before: 'shots/01.png',
    action: 'clicked Save',
    context: 'The Lumen Cloud console in a browser.',
    annotate: 'shots/02.marked.png',
  })

  // one look at the screen, and one at the pair before and after the action, side by side
  assert.equal(asked.length, 2)
  const look = asked.find(body => body.images.length === 1)
  const pair = asked.find(body => body.images.length === 2)
  assert.deepEqual(Object.keys(look.questions), ['find_1', 'find_2', 'check_1', 'check_2', 'expected'])
  assert.deepEqual(look.questions.find_1, { type: 'box', instructions: 'the Save button of the billing form' })
  assert.equal(look.questions.expected.instructions, 'Does the screenshot show this: the Billing page with a notice that the email was saved?')
  assert.equal(look.state, 'The Lumen Cloud console in a browser.')
  const url = async path => `data:image/png;base64,${(await readFile(join(workspace, path))).toString('base64')}`
  assert.deepEqual(pair.images, [await url('shots/01.png'), await url('shots/02.png')])
  assert.match(pair.questions.succeeded.instructions, /The action was: clicked Save\. Did the action succeed\?$/)
  assert.ok(asked.every(body => body.model === 'vllm-sr/vela3-turbo'))

  assert.deepEqual(value.found.save, {
    what: 'the Save button of the billing form',
    box: { left: 0.25, top: 0.5, right: 0.75, bottom: 0.75 },
    pixels: { left: 50, top: 50, right: 150, bottom: 75 },
    click: { x: 100, y: 63 },
    confidence: 0.97,
    found: true,
  })
  assert.equal(value.found.error.found, false)
  assert.deepEqual(value.checks, { page: { choice: 'billing', confidence: 0.9, p: { billing: 0.9, settings: 0.1 } }, broken: { yes: 0.04 } })
  assert.deepEqual(value.expect, { text: 'the Billing page with a notice that the email was saved.', yes: 0.91 })
  assert.deepEqual(value.action, { text: 'clicked Save', before: 'shots/01.png', beforePath: join(workspace, 'shots/01.png'), succeeded: 0.93 })
  assert.deepEqual([value.image, value.imagePath, value.size, value.requests], ['shots/02.png', join(workspace, 'shots/02.png'), { width: 200, height: 100 }, 2])

  // the copy: the box found in red just outside it, the click point in blue, nothing for what was not found
  assert.equal(value.annotated, 'shots/02.marked.png')
  const marked = decodePng(await readFile(join(workspace, 'shots/02.marked.png')))
  const at = (x, y) => [...marked.data.subarray((y * 200 + x) * 4, (y * 200 + x) * 4 + 3)]
  assert.deepEqual(at(49, 60), RED)
  assert.deepEqual(at(100, 63), BLUE)
  assert.deepEqual(at(5, 5), [255, 255, 255])

  assert.equal(rendered(value), [
    `System One (vllm-sr/vela3-turbo) looked at shots/02.png (200x100) in ${value.seconds} s.`,
    '- save (the Save button of the billing form): click (100, 63); box (50, 50)-(150, 75); confidence 0.97',
    '- error (an error message): not found (confidence 0.05)',
    '- page: billing (confidence 0.9)',
    '- broken: no (p 0.04)',
    'Expected "the Billing page with a notice that the email was saved.": yes (p 0.91)',
    'Action "clicked Save" (from shots/01.png): succeeded (p 0.93)',
    'Annotated copy: shots/02.marked.png',
  ].join('\n'))
  assert.deepEqual(tool.output.presentationMeta({}, value), { systemOneScreen: 1, ui: 'card', ...value })
  assert.deepEqual(screenPresentation(value, 'off'), { systemOneScreen: 1, ui: 'off' })
  assert.deepEqual([traced[0].reflex, traced[0].found, traced[0].succeeded], ['screen', { save: 0.97, error: 0.05 }, 0.93])
})

test('a screen step asks only what it is given, takes find as a list, and refuses what it cannot answer', async t => {
  const { asked, run, rendered } = await setup(t)
  const listed = await run({ image: 'shots/02.png', find: ['the Save button'] })
  assert.equal(asked.length, 1)
  assert.match(rendered(listed), /^- "the Save button": click \(100, 63\)/m)
  assert.equal(listed.checks, undefined)

  // a list of objects names each target, and no two targets share an id
  const objects = await run({
    image: 'shots/02.png',
    find: JSON.stringify([{ save: 'the Save button' }, { id: 'error', description: 'an error message' }, { what: 'the Save link' }, { save: 'a second Save button' }]),
  })
  assert.deepEqual(Object.fromEntries(Object.entries(objects.found).map(([id, target]) => [id, target.what])), {
    save: 'the Save button',
    error: 'an error message',
    'the Save link': 'the Save link',
    'save (2)': 'a second Save button',
  })
  assert.doesNotMatch(rendered(objects), /object Object/)

  asked.length = 0
  const compared = await run({ image: 'shots/02.png', before: 'shots/01.png', action: 'pressed Delete' })
  assert.deepEqual([asked.length, asked[0].images.length, compared.action.succeeded, compared.found], [1, 2, 0.08, undefined])
  assert.match(rendered(compared), /Action "pressed Delete" \(from shots\/01\.png\): did not succeed \(p 0\.08\)/)

  // a JPEG is read for what it shows; only a PNG is drawn on
  const jpeg = await run({ image: 'shots/03.jpg', expect: 'a chart' })
  assert.match(asked.at(-1).images[0], /^data:image\/jpeg;base64,/)
  assert.deepEqual(jpeg.size, { width: 200, height: 100 })

  await assert.rejects(run({ image: 'shots/03.jpg', find: ['the chart'], annotate: 'true' }), /annotate draws on PNG screenshots/)
  await assert.rejects(run({ image: 'notes.txt', expect: 'x' }), /is not a PNG, JPEG or WebP image/)
  await assert.rejects(run({ image: 'shots/02.png' }), /ask System One something/)
  await assert.rejects(run({ image: 'shots/02.png', action: 'clicked' }), /action needs before/)
  await assert.rejects(run({ image: 'shots/02.png', check: { where: { type: 'box', instructions: 'x' } } }), /check "where": ask a noul, choice or score question here/)
  await assert.rejects(run({ image: 'shots/02.png', check: { personal: { preset: 'pii' } } }), /check "personal"/)

  const beside = await run({ image: 'shots/02.png', find: ['the Save button'], annotate: 'true' })
  assert.equal(beside.annotated, 'shots/02.annotated.png')
  // a copy over the screenshot itself goes beside it instead
  const over = await run({ image: 'shots/02.png', find: ['the Save button'], annotate: 'shots/02.png' })
  assert.equal(over.annotated, 'shots/02.annotated.png')

  // before without its action is judged as the task's last step
  asked.length = 0
  const unnamed = await run({ image: 'shots/02.png', before: 'shots/01.png' })
  assert.match(asked[0].questions.succeeded.instructions, /The action was: the last step of the task\. Did the action succeed\?/)
  assert.equal(unnamed.action.text, 'the last step')
})
