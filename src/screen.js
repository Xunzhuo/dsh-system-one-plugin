/** The model-facing `system_one_screen` tool: System One as the eyes of a computer-use step. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { compactAnswer, unavailable, unavailableText } from './client.js'
import { kindAt, noFile } from './paths.js'
import { annotatePng, imageSize } from './png.js'
import { kindOf, readQuestions } from './rubric.js'
import { FOUND_AT } from './tool.js'
import { clip } from './trace.js'

export const SCREEN_TOOL = 'system_one_screen'
const MAX_BYTES = 10 * 1024 * 1024
const TYPES = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' }

const FIND_EXAMPLE = { save: 'the Save button of the billing form', error: 'an error message' }
const CHECK_EXAMPLE = { page: { type: 'choice', instructions: 'Which page is this?', criteria: { billing: 'the Billing page', settings: 'the Settings page' } }, signed_in: { type: 'noul', instructions: 'Is a user signed in?' } }

const DESCRIPTION = `Look at one screenshot with System One, a fast vision decision model, while you operate a user interface (a browser, a desktop app): find where things are on the screen (a box, and the pixel to click), check what the screen shows, and tell whether your last action worked from the screenshots before and after it. It answers in about a second, with calibrated confidence: use it at each step of computer use instead of guessing coordinates or describing the screen to yourself.

Give image (the screenshot's path) and at least one of:
- find: what to locate, as {"id": "what it is"}, e.g. ${JSON.stringify(FIND_EXAMPLE)}. Each comes back with its box, the pixel to click (the box's center) and a confidence; below ${FOUND_AT} it is not on the screen.
- check: questions about the screen, as the system_one tool takes them (noul, choice, score), e.g. ${JSON.stringify(CHECK_EXAMPLE)}.
- expect: what the screen should show now, in words, e.g. "the Billing page with a notice that the email was saved"; answered yes or no.
- before and action: the screenshot from before your last action, and what that action was; System One says whether it succeeded.
- annotate: a path for a copy of the screenshot (PNG) with the boxes found in red and their click points in blue, a folder for it, or true for a copy beside the screenshot.

Coordinates are pixels of the screenshot, from its top left corner.`

// where System Two sometimes writes what it asks
const ALIASES = { find: ['targets', 'locate', 'where'], check: ['checks', 'questions'], expect: ['expected'], before: ['before_image', 'previous', 'previous_image'], action: ['last_action'] }
const given = value => value !== undefined && value !== null && value !== ''

const WORDS = ['instructions', 'what', 'description', 'text']
const describe = what => (typeof what === 'string' ? what : WORDS.map(key => what?.[key]).find(text => typeof text === 'string'))

/** One item of a `find` list: a description that is its own id, {"id": ..., "description": ...}, or {"id": "what it is"}. */
function listed(item) {
  if (!item || typeof item !== 'object') return [[clip(String(item), 80), String(item)]]
  const id = item.id ?? item.name
  const what = describe(item)
  if (typeof id === 'string' && what) return [[id, what]]
  if (what && Object.keys(item).length === 1) return [[clip(what, 80), what]]
  return Object.entries(item).map(([key, value]) => [key, describe(value) ?? JSON.stringify(value)])
}

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
  if (!parsed || typeof parsed !== 'object') throw new Error('find names what to locate: {"id": "what it is"}, or a list of descriptions')
  const entries = Array.isArray(parsed) ? parsed.flatMap(listed) : Object.entries(parsed).map(([id, what]) => [id, describe(what) ?? JSON.stringify(what)])
  // two targets under one id would ask for one of them only
  const targets = new Map()
  for (const [id, what] of entries) {
    let key = id
    for (let n = 2; targets.has(key); n++) key = `${id} (${n})`
    targets.set(key, what)
  }
  return Object.fromEntries(targets)
}

async function readShot(cwd, path, name) {
  if (typeof path !== 'string' || !path.trim()) throw new Error(`${name} is the path of a screenshot`)
  const full = resolve(cwd, path)
  if ((await kindAt(full)) !== 'file') throw new Error(await noFile(cwd, path, name))
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
  if (value.notes?.length) lines.push(`Notes: ${value.notes.join('; ')}.`)
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
  // how the call was read is System Two's to know; Chat shows what System One answered
  const { notes, ...shown } = value
  return { systemOneScreen: 1, ui, ...shown }
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
      find: { type: 'json', description: 'What to locate: {"id": "what it is"}, or a list of descriptions.', examples: [FIND_EXAMPLE] },
      check: { type: 'json', description: 'Questions about the screen: question id -> {"type": "noul" | "choice" | "score", "instructions": ..., "criteria": ...}, as the system_one tool takes them.', examples: [CHECK_EXAMPLE] },
      expect: { type: 'string', description: 'What the screen should show now, in words.' },
      before: { type: 'string', description: 'Path to the screenshot taken before your last action.' },
      action: { type: 'string', description: 'What your last action was, e.g. "clicked Save".' },
      context: { type: 'string', description: 'What the screen is, e.g. "The Lumen Cloud console in a browser."' },
      annotate: {
        oneOf: [{ type: 'boolean' }, { type: 'string' }, { type: 'null' }],
        description: 'Where to save an annotated copy (PNG): boxes in red, click points in blue. A .png path, a folder for it, or true for <name>.annotated.png beside the screenshot.',
      },
      model: { type: 'string', description: `Decision model. Default ${config.screenModel}.` },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderScreen(value) }],
      presentationMeta: (_args, value) => screenPresentation(value, config.systemOneUi),
    },
    async execute(args, exec) {
      const notes = []
      // what to ask, also where it was written under another name
      args = { ...args }
      for (const [field, names] of Object.entries(ALIASES)) {
        const written = given(args[field]) ? undefined : names.find(name => given(args[name]))
        if (written) {
          args[field] = args[written]
          notes.push(`${written} read as ${field}`)
        }
      }
      const cwd = await workspaceOf(exec)
      const shot = await readShot(cwd, args.image, 'image')
      const find = targetsOf(args.find)
      let check = {}
      if (typeof args.check === 'string' && args.check.trim() && !/^\s*[[{"]/.test(args.check)) {
        // a check written as its words alone is a yes/no question
        check = { check: { type: 'noul', instructions: args.check.trim() } }
        notes.push('check read as a yes/no question')
      } else if (given(args.check)) {
        const read = readQuestions(args.check, { called: 'check' })
        check = read.questions
        notes.push(...read.notes)
      }
      // a question written alone, as "question": "Is the Billing page open?", is a yes/no check
      if (typeof args.question === 'string' && args.question.trim() && !Object.hasOwn(check, 'question')) {
        check = { ...check, question: { type: 'noul', instructions: args.question.trim() } }
        notes.push('question read as a yes/no check')
      }
      for (const [id, question] of Object.entries(check)) {
        // a box question is a target to find
        if (question.type === 'box') {
          let key = id
          for (let n = 2; Object.hasOwn(find, key); n++) key = `${id} (${n})`
          find[key] = question.instructions
          delete check[id]
          notes.push(`check ${id} is a box question: looked for under find`)
        } else if (kindOf(question) !== 'decision') throw new Error(`check "${id}": ask a noul, choice or score question here (span questions, presets and signals read text), and put what to locate in find`)
      }
      const expect = typeof args.expect === 'string' ? args.expect.trim() : ''
      const action = typeof args.action === 'string' ? args.action.trim() : ''
      if (action && !given(args.before)) throw new Error('action needs before: the path of the screenshot from before the action, as "before": "shots/02.png"')
      if (!Object.keys(find).length && !Object.keys(check).length && !expect && !given(args.before)) {
        const asked = Object.keys(args).filter(key => key !== 'image' && given(args[key]))
        throw new Error(`ask System One something about ${args.image}: find (what to locate, as ${JSON.stringify(FIND_EXAMPLE)}), check (questions about the screen), expect (what it should show), or before with action${asked.length ? `; this call gave only ${asked.join(', ')}` : ''}`)
      }
      const before = given(args.before) ? await readShot(cwd, args.before, 'before') : undefined
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

      // the annotated copy: a .png path, a folder for it, or beside the screenshot; a path without an image extension
      // names a folder unless a file is there already
      let annotateTo
      if (given(args.annotate) && args.annotate !== false && args.annotate !== 'false') {
        const beside = `${shot.path.slice(0, shot.path.length - extname(shot.path).length)}.annotated.png`
        if (shot.size.type !== 'png') notes.push('no annotated copy: annotate draws on PNG screenshots')
        else if (args.annotate === true || args.annotate === 'true') annotateTo = beside
        else {
          const named = resolve(cwd, String(args.annotate))
          const at = await kindAt(named)
          const into = at === 'directory' || (at === undefined && !/\.(png|jpe?g|webp)$/i.test(named))
          annotateTo = into ? join(named, basename(shot.path)) : named
          if (annotateTo === shot.path) annotateTo = beside
        }
      }

      const started = performance.now()
      let seen
      let compared
      try {
        [seen, compared] = await Promise.all([
          Object.keys(questions).length ? client.ask({ model, questions, inputs: [{ state: context || 'A screenshot of a user interface.', images: [shot.url] }], signal: exec.signal }) : undefined,
          before ? client.ask({
            model,
            questions: { succeeded: { type: 'noul', instructions: `The first image is the screen before the action, the second the screen after it. The action was: ${action || 'the last step of the task'}. Did the action succeed?` } },
            inputs: [{ state: `${context ? `${context} ` : ''}Two screenshots: before and after one action.`, images: [before.url, shot.url] }],
            signal: exec.signal,
          }) : undefined,
        ])
      } catch (error) {
        throw unavailable(error) ? new Error(unavailableText(error)) : error
      }
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
      if (annotateTo) {
        const marks = Object.values(found).filter(target => target.found).flatMap(target => [{ box: target.box }, { point: target.click }])
        await mkdir(dirname(annotateTo), { recursive: true })
        await writeFile(annotateTo, annotatePng(shot.bytes, marks))
        annotated = relative(cwd, annotateTo) || annotateTo
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
        ...(notes.length ? { notes } : {}),
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
