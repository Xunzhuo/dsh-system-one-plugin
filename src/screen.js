/** The model-facing `system_one_screen` tool: System One as the eyes of a computer-use step. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, extname, relative, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { compactAnswer } from './client.js'
import { annotatePng, imageSize } from './png.js'
import { kindOf, parseQuestions } from './rubric.js'
import { FOUND_AT } from './tool.js'
import { clip } from './trace.js'

export const SCREEN_TOOL = 'system_one_screen'
const MAX_BYTES = 10 * 1024 * 1024
const TYPES = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' }

const DESCRIPTION = `Look at one screenshot with System One, a fast vision decision model, while you operate a user interface (a browser, a desktop app): find where things are on the screen (a box, and the pixel to click), check what the screen shows, and tell whether your last action worked from the screenshots before and after it. It answers in about a second, with calibrated confidence: use it at each step of computer use instead of guessing coordinates or describing the screen to yourself.

- find: what to locate, as {"id": "what it is"}, e.g. {"save": "the Save button of the billing form", "error": "an error message"}. Each comes back with its box, the pixel to click (the box's center) and a confidence; below ${FOUND_AT} it is not on the screen.
- check: questions about the screen, as the system_one tool takes them: "noul" (yes or no), "choice", "score".
- expect: what the screen should show now, in words, e.g. "the Billing page with a notice that the email was saved"; answered yes or no.
- before and action: the screenshot from before your last action, and what that action was; System One says whether it succeeded.
- annotate: a path for a copy of the screenshot (PNG) with the boxes found in red and their click points in blue.

Coordinates are pixels of the screenshot, from its top left corner.`

/** What `find` names: {"id": "what it is"}, or a list of descriptions that are their own ids. */
function targetsOf(value) {
  if (value === undefined || value === null || value === '') return {}
  let parsed = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      parsed = [value]
    }
  }
  if (typeof parsed === 'string') parsed = [parsed]
  if (Array.isArray(parsed)) return Object.fromEntries(parsed.map(what => [clip(String(what), 80), String(what)]))
  if (parsed && typeof parsed === 'object') {
    return Object.fromEntries(Object.entries(parsed).map(([id, what]) => [id, typeof what === 'string' ? what : String(what?.instructions ?? JSON.stringify(what))]))
  }
  throw new Error('find names what to locate: {"id": "what it is"}, or a list of descriptions')
}

async function readShot(cwd, path, name) {
  if (typeof path !== 'string' || !path.trim()) throw new Error(`${name} is the path of a screenshot`)
  const full = resolve(cwd, path)
  const bytes = await readFile(full)
  const size = imageSize(bytes)
  if (!size) throw new Error(`${path} is not a PNG, JPEG or WebP image`)
  if (bytes.length > MAX_BYTES) throw new Error(`${path} is ${Math.round(bytes.length / 1048576)} MB, and System One takes screenshots of at most 10 MB`)
  return { path: full, shown: relative(cwd, full) || full, bytes, size, url: `data:${TYPES[size.type]};base64,${bytes.toString('base64')}` }
}

const round3 = value => Math.round(value * 1000) / 1000
const round4 = value => Math.round(value * 10000) / 10000
const verdict = (p, yes, no) => (typeof p === 'number' ? `${p >= 0.5 ? yes : no} (p ${p})` : 'no answer')

function renderScreen(value) {
  const { width, height } = value.size
  const lines = [`System One (${value.model}) looked at ${value.image} (${width}x${height}) in ${value.seconds} s.`]
  for (const [id, target] of Object.entries(value.found ?? {})) {
    const named = id === target.what ? `"${id}"` : `${id} (${target.what})`
    if (target.error) lines.push(`- ${named}: no answer (${target.error})`)
    else if (!target.found) lines.push(`- ${named}: not found (confidence ${target.confidence})`)
    else {
      const { left, top, right, bottom } = target.pixels
      lines.push(`- ${named}: click (${target.click.x}, ${target.click.y}); box (${left}, ${top})-(${right}, ${bottom}); confidence ${target.confidence}`)
    }
  }
  for (const [id, answer] of Object.entries(value.checks ?? {})) {
    if (answer.error) lines.push(`- ${id}: no answer (${answer.error})`)
    else if (answer.yes !== undefined) lines.push(`- ${id}: ${verdict(answer.yes, 'yes', 'no')}`)
    else if (answer.choice !== undefined) lines.push(`- ${id}: ${answer.choice} (confidence ${answer.confidence})`)
    else lines.push(`- ${id}: ${answer.score} (confidence ${answer.confidence})`)
  }
  if (value.expect) lines.push(`Expected "${value.expect.text}": ${verdict(value.expect.yes, 'yes', 'no')}`)
  if (value.action) lines.push(`Action "${value.action.text}" (from ${value.action.before}): ${verdict(value.action.succeeded, 'succeeded', 'did not succeed')}`)
  if (value.annotated) lines.push(`Annotated copy: ${value.annotated}`)
  return lines.join('\n')
}

/** The result's facts as the Web UI draws them (web/client.js), kept on the call's result. */
export function screenPresentation(value, ui) {
  if (ui === 'off') return { systemOneScreen: 1, ui }
  return { systemOneScreen: 1, ui, ...value }
}

/**
 * @param {object} deps
 * @param {ReturnType<import('./client.js').createDecisionClient>} deps.client
 * @param {(entry: object) => void} deps.trace
 * @param {object} deps.config
 * @param {(exec: object) => Promise<string>} [deps.workspaceOf]
 */
export function screenTool({ client, trace, config, workspaceOf = async () => process.cwd() }) {
  return defineTool({
    name: SCREEN_TOOL,
    description: DESCRIPTION,
    parameters: {
      image: { type: 'string', required: true, description: 'Path to the screenshot (PNG, JPEG or WebP).' },
      find: { type: 'json', description: 'What to locate: {"id": "what it is"}, or a list of descriptions.' },
      check: { type: 'json', description: 'Questions about the screen: question id -> {type: "noul" | "choice" | "score", instructions, criteria}.' },
      expect: { type: 'string', description: 'What the screen should show now, in words.' },
      before: { type: 'string', description: 'Path to the screenshot taken before your last action.' },
      action: { type: 'string', description: 'What your last action was, e.g. "clicked Save".' },
      context: { type: 'string', description: 'What the screen is, e.g. "The Lumen Cloud console in a browser."' },
      annotate: { type: 'string', description: 'Path for an annotated copy (PNG): boxes in red, click points in blue. "true" saves it beside the screenshot.' },
      model: { type: 'string', description: `Decision model. Default ${config.screenModel}.` },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderScreen(value) }],
      presentationMeta: (_args, value) => screenPresentation(value, config.systemOneUi),
    },
    async execute(args, exec) {
      const cwd = await workspaceOf(exec)
      const shot = await readShot(cwd, args.image, 'image')
      const find = targetsOf(args.find)
      const check = args.check === undefined || args.check === null || args.check === '' ? {} : parseQuestions(args.check)
      for (const [id, question] of Object.entries(check)) {
        if (kindOf(question) !== 'decision' || question.type === 'box') throw new Error(`check "${id}": ask a noul, choice or score question here, and put what to locate in find`)
      }
      const expect = typeof args.expect === 'string' ? args.expect.trim() : ''
      const action = typeof args.action === 'string' ? args.action.trim() : ''
      if (action && !args.before) throw new Error('action needs before: the screenshot from before the action')
      if (!Object.keys(find).length && !Object.keys(check).length && !expect && !args.before) throw new Error('ask System One something: find, check, expect, or before with action')
      const before = args.before ? await readShot(cwd, args.before, 'before') : undefined
      const model = args.model || config.screenModel
      const context = typeof args.context === 'string' ? args.context.trim() : ''

      // wire ids of System One's own, so that no id reaches a router signal's trained head
      const questions = {}
      const ids = {}
      Object.entries(find).forEach(([id, what], index) => {
        questions[`find_${index + 1}`] = { type: 'box', instructions: what }
        ids[`find_${index + 1}`] = { kind: 'find', id }
      })
      Object.entries(check).forEach(([id, question], index) => {
        questions[`check_${index + 1}`] = question
        ids[`check_${index + 1}`] = { kind: 'check', id }
      })
      if (expect) questions.expected = { type: 'noul', instructions: `Does the screenshot show this: ${expect.replace(/[.?!\s]+$/, '')}?` }

      const started = performance.now()
      const [seen, compared] = await Promise.all([
        Object.keys(questions).length ? client.ask({ model, questions, inputs: [{ state: context || 'A screenshot of a user interface.', images: [shot.url] }], signal: exec.signal }) : undefined,
        before ? client.ask({
          model,
          questions: { succeeded: { type: 'noul', instructions: `The first image is the screen before the action, the second the screen after it. The action was: ${action || 'the last step of the task'}. Did the action succeed?` } },
          inputs: [{ state: `${context ? `${context} ` : ''}Two screenshots: before and after one action.`, images: [before.url, shot.url] }],
          signal: exec.signal,
        }) : undefined,
      ])
      const seconds = Math.round((performance.now() - started) / 10) / 100

      const { width, height } = shot.size
      const answers = seen?.answers[0] ?? {}
      const found = {}
      const checks = {}
      for (const [wire, { kind, id }] of Object.entries(ids)) {
        const answer = answers[wire]
        if (kind === 'check') {
          checks[id] = compactAnswer(answer)
          continue
        }
        if (!answer || answer.error || !answer.box) {
          found[id] = { what: find[id], error: answer?.error ?? 'missing' }
          continue
        }
        const { left, top, right, bottom } = answer.box
        const confidence = round3(answer.confidence)
        found[id] = {
          what: find[id],
          box: { left: round4(left), top: round4(top), right: round4(right), bottom: round4(bottom) },
          pixels: { left: Math.round(left * width), top: Math.round(top * height), right: Math.round(right * width), bottom: Math.round(bottom * height) },
          click: { x: Math.round(((left + right) / 2) * width), y: Math.round(((top + bottom) / 2) * height) },
          confidence,
          found: confidence >= FOUND_AT,
        }
      }
      const p = answer => (typeof answer?.noul === 'number' ? round3(answer.noul) : undefined)

      let annotated
      if (args.annotate && args.annotate !== 'false') {
        if (shot.size.type !== 'png') throw new Error('annotate draws on PNG screenshots')
        // a copy beside the screenshot, also when the path given is the screenshot's own
        const beside = `${shot.path.slice(0, shot.path.length - extname(shot.path).length)}.annotated.png`
        const named = args.annotate === 'true' ? beside : resolve(cwd, args.annotate)
        const out = named === shot.path ? beside : named
        const marks = Object.values(found).filter(target => target.found).flatMap(target => [{ box: target.box }, { point: target.click }])
        await mkdir(dirname(out), { recursive: true })
        await writeFile(out, annotatePng(shot.bytes, marks))
        annotated = relative(cwd, out) || out
      }

      const value = {
        model,
        seconds,
        requests: [seen, compared].filter(Boolean).length,
        image: shot.shown,
        imagePath: shot.path,
        size: { width, height },
        ...(Object.keys(found).length ? { found } : {}),
        ...(Object.keys(check).length ? { checks } : {}),
        ...(expect ? { expect: { text: expect, yes: p(answers.expected) } } : {}),
        ...(before ? { action: { text: action || 'the last step', before: before.shown, beforePath: before.path, succeeded: p(compared.answers[0]?.succeeded) } } : {}),
        ...(annotated ? { annotated } : {}),
      }
      trace({
        ev: 's1',
        reflex: 'screen',
        session: exec.agent?.session?.id,
        model,
        ms: Math.round(seconds * 1000),
        image: shot.shown,
        found: Object.fromEntries(Object.entries(found).map(([id, target]) => [id, target.confidence ?? 'error'])),
        checks,
        expect: value.expect?.yes,
        succeeded: value.action?.succeeded,
      })
      return value
    },
  })
}
