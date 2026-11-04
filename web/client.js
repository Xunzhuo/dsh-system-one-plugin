/**
 * @vllm-sr/dsh in DeepSeek Harness's Web UI: System One's decisions, drawn in Chat.
 *
 * The host half records each decision System One makes in the session (src/records.js). This browser half turns the
 * records into Chat rows, one card or one compact line per System One call, grouped by turn, step and reflex, and draws
 * the system_one tool's row from its result. Everything it shows comes from those records and results.
 *
 * Plain JavaScript in the Web UI's client-module format, with no build step: React comes from the page's shared module
 * table. The Web UI does not start when a browser plugin fails to, so this one requires no service, attaches each part
 * only once its service exists, and contains its own errors. The Web UI joins plugin scripts into one classic script,
 * so nothing may be declared outside the factory.
 */
window.__ModuleLoader__.load({
  id: '@vllm-sr/dsh',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    exports.inject = []
    exports.apply = function apply() {}
    try {
      const React = require('react')
      const h = React.createElement

      const PACKAGE = '@vllm-sr/dsh'
      const RECORD_TYPE = 'plugin:vllm-sr/dsh/system-one'
      const NODE_KIND = 'vllm-sr.system-one'
      const TOOL_NAME = 'system_one'
      // a decision younger than this animates the first time this page draws it; history stays still
      const FRESH_MS = 20000
      const ROWS_SHOWN = 4

      const REFLEX = { triage: 'Triage', guard: 'Guard', shield: 'Shield', privacy: 'Privacy', done: 'Done-check', tool: 'Batch' }
      const KINDS = { code: 'Code', data: 'Data', research: 'Research', writing: 'Writing', ops: 'Ops', chat: 'Chat' }
      const EFFORT = ['Trivial', 'Small', 'Medium', 'Large']
      const RISK = ['Safe', 'Normal', 'Dangerous', 'Critical']
      // the vLLM logo's blue (#30A2FF) leads; its gold and cool neighbours tell the other options apart
      const HUES = ['#30A2FF', '#1559B5', '#7CCBFF', '#6E7CF5', '#FDB515', '#2BB3A3', '#A9C6FF', '#0B3A75']
      const RAMP = ['#C5E5FF', '#97D0FF', '#63B8FF', '#30A2FF', '#1E85E3', '#1667C4', '#0F4C94']
      const SEVERITY = { muted: 0, ok: 1, info: 2, warn: 3, bad: 4 }

      const GUARD = {
        allow: { label: 'Allowed', short: 'allowed', tone: 'ok' },
        ask: { label: 'Asked you', short: 'asked you', tone: 'warn' },
        deny: { label: 'Blocked', short: 'blocked', tone: 'bad' },
      }
      const OUTCOME = {
        allowed: { label: 'You allowed it', short: 'allowed by you', tone: 'ok' },
        rejected: { label: 'You rejected it', short: 'rejected by you', tone: 'bad' },
        cancelled: { label: 'Not run', short: 'not run', tone: 'muted' },
        failed: { label: 'Call failed', short: 'failed', tone: 'muted' },
      }
      const SHIELD = {
        clean: { label: 'Clean', short: 'clean', tone: 'ok' },
        removed: { label: 'Injection removed', short: 'injection removed', tone: 'bad' },
        flagged: { label: 'Injection found', short: 'injection found', tone: 'bad' },
      }
      const DONE = {
        complete: { label: 'Done', tone: 'ok' },
        waiting: { label: 'Waiting on you', tone: 'info' },
        declined: { label: 'Declined', tone: 'info' },
        unfinished: { label: 'Sent back', tone: 'warn' },
        unchecked: { label: 'Sent back to verify', tone: 'warn' },
        unsupported: { label: 'Sent back to re-verify', tone: 'warn' },
      }

      const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
      const p2 = value => (num(value) === undefined ? '?' : value.toFixed(2))
      // under a second in milliseconds (182 ms), from a second up in seconds (1.4 s)
      const secs = ms => (num(ms) === undefined ? '' : Math.round(ms) < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`)
      // the probability of one option of a choice answer, as the records keep it
      const optionOf = (answer, option) => num(answer?.p?.[option])
      // System One's models are vllm-sr's; the name always shows its owner, whatever form the answer gave it in
      const fullModel = model => (typeof model === 'string' && model ? (model.includes('/') ? model : `vllm-sr/${model}`) : '')
      const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
      const clamp01 = value => Math.min(1, Math.max(0, value))
      const level = (labels, score) => labels[Math.min(labels.length - 1, Math.max(0, Math.round(score)))]
      const yesOf = answer => num(answer?.yes)
      const scoreOf = answer => num(answer?.score)
      const cx = (...names) => names.filter(Boolean).join(' ')
      const text = value => (typeof value === 'string' ? value : '')
      const basename = path => text(path).split(/[\\/]/).filter(Boolean).pop() ?? text(path)

      // ---- the session records, folded into one Chat node per group ----

      function recordOf(event) {
        if (!event || event.type !== RECORD_TYPE || event.ignorable !== true) return undefined
        const data = event.data
        return data && typeof data === 'object' && data.v === 1 && typeof data.reflex === 'string' ? data : undefined
      }

      // one card per triage of a turn, per guard, shield or privacy step (parallel calls share it), per done-check
      function groupOf(data, seq) {
        const turn = Number.isSafeInteger(data.turn) ? data.turn : undefined
        const step = Number.isSafeInteger(data.step) ? data.step : undefined
        if (data.reflex === 'triage' && turn !== undefined) return `t${turn}:triage`
        if (['guard', 'shield', 'privacy'].includes(data.reflex) && turn !== undefined && step !== undefined) return `t${turn}:s${step}:${data.reflex}`
        // a done-check that was still deciding and its answer share one element
        if (data.reflex === 'done' && typeof data.decision === 'string') return `d:${data.decision}`
        return `r${seq}`
      }

      function fold(state, event) {
        const data = recordOf(event)
        const base = state ?? { reflex: data?.reflex ?? 'unknown', ui: data?.ui === 'compact' ? 'compact' : 'card', rows: [] }
        if (!data) return base
        // the answer to an approval the guard asked for completes that call's row
        if (typeof data.outcome === 'string' && data.callId !== undefined) {
          const at = base.rows.findIndex(row => row.callId === data.callId && row.outcome === undefined)
          if (at >= 0) {
            const rows = base.rows.slice()
            rows[at] = { ...rows[at], outcome: data.outcome }
            return { ...base, rows }
          }
        }
        const row = { ...data, seq: event.seq, time: event.time }
        // a decision's answer takes the place of the row that showed it deciding
        if (typeof data.decision === 'string') {
          const at = base.rows.findIndex(other => other.decision === data.decision)
          if (at >= 0) {
            const rows = base.rows.slice()
            rows[at] = row
            return { ...base, rows }
          }
        }
        return { ...base, rows: [...base.rows, row] }
      }

      // Triage and done-check frame the turn and stay visible when it folds; so does a guard or shield card that
      // stopped something. A routine one sits with the work it checked and folds with it.
      function standsOut(state) {
        // a decision still deciding, or stopped, is one line until its answer comes
        if (state.rows.every(row => row.pending || row.verdict === 'cancelled')) return false
        if (state.reflex === 'privacy') return state.rows.some(row => row.verdict === 'masked' || row.error)
        if (state.reflex !== 'guard' && state.reflex !== 'shield') return true
        return state.rows.some(row => SEVERITY[viewOf(state.reflex, row).tone] >= SEVERITY.warn)
      }

      const definition = {
        kind: NODE_KIND,
        target: 'chat',
        match: {
          [RECORD_TYPE](event) {
            const data = recordOf(event)
            // every record is complete on its own, so any of them can open its group's card
            return data ? { id: groupOf(data, event.seq), role: 'start' } : null
          },
        },
        start: (_context, match) => fold(undefined, match.event),
        update: (context, match) => fold(context.state, match.event),
        publication: () => 'immediate',
        buildViewNode(context) {
          const state = context.state
          if (!state || state.rows.length === 0) return null
          const first = context.start ?? context.matches[0]
          return {
            key: context.key,
            kind: NODE_KIND,
            id: context.id,
            target: 'chat',
            anchorSeq: first?.event?.seq ?? state.rows[0].seq,
            location: first?.location ?? { kind: 'unresolved' },
            visibility: 'visible',
            groupTree: standsOut(state) ? 'turn' : undefined,
            data: state,
          }
        },
      }

      // ---- what each decision says ----

      function errorView(row, fallback) {
        return {
          verdict: 'error', label: 'Unavailable', short: 'unavailable', tone: fallback?.tone ?? 'muted', error: text(row.error),
          subject: row.call ? { tool: row.tool, text: row.call } : undefined, facts: [],
          note: `System One did not answer (${text(row.error)})${fallback ? `, ${fallback.text}` : ''}.`,
        }
      }

      function triageView(row) {
        if (row.error) return errorView(row)
        const a = row.answers ?? {}
        const kind = text(a.kind?.choice)
        const confidence = num(a.kind?.confidence)
        const effort = scoreOf(a.effort)
        const unclear = yesOf(a.unclear)
        const risky = yesOf(a.risky)
        const kindLabel = KINDS[kind] ?? (kind || '?')
        const effortLabel = effort === undefined ? '?' : level(EFFORT, effort)
        const flags = [unclear >= 0.6 && 'unclear', risky >= 0.5 && 'risky'].filter(Boolean)
        const hints = Array.isArray(row.hints) ? row.hints.filter(hint => typeof hint === 'string') : []
        return {
          verdict: 'brief', label: kindLabel, short: kindLabel.toLowerCase(), tone: 'info',
          headline: [`${kindLabel} work`, `${effortLabel.toLowerCase()} effort`, ...flags].join(' · '),
          facts: [
            { id: 'kind', label: 'Kind', value: `${kindLabel} ${p2(confidence)}`, bar: confidence },
            { id: 'effort', label: 'Effort', value: effort === undefined ? '?' : `${effortLabel} · ${effort.toFixed(1)} of 3`, short: effort === undefined ? undefined : `${effortLabel} ${effort.toFixed(1)}`, bar: effort === undefined ? undefined : effort / 3 },
            { id: 'unclear', label: 'Unclear', value: p2(unclear), bar: unclear, tone: unclear >= 0.6 ? 'warn' : undefined },
            { id: 'risky', label: 'Risky', value: p2(risky), bar: risky, tone: risky >= 0.5 ? 'bad' : undefined },
          ],
          note: hints.length ? `Brief for System Two: ${hints.join(' ')}` : undefined,
        }
      }

      function guardView(row) {
        const outcome = OUTCOME[row.outcome]
        if (row.error) {
          const fallback = { allow: { text: 'so the call ran', tone: 'muted' }, ask: { text: 'so you were asked', tone: 'warn' }, deny: { text: 'so the call was blocked', tone: 'bad' } }[row.verdict]
          return { ...errorView(row, fallback), outcome, outcomeKey: outcome ? row.outcome : undefined }
        }
        const subject = { tool: row.tool, text: row.call }
        const verdict = GUARD[row.verdict]
        if (!verdict) return { verdict: row.outcome ?? 'unknown', ...(outcome ?? { label: 'Reviewed', short: 'reviewed', tone: 'muted' }), outcomeKey: outcome ? row.outcome : undefined, subject, facts: [] }
        const a = row.answers ?? {}
        const risk = scoreOf(a.risk)
        const leaks = yesOf(a.exfiltration)
        const onTask = yesOf(a.on_task)
        // vllm-sr/vela3-turbo's router safety heads: is the call itself harmful, and is the request it serves
        const harm = optionOf(a.r_harm, 'unsafe response')
        const unsafe = optionOf(a.p_harm, 'unsafe')
        const facts = []
        if (risk !== undefined) {
          const named = level(RISK, Math.min(3, risk))
          const dangerous = risk >= 1.8
          facts.push({ id: 'risk', label: 'Risk', value: `${named} · ${risk.toFixed(2)} of 3`, short: `${named} ${risk.toFixed(2)}`, chip: dangerous ? named : undefined, chipTone: 'bad', bar: risk / 3 })
        }
        if (leaks !== undefined) facts.push({ id: 'leaks', label: 'Leaks secrets', value: p2(leaks), bar: leaks, tone: leaks >= 0.7 ? 'bad' : undefined })
        if (onTask !== undefined) facts.push({ id: 'on-task', label: 'On task', value: p2(onTask), bar: onTask })
        if (harm !== undefined) facts.push({ id: 'harm', label: 'Harmful call', value: p2(harm), bar: harm })
        if (unsafe !== undefined) facts.push({ id: 'request-harm', label: 'Harmful request', value: p2(unsafe), bar: unsafe })
        const danger = Array.isArray(row.danger) ? row.danger.filter(span => typeof span?.text === 'string' && span.text) : []
        return {
          verdict: row.verdict, ...verdict, subject: danger.length ? { ...subject, marks: danger, kind: 'dangerous' } : subject, facts, outcome, outcomeKey: outcome ? row.outcome : undefined, verdictTone: verdict.tone,
          tone: outcome && SEVERITY[outcome.tone] > SEVERITY[verdict.tone] ? outcome.tone : verdict.tone,
          note: row.verdict !== 'allow' && row.why ? `Because ${row.why}.` : undefined,
        }
      }

      function shieldView(row) {
        if (row.error) return errorView(row, { text: 'so the result was passed on unscreened', tone: 'muted' })
        const verdict = SHIELD[row.verdict] ?? SHIELD.clean
        const lines = num(row.removedLines) ?? 0
        const spans = num(row.removedSpans) ?? 0
        const what = spans ? `${plural(spans, 'span')} of text (${plural(num(row.removedChars) ?? 0, 'character')})` : plural(lines, 'line')
        return {
          verdict: row.verdict, ...verdict, subject: { tool: row.tool, text: row.call },
          facts: [
            { id: 'passages', label: 'Passages', value: String(num(row.passages) ?? '?') },
            { id: 'injection', label: 'Injection', value: p2(row.maxP), bar: num(row.maxP), tone: row.maxP >= 0.5 ? 'bad' : undefined },
            ...(spans ? [{ id: 'spans', label: 'Spans removed', value: String(spans) }] : []),
          ],
          excerpts: Array.isArray(row.excerpts) ? { list: row.excerpts, kind: 'removed' } : undefined,
          note: row.verdict === 'removed' ? `Removed ${what} that gave orders to AI agents before System Two read the result${spans ? '; the text around it stayed' : ''}.`
            : row.verdict === 'flagged' ? `Found ${what} that give orders to AI agents; the result was withheld.` : undefined,
        }
      }

      function privacyView(row) {
        if (row.error) return errorView(row, { text: 'so the result went to System Two unmasked', tone: 'warn' })
        if (row.verdict === 'clean') {
          return { verdict: 'clean', label: 'Nothing to mask', short: 'nothing to mask', tone: 'ok', subject: row.call ? { tool: row.tool, text: row.call } : undefined, facts: [{ id: 'masked', label: 'Masked', value: '0' }] }
        }
        const masked = num(row.masked) ?? 0
        const labels = row.labels && typeof row.labels === 'object' ? Object.entries(row.labels).filter(([, n]) => num(n)) : []
        return {
          verdict: 'masked', label: 'Masked', short: 'masked', tone: 'info',
          headline: `${plural(masked, 'personal detail')} masked${row.tool ? ` · ${row.tool}` : ''}`,
          subject: row.call ? { tool: row.tool, text: row.call } : undefined,
          facts: [{ id: 'masked', label: 'Masked', value: String(masked) }],
          labels: labels.map(([label, n]) => ({ label, n })),
          excerpts: Array.isArray(row.excerpts) ? { list: row.excerpts, kind: 'masked' } : undefined,
          note: 'System Two read [LABEL] placeholders instead of these details.',
        }
      }

      function doneView(row) {
        if (row.error) return errorView(row, { text: 'so the turn ended as it was', tone: 'muted' })
        const a = row.answers ?? {}
        const why = DONE[row.why] ? row.why : row.verdict === 'continue' ? 'unfinished' : 'complete'
        const verdict = DONE[why]
        const round = `${num(row.steers) ?? '?'} of ${num(row.maxSteers) ?? '?'}`
        const unsupported = num(row.unsupported) ?? 0
        const declined = optionOf(a.r_refusal, 'refusal')
        return {
          verdict: row.verdict === 'continue' ? 'continue' : 'stop', ...verdict, why, short: verdict.label.toLowerCase(),
          headline: row.verdict === 'continue' ? `${verdict.label} to System Two (${round})` : why === 'waiting' ? 'Waiting on you' : why === 'declined' ? 'System Two declined' : 'The work is done',
          facts: [
            { id: 'complete', label: 'Complete', value: p2(yesOf(a.complete)), bar: yesOf(a.complete) },
            { id: 'checked', label: 'Checked', value: p2(yesOf(a.checked)), bar: yesOf(a.checked) },
            { id: 'waiting', label: 'Waiting on you', value: p2(yesOf(a.waiting)), bar: yesOf(a.waiting) },
            ...(declined === undefined ? [] : [{ id: 'declined', label: 'Declined', value: p2(declined), bar: declined }]),
            ...(row.spanModel ? [{ id: 'unsupported', label: 'Unsupported', value: String(unsupported), tone: unsupported ? 'warn' : undefined }] : []),
          ],
          excerpts: unsupported && Array.isArray(row.excerpts) ? { list: row.excerpts, kind: 'unsupported' } : undefined,
          note: why === 'unfinished' ? `Not finished yet, so System Two goes back to work (${round}).`
            : why === 'unchecked' ? `The changes were not checked, so System Two goes back to verify them (${round}).`
              : why === 'unsupported' ? `Nothing System Two read supports ${plural(unsupported, 'claim')} in its answer, so it goes back to re-verify just ${unsupported === 1 ? 'that one' : 'those'} (${round}).`
                : why === 'declined' ? 'System Two declined or was refused, so System One did not send it back.'
                  : unsupported ? `Nothing System Two read supports ${plural(unsupported, 'claim')} in its answer.` : undefined,
        }
      }

      // what a decision that has no answer yet says, and one whose turn stopped before it was answered
      const WAITING = {
        guard: 'reviewing the call', shield: 'screening the result', privacy: 'looking for personal data', done: 'checking the work', triage: 'reading the request',
      }
      function waitingView(reflex, row) {
        const subject = row.call ? { tool: row.tool, text: row.call } : undefined
        if (row.pending) return { verdict: 'deciding', label: 'Deciding', short: 'deciding', tone: 'info', pending: true, detail: WAITING[reflex] ?? 'thinking', subject, facts: [] }
        return { verdict: 'cancelled', label: 'Stopped', short: 'stopped', tone: 'muted', detail: 'the turn stopped before System One answered', subject, facts: [] }
      }

      function viewOf(reflex, row) {
        if (row.pending || row.verdict === 'cancelled') return waitingView(reflex, row)
        switch (reflex) {
          case 'triage': return triageView(row)
          case 'guard': return guardView(row)
          case 'shield': return shieldView(row)
          case 'done': return doneView(row)
          case 'privacy': return privacyView(row)
          default: return row.error ? errorView(row) : { verdict: 'unknown', label: 'Decision', short: 'decision', tone: 'muted', facts: [] }
        }
      }

      function worstOf(views) {
        return views.reduce((worst, view) => (SEVERITY[view.tone] > SEVERITY[worst.tone] ? view : worst), views[0])
      }

      function headlineOf(reflex, views) {
        if (views.length === 1) {
          const view = views[0]
          if (view.headline) return view.headline
          const said = [view.label, view.outcome?.label].filter(Boolean).join(' → ')
          return view.subject?.tool ? `${said} · ${view.subject.tool}` : said
        }
        const counts = new Map()
        for (const view of views) {
          const key = view.outcome?.short ?? view.short
          counts.set(key, (counts.get(key) ?? 0) + 1)
        }
        const noun = reflex === 'guard' ? 'call' : reflex === 'shield' || reflex === 'privacy' ? 'result' : 'decision'
        return [plural(views.length, noun), ...[...counts].map(([short, n]) => `${n} ${short}`)].join(' · ')
      }

      // one line: the verdict, then what it was about and its leading number, each a part of the row
      function compactLine(view) {
        const label = view.outcome ? `${view.label} → ${view.outcome.label}` : view.label
        const rest = []
        if (view.detail) rest.push(view.detail)
        if (view.subject?.text) rest.push(`${view.subject.tool ?? ''} ${view.subject.text}`.trim())
        const lead = view.facts.find(fact => ['risk', 'injection', 'complete', 'effort', 'masked'].includes(fact.id))
        if (lead) rest.push(`${lead.label.toLowerCase()} ${lead.short ?? lead.value}`)
        if (view.error) rest.push(view.error)
        return { label, tone: view.tone, rest }
      }

      // ---- drawing ----

      const seen = new Set()
      // true once per decision, when this page first draws it while it is fresh
      function firstSight(id, time) {
        if (seen.has(id)) return false
        if (seen.size > 4000) seen.clear()
        seen.add(id)
        return num(time) !== undefined && Math.abs(Date.now() - time) < FRESH_MS
      }
      const useFresh = (id, time) => React.useState(() => firstSight(id, time))[0]
      const idOf = row => `${row.time}:${row.seq}:${row.reflex}:${row.callId ?? ''}`

      class Contained extends React.Component {
        constructor(props) {
          super(props)
          this.state = { failed: false }
        }

        static getDerivedStateFromError() {
          return { failed: true }
        }

        componentDidCatch(error) {
          console.warn(`[${PACKAGE}] a System One card failed to draw:`, error)
        }

        render() {
          return this.state.failed ? null : this.props.children
        }
      }

      // A System One line is drawn as DeepSeek Harness draws a tool row: an icon in a 16 px slot, then its parts in the
      // row's muted text with a dot between each, and "System One" in blue as its only accent. While System One decides,
      // a band of light sweeps across the line, as it does across a running tool's row.
      function Bolt() {
        return h('svg', { className: 'vsr-s1__bolt', viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true },
          h('path', { d: 'M9.4 1.6 3.6 9h4.1l-1.1 5.4L12.4 7H8.3l1.1-5.4Z', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round' }))
      }

      // the icon slot; a row that opens shows its chevron there on hover, and while open
      function Lead({ glyph, toggles }) {
        return h('span', { className: 'vsr-s1__lead', 'data-system-one-part': 'icon', 'aria-hidden': true },
          h('span', { className: 'vsr-s1__icon' }, glyph ?? h(Bolt)),
          toggles ? h(Chevron) : null)
      }

      // the parts of a row, with a dot between each
      function joined(list) {
        const out = []
        for (const part of list.filter(Boolean)) {
          if (out.length) out.push(h('i', { className: 'vsr-s1__sep', 'aria-hidden': true }))
          out.push(part)
        }
        return out
      }

      // `marked` puts the selectors on the parts; the shimmer's copy of the line goes without them
      const nameOf = (marked, name = 'System One') => h('b', { className: 'vsr-s1__name', 'data-system-one-part': marked ? 'badge' : undefined }, name)
      const latencyOf = (marked, ms) => (secs(ms) ? h('span', { className: 'vsr-s1__ms', 'data-system-one-part': marked ? 'latency' : undefined }, secs(ms)) : null)
      const reflexOf = (marked, reflex) => h('span', { className: 'vsr-s1__reflex', 'data-system-one-part': marked ? 'reflex' : undefined }, reflex)

      // DeepSeek Harness's row shimmer: a copy of the line in the shimmer colour, seen through a window that sweeps across
      function Shimmer({ active, line }) {
        return h('span', { className: 'vsr-s1__shim', 'data-shimmer': active || undefined },
          h('span', { className: 'vsr-s1__shim-line' }, ...line(true)),
          active ? h('span', { className: 'vsr-s1__shim-deco', 'data-system-one-part': 'progress', 'aria-hidden': true },
            h('span', { className: 'vsr-s1__shim-sweep' }, h('span', { className: 'vsr-s1__shim-line vsr-s1__shim-copy' }, ...line(false)))) : null)
      }

      // a line that said deciding and now has its answer settles once, in place
      const waitedOn = new Map()
      function settles(row) {
        const id = row?.decision
        if (typeof id !== 'string') return false
        if (row.pending) {
          if (waitedOn.size > 2000) waitedOn.clear()
          waitedOn.set(id, 0)
          return false
        }
        const since = waitedOn.get(id)
        if (since === undefined) return false
        if (since === 0) waitedOn.set(id, Date.now())
        else if (Date.now() - since > 1500) {
          waitedOn.delete(id)
          return false
        }
        return true
      }

      // one name: the model that answered; another one (the span model, when it differs) is named in the rows
      function Model({ model }) {
        const name = fullModel(model)
        return name ? h('b', { className: 'vsr-s1__model', 'data-system-one-part': 'model', title: name }, name) : null
      }

      // what a span model marked: removed injections, masked personal data (only its label), unsupported claims
      function Mark({ mark, kind }) {
        const p = num(mark.probability)
        return h('mark', {
          className: cx('vsr-s1__span', `vsr-s1__span--${kind}`),
          'data-system-one-part': 'span',
          'data-system-one-span-label': text(mark.label) || undefined,
          'data-system-one-probability': p === undefined ? undefined : String(p),
          title: [text(mark.label), p === undefined ? '' : p.toFixed(2)].filter(Boolean).join(' · '),
        }, kind === 'masked' ? text(mark.label) || 'PII' : text(mark.text))
      }

      function Excerpts({ excerpts }) {
        return h('div', { className: 'vsr-s1__excerpts', 'data-system-one-part': 'excerpts' },
          excerpts.list.slice(0, 3).map((parts, index) => h('div', { key: index, className: 'vsr-s1__excerpt', 'data-system-one-part': 'excerpt' },
            (Array.isArray(parts) ? parts : []).map((part, at) => (part?.mark ? h(Mark, { key: at, mark: part.mark, kind: excerpts.kind }) : h('span', { key: at }, text(part?.text)))))))
      }

      // the subject with each marked text highlighted where it first occurs
      function Marked({ value, marks, kind }) {
        const pieces = []
        let rest = value
        for (const mark of marks) {
          const at = rest.indexOf(mark.text)
          if (at < 0) continue
          if (at > 0) pieces.push(rest.slice(0, at))
          pieces.push(h(Mark, { key: pieces.length, mark, kind }))
          rest = rest.slice(at + mark.text.length)
        }
        return [...pieces, rest]
      }

      function Pill({ tone, children, arrow, part }) {
        return h('span', { className: cx('vsr-s1__pill', `vsr-s1__pill--${tone}`, arrow && 'vsr-s1__pill--then'), 'data-system-one-part': part }, children)
      }

      function Fact({ id, label, value, bar, tone, chip, chipTone }) {
        // a level worth a warning ("Dangerous") is a chip in its tone, the rest of the value beside it
        const rest = chip && value.startsWith(chip) ? value.slice(chip.length) : undefined
        return h('span', { className: 'vsr-s1__fact', 'data-system-one-fact': id },
          h('span', { className: 'vsr-s1__fact-label' }, label),
          num(bar) === undefined ? null : h('span', { className: cx('vsr-s1__bar', tone && `vsr-s1__bar--${tone}`), style: { '--p': clamp01(bar) }, 'aria-hidden': true }, h('i')),
          rest === undefined ? h('b', null, value) : h('b', null, h('span', { className: cx('vsr-s1__level', `vsr-s1__level--${chipTone ?? tone}`) }, chip), rest))
      }

      function Row({ row, view, single, index = 0 }) {
        const fresh = useFresh(`row:${idOf(row)}`, row.time)
        return h('div', {
          className: cx('vsr-s1__row', fresh && 'vsr-s1__row--fresh'),
          style: fresh ? { '--vsr-s1-i': Math.min(index, 6) } : undefined,
          'data-system-one-decision': view.verdict,
          'data-system-one-outcome': view.outcomeKey,
          'data-system-one-call': row.callId,
        },
        h('span', { className: 'vsr-s1__verdicts' },
          h(Pill, { tone: view.verdictTone ?? view.tone, part: 'verdict' }, view.label),
          view.outcome ? h(Pill, { tone: view.outcome.tone, arrow: true, part: 'outcome' }, view.outcome.label) : null),
        h('div', { className: 'vsr-s1__main' },
          view.subject?.text ? h('div', { className: 'vsr-s1__subject', 'data-system-one-part': 'subject' },
            view.subject.tool ? h('span', { className: 'vsr-s1__tool' }, view.subject.tool) : null,
            h('code', { className: 'vsr-s1__code', title: view.subject.text }, view.subject.marks ? h(Marked, { value: view.subject.text, marks: view.subject.marks, kind: view.subject.kind }) : view.subject.text)) : null,
          view.subject?.marks && view.subject.marks.some(mark => !view.subject.text.includes(mark.text))
            ? h('div', { className: 'vsr-s1__note', 'data-system-one-part': 'note' }, 'The dangerous part: ', view.subject.marks.map((mark, index) => h(Mark, { key: index, mark, kind: view.subject.kind }))) : null,
          view.facts.length ? h('div', { className: 'vsr-s1__facts', 'data-system-one-part': 'facts' }, view.facts.map(fact => h(Fact, { key: fact.id, ...fact }))) : null,
          view.labels?.length ? h('div', { className: 'vsr-s1__labels', 'data-system-one-part': 'labels' }, view.labels.map(entry => h('span', { key: entry.label, className: 'vsr-s1__label', 'data-system-one-span-label': entry.label }, entry.label, h('b', null, String(entry.n))))) : null,
          view.excerpts?.list?.length ? h(Excerpts, { excerpts: view.excerpts }) : null,
          view.note ? h('div', { className: 'vsr-s1__note', 'data-system-one-part': 'note' }, view.note) : null,
          fullModel(row.spanModel) && fullModel(row.spanModel) !== fullModel(row.model)
            ? h('div', { className: 'vsr-s1__note', 'data-system-one-part': 'span-model' }, 'Spans by ', h('b', { className: 'vsr-s1__by' }, fullModel(row.spanModel)), secs(row.spanMs) ? ` · ${secs(row.spanMs)}` : '') : null),
        !single && secs(row.ms) ? h('span', { className: 'vsr-s1__rowms', 'data-system-one-part': 'latency' }, secs(row.ms)) : null)
      }

      function Rows({ reflex, rows, views }) {
        const [all, setAll] = React.useState(false)
        const hidden = all ? 0 : Math.max(0, rows.length - ROWS_SHOWN)
        return h('div', { className: 'vsr-s1__rows', 'data-system-one-part': 'rows' },
          hidden > 0 ? h('button', { type: 'button', className: 'vsr-s1__more', 'data-system-one-part': 'more', onClick: () => setAll(true) }, `Show ${plural(hidden, `earlier ${reflex === 'guard' ? 'call' : 'result'}`)}`) : null,
          rows.slice(hidden).map((row, index) => h(Row, { key: idOf(row), row, view: views[hidden + index], single: rows.length === 1, index })))
      }

      const whole = value => (Number.isSafeInteger(value) ? String(value) : undefined)

      // how many spans a span model marked in an element's decisions
      function spanCount(state) {
        const n = state.rows.reduce((sum, row) => sum + (num(row.removedSpans) ?? 0) + (num(row.masked) ?? 0) + (num(row.unsupported) ?? 0) + (Array.isArray(row.danger) ? row.danger.length : 0), 0)
        return n ? String(n) : undefined
      }

      // a public contract (README.md, "Selectors"); React leaves out an attribute whose value is undefined
      function attributes(kind, state, worst) {
        return {
          'data-system-one': kind,
          'data-system-one-reflex': state.reflex,
          'data-system-one-verdict': worst.verdict,
          'data-system-one-outcome': worst.outcomeKey,
          'data-system-one-why': worst.why,
          'data-system-one-tone': worst.tone,
          'data-system-one-count': String(state.rows.length),
          'data-system-one-turn': whole(state.rows[0].turn),
          'data-system-one-step': state.reflex === 'guard' || state.reflex === 'shield' ? whole(state.rows[0].step) : undefined,
          'data-system-one-model': fullModel(state.rows[state.rows.length - 1].model) || undefined,
          'data-system-one-span-model': fullModel(state.rows.find(row => row.spanModel)?.spanModel) || undefined,
          'data-system-one-spans': spanCount(state) || undefined,
        }
      }

      function Card({ state }) {
        const views = state.rows.map(row => viewOf(state.reflex, row))
        const worst = worstOf(views)
        const last = state.rows[state.rows.length - 1]
        const headline = headlineOf(state.reflex, views)
        const fresh = useFresh(`card:${idOf(state.rows[0])}`, state.rows[0].time)
        const reflex = REFLEX[state.reflex] ?? state.reflex
        return h('section', {
          className: cx('vsr-s1', 'vsr-s1--card', `vsr-s1--${worst.tone}`, fresh && 'vsr-s1--fresh'),
          role: 'group',
          'aria-label': `System One ${reflex}: ${headline}`,
          ...attributes('card', state, worst),
        },
        h('span', { className: 'vsr-s1__sheen', 'aria-hidden': true }),
        h('div', { className: 'vsr-s1__head', 'data-system-one-part': 'head' },
          h(Lead, {}),
          ...joined([
            nameOf(true),
            latencyOf(true, last.ms),
            reflexOf(true, reflex),
            h('span', { className: 'vsr-s1__summary', 'data-system-one-part': 'summary', title: headline }, headline),
          ]),
          h(Model, { model: last.model })),
        h(Rows, { reflex: state.reflex, rows: state.rows, views }))
      }

      function Chevron() {
        return h('svg', { className: 'vsr-s1__chev', viewBox: '0 0 16 16', width: 12, height: 12, 'aria-hidden': true },
          h('path', { d: 'M6 3.5 10.5 8 6 12.5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }))
      }

      function Compact({ state }) {
        const views = state.rows.map(row => viewOf(state.reflex, row))
        const worst = worstOf(views)
        const last = state.rows[state.rows.length - 1]
        const [open, setOpen] = React.useState(false)
        const fresh = useFresh(`card:${idOf(state.rows[0])}`, state.rows[0].time)
        const reflex = REFLEX[state.reflex] ?? state.reflex
        const line = views.length === 1 ? compactLine(views[0]) : { label: headlineOf(state.reflex, views), tone: undefined, rest: [] }
        const said = [line.label, ...line.rest].join(' · ')
        const deciding = views.some(view => view.pending)
        const settled = state.rows.map(settles).some(Boolean)
        const parts = marked => joined([
          nameOf(marked),
          deciding ? null : latencyOf(marked, last.ms),
          reflexOf(marked, reflex),
          h('span', { className: 'vsr-s1__summary', 'data-system-one-part': marked ? 'summary' : undefined, title: marked ? said : undefined },
            ...joined([
              h('span', { className: cx('vsr-s1__verdict', line.tone && `vsr-s1__verdict--${line.tone}`), 'data-system-one-part': marked ? 'verdict' : undefined }, line.label),
              ...line.rest,
            ])),
        ])
        return h('div', {
          className: cx('vsr-s1', 'vsr-s1--compact', `vsr-s1--${worst.tone}`, open && 'vsr-s1--open', fresh && 'vsr-s1--fresh', deciding && 'vsr-s1--deciding', settled && 'vsr-s1--settle'),
          role: 'group',
          'aria-label': `System One ${reflex}: ${said}`,
          'aria-busy': deciding || undefined,
          ...attributes('compact', state, deciding ? views.find(view => view.pending) : worst),
        },
        h('button', { type: 'button', className: 'vsr-s1__chip', 'data-system-one-part': 'toggle', 'aria-expanded': open, onClick: () => setOpen(!open) },
          h(Lead, { toggles: true }),
          h(Shimmer, { active: deciding, line: parts }),
          open && !deciding ? h(Model, { model: last.model }) : null),
        open ? h(Rows, { reflex: state.reflex, rows: state.rows, views }) : null)
      }

      function KeyGlyph() {
        return h('svg', { className: 'vsr-s1__glyph', viewBox: '0 0 16 16', width: 12, height: 12, 'aria-hidden': true },
          h('circle', { cx: 5.5, cy: 8, r: 3, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
          h('path', { d: 'M8.5 8H14M12 8v2.5M14 8v2', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }))
      }

      // The free key a start fetched, or why it could not: one line under the request, in either mode.
      function KeyNotice({ state }) {
        const row = state.rows[state.rows.length - 1]
        const created = row.verdict === 'created'
        const fresh = useFresh(`key:${idOf(row)}`, row.time)
        const site = text(row.site) || 'app.vllm-sr.ai'
        const said = created
          ? `Free API key created for ${site}, saved in ${text(row.saved) || '~/.dsh/.env'}`
          : `No free API key from ${site}: ${text(row.error?.message) || 'the site refused'}. Get one at ${site} and save it as ${text(row.ref) || 'VLLM_SR_API_KEY'}.`
        const link = (href, label) => (typeof href === 'string' && /^https:\/\//.test(href) ? h('a', { className: 'vsr-s1__link', href, target: '_blank', rel: 'noreferrer' }, label) : null)
        return h('div', {
          className: cx('vsr-s1', 'vsr-s1--notice', created ? 'vsr-s1--ok' : 'vsr-s1--bad', fresh && 'vsr-s1--fresh'),
          role: 'note',
          'aria-label': `System Duo: ${said}`,
          'data-system-one': 'notice',
          'data-system-one-reflex': 'key',
          'data-system-one-verdict': created ? 'created' : 'failed',
          'data-system-one-tone': created ? 'ok' : 'bad',
          'data-system-one-turn': whole(row.turn),
        },
        h(Lead, { glyph: h(KeyGlyph) }),
        ...joined([
          nameOf(true, 'System Duo'),
          h('span', { className: cx('vsr-s1__summary', !created && 'vsr-s1__summary--bad'), 'data-system-one-part': 'summary', title: said }, said),
          created && (row.terms || row.privacy) ? h('span', { className: 'vsr-s1__links', 'data-system-one-part': 'links' }, link(row.terms, 'Terms'), link(row.privacy, 'Privacy')) : null,
        ]))
      }

      // A routine check (an allowed call, a clean result) is one line in either mode; a decision that changed
      // something, and the triage and done-check that frame the turn, are cards unless the mode is compact.
      function SystemOneNode(props) {
        const state = props?.node?.data
        if (!state || !Array.isArray(state.rows) || state.rows.length === 0) return null
        if (state.reflex === 'key') return h(Contained, null, h(KeyNotice, { state }))
        const slim = state.ui === 'compact' || !standsOut(state)
        return h(Contained, null, h(slim ? Compact : Card, { state }))
      }

      // ---- the system_one tool's row ----

      function parseArgs(raw) {
        try {
          const args = typeof raw === 'string' ? JSON.parse(raw) : raw
          return args && typeof args === 'object' ? args : {}
        } catch {
          return {}
        }
      }

      function questionCount(questions) {
        const parsed = typeof questions === 'string' ? parseArgs(questions) : questions
        return parsed && typeof parsed === 'object' ? Object.keys(parsed).length : 0
      }

      function resultText(block) {
        return (Array.isArray(block?.content) ? block.content : []).filter(part => part?.type === 'text').map(part => part.text).join('\n').trim()
      }

      function relative(path, cwd) {
        const value = text(path)
        const root = text(cwd).replace(/[\\/]+$/, '')
        return root && value.startsWith(`${root}/`) ? value.slice(root.length + 1) : value
      }

      function Stack({ parts, fresh }) {
        const total = parts.reduce((sum, part) => sum + part.n, 0)
        return h('span', { className: cx('vsr-s1__stack', fresh && 'vsr-s1__stack--fresh'), 'data-system-one-part': 'stack', 'aria-hidden': true },
          total > 0 ? parts.filter(part => part.n > 0).map((part, index) => h('i', { key: part.label, style: { flexGrow: part.n, background: part.color, animationDelay: `${0.12 + index * 0.06}s` } })) : null)
      }

      // the model writes the option names; a long one is cut in the legend and kept whole in its tooltip
      const LABEL_CHARS = 28
      const shortLabel = label => (label.length > LABEL_CHARS ? `${label.slice(0, LABEL_CHARS - 1).trimEnd()}…` : label)

      function Legend({ parts, extra, failed }) {
        return h('span', { className: 'vsr-s1__legend', 'data-system-one-part': 'legend' },
          parts.map(part => h('span', { key: part.label, className: 'vsr-s1__key', title: `${part.label}: ${part.n}` },
            h('i', { className: 'vsr-s1__swatch', style: { background: part.color } }),
            `${shortLabel(part.label)} `, h('b', null, String(part.n)))),
          extra ? h('span', { className: 'vsr-s1__key vsr-s1__key--note' }, extra) : null,
          failed ? h('span', { className: 'vsr-s1__key vsr-s1__key--bad', 'data-system-one-part': 'failed' }, `${failed} failed`) : null)
      }

      function questionParts(summary) {
        if (summary?.type === 'choice') {
          const counts = Object.entries(summary.counts ?? {}).sort((x, y) => y[1] - x[1])
          const head = counts.slice(0, 6).map(([label, n], index) => ({ label, n, color: HUES[index % HUES.length] }))
          const rest = counts.slice(6).reduce((sum, [, n]) => sum + n, 0)
          return {
            parts: rest ? [...head, { label: 'other', n: rest, color: 'var(--vsr-s1-text-3)' }] : head,
            extra: summary.unsureCount ? `${summary.unsureCount} unsure` : undefined,
          }
        }
        if (summary?.type === 'noul') {
          return { parts: [{ label: 'yes', n: summary.yes ?? 0, color: '#30A2FF' }, { label: 'no', n: summary.no ?? 0, color: 'var(--vsr-s1-track)' }] }
        }
        if (summary?.type === 'score') {
          const levels = Object.entries(summary.levels ?? {})
          return {
            parts: levels.map(([label, n], index) => ({ label, n, color: RAMP[Math.round((index / Math.max(1, levels.length - 1)) * (RAMP.length - 1))] })),
            extra: num(summary.mean) !== undefined ? `mean ${summary.mean}` : undefined,
          }
        }
        if (summary?.type === 'box') return { parts: [], extra: plural(summary.boxes?.length ?? 0, 'box', 'boxes') }
        return { parts: [] }
      }

      function Question({ id, summary, fresh }) {
        const { parts, extra } = questionParts(summary)
        return h('div', { className: 'vsr-s1__q', 'data-system-one-question': id },
          h('code', { className: 'vsr-s1__qname', title: id }, id),
          h('div', { className: 'vsr-s1__qbody' },
            parts.length ? h(Stack, { parts, fresh }) : null,
            h(Legend, { parts, extra, failed: num(summary?.failed) || undefined })))
      }

      function ToolBody({ meta, fresh, cwd, openFile }) {
        const entries = Object.entries(meta.summary ?? {})
        return h('div', { className: 'vsr-s1__rows', 'data-system-one-part': 'rows' },
          entries.map(([id, summary]) => h(Question, { key: id, id, summary, fresh })),
          meta.output ? h('div', { className: 'vsr-s1__foot', 'data-system-one-part': 'results' },
            'Results ',
            typeof openFile === 'function'
              ? h('button', { type: 'button', className: 'vsr-s1__link', onClick: () => openFile(meta.output) }, relative(meta.output, cwd))
              : h('code', null, relative(meta.output, cwd))) : null)
      }

      function ToolRow(props) {
        const { block, phase, callId, cwd, openFile } = props
        const args = parseArgs(phase === 'result' ? block?.call?.argsRaw : block?.argsRaw)
        const meta = phase === 'result' && block?.meta && block.meta.systemOne === 1 ? block.meta : undefined
        const ui = meta?.ui ?? 'card'
        const fresh = useFresh(`tool:${callId}:${phase}`, phase === 'result' ? block?.time : Date.now())
        const [open, setOpen] = React.useState(false)
        const source = args.file ? basename(args.file) : Array.isArray(args.images) ? plural(args.images.length, 'image') : Array.isArray(args.items) ? plural(args.items.length, 'item') : ''
        const asked = questionCount(args.questions)
        const common = { 'data-system-one-reflex': 'tool', 'data-system-one-call': callId }

        if (phase !== 'result') {
          const line = phase === 'preparing' ? 'Preparing a batch' : `Answering ${plural(asked, 'question')}${source ? ` over ${source}` : ''}`
          return h('div', { className: 'vsr-s1 vsr-s1--compact vsr-s1--running vsr-s1--deciding', 'aria-busy': true, 'data-system-one': 'tool', ...common, 'data-system-one-verdict': 'running', 'data-system-one-tone': 'info' },
            h('div', { className: 'vsr-s1__chip vsr-s1__chip--static' },
              h(Lead, {}),
              h(Shimmer, {
                active: true,
                line: marked => joined([nameOf(marked), reflexOf(marked, REFLEX.tool), h('span', { className: 'vsr-s1__summary', 'data-system-one-part': marked ? 'summary' : undefined }, line)]),
              })))
        }

        if (block?.isError || !meta || ui === 'off') {
          const body = resultText(block)
          const first = body.split('\n')[0] || (block?.isError ? 'The batch failed' : 'Done')
          return h('div', {
            className: cx('vsr-s1', 'vsr-s1--compact', 'vsr-s1--plain', block?.isError && 'vsr-s1--bad', open && 'vsr-s1--open'),
            'data-system-one': 'tool', ...common, 'data-system-one-verdict': block?.isError ? 'error' : 'done', 'data-system-one-tone': block?.isError ? 'bad' : 'muted',
          },
          h('button', { type: 'button', className: 'vsr-s1__chip', 'data-system-one-part': 'toggle', 'aria-expanded': open, onClick: () => setOpen(!open) },
            h(Lead, { toggles: true }),
            ...joined([
              nameOf(true),
              h('span', { className: cx('vsr-s1__summary', block?.isError && 'vsr-s1__summary--bad'), 'data-system-one-part': 'summary', title: first }, first),
            ])),
          open ? h('pre', { className: 'vsr-s1__raw', 'data-system-one-part': 'raw' }, body) : null)
        }

        const ms = num(meta.seconds) === undefined ? undefined : meta.seconds * 1000
        const headline = [plural(num(meta.items) ?? 0, 'item'), plural(num(meta.questions) ?? 0, 'question'), plural(num(meta.requests) ?? 0, 'request')].join(' · ')
        const done = {
          ...common, 'data-system-one-verdict': 'done', 'data-system-one-tone': 'ok', 'data-system-one-count': String(meta.items ?? ''),
          'data-system-one-model': fullModel(meta.model) || undefined,
        }
        if (ui === 'compact') {
          return h('div', { className: cx('vsr-s1', 'vsr-s1--compact', 'vsr-s1--ok', open && 'vsr-s1--open', fresh && 'vsr-s1--fresh'), 'data-system-one': 'tool', ...done },
            h('button', { type: 'button', className: 'vsr-s1__chip', 'data-system-one-part': 'toggle', 'aria-expanded': open, onClick: () => setOpen(!open) },
              h(Lead, { toggles: true }),
              ...joined([
                nameOf(true),
                latencyOf(true, ms),
                reflexOf(true, REFLEX.tool),
                h('span', { className: 'vsr-s1__summary', 'data-system-one-part': 'summary', title: headline }, headline),
              ]),
              open ? h(Model, { model: meta.model }) : null),
            open ? h(ToolBody, { meta, fresh, cwd, openFile }) : null)
        }
        return h('section', {
          className: cx('vsr-s1', 'vsr-s1--card', 'vsr-s1--ok', 'vsr-s1--tool', fresh && 'vsr-s1--fresh'),
          role: 'group',
          'aria-label': `System One batch: ${headline}`,
          'data-system-one': 'tool',
          ...done,
        },
        h('span', { className: 'vsr-s1__sheen', 'aria-hidden': true }),
        h('div', { className: 'vsr-s1__head', 'data-system-one-part': 'head' },
          h(Lead, {}),
          ...joined([
            nameOf(true),
            latencyOf(true, ms),
            reflexOf(true, REFLEX.tool),
            h('span', { className: 'vsr-s1__summary', 'data-system-one-part': 'summary', title: headline }, headline),
          ]),
          h(Model, { model: meta.model })),
        h(ToolBody, { meta, fresh, cwd, openFile }))
      }

      function SystemOneToolRow(props) {
        return h(Contained, null, h(ToolRow, props))
      }

      // ---- styles: the Web UI's theme tokens, with the blue of the vLLM logo (#30A2FF) for System One ----

      const CSS = `
.vsr-s1{--vsr-s1-blue:#30A2FF;--vsr-s1-blue-soft:#7CC4FF;--vsr-s1-blue-deep:#1E7FE0;--vsr-s1-ink:#166BC9;--vsr-s1-tint:6%;--vsr-s1-tint-2:1.5%;--vsr-s1-edge:24%;--vsr-s1-lift:rgba(16,42,84,.05);--vsr-s1-warn:var(--dsw-alias-state-warn-primary,#E8A100);--vsr-s1-bad:var(--dsw-alias-state-error-primary,#E5484D);--vsr-s1-text:var(--dsw-alias-label-primary,#1F2329);--vsr-s1-text-2:var(--dsw-alias-label-secondary,#545961);--vsr-s1-text-3:var(--dsw-alias-label-tertiary,#8A8F98);--vsr-s1-row:var(--dsw-alias-label-tertiary,#81858C);--vsr-s1-row-hover:var(--dsw-alias-label-secondary,#61666B);--vsr-s1-dot:var(--dsw-alias-label-caption,#ADB2B8);--vsr-s1-glint:var(--dsw-alias-label-shimmer,rgba(15,17,21,.3));--vsr-s1-row-size:var(--dsh-content-font-size-secondary,13px);--vsr-s1-line:var(--dsw-alias-border-l2,rgba(127,127,127,.22));--vsr-s1-track:color-mix(in srgb,var(--vsr-s1-text-3) 26%,transparent);--vsr-s1-mono:ui-monospace,SFMono-Regular,"JetBrains Mono",Menlo,Consolas,monospace;--vsr-s1-ease:cubic-bezier(.22,1,.36,1);position:relative;box-sizing:border-box;width:100%;margin:6px 0;color:var(--vsr-s1-text);font-size:13.5px;line-height:1.45;text-align:left}
body[data-ds-dark-theme] .vsr-s1{--vsr-s1-blue-soft:#4DB0FF;--vsr-s1-ink:#6BBEFF;--vsr-s1-tint:9%;--vsr-s1-tint-2:3%;--vsr-s1-edge:32%;--vsr-s1-lift:rgba(0,0,0,.28)}
.vsr-s1 *{box-sizing:border-box}
.vsr-s1--card{padding:8px 14px 12px 15px;border:1px solid color-mix(in srgb,var(--vsr-s1-blue) var(--vsr-s1-edge),var(--vsr-s1-line));border-radius:12px;background:linear-gradient(180deg,color-mix(in srgb,var(--vsr-s1-blue) var(--vsr-s1-tint),transparent),color-mix(in srgb,var(--vsr-s1-blue) var(--vsr-s1-tint-2),transparent));box-shadow:0 1px 2px var(--vsr-s1-lift),0 10px 24px -16px color-mix(in srgb,var(--vsr-s1-blue) 55%,transparent)}
.vsr-s1__sheen{position:absolute;inset:0;border-radius:inherit;overflow:hidden;pointer-events:none}
.vsr-s1__sheen::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:linear-gradient(180deg,var(--vsr-s1-blue-soft),var(--vsr-s1-blue) 45%,var(--vsr-s1-blue-deep));transform-origin:top center}
.vsr-s1__head,.vsr-s1__chip,.vsr-s1--notice{display:flex;align-items:center;min-width:0;color:var(--vsr-s1-row);font-size:var(--vsr-s1-row-size);font-weight:400;line-height:24px}
.vsr-s1__head{position:relative;height:24px}
.vsr-s1__lead{position:relative;display:inline-flex;flex:none;align-items:center;justify-content:center;width:16px;height:16px;margin-right:6px;color:inherit}
.vsr-s1__lead svg{width:14px;height:14px}
.vsr-s1__icon{display:inline-flex;transition:opacity .1s ease}
.vsr-s1__lead>.vsr-s1__chev{position:absolute;inset:0;margin:auto;opacity:0;transition:opacity .1s ease,transform .2s var(--vsr-s1-ease)}
.vsr-s1__chip:hover .vsr-s1__icon,.vsr-s1--open>.vsr-s1__chip .vsr-s1__icon{opacity:0}
.vsr-s1__chip:hover .vsr-s1__lead>.vsr-s1__chev,.vsr-s1--open>.vsr-s1__chip .vsr-s1__lead>.vsr-s1__chev{opacity:1}
.vsr-s1--open>.vsr-s1__chip .vsr-s1__chev{transform:rotate(90deg)}
.vsr-s1__name{flex:none;color:var(--vsr-s1-ink);font-weight:650;letter-spacing:-.005em;white-space:nowrap}
.vsr-s1__sep{display:inline-block;flex:none;width:2px;height:2px;margin:0 8px;border-radius:1px;background:var(--vsr-s1-dot);vertical-align:middle}
.vsr-s1__ms{flex:none;font-variant-numeric:tabular-nums;white-space:nowrap}
.vsr-s1__reflex{flex:none;font-weight:500;white-space:nowrap}
.vsr-s1__summary{flex:1 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.vsr-s1__summary--bad{color:var(--vsr-s1-bad)}
.vsr-s1__verdict{font-weight:500;color:var(--vsr-s1-text-2)}
.vsr-s1__verdict--warn{color:color-mix(in srgb,var(--vsr-s1-warn) 82%,var(--vsr-s1-text))}.vsr-s1__verdict--bad{color:var(--vsr-s1-bad)}.vsr-s1__verdict--muted{color:inherit;font-weight:400}
.vsr-s1__model{flex:none;margin-left:12px;color:var(--vsr-s1-text-2);font-size:12px;font-weight:700;letter-spacing:-.005em;white-space:nowrap}
.vsr-s1__by{color:var(--vsr-s1-text-2);font-weight:700}
.vsr-s1--notice{align-items:flex-start;margin:4px 0}
.vsr-s1--notice .vsr-s1__lead{margin-top:4px}
.vsr-s1--notice .vsr-s1__sep{margin-top:11px}
.vsr-s1--notice .vsr-s1__summary{white-space:normal}
.vsr-s1__glyph{flex:none}
.vsr-s1__links{display:inline-flex;flex:none;gap:10px}
a.vsr-s1__link{text-decoration:none}
.vsr-s1__rows{display:grid;grid-template-columns:auto minmax(0,1fr) auto;column-gap:12px;row-gap:8px;margin-top:8px}
.vsr-s1__rows>*{grid-column:1/-1}
.vsr-s1__row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;grid-template-columns:subgrid;column-gap:12px;align-items:start}
.vsr-s1__verdicts{display:flex;flex-direction:column;align-items:flex-start;gap:4px;min-width:92px}
.vsr-s1__pill{--tone:var(--vsr-s1-text-3);display:inline-flex;align-items:center;gap:6px;padding:1px 8px 1px 7px;border-radius:6px;color:var(--tone);background:color-mix(in srgb,var(--tone) 12%,transparent);box-shadow:inset 0 0 0 .5px color-mix(in srgb,var(--tone) 22%,transparent);font-size:12px;font-weight:650;line-height:20px;white-space:nowrap}
.vsr-s1__pill::before{content:"";flex:none;width:6px;height:6px;border-radius:50%;background:currentColor}
.vsr-s1__pill--then::before{width:auto;height:auto;border-radius:0;background:none;content:"\\21B3"}
.vsr-s1__pill--ok,.vsr-s1__pill--info{--tone:var(--vsr-s1-ink)}.vsr-s1__pill--warn{--tone:color-mix(in srgb,var(--vsr-s1-warn) 82%,var(--vsr-s1-text))}.vsr-s1__pill--bad{--tone:var(--vsr-s1-bad)}.vsr-s1__pill--muted{--tone:var(--vsr-s1-text-3)}
.vsr-s1__main{display:grid;gap:3px;min-width:0}
.vsr-s1__subject{display:flex;align-items:baseline;gap:7px;min-width:0;line-height:22px}
.vsr-s1__tool{flex:none;color:var(--vsr-s1-text-2);font-weight:600}
.vsr-s1__code{min-width:0;overflow:hidden;color:var(--vsr-s1-text);font-family:var(--vsr-s1-mono);font-size:12.5px;white-space:nowrap;text-overflow:ellipsis;background:none;padding:0}
.vsr-s1__facts{display:flex;flex-wrap:wrap;gap:3px 16px;color:var(--vsr-s1-text-2);font-size:12.5px;line-height:22px}
.vsr-s1__fact{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.vsr-s1__fact b{color:var(--vsr-s1-text);font-weight:600;font-variant-numeric:tabular-nums}
.vsr-s1__level{display:inline-block;margin-right:1px;padding:0 6px;border-radius:5px;line-height:18px;font-weight:650}
.vsr-s1__level--bad{color:var(--vsr-s1-bad);background:color-mix(in srgb,var(--vsr-s1-bad) 12%,transparent);box-shadow:inset 0 0 0 .5px color-mix(in srgb,var(--vsr-s1-bad) 26%,transparent)}
.vsr-s1__bar{position:relative;width:34px;height:4px;border-radius:2px;overflow:hidden;background:var(--vsr-s1-track)}
.vsr-s1__bar>i{position:absolute;inset:0;border-radius:inherit;background:var(--vsr-s1-blue);transform-origin:left center;transform:scaleX(var(--p))}
.vsr-s1__bar--warn>i{background:var(--vsr-s1-warn)}.vsr-s1__bar--bad>i{background:var(--vsr-s1-bad)}
.vsr-s1__note{color:var(--vsr-s1-text-2);font-size:12.5px}
.vsr-s1__span{padding:0 3px;border-radius:4px;color:inherit;background:none;font:inherit}
.vsr-s1__span--removed{color:var(--vsr-s1-bad);background:color-mix(in srgb,var(--vsr-s1-bad) 14%,transparent);text-decoration:line-through;text-decoration-thickness:1.5px}
.vsr-s1__span--dangerous{color:var(--vsr-s1-bad);background:color-mix(in srgb,var(--vsr-s1-bad) 16%,transparent);box-shadow:inset 0 -2px 0 var(--vsr-s1-bad);font-weight:650}
.vsr-s1__span--unsupported{background:color-mix(in srgb,var(--vsr-s1-warn) 22%,transparent);text-decoration:underline wavy color-mix(in srgb,var(--vsr-s1-warn) 85%,var(--vsr-s1-text));text-decoration-thickness:1.5px;text-underline-offset:3px}
.vsr-s1__span--masked{display:inline-block;padding:0 6px;color:var(--dsw-alias-bg-layer-1,#fff);background:repeating-linear-gradient(135deg,color-mix(in srgb,var(--vsr-s1-text) 80%,transparent) 0 6px,color-mix(in srgb,var(--vsr-s1-text) 66%,transparent) 6px 12px);font-family:var(--vsr-s1-mono);font-size:11px;font-weight:650;letter-spacing:.02em;line-height:17px}
.vsr-s1__excerpts{display:grid;gap:5px;margin:3px 0 1px}
.vsr-s1__excerpt{padding:6px 9px;border-left:2px solid color-mix(in srgb,var(--vsr-s1-blue) 50%,transparent);border-radius:0 6px 6px 0;color:var(--vsr-s1-text-2);background:color-mix(in srgb,var(--vsr-s1-text-3) 8%,transparent);font-family:var(--vsr-s1-mono);font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
.vsr-s1__labels{display:flex;flex-wrap:wrap;gap:4px 6px}
.vsr-s1__label{display:inline-flex;align-items:center;gap:5px;padding:0 7px;border-radius:5px;color:var(--vsr-s1-text-2);background:color-mix(in srgb,var(--vsr-s1-blue) 10%,transparent);font-family:var(--vsr-s1-mono);font-size:11.5px;line-height:20px}
.vsr-s1__label b{color:var(--vsr-s1-text);font-weight:650}
.vsr-s1__rowms{color:var(--vsr-s1-text-3);font-size:12px;line-height:22px;font-variant-numeric:tabular-nums;white-space:nowrap}
.vsr-s1__more,.vsr-s1__link{justify-self:start;padding:0;border:0;background:none;color:var(--dsw-alias-link,#2F7BF6);font:inherit;font-size:12.5px;cursor:pointer}
.vsr-s1__more:hover,.vsr-s1__link:hover{text-decoration:underline}
.vsr-s1--compact{margin:2px 0}
.vsr-s1__chip{width:100%;height:24px;padding:0;border:0;background:none;font-family:inherit;text-align:left;cursor:pointer;transition:color .1s ease}
.vsr-s1__chip:hover{color:var(--vsr-s1-row-hover)}
.vsr-s1__chip--static{cursor:default}
.vsr-s1__chip--static:hover{color:var(--vsr-s1-row)}
.vsr-s1__chev{flex:none;color:inherit}
.vsr-s1--compact>.vsr-s1__rows{margin:4px 0 8px 7px;padding-left:15px;border-left:2px solid color-mix(in srgb,var(--vsr-s1-blue) 40%,transparent)}
.vsr-s1__raw{margin:4px 0 8px;padding:8px 10px;max-height:320px;overflow:auto;border-radius:8px;background:color-mix(in srgb,var(--vsr-s1-text-3) 10%,transparent);font-family:var(--vsr-s1-mono);font-size:12px;white-space:pre-wrap}
.vsr-s1__shim{position:relative;display:inline-grid;flex:1 1 auto;min-width:0;max-width:100%;vertical-align:top}
.vsr-s1__shim-line{display:flex;align-items:center;min-width:0}
.vsr-s1__shim-deco{position:absolute;inset:0;overflow:clip;pointer-events:none;user-select:none}
.vsr-s1__shim-sweep{position:absolute;inset:0;overflow:hidden;color:var(--vsr-s1-glint);-webkit-mask-image:linear-gradient(105deg,transparent 0%,#000 40% 60%,transparent 100%);mask-image:linear-gradient(105deg,transparent 0%,#000 40% 60%,transparent 100%);transform:translateX(-100%)}
.vsr-s1__shim-sweep *{color:inherit!important}
.vsr-s1__shim-sweep .vsr-s1__sep{background:currentColor}
.vsr-s1__shim-copy{width:100%;height:100%;transform:translateX(100%)}
.vsr-s1__q{display:grid;grid-template-columns:minmax(80px,140px) minmax(0,1fr);column-gap:14px;align-items:start}
.vsr-s1__qname{overflow:hidden;color:var(--vsr-s1-text);font-family:var(--vsr-s1-mono);font-size:12.5px;line-height:16px;white-space:nowrap;text-overflow:ellipsis;background:none;padding:0}
.vsr-s1__qbody{display:grid;gap:4px;min-width:0}
.vsr-s1__stack{display:flex;gap:2px;height:8px;margin-top:4px;border-radius:4px;overflow:hidden;background:var(--vsr-s1-track)}
.vsr-s1__stack>i{display:block;min-width:3px;height:100%;transform-origin:left center}
.vsr-s1__legend{display:flex;flex-wrap:wrap;gap:1px 14px;color:var(--vsr-s1-text-2);font-size:12.5px}
.vsr-s1__key{display:inline-flex;align-items:center;white-space:nowrap}
.vsr-s1__key b{margin-left:4px;color:var(--vsr-s1-text);font-weight:600;font-variant-numeric:tabular-nums}
.vsr-s1__key--note{color:var(--vsr-s1-text-3)}
.vsr-s1__key--bad{color:var(--vsr-s1-bad);font-weight:600}
.vsr-s1__swatch{flex:none;width:8px;height:8px;margin-right:6px;border-radius:2px}
.vsr-s1__foot{color:var(--vsr-s1-text-3);font-size:12.5px}
.vsr-s1__foot code{font-family:var(--vsr-s1-mono)}
@keyframes vsr-s1-reveal{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes vsr-s1-rise{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
@keyframes vsr-s1-draw{from{transform:scaleY(0)}to{transform:scaleY(1)}}
@keyframes vsr-s1-fill{from{transform:scaleX(0)}}
@keyframes vsr-s1-grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes vsr-s1-ink{from{background-color:transparent;box-shadow:none}}
@keyframes vsr-s1-sweep{0%{transform:translateX(-100%)}66.6667%,to{transform:translateX(100%)}}
@keyframes vsr-s1-sweep-back{0%{transform:translateX(100%)}66.6667%,to{transform:translateX(-100%)}}
@keyframes vsr-s1-settle{from{opacity:.4}to{opacity:1}}
.vsr-s1--fresh{animation:vsr-s1-reveal .22s var(--vsr-s1-ease) both}
.vsr-s1--fresh>.vsr-s1__sheen::before{animation:vsr-s1-draw .42s var(--vsr-s1-ease) .06s both}
.vsr-s1__row--fresh{animation:vsr-s1-rise .24s var(--vsr-s1-ease) both;animation-delay:calc(60ms + var(--vsr-s1-i,0) * 45ms)}
.vsr-s1__row--fresh .vsr-s1__bar>i{animation:vsr-s1-fill .6s var(--vsr-s1-ease) .16s both}
.vsr-s1__row--fresh .vsr-s1__span{animation:vsr-s1-ink .5s ease-out .26s both}
.vsr-s1__stack--fresh>i{animation:vsr-s1-grow .6s var(--vsr-s1-ease) both}
.vsr-s1__shim-sweep{animation:vsr-s1-sweep 1.5s steps(48,end) .3s infinite}
.vsr-s1__shim-copy{animation:vsr-s1-sweep-back 1.5s steps(48,end) .3s infinite}
.vsr-s1--settle .vsr-s1__shim-line{animation:vsr-s1-settle .32s var(--vsr-s1-ease) both}
@media (prefers-reduced-motion:reduce){.vsr-s1,.vsr-s1 *,.vsr-s1 *::before,.vsr-s1 *::after{animation:none!important;transition:none!important}.vsr-s1__shim-deco{display:none}}
`
      if (typeof document !== 'undefined') {
        const tagId = `${PACKAGE}/system-one.css`
        if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) === null) {
          const tag = document.createElement('style')
          tag.dataset.plugin = PACKAGE
          tag.dataset.pluginCss = tagId
          tag.textContent = CSS
          document.head.appendChild(tag)
        }
      }

      // ---- wiring: each part attaches when its service is there ----

      function contained(what, run) {
        try {
          return run()
        } catch (error) {
          console.warn(`[${PACKAGE}] ${what} is off:`, error)
          return undefined
        }
      }

      function slot(scoped, name, key, component) {
        if (typeof scoped.slots?.inject !== 'function') return
        scoped.slots.inject(name, () => contained(`the ${name} entry`, () => scoped.slots.register({ name, key }, component)) ?? (() => {}))
      }

      function apply(ctx) {
        contained('the System One cards', () => ctx.inject(['uiConversation'], scoped => {
          contained('the System One cards', () => scoped.uiConversation.events.register(definition))
        }))
        contained('the System One views', () => ctx.inject(['slots'], scoped => {
          slot(scoped, 'conversation.chat.node', NODE_KIND, SystemOneNode)
          slot(scoped, 'tool.call.toolview', TOOL_NAME, SystemOneToolRow)
        }))
      }

      exports.apply = apply
      exports.definition = definition
      exports.viewOf = viewOf
      exports.SystemOneNode = SystemOneNode
      exports.SystemOneToolRow = SystemOneToolRow
      exports.RECORD_TYPE = RECORD_TYPE
      exports.NODE_KIND = NODE_KIND
    } catch (error) {
      console.warn('[@vllm-sr/dsh] the System One views are off:', error)
    }
    return module.exports
  },
})
