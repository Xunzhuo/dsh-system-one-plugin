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
      const HUES = ['#2F9BFF', '#14C4E8', '#7357F6', '#F2A100', '#A95BF2', '#1F9D5B', '#4A6CFF', '#EF5630']
      const RAMP = ['#14C4E8', '#2F9BFF', '#7357F6', '#A95BF2', '#F2A100', '#EF5630', '#D9441F']
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
        unfinished: { label: 'Sent back', tone: 'warn' },
        unchecked: { label: 'Sent back to verify', tone: 'warn' },
        unsupported: { label: 'Sent back to re-verify', tone: 'warn' },
      }

      const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
      const p2 = value => (num(value) === undefined ? '?' : value.toFixed(2))
      const secs = ms => (num(ms) === undefined ? '' : `${(ms / 1000).toFixed(2)} s`)
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
        return { ...base, rows: [...base.rows, { ...data, seq: event.seq, time: event.time }] }
      }

      // Triage and done-check frame the turn and stay visible when it folds; so does a guard or shield card that
      // stopped something. A routine one sits with the work it checked and folds with it.
      function standsOut(state) {
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
            { id: 'effort', label: 'Effort', value: effort === undefined ? '?' : `${effortLabel} · ${effort.toFixed(1)} of 3`, bar: effort === undefined ? undefined : effort / 3 },
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
        const facts = []
        if (risk !== undefined) facts.push({ id: 'risk', label: 'Risk', value: `${level(RISK, Math.min(3, risk))} · ${risk.toFixed(2)} of 3`, bar: risk / 3, tone: risk >= 2.5 ? 'bad' : risk >= 1.8 ? 'warn' : 'ok' })
        if (leaks !== undefined) facts.push({ id: 'leaks', label: 'Leaks secrets', value: p2(leaks), bar: leaks, tone: leaks >= 0.7 ? 'bad' : undefined })
        if (onTask !== undefined) facts.push({ id: 'on-task', label: 'On task', value: p2(onTask), bar: onTask, tone: onTask < 0.15 ? 'warn' : undefined })
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
            { id: 'injection', label: 'Injection', value: p2(row.maxP), bar: num(row.maxP), tone: row.maxP >= 0.5 ? 'bad' : 'ok' },
            ...(spans ? [{ id: 'spans', label: 'Spans removed', value: String(spans) }] : []),
          ],
          excerpts: Array.isArray(row.excerpts) ? { list: row.excerpts, kind: 'removed' } : undefined,
          note: row.verdict === 'removed' ? `Removed ${what} that gave orders to AI agents before System Two read the result${spans ? '; the text around it stayed' : ''}.`
            : row.verdict === 'flagged' ? `Found ${what} that give orders to AI agents; the result was withheld.` : undefined,
        }
      }

      function privacyView(row) {
        if (row.error) return errorView(row, { text: 'so the result went to System Two unmasked', tone: 'warn' })
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
        return {
          verdict: row.verdict === 'continue' ? 'continue' : 'stop', ...verdict, why, short: verdict.label.toLowerCase(),
          headline: row.verdict === 'continue' ? `${verdict.label} to System Two (${round})` : why === 'waiting' ? 'Waiting on you' : 'The work is done',
          facts: [
            { id: 'complete', label: 'Complete', value: p2(yesOf(a.complete)), bar: yesOf(a.complete), tone: yesOf(a.complete) < 0.5 ? 'warn' : 'ok' },
            { id: 'checked', label: 'Checked', value: p2(yesOf(a.checked)), bar: yesOf(a.checked) },
            { id: 'waiting', label: 'Waiting on you', value: p2(yesOf(a.waiting)), bar: yesOf(a.waiting) },
            ...(row.spanModel ? [{ id: 'unsupported', label: 'Unsupported', value: String(unsupported), tone: unsupported ? 'warn' : 'ok' }] : []),
          ],
          excerpts: unsupported && Array.isArray(row.excerpts) ? { list: row.excerpts, kind: 'unsupported' } : undefined,
          note: why === 'unfinished' ? `Not finished yet, so System Two goes back to work (${round}).`
            : why === 'unchecked' ? `The changes were not checked, so System Two goes back to verify them (${round}).`
              : why === 'unsupported' ? `Nothing System Two read supports ${plural(unsupported, 'claim')} in its answer, so it goes back to re-verify just ${unsupported === 1 ? 'that one' : 'those'} (${round}).`
                : unsupported ? `Nothing System Two read supports ${plural(unsupported, 'claim')} in its answer.` : undefined,
        }
      }

      function viewOf(reflex, row) {
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

      // one line: the verdict, then what it was about and its leading number
      function compactLine(view) {
        const label = view.outcome ? `${view.label} → ${view.outcome.label}` : view.label
        const rest = []
        if (view.subject?.text) rest.push(`${view.subject.tool ?? ''} ${view.subject.text}`.trim())
        const lead = view.facts.find(fact => ['risk', 'injection', 'complete', 'effort', 'masked'].includes(fact.id))
        if (lead) rest.push(`${lead.label.toLowerCase()} ${lead.value}`)
        if (view.error) rest.push(view.error)
        return { label, tone: view.tone, rest: rest.join(' · ') }
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

      function Badge({ id, ms, time }) {
        const fresh = useFresh(`badge:${id}`, time)
        return h('span', { className: cx('vsr-s1__badge', fresh && 'vsr-s1__badge--fresh'), 'data-system-one-part': 'badge' },
          h('i', { className: 'vsr-s1__dot', 'aria-hidden': true }),
          h('span', { className: 'vsr-s1__name' }, 'System One'),
          secs(ms) ? h('span', { className: 'vsr-s1__ms', 'data-system-one-part': 'latency' }, secs(ms)) : null)
      }

      function Model({ model, also }) {
        const names = [...new Set([fullModel(model), fullModel(also)].filter(Boolean))]
        return names.length ? h('b', { className: 'vsr-s1__model', 'data-system-one-part': 'model', title: names.join(' + ') }, names.join(' + ')) : null
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

      function Fact({ id, label, value, bar, tone }) {
        return h('span', { className: 'vsr-s1__fact', 'data-system-one-fact': id },
          h('span', { className: 'vsr-s1__fact-label' }, label),
          num(bar) === undefined ? null : h('span', { className: cx('vsr-s1__bar', tone && `vsr-s1__bar--${tone}`), style: { '--p': clamp01(bar) }, 'aria-hidden': true }, h('i')),
          h('b', null, value))
      }

      function Row({ row, view, single }) {
        const fresh = useFresh(`row:${idOf(row)}`, row.time)
        return h('div', {
          className: cx('vsr-s1__row', fresh && 'vsr-s1__row--fresh'),
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
          view.note ? h('div', { className: 'vsr-s1__note', 'data-system-one-part': 'note' }, view.note) : null),
        !single && secs(row.ms) ? h('span', { className: 'vsr-s1__rowms', 'data-system-one-part': 'latency' }, secs(row.ms)) : null)
      }

      function Rows({ reflex, rows, views }) {
        const [all, setAll] = React.useState(false)
        const hidden = all ? 0 : Math.max(0, rows.length - ROWS_SHOWN)
        return h('div', { className: 'vsr-s1__rows', 'data-system-one-part': 'rows' },
          hidden > 0 ? h('button', { type: 'button', className: 'vsr-s1__more', 'data-system-one-part': 'more', onClick: () => setAll(true) }, `Show ${plural(hidden, `earlier ${reflex === 'guard' ? 'call' : 'result'}`)}`) : null,
          rows.slice(hidden).map((row, index) => h(Row, { key: idOf(row), row, view: views[hidden + index], single: rows.length === 1 })))
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
          h(Badge, { key: idOf(last), id: idOf(last), ms: last.ms, time: last.time }),
          h('span', { className: 'vsr-s1__reflex', 'data-system-one-part': 'reflex' }, reflex),
          h('span', { className: 'vsr-s1__summary', 'data-system-one-part': 'summary', title: headline }, headline),
          h(Model, { model: last.model, also: state.rows.find(row => row.spanModel)?.spanModel })),
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
        const line = views.length === 1 ? compactLine(views[0]) : { label: headlineOf(state.reflex, views), tone: undefined, rest: '' }
        const said = line.rest ? `${line.label} · ${line.rest}` : line.label
        return h('div', {
          className: cx('vsr-s1', 'vsr-s1--compact', `vsr-s1--${worst.tone}`, open && 'vsr-s1--open', fresh && 'vsr-s1--fresh'),
          role: 'group',
          'aria-label': `System One ${reflex}: ${said}`,
          ...attributes('compact', state, worst),
        },
        h('button', { type: 'button', className: 'vsr-s1__chip', 'data-system-one-part': 'toggle', 'aria-expanded': open, onClick: () => setOpen(!open) },
          h(Badge, { key: idOf(last), id: idOf(last), ms: last.ms, time: last.time }),
          h('span', { className: 'vsr-s1__reflex', 'data-system-one-part': 'reflex' }, reflex),
          h('span', { className: 'vsr-s1__summary', 'data-system-one-part': 'summary', title: said },
            h('span', { className: cx('vsr-s1__verdict', line.tone && `vsr-s1__verdict--${line.tone}`), 'data-system-one-part': 'verdict' }, line.label),
            line.rest ? ` · ${line.rest}` : null),
          open ? h(Model, { model: last.model, also: state.rows.find(row => row.spanModel)?.spanModel }) : null,
          h(Chevron)),
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
        h('span', { className: cx('vsr-s1__duo', fresh && 'vsr-s1__badge--fresh'), 'data-system-one-part': 'badge' }, h(KeyGlyph), 'System Duo'),
        h('span', { className: cx('vsr-s1__summary', !created && 'vsr-s1__summary--bad'), 'data-system-one-part': 'summary', title: said }, said),
        created && (row.terms || row.privacy) ? h('span', { className: 'vsr-s1__links', 'data-system-one-part': 'links' }, link(row.terms, 'Terms'), link(row.privacy, 'Privacy')) : null)
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
          return { parts: [{ label: 'yes', n: summary.yes ?? 0, color: '#EF5630' }, { label: 'no', n: summary.no ?? 0, color: 'var(--vsr-s1-track)' }] }
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
          return h('div', { className: 'vsr-s1 vsr-s1--compact vsr-s1--running', 'data-system-one': 'tool', ...common, 'data-system-one-verdict': 'running', 'data-system-one-tone': 'info' },
            h('div', { className: 'vsr-s1__chip vsr-s1__chip--static' },
              h(Badge, { id: `${callId}:running`, time: Date.now() }),
              h('span', { className: 'vsr-s1__reflex', 'data-system-one-part': 'reflex' }, REFLEX.tool),
              h('span', { className: 'vsr-s1__summary vsr-s1__shimmer', 'data-system-one-part': 'summary' }, line)))
        }

        if (block?.isError || !meta || ui === 'off') {
          const body = resultText(block)
          const first = body.split('\n')[0] || (block?.isError ? 'The batch failed' : 'Done')
          return h('div', {
            className: cx('vsr-s1', 'vsr-s1--compact', 'vsr-s1--plain', block?.isError && 'vsr-s1--bad', open && 'vsr-s1--open'),
            'data-system-one': 'tool', ...common, 'data-system-one-verdict': block?.isError ? 'error' : 'done', 'data-system-one-tone': block?.isError ? 'bad' : 'muted',
          },
          h('button', { type: 'button', className: 'vsr-s1__chip', 'data-system-one-part': 'toggle', 'aria-expanded': open, onClick: () => setOpen(!open) },
            h('span', { className: 'vsr-s1__reflex', 'data-system-one-part': 'reflex' }, 'System One'),
            h('span', { className: cx('vsr-s1__summary', block?.isError && 'vsr-s1__summary--bad'), 'data-system-one-part': 'summary', title: first }, first),
            h(Chevron)),
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
              h(Badge, { id: `${callId}:done`, ms, time: block?.time }),
              h('span', { className: 'vsr-s1__reflex', 'data-system-one-part': 'reflex' }, REFLEX.tool),
              h('span', { className: 'vsr-s1__summary', 'data-system-one-part': 'summary', title: headline }, headline),
              open ? h(Model, { model: meta.model }) : null,
              h(Chevron)),
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
          h(Badge, { id: `${callId}:done`, ms, time: block?.time }),
          h('span', { className: 'vsr-s1__reflex', 'data-system-one-part': 'reflex' }, REFLEX.tool),
          h('span', { className: 'vsr-s1__summary', 'data-system-one-part': 'summary', title: headline }, headline),
          h(Model, { model: meta.model })),
        h(ToolBody, { meta, fresh, cwd, openFile }))
      }

      function SystemOneToolRow(props) {
        return h(Contained, null, h(ToolRow, props))
      }

      // ---- styles: the Web UI's theme tokens, with System One's ember from the launch film ----

      const CSS = `
.vsr-s1{--vsr-s1-ember:#EF5630;--vsr-s1-ember-deep:#D9441F;--vsr-s1-gold:#F5B82E;--vsr-s1-ok:var(--dsw-alias-state-success-primary,#1F9D5B);--vsr-s1-warn:var(--dsw-alias-state-warn-primary,#E8A100);--vsr-s1-bad:var(--dsw-alias-state-error-primary,#E5484D);--vsr-s1-info:var(--dsw-alias-brand-primary,#2F7BF6);--vsr-s1-text:var(--dsw-alias-label-primary,#1F2329);--vsr-s1-text-2:var(--dsw-alias-label-secondary,#545961);--vsr-s1-text-3:var(--dsw-alias-label-tertiary,#8A8F98);--vsr-s1-line:var(--dsw-alias-border-l2,rgba(127,127,127,.22));--vsr-s1-track:color-mix(in srgb,var(--vsr-s1-text-3) 28%,transparent);--vsr-s1-mono:ui-monospace,SFMono-Regular,"JetBrains Mono",Menlo,Consolas,monospace;position:relative;box-sizing:border-box;width:100%;margin:6px 0;color:var(--vsr-s1-text);font-size:13.5px;line-height:1.45;text-align:left}
.vsr-s1 *{box-sizing:border-box}
.vsr-s1--card{padding:11px 14px 12px 17px;border:1px solid color-mix(in srgb,var(--vsr-s1-ember) 30%,var(--vsr-s1-line));border-radius:12px;background:linear-gradient(180deg,color-mix(in srgb,var(--vsr-s1-ember) 7%,transparent),color-mix(in srgb,var(--vsr-s1-ember) 2.5%,transparent))}
.vsr-s1--card.vsr-s1--bad{border-color:color-mix(in srgb,var(--vsr-s1-bad) 50%,var(--vsr-s1-line));background:linear-gradient(180deg,color-mix(in srgb,var(--vsr-s1-bad) 9%,transparent),color-mix(in srgb,var(--vsr-s1-bad) 3%,transparent))}
.vsr-s1--card.vsr-s1--warn{border-color:color-mix(in srgb,var(--vsr-s1-warn) 50%,var(--vsr-s1-line));background:linear-gradient(180deg,color-mix(in srgb,var(--vsr-s1-warn) 9%,transparent),color-mix(in srgb,var(--vsr-s1-warn) 3%,transparent))}
.vsr-s1__sheen{position:absolute;inset:0;border-radius:inherit;overflow:hidden;pointer-events:none}
.vsr-s1__sheen::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:linear-gradient(180deg,var(--vsr-s1-ember),var(--vsr-s1-gold))}
.vsr-s1--bad>.vsr-s1__sheen::before{background:var(--vsr-s1-bad)}
.vsr-s1--warn>.vsr-s1__sheen::before{background:var(--vsr-s1-warn)}
.vsr-s1__head{position:relative;display:flex;align-items:center;gap:9px;min-width:0}
.vsr-s1__badge{position:relative;display:inline-flex;flex:none;align-items:center;gap:6px;height:22px;padding:0 9px 0 8px;border-radius:999px;color:#fff;font-size:12px;font-weight:650;letter-spacing:-.005em;white-space:nowrap;background:linear-gradient(160deg,var(--vsr-s1-ember) 0%,var(--vsr-s1-ember-deep) 100%);box-shadow:0 1px 2px rgba(217,68,31,.28),inset 0 1px 0 rgba(255,255,255,.35)}
.vsr-s1__dot{flex:none;width:6px;height:6px;border-radius:50%;background:#fff;box-shadow:0 0 6px #fff}
.vsr-s1__ms{padding-left:7px;border-left:1px solid rgba(255,255,255,.5);font-weight:750;font-variant-numeric:tabular-nums}
.vsr-s1__reflex{flex:none;font-weight:650;color:var(--vsr-s1-text);white-space:nowrap}
.vsr-s1__summary{flex:1;min-width:0;overflow:hidden;color:var(--vsr-s1-text-2);white-space:nowrap;text-overflow:ellipsis}
.vsr-s1__summary--bad{color:var(--vsr-s1-bad)}
.vsr-s1__verdict{font-weight:600;color:var(--vsr-s1-text)}
.vsr-s1__verdict--ok{color:var(--vsr-s1-ok)}.vsr-s1__verdict--warn{color:color-mix(in srgb,var(--vsr-s1-warn) 82%,var(--vsr-s1-text))}.vsr-s1__verdict--bad{color:var(--vsr-s1-bad)}.vsr-s1__verdict--info{color:var(--vsr-s1-ember-deep)}.vsr-s1__verdict--muted{color:var(--vsr-s1-text-3)}
.vsr-s1__model{flex:none;color:var(--vsr-s1-text-2);font-size:12px;font-weight:700;letter-spacing:-.005em;white-space:nowrap}
.vsr-s1--notice{display:flex;align-items:center;gap:9px;min-width:0;margin:4px 0;padding:3px 0}
.vsr-s1--notice .vsr-s1__summary{white-space:normal}
.vsr-s1__duo{position:relative;display:inline-flex;flex:none;align-items:center;gap:5px;height:22px;padding:0 9px 0 8px;border-radius:999px;color:#fff;font-size:12px;font-weight:650;white-space:nowrap;background:linear-gradient(110deg,var(--vsr-s1-ember) 0%,#B04FD0 58%,#2F7BF6 100%);box-shadow:0 1px 2px rgba(90,60,170,.25),inset 0 1px 0 rgba(255,255,255,.32)}
.vsr-s1__glyph{flex:none}
.vsr-s1__links{display:inline-flex;flex:none;gap:10px}
a.vsr-s1__link{text-decoration:none}
.vsr-s1__rows{display:grid;grid-template-columns:auto minmax(0,1fr) auto;column-gap:12px;row-gap:8px;margin-top:9px}
.vsr-s1__rows>*{grid-column:1/-1}
.vsr-s1__row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;grid-template-columns:subgrid;column-gap:12px;align-items:start}
.vsr-s1__verdicts{display:flex;flex-direction:column;align-items:flex-start;gap:4px;min-width:92px}
.vsr-s1__pill{--tone:var(--vsr-s1-text-3);display:inline-flex;align-items:center;gap:6px;padding:1px 8px 1px 7px;border-radius:6px;color:var(--tone);background:color-mix(in srgb,var(--tone) 13%,transparent);font-size:12px;font-weight:650;line-height:20px;white-space:nowrap}
.vsr-s1__pill::before{content:"";flex:none;width:6px;height:6px;border-radius:50%;background:currentColor}
.vsr-s1__pill--then::before{width:auto;height:auto;border-radius:0;background:none;content:"\\21B3"}
.vsr-s1__pill--ok{--tone:var(--vsr-s1-ok)}.vsr-s1__pill--warn{--tone:color-mix(in srgb,var(--vsr-s1-warn) 82%,var(--vsr-s1-text))}.vsr-s1__pill--bad{--tone:var(--vsr-s1-bad)}.vsr-s1__pill--info{--tone:var(--vsr-s1-ember-deep)}.vsr-s1__pill--muted{--tone:var(--vsr-s1-text-3)}
.vsr-s1__main{display:grid;gap:3px;min-width:0}
.vsr-s1__subject{display:flex;align-items:baseline;gap:7px;min-width:0;line-height:22px}
.vsr-s1__tool{flex:none;color:var(--vsr-s1-text-2);font-weight:600}
.vsr-s1__code{min-width:0;overflow:hidden;color:var(--vsr-s1-text);font-family:var(--vsr-s1-mono);font-size:12.5px;white-space:nowrap;text-overflow:ellipsis;background:none;padding:0}
.vsr-s1__facts{display:flex;flex-wrap:wrap;gap:3px 16px;color:var(--vsr-s1-text-2);font-size:12.5px;line-height:22px}
.vsr-s1__fact{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.vsr-s1__fact b{color:var(--vsr-s1-text);font-weight:600;font-variant-numeric:tabular-nums}
.vsr-s1__bar{position:relative;width:34px;height:4px;border-radius:2px;overflow:hidden;background:var(--vsr-s1-track)}
.vsr-s1__bar>i{position:absolute;inset:0;border-radius:inherit;background:color-mix(in srgb,var(--vsr-s1-ember) 70%,var(--vsr-s1-text-3));transform-origin:left center;transform:scaleX(var(--p))}
.vsr-s1__bar--ok>i{background:var(--vsr-s1-ok)}.vsr-s1__bar--warn>i{background:var(--vsr-s1-warn)}.vsr-s1__bar--bad>i{background:var(--vsr-s1-bad)}
.vsr-s1__note{color:var(--vsr-s1-text-2);font-size:12.5px}
.vsr-s1__span{padding:0 3px;border-radius:4px;color:inherit;background:none;font:inherit}
.vsr-s1__span--removed{color:var(--vsr-s1-bad);background:color-mix(in srgb,var(--vsr-s1-bad) 15%,transparent);text-decoration:line-through;text-decoration-thickness:1.5px}
.vsr-s1__span--dangerous{color:var(--vsr-s1-bad);background:color-mix(in srgb,var(--vsr-s1-bad) 17%,transparent);box-shadow:inset 0 -2px 0 var(--vsr-s1-bad);font-weight:650}
.vsr-s1__span--unsupported{background:color-mix(in srgb,var(--vsr-s1-warn) 24%,transparent);text-decoration:underline wavy color-mix(in srgb,var(--vsr-s1-warn) 85%,var(--vsr-s1-text));text-decoration-thickness:1.5px;text-underline-offset:3px}
.vsr-s1__span--masked{display:inline-block;padding:0 6px;color:var(--dsw-alias-bg-layer-1,#fff);background:repeating-linear-gradient(135deg,color-mix(in srgb,var(--vsr-s1-text) 80%,transparent) 0 6px,color-mix(in srgb,var(--vsr-s1-text) 66%,transparent) 6px 12px);font-family:var(--vsr-s1-mono);font-size:11px;font-weight:650;letter-spacing:.02em;line-height:17px}
.vsr-s1__excerpts{display:grid;gap:5px;margin:3px 0 1px}
.vsr-s1__excerpt{padding:6px 9px;border-left:2px solid color-mix(in srgb,var(--vsr-s1-ember) 50%,transparent);border-radius:0 6px 6px 0;color:var(--vsr-s1-text-2);background:color-mix(in srgb,var(--vsr-s1-text-3) 9%,transparent);font-family:var(--vsr-s1-mono);font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
.vsr-s1--bad .vsr-s1__excerpt{border-left-color:color-mix(in srgb,var(--vsr-s1-bad) 55%,transparent)}
.vsr-s1--warn .vsr-s1__excerpt{border-left-color:color-mix(in srgb,var(--vsr-s1-warn) 60%,transparent)}
.vsr-s1__labels{display:flex;flex-wrap:wrap;gap:4px 6px}
.vsr-s1__label{display:inline-flex;align-items:center;gap:5px;padding:0 7px;border-radius:5px;color:var(--vsr-s1-text-2);background:color-mix(in srgb,var(--vsr-s1-text-3) 14%,transparent);font-family:var(--vsr-s1-mono);font-size:11.5px;line-height:20px}
.vsr-s1__label b{color:var(--vsr-s1-text);font-weight:650}
.vsr-s1__rowms{color:var(--vsr-s1-text-3);font-size:12px;line-height:22px;font-variant-numeric:tabular-nums;white-space:nowrap}
.vsr-s1__more,.vsr-s1__link{justify-self:start;padding:0;border:0;background:none;color:var(--dsw-alias-link,#2F7BF6);font:inherit;font-size:12.5px;cursor:pointer}
.vsr-s1__more:hover,.vsr-s1__link:hover{text-decoration:underline}
.vsr-s1--compact{margin:4px 0}
.vsr-s1__chip{display:flex;align-items:center;gap:9px;width:100%;min-width:0;padding:3px 0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.vsr-s1__chip--static{cursor:default}
.vsr-s1__chev{flex:none;color:var(--vsr-s1-text-3);transition:transform .16s ease}
.vsr-s1--open .vsr-s1__chev{transform:rotate(90deg)}
.vsr-s1--compact>.vsr-s1__rows{margin:4px 0 8px 3px;padding-left:12px;border-left:2px solid color-mix(in srgb,var(--vsr-s1-ember) 45%,transparent)}
.vsr-s1--plain .vsr-s1__reflex{color:var(--vsr-s1-text-2)}
.vsr-s1__raw{margin:4px 0 8px;padding:8px 10px;max-height:320px;overflow:auto;border-radius:8px;background:color-mix(in srgb,var(--vsr-s1-text-3) 10%,transparent);font-family:var(--vsr-s1-mono);font-size:12px;white-space:pre-wrap}
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
@keyframes vsr-s1-in{from{opacity:0;transform:translateY(8px) scale(.985)}to{opacity:1;transform:none}}
@keyframes vsr-s1-glow{0%{box-shadow:0 0 0 0 rgba(239,86,48,0)}25%{box-shadow:0 0 0 5px rgba(239,86,48,.2),0 8px 28px rgba(239,86,48,.18)}100%{box-shadow:0 0 0 0 rgba(239,86,48,0),0 0 0 rgba(239,86,48,0)}}
@keyframes vsr-s1-sweep{from{transform:translateX(-110%)}to{transform:translateX(110%)}}
@keyframes vsr-s1-pop{0%{transform:scale(.55)}55%{transform:scale(1.09)}100%{transform:scale(1)}}
@keyframes vsr-s1-ring{0%{opacity:.7;transform:scale(1)}100%{opacity:0;transform:scale(1.45,2.1)}}
@keyframes vsr-s1-row{from{opacity:0;transform:translateX(-10px)}to{opacity:1;transform:none}}
@keyframes vsr-s1-fill{from{transform:scaleX(0)}}
@keyframes vsr-s1-grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes vsr-s1-blink{0%,100%{opacity:1}50%{opacity:.25}}
@keyframes vsr-s1-shimmer{from{background-position:120% 0}to{background-position:-20% 0}}
.vsr-s1--fresh{animation:vsr-s1-in .3s cubic-bezier(.2,.8,.2,1) both}
.vsr-s1--card.vsr-s1--fresh{animation:vsr-s1-in .3s cubic-bezier(.2,.8,.2,1) both,vsr-s1-glow 1.3s ease-out .08s both}
.vsr-s1--fresh>.vsr-s1__sheen::after{content:"";position:absolute;top:0;bottom:0;left:0;width:100%;background:linear-gradient(100deg,transparent 30%,rgba(255,170,110,.32) 50%,transparent 70%);animation:vsr-s1-sweep 1s cubic-bezier(.3,.7,.2,1) .1s both}
.vsr-s1__badge--fresh{animation:vsr-s1-pop .55s cubic-bezier(.3,1.5,.5,1) both}
.vsr-s1__badge--fresh::after{content:"";position:absolute;inset:-1px;border:2px solid var(--vsr-s1-ember);border-radius:inherit;pointer-events:none;animation:vsr-s1-ring .85s ease-out .06s both}
.vsr-s1__row--fresh{animation:vsr-s1-row .34s cubic-bezier(.2,.8,.2,1) .06s both}
.vsr-s1__row--fresh .vsr-s1__bar>i{animation:vsr-s1-fill .7s cubic-bezier(.2,.8,.2,1) .2s both}
@keyframes vsr-s1-mark{0%{outline:2px solid color-mix(in srgb,var(--vsr-s1-ember) 70%,transparent);outline-offset:3px}100%{outline:2px solid transparent;outline-offset:0}}
.vsr-s1__row--fresh .vsr-s1__span{animation:vsr-s1-mark .9s ease-out .35s both}
.vsr-s1__stack--fresh>i{animation:vsr-s1-grow .6s cubic-bezier(.2,.8,.2,1) both}
.vsr-s1--running .vsr-s1__dot{animation:vsr-s1-blink 1s ease-in-out infinite}
.vsr-s1__shimmer{background:linear-gradient(90deg,var(--vsr-s1-text-2) 35%,var(--vsr-s1-ember) 50%,var(--vsr-s1-text-2) 65%);background-size:250% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:vsr-s1-shimmer 1.6s linear infinite}
@media (prefers-reduced-motion:reduce){.vsr-s1,.vsr-s1 *,.vsr-s1 *::before,.vsr-s1 *::after{animation:none!important;transition:none!important}.vsr-s1__shimmer{color:var(--vsr-s1-text-2)}}
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
