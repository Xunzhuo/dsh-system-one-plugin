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
      const SCREEN_TOOL = 'system_one_screen'
      // a decision younger than this animates the first time this page draws it; history stays still
      const FRESH_MS = 20000
      const ROWS_SHOWN = 4

      const REFLEX = { triage: 'Triage', guard: 'Guard', shield: 'Shield', privacy: 'Privacy', done: 'Done-check', tool: 'Batch', screen: 'Screen' }
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
      const pct = value => `${(clamp01(value) * 100).toFixed(2)}%`

      // ---- images of the session's workspace (screenshots, a batch's images), read once each ----

      let workspaceFiles
      const filesWaiting = new Set()
      const images = new Map()
      const IMAGES_KEPT = 96
      const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }

      function imageEntry(sessionId, path) {
        const key = `${sessionId}\n${path}`
        let entry = images.get(key)
        if (entry) return entry
        const type = IMAGE_TYPES[(path.split('.').pop() ?? '').toLowerCase()] ?? 'application/octet-stream'
        entry = { url: undefined }
        // a remote call of the Web UI answers { ok: true, value } or { ok: false, error }
        entry.promise = Promise.resolve(workspaceFiles.readBytes(sessionId, path, {}, undefined)).then(result => {
          if (!result?.ok || !ArrayBuffer.isView(result.value?.data) || result.value.data.byteLength === 0) {
            throw new Error(result?.error?.message ?? `${path} could not be read`)
          }
          entry.url = URL.createObjectURL(new Blob([result.value.data], { type }))
          return entry.url
        })
        entry.promise.catch(() => images.delete(key))
        images.set(key, entry)
        if (images.size > IMAGES_KEPT) {
          const [oldest, old] = images.entries().next().value
          images.delete(oldest)
          if (old.url) URL.revokeObjectURL(old.url)
        }
        return entry
      }

      // an image file as a URL for <img>, once the Web UI's file service is there
      function useImage(sessionId, path) {
        const wanted = Boolean(text(sessionId) && text(path))
        const [ready, setReady] = React.useState(Boolean(workspaceFiles))
        const [url, setUrl] = React.useState(() => (wanted && workspaceFiles ? images.get(`${sessionId}\n${path}`)?.url : undefined))
        React.useEffect(() => {
          if (!wanted) return undefined
          if (!workspaceFiles) {
            const wake = () => setReady(true)
            filesWaiting.add(wake)
            return () => filesWaiting.delete(wake)
          }
          let live = true
          const entry = imageEntry(sessionId, path)
          if (entry.url) setUrl(entry.url)
          else entry.promise.then(value => live && setUrl(value), () => {})
          return () => {
            live = false
          }
        }, [sessionId, path, ready])
        return url
      }

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
        const backed = num(row.backed) ?? 0
        return {
          verdict: row.verdict === 'continue' ? 'continue' : 'stop', ...verdict, why, short: verdict.label.toLowerCase(),
          headline: row.verdict === 'continue' ? `${verdict.label} to System Two (${round})` : why === 'waiting' ? 'Waiting on you' : why === 'declined' ? 'System Two declined' : 'The work is done',
          facts: [
            { id: 'complete', label: 'Complete', value: p2(yesOf(a.complete)), bar: yesOf(a.complete) },
            { id: 'checked', label: 'Checked', value: p2(yesOf(a.checked)), bar: yesOf(a.checked) },
            { id: 'waiting', label: 'Waiting on you', value: p2(yesOf(a.waiting)), bar: yesOf(a.waiting) },
            ...(declined === undefined ? [] : [{ id: 'declined', label: 'Declined', value: p2(declined), bar: declined }]),
            ...(row.spanModel ? [{ id: 'unsupported', label: 'Unsupported', value: String(unsupported), tone: unsupported ? 'warn' : undefined }] : []),
            ...(backed ? [{ id: 'backed', label: 'Backed', value: String(backed) }] : []),
          ],
          excerpts: unsupported && Array.isArray(row.excerpts) ? { list: row.excerpts, kind: 'unsupported' } : undefined,
          evidence: Array.isArray(row.evidence) ? row.evidence.filter(entry => text(entry?.text)) : undefined,
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

      // what a span model marked: removed injections, masked personal data (only its label), unsupported claims, the
      // words of a label set (in the label's hue, with its name), the evidence that backs an answer
      function Mark({ mark, kind, hue }) {
        const p = num(mark.probability)
        const label = text(mark.label)
        return h('mark', {
          className: cx('vsr-s1__span', `vsr-s1__span--${kind}`),
          style: hue ? { '--vsr-s1-hue': hue } : undefined,
          'data-system-one-part': 'span',
          'data-system-one-span-label': label || undefined,
          'data-system-one-probability': p === undefined ? undefined : String(p),
          title: [label, p === undefined ? '' : p.toFixed(2)].filter(Boolean).join(' · '),
        }, kind === 'masked' ? label || 'PII' : text(mark.text), kind === 'labels' && label ? h('span', { className: 'vsr-s1__tag' }, label) : null)
      }

      const markedParts = (parts, kind, hues) => (Array.isArray(parts) ? parts : [])
        .map((part, at) => (part?.mark ? h(Mark, { key: at, mark: part.mark, kind, hue: hues?.[text(part.mark.label)] }) : h('span', { key: at }, text(part?.text))))

      function Excerpts({ excerpts }) {
        return h('div', { className: 'vsr-s1__excerpts', 'data-system-one-part': 'excerpts' },
          excerpts.list.slice(0, 3).map((parts, index) => h('div', { key: index, className: 'vsr-s1__excerpt', 'data-system-one-part': 'excerpt' }, markedParts(parts, excerpts.kind))))
      }

      // a batch question's marked items: the item, what was marked around it, and the source of a passage
      function Examples({ list, hues }) {
        return h('div', { className: 'vsr-s1__excerpts', 'data-system-one-part': 'examples' },
          list.slice(0, 3).map((example, index) => h('div', { key: index, className: 'vsr-s1__excerpt', 'data-system-one-part': 'example', 'data-system-one-item': text(example?.id) || undefined },
            text(example?.id) ? h('span', { className: 'vsr-s1__item' }, text(example.id)) : null,
            markedParts(example?.parts, text(example?.kind) || 'labels', hues),
            text(example?.source) ? h('span', { className: 'vsr-s1__source', 'data-system-one-part': 'source' }, example.source) : null)))
      }

      // the done-check's passages of what System Two read that back its answer
      function Evidence({ list }) {
        return h('div', { className: 'vsr-s1__excerpts', 'data-system-one-part': 'evidence' },
          h('span', { className: 'vsr-s1__fact-label' }, 'Backed by'),
          list.slice(0, 3).map((entry, index) => h('div', { key: index, className: 'vsr-s1__excerpt vsr-s1__excerpt--evidence', 'data-system-one-part': 'backing' },
            h('span', { className: 'vsr-s1__source', 'data-system-one-part': 'source' }, [text(entry.tool), text(entry.source)].filter(Boolean).join(' · ')),
            h(Mark, { mark: { label: 'evidence', probability: entry.p, text: entry.text }, kind: 'evidence' }))))
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
          view.evidence?.length ? h(Evidence, { list: view.evidence }) : null,
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
        if (summary?.type === 'span') {
          // unsupported words in amber, evidence in blue, a label set in the hues of its options
          const tints = summary.preset === 'halu' ? ['#E8A100'] : summary.preset === 'evidence' ? ['#30A2FF'] : HUES
          return {
            parts: Object.entries(summary.labels ?? {}).slice(0, 8).map(([label, n], index) => ({ label, n, color: tints[index % tints.length] })),
            extra: `in ${num(summary.items) ?? 0} of ${plural(num(summary.of) ?? 0, 'item')}`,
          }
        }
        if (summary?.type === 'box') {
          if (num(summary.found) === undefined) return { parts: [], extra: plural(summary.boxes?.length ?? 0, 'box', 'boxes') }
          return { parts: [{ label: 'found', n: summary.found, color: '#30A2FF' }, { label: 'not found', n: Math.max(0, (num(summary.of) ?? 0) - summary.found), color: 'var(--vsr-s1-track)' }] }
        }
        return { parts: [] }
      }

      function Question({ id, summary, fresh, examples }) {
        const { parts, extra } = questionParts(summary)
        const tag = text(summary?.preset) || (text(summary?.signal) ? `signal ${summary.signal}` : summary?.type === 'span' ? 'labels' : '')
        const hues = Object.fromEntries(parts.map(part => [part.label, part.color]))
        return h('div', { className: 'vsr-s1__q', 'data-system-one-question': id, 'data-system-one-kind': text(summary?.type) || undefined },
          h('div', { className: 'vsr-s1__qhead' },
            h('code', { className: 'vsr-s1__qname', title: id }, id),
            tag ? h('span', { className: 'vsr-s1__qtag', 'data-system-one-part': 'qtag' }, tag) : null),
          h('div', { className: 'vsr-s1__qbody' },
            parts.length ? h(Stack, { parts, fresh }) : null,
            h(Legend, { parts, extra, failed: num(summary?.failed) || undefined }),
            Array.isArray(examples) && examples.length ? h(Examples, { list: examples, hues }) : null))
      }

      function FileLink({ path, cwd, openFile }) {
        const shown = relative(path, cwd)
        return typeof openFile === 'function'
          ? h('button', { type: 'button', className: 'vsr-s1__link', title: shown, onClick: () => openFile(path) }, shown)
          : h('code', null, shown)
      }

      // a file the result names relative to the working directory, as the path openFile takes
      const inside = (path, cwd) => {
        const root = text(cwd).replace(/[\\/]+$/, '')
        return /^([\\/]|[A-Za-z]:)/.test(text(path)) || !root ? text(path) : `${root}/${path}`
      }

      // a screenshot or an image of the workspace, with the boxes System One found on it and the points to click
      function Shot({ sessionId, path, boxes = [], points = [], size, thumb, alt }) {
        const url = useImage(sessionId, path)
        const ratio = num(size?.width) && num(size?.height) ? `${size.width} / ${size.height}` : undefined
        return h('figure', {
          className: cx('vsr-s1__shot', thumb && 'vsr-s1__shot--thumb', !url && 'vsr-s1__shot--empty'),
          style: ratio ? { aspectRatio: ratio } : undefined,
          'data-system-one-part': 'shot',
          'data-system-one-image': basename(path) || undefined,
        },
        url ? h('img', { src: url, alt: alt ?? basename(path), draggable: false }) : null,
        boxes.map((box, index) => h('span', {
          key: `box${index}`,
          className: cx('vsr-s1__box', box.tone && `vsr-s1__box--${box.tone}`, num(box.top) < 0.14 && 'vsr-s1__box--low'),
          style: { left: pct(box.left), top: pct(box.top), width: pct(box.right - box.left), height: pct(box.bottom - box.top), '--vsr-s1-i': index },
          'data-system-one-part': 'box',
          'data-system-one-box': text(box.id) || undefined,
          title: text(box.label) || undefined,
        }, !thumb && text(box.label) ? h('span', { className: 'vsr-s1__boxlabel' }, box.label) : null)),
        points.map((point, index) => h('span', {
          key: `point${index}`, className: 'vsr-s1__point', style: { left: pct(point.x), top: pct(point.y), '--vsr-s1-i': index }, 'data-system-one-part': 'point', 'aria-hidden': true,
        })))
      }

      // one answer of an image, short: a yes or no with its probability, a choice, a level
      function answerText(id, answer) {
        if (num(answer?.yes) !== undefined) return `${id} ${p2(answer.yes)}`
        if (text(answer?.choice)) return answer.choice
        if (num(answer?.score) !== undefined) return `${id} ${answer.score.toFixed(1)}`
        return ''
      }

      function Images({ list, sessionId }) {
        return h('div', { className: 'vsr-s1__thumbs', 'data-system-one-part': 'images' },
          list.map((image, index) => {
            const boxes = (Array.isArray(image?.boxes) ? image.boxes : []).filter(entry => entry?.box)
            const [first] = Object.entries(image?.answers ?? {})
            const yes = num(first?.[1]?.yes)
            return h('div', {
              key: text(image?.id) || String(index),
              className: cx('vsr-s1__thumbcell', (boxes.length || yes >= 0.5) && 'vsr-s1__thumbcell--hit'),
              style: { '--vsr-s1-i': Math.min(index, 15) },
              'data-system-one-part': 'image',
              'data-system-one-item': text(image?.id) || undefined,
              'data-system-one-found': String(boxes.length),
            },
            h(Shot, { sessionId, path: image?.path, boxes: boxes.map(entry => ({ ...entry.box, id: entry.id, label: `${entry.id} ${p2(entry.confidence)}` })), thumb: true }),
            h('span', { className: 'vsr-s1__caption' },
              h('span', { className: 'vsr-s1__caption-name', title: text(image?.id) }, text(image?.id).replace(/\.(png|jpe?g|webp)$/i, '')),
              first ? h('b', null, answerText(first[0], first[1])) : null))
          }))
      }

      const fileList = (files, cwd, openFile) => files.slice(0, 4).flatMap((file, index) => [index ? ', ' : '', h(FileLink, { key: file, path: inside(file, cwd), cwd, openFile })])

      function ToolBody({ meta, fresh, cwd, openFile, sessionId }) {
        const entries = Object.entries(meta.summary ?? {})
        const redacted = meta.redacted && typeof meta.redacted === 'object' ? meta.redacted : undefined
        const annotated = meta.annotated && Array.isArray(meta.annotated.files) ? meta.annotated : undefined
        const sources = Array.isArray(meta.sources) ? meta.sources.filter(source => text(source)) : []
        return h('div', { className: 'vsr-s1__rows', 'data-system-one-part': 'rows' },
          entries.map(([id, summary]) => h(Question, { key: id, id, summary, fresh, examples: meta.examples?.[id] })),
          Array.isArray(meta.images) && meta.images.length ? h(Images, { list: meta.images, sessionId }) : null,
          meta.output ? h('div', { className: 'vsr-s1__foot', 'data-system-one-part': 'results' }, 'Results ', h(FileLink, { path: meta.output, cwd, openFile })) : null,
          redacted ? h('div', { className: 'vsr-s1__foot', 'data-system-one-part': 'redacted' },
            'Redacted copy ', h(FileLink, { path: text(redacted.output), cwd, openFile }),
            ` · ${plural(num(redacted.spans) ?? 0, 'span')} in ${plural(num(redacted.items) ?? 0, 'item')} replaced by their [LABEL]`) : null,
          annotated ? h('div', { className: 'vsr-s1__foot', 'data-system-one-part': 'annotated' },
            annotated.files.length ? 'Annotated copies ' : 'No box found to draw',
            fileList(annotated.files, cwd, openFile),
            annotated.files.length > 4 ? ` and ${annotated.files.length - 4} more` : '') : null,
          sources.length ? h('div', { className: 'vsr-s1__foot', 'data-system-one-part': 'sources' }, 'Checked against ', fileList(sources, cwd, openFile)) : null,
          fullModel(meta.spanModel) && fullModel(meta.spanModel) !== fullModel(meta.model)
            ? h('div', { className: 'vsr-s1__foot', 'data-system-one-part': 'span-model' }, 'Spans by ', h('b', { className: 'vsr-s1__by' }, fullModel(meta.spanModel))) : null)
      }

      // how many words the span questions of a batch marked
      const markedIn = summary => Object.values(summary ?? {}).filter(entry => entry?.type === 'span')
        .reduce((sum, entry) => sum + Object.values(entry.labels ?? {}).reduce((n, count) => n + (num(count) ?? 0), 0), 0)

      // a call that is still running: one line, with the Web UI's shimmer across it
      function Running({ reflex, line, common }) {
        return h('div', { className: 'vsr-s1 vsr-s1--compact vsr-s1--running vsr-s1--deciding', 'aria-busy': true, ...common, 'data-system-one-verdict': 'running', 'data-system-one-tone': 'info' },
          h('div', { className: 'vsr-s1__chip vsr-s1__chip--static' },
            h(Lead, {}),
            h(Shimmer, {
              active: true,
              line: marked => joined([nameOf(marked), reflexOf(marked, reflex), h('span', { className: 'vsr-s1__summary', 'data-system-one-part': marked ? 'summary' : undefined }, line)]),
            })))
      }

      // a call that failed, or whose result carries no facts to draw: its first line, and the rest on demand
      function Plain({ block, common, what }) {
        const [open, setOpen] = React.useState(false)
        const body = resultText(block)
        const first = body.split('\n')[0] || (block?.isError ? `The ${what} failed` : 'Done')
        return h('div', {
          className: cx('vsr-s1', 'vsr-s1--compact', 'vsr-s1--plain', block?.isError && 'vsr-s1--bad', open && 'vsr-s1--open'),
          ...common, 'data-system-one-verdict': block?.isError ? 'error' : 'done', 'data-system-one-tone': block?.isError ? 'bad' : 'muted',
        },
        h('button', { type: 'button', className: 'vsr-s1__chip', 'data-system-one-part': 'toggle', 'aria-expanded': open, onClick: () => setOpen(!open) },
          h(Lead, { toggles: true }),
          ...joined([
            nameOf(true),
            h('span', { className: cx('vsr-s1__summary', block?.isError && 'vsr-s1__summary--bad'), 'data-system-one-part': 'summary', title: first }, first),
          ])),
        open ? h('pre', { className: 'vsr-s1__raw', 'data-system-one-part': 'raw' }, body) : null)
      }

      // a finished call's one line, or the head of its card: System One, the latency, the reflex, what it found, and
      // in a card the one model that answered
      function ResultRow({ kind, common, done, reflex, ms, summary, model, body, fresh, tone, label }) {
        const [open, setOpen] = React.useState(false)
        const parts = joined([nameOf(true), latencyOf(true, ms), reflexOf(true, reflex), summary])
        if (kind === 'compact') {
          return h('div', { className: cx('vsr-s1', 'vsr-s1--compact', `vsr-s1--${tone}`, open && 'vsr-s1--open', fresh && 'vsr-s1--fresh'), ...common, ...done },
            h('button', { type: 'button', className: 'vsr-s1__chip', 'data-system-one-part': 'toggle', 'aria-expanded': open, onClick: () => setOpen(!open) },
              h(Lead, { toggles: true }),
              ...parts,
              open ? h(Model, { model }) : null),
            open ? body : null)
        }
        return h('section', {
          className: cx('vsr-s1', 'vsr-s1--card', `vsr-s1--${tone}`, `vsr-s1--${common['data-system-one']}`, fresh && 'vsr-s1--fresh'),
          role: 'group',
          'aria-label': label,
          ...common,
          ...done,
        },
        h('span', { className: 'vsr-s1__sheen', 'aria-hidden': true }),
        h('div', { className: 'vsr-s1__head', 'data-system-one-part': 'head' }, h(Lead, {}), ...parts, h(Model, { model })),
        body)
      }

      function ToolRow(props) {
        const { block, phase, callId, cwd, openFile, sessionId } = props
        const args = parseArgs(phase === 'result' ? block?.call?.argsRaw : block?.argsRaw)
        const meta = phase === 'result' && block?.meta && block.meta.systemOne === 1 ? block.meta : undefined
        const ui = meta?.ui ?? 'card'
        const fresh = useFresh(`tool:${callId}:${phase}`, phase === 'result' ? block?.time : Date.now())
        const source = args.file ? basename(args.file) : Array.isArray(args.images) ? plural(args.images.length, 'image') : Array.isArray(args.items) ? plural(args.items.length, 'item') : ''
        const asked = questionCount(args.questions)
        const common = { 'data-system-one': 'tool', 'data-system-one-reflex': 'tool', 'data-system-one-call': callId }

        if (phase !== 'result') {
          const line = phase === 'preparing' ? 'Preparing a batch' : `Answering ${plural(asked, 'question')}${source ? ` over ${source}` : ''}`
          return h(Running, { reflex: REFLEX.tool, line, common })
        }
        if (block?.isError || !meta || ui === 'off') return h(Plain, { block, common, what: 'batch' })

        const headline = [plural(num(meta.items) ?? 0, 'item'), plural(num(meta.questions) ?? 0, 'question'), plural(num(meta.requests) ?? 0, 'request')].join(' · ')
        const marked = markedIn(meta.summary)
        const done = {
          'data-system-one-verdict': 'done', 'data-system-one-tone': 'ok', 'data-system-one-count': String(meta.items ?? ''),
          'data-system-one-model': fullModel(meta.model) || undefined,
          'data-system-one-span-model': fullModel(meta.spanModel) || undefined,
          'data-system-one-spans': marked ? String(marked) : undefined,
        }
        return h(ResultRow, {
          kind: ui === 'compact' ? 'compact' : 'card', common, done, reflex: REFLEX.tool, tone: 'ok', fresh, label: `System One batch: ${headline}`,
          ms: num(meta.seconds) === undefined ? undefined : meta.seconds * 1000,
          summary: h('span', { className: 'vsr-s1__summary', 'data-system-one-part': 'summary', title: headline }, headline),
          model: meta.model,
          body: h(ToolBody, { meta, fresh, cwd, openFile, sessionId }),
        })
      }

      function SystemOneToolRow(props) {
        return h(Contained, null, h(ToolRow, props))
      }

      // ---- the system_one_screen row: a screenshot, what System One found on it, and whether the last action worked ----

      const clipText = (value, max) => (text(value).length > max ? `${text(value).slice(0, max - 1)}…` : text(value))

      function checkFact(answer) {
        if (answer?.error) return { value: 'no answer', tone: 'muted' }
        if (num(answer?.yes) !== undefined) return { value: `${answer.yes >= 0.5 ? 'yes' : 'no'} ${p2(answer.yes)}`, bar: answer.yes }
        if (text(answer?.choice)) return { value: `${answer.choice} ${p2(answer.confidence)}`, bar: num(answer.confidence) }
        if (num(answer?.score) !== undefined) return { value: answer.score.toFixed(2) }
        return { value: '?' }
      }

      function screenView(meta) {
        const found = Object.entries(meta.found ?? {}).filter(([, target]) => target && typeof target === 'object')
        const hits = found.filter(([, target]) => target.found && target.box)
        const action = meta.action && typeof meta.action === 'object' ? meta.action : undefined
        const succeeded = num(action?.succeeded)
        const expected = num(meta.expect?.yes)
        const failed = succeeded !== undefined && succeeded < 0.5
        const unexpected = expected !== undefined && expected < 0.5
        const [check] = Object.entries(meta.checks ?? {})
        const said = [
          found.length === 1 && hits.length === 1 ? `found ${hits[0][0]}` : found.length ? `found ${hits.length} of ${found.length}` : '',
          meta.expect && expected !== undefined ? (unexpected ? 'not the expected screen' : 'the expected screen') : '',
          action && succeeded !== undefined ? (failed ? 'the action did not work' : 'the action worked') : '',
        ].filter(Boolean)
        const headline = said.join(' · ') || (check ? `${check[0]}: ${checkFact(check[1]).value}` : 'looked at the screen')
        return { found, hits, action, succeeded, expected, failed, unexpected, headline, tone: failed ? 'bad' : unexpected ? 'warn' : 'ok' }
      }

      function ScreenBody({ meta, view, sessionId, cwd, openFile }) {
        const size = meta.size
        const wide = num(size?.width)
        const tall = num(size?.height)
        const boxes = view.hits.map(([id, target]) => ({ ...target.box, id, label: `${id} ${p2(target.confidence)}` }))
        const points = wide && tall ? view.hits.filter(([, target]) => target.click).map(([, target]) => ({ x: target.click.x / wide, y: target.click.y / tall })) : []
        const checks = Object.entries(meta.checks ?? {})
        return h('div', { className: 'vsr-s1__screen', 'data-system-one-part': 'rows' },
          h(Shot, { sessionId, path: meta.imagePath, boxes, points, size, alt: text(meta.image) }),
          view.found.length ? h('div', { className: 'vsr-s1__targets', 'data-system-one-part': 'targets' },
            view.found.map(([id, target]) => h('div', {
              key: id, className: cx('vsr-s1__target', !target.found && 'vsr-s1__target--missing'),
              'data-system-one-part': 'target', 'data-system-one-target': id, 'data-system-one-found': target.found ? 'yes' : 'no',
            },
            // a target named by its description alone shows it once
            id === text(target.what) ? null : h('code', { className: 'vsr-s1__qname', title: id }, id),
            h('span', { className: cx('vsr-s1__what', id === text(target.what) && 'vsr-s1__what--wide'), title: text(target.what) }, text(target.what)),
            target.found && target.click
              ? h('span', { className: 'vsr-s1__click', 'data-system-one-part': 'click' }, `click ${target.click.x}, ${target.click.y}`)
              : h('span', { className: 'vsr-s1__click vsr-s1__click--none', 'data-system-one-part': 'click' }, target.error ? 'no answer' : 'not found'),
            h('span', { className: 'vsr-s1__rowms' }, p2(target.confidence))))) : null,
          checks.length ? h('div', { className: 'vsr-s1__facts', 'data-system-one-part': 'checks' },
            checks.map(([id, answer]) => h(Fact, { key: id, id, label: id, ...checkFact(answer) }))) : null,
          meta.expect ? h('div', { className: 'vsr-s1__said', 'data-system-one-part': 'expect' },
            h(Pill, { tone: view.expected === undefined ? 'muted' : view.unexpected ? 'warn' : 'ok', part: 'verdict' },
              view.expected === undefined ? 'No answer' : `${view.unexpected ? 'Not as expected' : 'As expected'} ${p2(view.expected)}`),
            h('span', { className: 'vsr-s1__what' }, text(meta.expect.text))) : null,
          view.action ? h('div', { className: 'vsr-s1__action', 'data-system-one-part': 'action' },
            h('div', { className: 'vsr-s1__pair' },
              h('div', { className: 'vsr-s1__side', 'data-system-one-part': 'before' }, h(Shot, { sessionId, path: view.action.beforePath, size, thumb: true }), h('span', { className: 'vsr-s1__caption' }, 'Before')),
              h('span', { className: 'vsr-s1__arrow', 'aria-hidden': true }, '→'),
              h('div', { className: 'vsr-s1__side', 'data-system-one-part': 'after' }, h(Shot, { sessionId, path: meta.imagePath, size, thumb: true }), h('span', { className: 'vsr-s1__caption' }, 'After'))),
            h('div', { className: 'vsr-s1__said' },
              h(Pill, { tone: view.succeeded === undefined ? 'muted' : view.failed ? 'bad' : 'ok', part: 'verdict' },
                view.succeeded === undefined ? 'No answer' : `${view.failed ? 'Did not work' : 'Worked'} ${p2(view.succeeded)}`),
              h('span', { className: 'vsr-s1__what' }, text(view.action.text)))) : null,
          text(meta.annotated) ? h('div', { className: 'vsr-s1__foot', 'data-system-one-part': 'annotated' }, 'Annotated copy ', h(FileLink, { path: inside(meta.annotated, cwd), cwd, openFile })) : null)
      }

      function ScreenRow(props) {
        const { block, phase, callId, cwd, openFile, sessionId } = props
        const args = parseArgs(phase === 'result' ? block?.call?.argsRaw : block?.argsRaw)
        const meta = phase === 'result' && block?.meta && block.meta.systemOneScreen === 1 ? block.meta : undefined
        const ui = meta?.ui ?? 'card'
        const fresh = useFresh(`screen:${callId}:${phase}`, phase === 'result' ? block?.time : Date.now())
        const common = { 'data-system-one': 'screen', 'data-system-one-reflex': 'screen', 'data-system-one-call': callId }

        if (phase !== 'result') {
          const image = basename(args.image)
          const line = phase === 'preparing' ? 'Getting ready to look' : `Looking at ${image || 'the screen'}${text(args.action) ? ` after “${clipText(args.action, 60)}”` : ''}`
          return h(Running, { reflex: REFLEX.screen, line, common })
        }
        if (block?.isError || !meta || ui === 'off') return h(Plain, { block, common, what: 'look' })

        const view = screenView(meta)
        const done = {
          'data-system-one-verdict': 'done', 'data-system-one-tone': view.tone,
          'data-system-one-model': fullModel(meta.model) || undefined,
          'data-system-one-image': text(meta.image) || undefined,
          'data-system-one-found': view.found.length ? String(view.hits.length) : undefined,
          'data-system-one-expect': view.expected === undefined ? undefined : view.unexpected ? 'no' : 'yes',
          'data-system-one-action': view.succeeded === undefined ? undefined : view.failed ? 'failed' : 'succeeded',
        }
        // the frame stays blue; what went wrong reads in its verdict, red for an action that did not work
        const said = [view.headline, text(meta.image) || 'the screen'].join(' · ')
        return h(ResultRow, {
          kind: ui === 'compact' ? 'compact' : 'card', common, done, reflex: REFLEX.screen, tone: view.tone, fresh, label: `System One screen: ${said}`,
          ms: num(meta.seconds) === undefined ? undefined : meta.seconds * 1000,
          summary: h('span', { className: 'vsr-s1__summary', 'data-system-one-part': 'summary', title: said },
            ...joined([
              h('span', { className: cx('vsr-s1__verdict', view.tone !== 'ok' && `vsr-s1__verdict--${view.tone}`), 'data-system-one-part': 'verdict' }, view.headline),
              text(meta.image) || 'the screen',
            ])),
          model: meta.model,
          body: h(ScreenBody, { meta, view, sessionId, cwd, openFile }),
        })
      }

      function SystemOneScreenRow(props) {
        return h(Contained, null, h(ScreenRow, props))
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
.vsr-s1__qhead{display:flex;flex-direction:column;align-items:flex-start;gap:4px;min-width:0}
.vsr-s1__qhead>.vsr-s1__qname{max-width:100%}
.vsr-s1__qtag{padding:0 6px;border-radius:4px;color:var(--vsr-s1-ink);background:color-mix(in srgb,var(--vsr-s1-blue) 11%,transparent);font-size:11px;font-weight:650;line-height:17px;white-space:nowrap}
.vsr-s1__span--labels{--vsr-s1-hue:var(--vsr-s1-blue);color:var(--vsr-s1-text);background:color-mix(in srgb,var(--vsr-s1-hue) 15%,transparent);box-shadow:inset 0 -1.5px 0 var(--vsr-s1-hue)}
.vsr-s1__span--evidence{color:var(--vsr-s1-text);background:color-mix(in srgb,var(--vsr-s1-blue) 13%,transparent);box-shadow:inset 0 -1.5px 0 var(--vsr-s1-blue)}
.vsr-s1__tag{margin-left:5px;padding:0 4px;border-radius:3px;color:#fff;background:var(--vsr-s1-hue);font-family:var(--vsr-s1-mono);font-size:9.5px;font-weight:700;letter-spacing:.03em;line-height:14px;vertical-align:1px}
.vsr-s1__item{margin-right:8px;padding:0 5px;border-radius:4px;color:var(--vsr-s1-text);background:color-mix(in srgb,var(--vsr-s1-text-3) 15%,transparent);font-weight:650}
.vsr-s1__source{display:block;color:var(--vsr-s1-text-3);font-size:11px;line-height:18px}
.vsr-s1__excerpt--evidence{display:grid;justify-items:start;gap:2px}
.vsr-s1__shot{position:relative;display:block;max-width:100%;margin:0;border-radius:8px;background:color-mix(in srgb,var(--vsr-s1-text-3) 12%,transparent);box-shadow:0 0 0 1px var(--vsr-s1-line),0 8px 22px -16px rgba(16,42,84,.45)}
.vsr-s1__shot img{display:block;width:100%;height:auto;border-radius:inherit}
.vsr-s1__shot--empty{aspect-ratio:16/10}
.vsr-s1__shot--thumb{border-radius:6px}
.vsr-s1__box{position:absolute;border:2px solid var(--vsr-s1-blue);border-radius:5px;background:color-mix(in srgb,var(--vsr-s1-blue) 9%,transparent);box-shadow:0 0 0 1.5px rgba(255,255,255,.85),0 4px 14px -4px color-mix(in srgb,var(--vsr-s1-blue) 70%,transparent)}
.vsr-s1__shot--thumb .vsr-s1__box{border-width:1.5px;border-radius:3px;box-shadow:0 0 0 1px rgba(255,255,255,.8)}
.vsr-s1__boxlabel{position:absolute;left:-2px;bottom:calc(100% + 4px);padding:0 6px;border-radius:4px;color:#fff;background:linear-gradient(135deg,var(--vsr-s1-blue-deep),var(--vsr-s1-ink));font-family:var(--vsr-s1-mono);font-size:11px;font-weight:650;line-height:18px;white-space:nowrap;box-shadow:0 2px 6px -2px rgba(16,42,84,.4)}
.vsr-s1__box--low .vsr-s1__boxlabel{top:calc(100% + 4px);bottom:auto}
.vsr-s1__point{position:absolute;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;background:var(--vsr-s1-blue);box-shadow:0 0 0 3px #fff,0 0 0 4.5px rgba(15,23,42,.85),0 4px 10px rgba(15,23,42,.35)}
.vsr-s1__point::after{content:"";position:absolute;inset:-3px;border-radius:50%;border:2px solid var(--vsr-s1-blue);opacity:0}
.vsr-s1__thumbs{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:10px 8px}
.vsr-s1__thumbcell{display:grid;gap:4px;min-width:0}
.vsr-s1__thumbcell--hit .vsr-s1__shot{box-shadow:0 0 0 1.5px color-mix(in srgb,var(--vsr-s1-blue) 70%,transparent),0 6px 16px -12px rgba(16,42,84,.5)}
.vsr-s1__caption{display:flex;align-items:baseline;justify-content:space-between;gap:6px;min-width:0;color:var(--vsr-s1-text-3);font-size:11.5px;line-height:16px}
.vsr-s1__caption-name{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-family:var(--vsr-s1-mono)}
.vsr-s1__caption b{flex:none;color:var(--vsr-s1-text);font-weight:600;font-variant-numeric:tabular-nums}
.vsr-s1__thumbcell--hit .vsr-s1__caption b{color:var(--vsr-s1-ink)}
.vsr-s1__screen{display:grid;gap:10px;margin-top:10px}
.vsr-s1__screen>.vsr-s1__shot{width:100%;max-width:640px}
.vsr-s1__targets{display:grid;gap:4px}
.vsr-s1__target{display:grid;grid-template-columns:minmax(60px,120px) minmax(0,1fr) auto auto;column-gap:12px;align-items:center;font-size:12.5px;line-height:22px}
.vsr-s1__target--missing{opacity:.72}
.vsr-s1__what{min-width:0;overflow:hidden;color:var(--vsr-s1-text-2);white-space:nowrap;text-overflow:ellipsis}
.vsr-s1__what--wide{grid-column:1/3}
.vsr-s1__click{color:var(--vsr-s1-ink);font-family:var(--vsr-s1-mono);font-size:12px;font-weight:650;white-space:nowrap}
.vsr-s1__click--none{color:var(--vsr-s1-text-3);font-weight:500}
.vsr-s1__said{display:flex;align-items:center;gap:9px;min-width:0;font-size:12.5px}
.vsr-s1__action{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px}
.vsr-s1__pair{display:flex;flex:none;align-items:center;gap:8px}
.vsr-s1__side{display:grid;gap:3px;width:150px}
.vsr-s1__action>.vsr-s1__said{flex:1;min-width:220px;flex-wrap:wrap}
.vsr-s1__arrow{flex:none;color:var(--vsr-s1-text-3);font-size:16px}
.vsr-s1__excerpts>.vsr-s1__fact-label{color:var(--vsr-s1-text-3);font-size:12px}
@keyframes vsr-s1-reveal{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes vsr-s1-rise{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
@keyframes vsr-s1-draw{from{transform:scaleY(0)}to{transform:scaleY(1)}}
@keyframes vsr-s1-fill{from{transform:scaleX(0)}}
@keyframes vsr-s1-grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes vsr-s1-ink{from{background-color:transparent;box-shadow:none}}
@keyframes vsr-s1-sweep{0%{transform:translateX(-100%)}66.6667%,to{transform:translateX(100%)}}
@keyframes vsr-s1-sweep-back{0%{transform:translateX(100%)}66.6667%,to{transform:translateX(-100%)}}
@keyframes vsr-s1-settle{from{opacity:.4}to{opacity:1}}
@keyframes vsr-s1-frame{from{opacity:0;transform:scale(1.12)}to{opacity:1;transform:none}}
@keyframes vsr-s1-ripple{from{opacity:.75;transform:scale(1)}to{opacity:0;transform:scale(2.6)}}
.vsr-s1--fresh{animation:vsr-s1-reveal .22s var(--vsr-s1-ease) both}
.vsr-s1--fresh>.vsr-s1__sheen::before{animation:vsr-s1-draw .42s var(--vsr-s1-ease) .06s both}
.vsr-s1__row--fresh{animation:vsr-s1-rise .24s var(--vsr-s1-ease) both;animation-delay:calc(60ms + var(--vsr-s1-i,0) * 45ms)}
.vsr-s1__row--fresh .vsr-s1__bar>i{animation:vsr-s1-fill .6s var(--vsr-s1-ease) .16s both}
.vsr-s1__row--fresh .vsr-s1__span{animation:vsr-s1-ink .5s ease-out .26s both}
.vsr-s1__stack--fresh>i{animation:vsr-s1-grow .6s var(--vsr-s1-ease) both}
.vsr-s1__shim-sweep{animation:vsr-s1-sweep 1.5s steps(48,end) .3s infinite}
.vsr-s1__shim-copy{animation:vsr-s1-sweep-back 1.5s steps(48,end) .3s infinite}
.vsr-s1--settle .vsr-s1__shim-line{animation:vsr-s1-settle .32s var(--vsr-s1-ease) both}
.vsr-s1--fresh .vsr-s1__box{animation:vsr-s1-frame .34s var(--vsr-s1-ease) both;animation-delay:calc(.22s + var(--vsr-s1-i,0) * 70ms)}
.vsr-s1--fresh .vsr-s1__point{animation:vsr-s1-rise .3s var(--vsr-s1-ease) .5s both}
.vsr-s1--fresh .vsr-s1__point::after{animation:vsr-s1-ripple 1.1s var(--vsr-s1-ease) .62s 2}
.vsr-s1--fresh .vsr-s1__thumbcell{animation:vsr-s1-rise .26s var(--vsr-s1-ease) both;animation-delay:calc(.08s + var(--vsr-s1-i,0) * 30ms)}
.vsr-s1--fresh .vsr-s1__span--labels,.vsr-s1--fresh .vsr-s1__span--evidence{animation:vsr-s1-ink .5s ease-out .3s both}
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
          slot(scoped, 'tool.call.toolview', SCREEN_TOOL, SystemOneScreenRow)
        }))
        // screenshots and a batch's images are workspace files; without this service the cards draw no pictures
        contained('the System One images', () => ctx.inject(['remote', 'remote.workspaceFiles'], scoped => {
          const files = scoped.remote?.workspaceFiles
          if (typeof files?.readBytes !== 'function') return
          workspaceFiles = files
          for (const wake of [...filesWaiting]) wake()
        }))
      }

      exports.apply = apply
      exports.definition = definition
      exports.viewOf = viewOf
      exports.SystemOneNode = SystemOneNode
      exports.SystemOneToolRow = SystemOneToolRow
      exports.SystemOneScreenRow = SystemOneScreenRow
      exports.RECORD_TYPE = RECORD_TYPE
      exports.NODE_KIND = NODE_KIND
    } catch (error) {
      console.warn('[@vllm-sr/dsh] the System One views are off:', error)
    }
    return module.exports
  },
})
