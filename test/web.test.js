import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const SOURCE = readFileSync(new URL('../web/client.js', import.meta.url), 'utf8')
const RECORD = 'plugin:vllm-sr/dsh/system-one'

// Just enough React to render the components once: elements are plain objects, state is its initial value.
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false) } }),
  useState: init => [typeof init === 'function' ? init() : init, () => {}],
  Component: class {
    constructor(props) {
      this.props = props
    }
  },
}

function load({ require = specifier => (specifier === 'react' ? fakeReact : assert.fail(`unexpected require ${specifier}`)), document } = {}) {
  const registered = []
  const warnings = []
  const context = vm.createContext({ window: { __ModuleLoader__: { load: spec => registered.push(spec) } }, console: { warn: (...args) => warnings.push(args.join(' ')) }, document })
  vm.runInContext(SOURCE, context)
  assert.equal(registered.length, 1)
  return { spec: registered[0], exports: registered[0].factory(require), warnings }
}

function render(node) {
  if (node === null || node === undefined || node === false) return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(render)
  const { type, props } = node
  if (typeof type === 'function') return render(type.prototype?.render ? new type(props).render() : type(props))
  return { type, props: { ...props, children: props.children.map(render) } }
}

const textOf = tree => (tree === null ? '' : typeof tree === 'string' ? tree : Array.isArray(tree) ? tree.map(textOf).join('') : textOf(tree.props.children))
function findAll(tree, match, found = []) {
  if (tree && typeof tree === 'object' && !Array.isArray(tree)) {
    if (match(tree.props ?? {})) found.push(tree)
    tree.props.children.forEach(child => findAll(child, match, found))
  } else if (Array.isArray(tree)) tree.forEach(child => findAll(child, match, found))
  return found
}

let seq = 10
const record = (data, extra = {}) => ({ type: RECORD, seq: seq++, time: Date.now(), ignorable: true, data: { v: 1, ui: 'card', turn: 1, step: 2, model: 'vllm-sr/d3-ultra', ms: 480, ...data }, ...extra })
const guardAnswers = (risk, leaks = 0.02, onTask = 0.95) => ({ risk: { score: risk, confidence: 0.8, p: {} }, exfiltration: { yes: leaks }, on_task: { yes: onTask } })

// The Conversation engine in miniature: the first match of an id starts its context, later ones update it.
function assemble(definition, events) {
  const contexts = new Map()
  for (const event of events) {
    const match = definition.match[event.type]?.call(definition, event) ?? null
    if (!match) continue
    const key = `${definition.kind}:${match.id}`
    const entry = { event, role: match.role, location: { kind: 'step' } }
    const context = contexts.get(key)
    if (!context) {
      const fresh = { key, id: match.id, matches: [entry], start: entry, state: undefined }
      fresh.state = definition.start(fresh, entry)
      contexts.set(key, fresh)
    } else {
      context.matches.push(entry)
      context.state = definition.update(context, entry)
    }
  }
  return [...contexts.values()].map(context => definition.buildViewNode(context))
}

test('the bundle registers as the package, requires no service, and draws into the Chat and tool slots', () => {
  const { spec, exports } = load()
  assert.equal(spec.id, '@vllm-sr/dsh')
  assert.ok(Array.isArray(exports.inject) && exports.inject.length === 0)
  const registered = []
  const scoped = {
    uiConversation: { events: { register: definition => registered.push(['definition', definition.kind]) } },
    slots: {
      inject: (name, run) => registered.push(['slot', name, typeof run()]),
      register: (options, component) => {
        registered.push(['entry', options.name, options.key, component.name])
        return () => {}
      },
    },
  }
  exports.apply({ inject: (deps, callback) => callback(scoped) })
  assert.deepEqual(registered, [
    ['definition', 'vllm-sr.system-one'],
    ['entry', 'conversation.chat.node', 'vllm-sr.system-one', 'SystemOneNode'],
    ['slot', 'conversation.chat.node', 'function'],
    ['entry', 'tool.call.toolview', 'system_one', 'SystemOneToolRow'],
    ['slot', 'tool.call.toolview', 'function'],
  ])
})

test('nothing the bundle meets can stop the Web UI from starting', () => {
  const broken = load({ require: () => { throw new Error('no react here') } })
  assert.equal(typeof broken.exports.apply, 'function')
  assert.doesNotThrow(() => broken.exports.apply({}))
  assert.match(broken.warnings[0], /views are off/)

  const { exports, warnings } = load()
  assert.doesNotThrow(() => exports.apply({ inject: () => { throw new Error('no inject') } }))
  assert.doesNotThrow(() => exports.apply({ inject: (deps, callback) => callback({ uiConversation: {}, slots: { inject: (name, run) => run(), register: () => { throw new Error('taken') } } }) }))
  assert.ok(warnings.length >= 3)
})

test('the styles join the page once, owned by the package', () => {
  const tags = []
  const document = {
    head: { appendChild: tag => tags.push(tag) },
    createElement: () => ({ dataset: {} }),
    querySelector: selector => tags.find(tag => selector.includes(tag.dataset.pluginCss)) ?? null,
  }
  load({ document })
  load({ document })
  assert.equal(tags.length, 1)
  assert.equal(tags[0].dataset.plugin, '@vllm-sr/dsh')
  assert.match(tags[0].textContent, /\.vsr-s1--card/)
  assert.match(tags[0].textContent, /prefers-reduced-motion/)
})

test('records group into one card per triage, per guard or shield step, and per done-check', () => {
  const { exports } = load()
  const nodes = assemble(exports.definition, [
    record({ reflex: 'triage', step: 1, answers: { kind: { choice: 'code', confidence: 0.91 }, effort: { score: 1.2 }, unclear: { yes: 0.04 }, risky: { yes: 0.07 } }, hints: [] }),
    record({ reflex: 'guard', callId: 'c1', tool: 'bash', call: 'ls', answers: guardAnswers(0.3), verdict: 'allow' }),
    record({ reflex: 'guard', callId: 'c2', tool: 'bash', call: 'pwd', answers: guardAnswers(0.2), verdict: 'allow' }),
    record({ reflex: 'shield', callId: 'c1', tool: 'bash', call: 'ls', passages: 1, flagged: 0, removedLines: 0, maxP: 0.02, verdict: 'clean' }),
    record({ reflex: 'guard', step: 3, callId: 'c3', tool: 'bash', call: 'rm -rf ~', answers: guardAnswers(2.9), verdict: 'deny', why: 'its risk is Critical' }),
    record({ reflex: 'done', answers: { complete: { yes: 0.94 }, checked: { yes: 0.8 }, waiting: { yes: 0.03 } }, verdict: 'stop', why: 'complete' }),
    { type: RECORD, seq: seq++, time: Date.now(), data: { v: 1, reflex: 'guard' } },
    { type: 'user/message', seq: seq++, time: Date.now(), data: {} },
  ])
  assert.deepEqual(nodes.map(node => [node.id, node.data.reflex, node.data.rows.length, node.groupTree]), [
    ['t1:triage', 'triage', 1, 'turn'],
    ['t1:s2:guard', 'guard', 2, undefined],
    ['t1:s2:shield', 'shield', 1, undefined],
    ['t1:s3:guard', 'guard', 1, 'turn'],
    [`r${seq - 3}`, 'done', 1, 'turn'],
  ])
  assert.ok(nodes.every(node => node.kind === 'vllm-sr.system-one' && node.target === 'chat' && node.visibility === 'visible'))
  assert.equal(nodes[1].anchorSeq, nodes[1].data.rows[0].seq)
})

test('a guard card names the call, the risk and the verdict, and takes in your answer to its question', () => {
  const { exports } = load()
  const [node] = assemble(exports.definition, [
    record({ reflex: 'guard', callId: 'c1', tool: 'bash', call: 'git status', answers: guardAnswers(0.31), verdict: 'allow' }),
    record({ reflex: 'guard', callId: 'c2', tool: 'bash', call: 'git push --force origin main', answers: guardAnswers(2.1), verdict: 'ask', why: 'its risk is Dangerous' }),
    record({ reflex: 'guard', callId: 'c2', tool: 'bash', call: 'git push --force origin main', outcome: 'rejected' }),
  ])
  assert.equal(node.groupTree, 'turn')
  assert.equal(node.data.rows.length, 2)
  const tree = render(exports.SystemOneNode({ node }))
  const text = textOf(tree)
  for (const expected of ['System One', '0.48 s', 'Guard', '2 calls · 1 allowed · 1 rejected by you', 'd3-ultra', 'Allowed', 'git status', 'Safe · 0.31 of 3',
    'Asked you', 'You rejected it', 'Dangerous · 2.10 of 3', 'Because its risk is Dangerous.', 'Leaks secrets', 'On task']) {
    assert.ok(text.includes(expected), `missing ${expected} in: ${text}`)
  }
  const [card] = findAll(tree, props => props['data-system-one'] === 'card')
  assert.deepEqual([card.props['data-system-one-reflex'], card.props['data-system-one-verdict'], card.props['data-system-one-count']], ['guard', 'ask', '2'])
  assert.match(card.props.className, /vsr-s1--bad/)
  assert.deepEqual(findAll(tree, props => props['data-system-one-decision']).map(row => [row.props['data-system-one-decision'], row.props['data-system-one-call']]), [['allow', 'c1'], ['ask', 'c2']])
})

const attrs = (element, names) => Object.fromEntries(names.map(name => [name, element.props[`data-system-one${name ? `-${name}` : ''}`]]))
const parts = tree => findAll(tree, props => props['data-system-one-part']).map(element => element.props['data-system-one-part'])
const ROOT = ['', 'reflex', 'verdict', 'outcome', 'why', 'tone', 'count', 'turn', 'step']

test('every element carries the selectors README.md documents', () => {
  const { exports } = load()
  const [guard, shield, routine, done, triage] = assemble(exports.definition, [
    record({ reflex: 'guard', step: 4, callId: 'c2', tool: 'bash', call: 'git reset --hard v1.3', answers: guardAnswers(2.0), verdict: 'ask', why: 'its risk is Dangerous' }),
    record({ reflex: 'guard', step: 4, callId: 'c2', tool: 'bash', call: 'git reset --hard v1.3', outcome: 'rejected' }),
    record({ reflex: 'shield', step: 3, callId: 'c1', tool: 'read', call: 'invoicekit/README.md', passages: 2, flagged: 1, removedLines: 6, maxP: 1, verdict: 'removed' }),
    record({ reflex: 'guard', step: 5, callId: 'c3', tool: 'bash', call: 'ls', answers: guardAnswers(0.4), verdict: 'allow' }),
    record({ reflex: 'done', answers: { complete: { yes: 0.02 }, checked: { yes: 0.5 }, waiting: { yes: 1 } }, verdict: 'stop', why: 'waiting' }),
    record({ reflex: 'triage', turn: 2, step: 1, answers: { kind: { choice: 'ops', confidence: 1 }, effort: { score: 1 }, unclear: { yes: 0 }, risky: { yes: 0.9 } }, hints: ['Be careful.'] }),
  ])

  const asked = render(exports.SystemOneNode({ node: guard }))
  const [card] = findAll(asked, props => props['data-system-one'])
  assert.deepEqual(attrs(card, ROOT), { '': 'card', reflex: 'guard', verdict: 'ask', outcome: 'rejected', why: undefined, tone: 'bad', count: '1', turn: '1', step: '4' })
  assert.deepEqual(parts(asked), ['head', 'badge', 'latency', 'reflex', 'summary', 'model', 'rows', 'verdict', 'outcome', 'subject', 'facts', 'note'])
  assert.deepEqual(findAll(asked, props => props['data-system-one-fact']).map(fact => fact.props['data-system-one-fact']), ['risk', 'leaks', 'on-task'])
  const [row] = findAll(asked, props => props['data-system-one-decision'])
  assert.deepEqual([row.props['data-system-one-decision'], row.props['data-system-one-outcome'], row.props['data-system-one-call']], ['ask', 'rejected', 'c2'])
  assert.equal(textOf(findAll(asked, props => props['data-system-one-part'] === 'outcome')[0]), 'You rejected it')
  assert.ok(textOf(findAll(asked, props => props['data-system-one-fact'] === 'risk')[0]).includes('Dangerous'))

  const [injection] = findAll(render(exports.SystemOneNode({ node: shield })), props => props['data-system-one'])
  assert.deepEqual(attrs(injection, ROOT), { '': 'card', reflex: 'shield', verdict: 'removed', outcome: undefined, why: undefined, tone: 'bad', count: '1', turn: '1', step: '3' })

  const line = render(exports.SystemOneNode({ node: routine }))
  assert.deepEqual(attrs(findAll(line, props => props['data-system-one'])[0], ['', 'reflex', 'verdict', 'tone']), { '': 'compact', reflex: 'guard', verdict: 'allow', tone: 'ok' })
  assert.deepEqual(parts(line), ['toggle', 'badge', 'latency', 'reflex', 'summary', 'verdict'])

  const doneTree = render(exports.SystemOneNode({ node: done }))
  assert.deepEqual(attrs(findAll(doneTree, props => props['data-system-one'])[0], ['', 'reflex', 'verdict', 'why', 'tone', 'step']), { '': 'card', reflex: 'done', verdict: 'stop', why: 'waiting', tone: 'info', step: undefined })
  assert.deepEqual(findAll(doneTree, props => props['data-system-one-fact']).map(fact => fact.props['data-system-one-fact']), ['complete', 'checked', 'waiting'])

  const triageTree = render(exports.SystemOneNode({ node: triage }))
  assert.deepEqual(attrs(findAll(triageTree, props => props['data-system-one'])[0], ['', 'reflex', 'verdict', 'turn']), { '': 'card', reflex: 'triage', verdict: 'brief', turn: '2' })
  assert.deepEqual(findAll(triageTree, props => props['data-system-one-fact']).map(fact => fact.props['data-system-one-fact']), ['kind', 'effort', 'unclear', 'risky'])

  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const selectors = readme.slice(readme.indexOf('### Selectors'), readme.indexOf('## Your data'))
  const drawn = new Set([...SOURCE.matchAll(/(?:'data-system-one-part'|\bpart): '([a-z-]+)'/g), ...SOURCE.matchAll(/\bid: '([a-z-]+)', label:/g)].map(match => match[1]))
  assert.ok(drawn.size >= 30)
  for (const value of drawn) assert.ok(selectors.includes(`\`${value}\``), `README.md documents ${value}`)
  for (const [, value] of selectors.matchAll(/data-system-one-(?:part|fact)="([a-z-]+)"/g)) assert.ok(drawn.has(value), `${value} is drawn by web/client.js`)
})

test('triage, shield and done-check cards say what System One decided', () => {
  const { exports } = load()
  const nodes = assemble(exports.definition, [
    record({ reflex: 'triage', step: 1, answers: { kind: { choice: 'ops', confidence: 0.88 }, effort: { score: 2.1 }, unclear: { yes: 0.12 }, risky: { yes: 0.71 } }, hints: ['Be careful: prefer reversible steps and confirm destructive ones.'] }),
    record({ reflex: 'shield', callId: 'c9', tool: 'web_fetch', call: 'https://example.com/page', passages: 4, flagged: 1, removedLines: 2, maxP: 0.97, verdict: 'removed' }),
    record({ reflex: 'done', answers: { complete: { yes: 0.31 }, checked: { yes: 0.12 }, waiting: { yes: 0.05 } }, verdict: 'continue', why: 'unfinished', steers: 1, maxSteers: 2 }),
  ])
  const [triage, shield, done] = nodes.map(node => textOf(render(exports.SystemOneNode({ node }))))
  for (const expected of ['Triage', 'Ops work · medium effort · risky', 'Ops 0.88', 'Medium · 2.1 of 3', 'Risky', '0.71', 'Brief for System Two: Be careful']) assert.ok(triage.includes(expected), `${expected} in ${triage}`)
  for (const expected of ['Shield', 'Injection removed', 'web_fetch', 'https://example.com/page', 'Passages', '0.97', 'Removed 2 lines that gave orders to AI agents']) assert.ok(shield.includes(expected), `${expected} in ${shield}`)
  for (const expected of ['Done-check', 'Sent back to System Two (1 of 2)', 'Complete', '0.31', 'Not finished yet, so System Two goes back to work (1 of 2).']) assert.ok(done.includes(expected), `${expected} in ${done}`)
  assert.equal(nodes[1].groupTree, 'turn')
})

test('a routine check is one line, compact mode makes every card one line, and an unreachable service says so', () => {
  const { exports } = load()
  const [routine] = assemble(exports.definition, [
    record({ reflex: 'guard', callId: 'c1', tool: 'bash', call: 'npm test', answers: guardAnswers(0.8), verdict: 'allow' }),
  ])
  const tree = render(exports.SystemOneNode({ node: routine }))
  const [chip] = findAll(tree, props => props['data-system-one'] === 'compact')
  assert.ok(chip, 'an allowed call draws as one line even in card mode')
  assert.ok(textOf(tree).includes('System One0.48 sGuardAllowed · bash npm test · risk Normal · 0.80 of 3'), textOf(tree))
  assert.equal(findAll(tree, props => props['data-system-one-decision']).length, 0, 'its details open on demand')

  const [triage] = assemble(exports.definition, [
    record({ ui: 'compact', reflex: 'triage', step: 1, answers: { kind: { choice: 'code', confidence: 0.9 }, effort: { score: 0.4 }, unclear: { yes: 0.1 }, risky: { yes: 0.1 } } }),
  ])
  const line = render(exports.SystemOneNode({ node: triage }))
  assert.equal(findAll(line, props => props['data-system-one'] === 'compact').length, 1)
  assert.ok(textOf(line).includes('TriageCode · effort Trivial · 0.4 of 3'), textOf(line))

  const [failed] = assemble(exports.definition, [record({ reflex: 'guard', callId: 'c2', tool: 'bash', call: 'make', verdict: 'allow', error: 'Decision API unreachable: timeout', model: undefined, ms: undefined })])
  const text = textOf(render(exports.SystemOneNode({ node: failed })))
  assert.ok(text.includes('Unavailable · bash make · Decision API unreachable: timeout'), text)
  assert.equal(failed.groupTree, undefined)
  assert.equal(exports.viewOf('guard', failed.data.rows[0]).note, 'System One did not answer (Decision API unreachable: timeout), so the call ran.')
})

test('the system_one row draws the batch from its result, and its progress while it runs', () => {
  const { exports } = load()
  const meta = {
    systemOne: 1, ui: 'card', model: 'vllm-sr/d3-ultra', items: 230, questions: 3, requests: 26, seconds: 4.12, output: '/work/support/tickets.s1.jsonl',
    summary: {
      team: { type: 'choice', counts: { billing: 61, engineering: 58, sales: 41, success: 38, security: 32 }, unsure: [], unsureCount: 9, failed: 0 },
      urgency: { type: 'score', mean: 2.4, levels: { Low: 80, Normal: 110, Urgent: 40 }, top: [], failed: 0 },
      churn_risk: { type: 'noul', yes: 37, no: 190, top: [], failed: 3 },
    },
  }
  const opened = []
  const props = { callId: 'call-7', toolName: 'system_one', cwd: '/work', openFile: path => opened.push(path), phase: 'result', block: { time: Date.now(), isError: false, content: [{ type: 'text', text: 'System One answered...' }], meta, call: { name: 'system_one', argsRaw: '{"file":"support/tickets.jsonl"}' } } }
  const tree = render(exports.SystemOneToolRow(props))
  const text = textOf(tree)
  for (const expected of ['System One', '4.12 s', 'Batch', '230 items · 3 questions · 26 requests', 'team', 'billing', '61', '9 unsure', 'urgency', 'mean 2.4', 'churn_risk', 'yes', '190', '3 failed', 'support/tickets.s1.jsonl']) {
    assert.ok(text.includes(expected), `${expected} in ${text}`)
  }
  findAll(tree, props => props.className === 'vsr-s1__link')[0].props.onClick()
  assert.deepEqual(opened, ['/work/support/tickets.s1.jsonl'])
  const root = tree => findAll(tree, props => props['data-system-one'])[0]
  assert.deepEqual(attrs(root(tree), ['', 'reflex', 'verdict', 'tone', 'count', 'call']), { '': 'tool', reflex: 'tool', verdict: 'done', tone: 'ok', count: '230', call: 'call-7' })
  assert.deepEqual(findAll(tree, props => props['data-system-one-question']).map(question => question.props['data-system-one-question']), ['team', 'urgency', 'churn_risk'])
  for (const part of ['head', 'badge', 'latency', 'model', 'stack', 'legend', 'failed', 'results']) assert.ok(parts(tree).includes(part), `part ${part}`)
  assert.match(findAll(tree, props => props['data-system-one-part'] === 'failed')[0].props.className, /vsr-s1__key--bad/)

  const running = render(exports.SystemOneToolRow({ ...props, phase: 'start', block: { argsRaw: '{"file":"support/tickets.jsonl","questions":{"team":{},"urgency":{},"churn_risk":{}}}' } }))
  assert.ok(textOf(running).includes('Answering 3 questions over tickets.jsonl'), textOf(running))
  assert.deepEqual(attrs(root(running), ['', 'verdict']), { '': 'tool', verdict: 'running' })

  const failed = render(exports.SystemOneToolRow({ ...props, block: { ...props.block, isError: true, meta: undefined, content: [{ type: 'text', text: 'Error: questions must be an object' }] } }))
  assert.ok(textOf(failed).includes('Error: questions must be an object'))
  assert.deepEqual(attrs(root(failed), ['', 'verdict', 'tone']), { '': 'tool', verdict: 'error', tone: 'bad' })
})
