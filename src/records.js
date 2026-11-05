/**
 * System One in the conversation. Every decision System One makes during a turn (triage, guard, shield, done-check)
 * is written to the session as one plugin record: an ignorable event beside the events it judged, which the model
 * never sees and other readers skip. The plugin's browser half (web/client.js) draws each record in the Web UI's Chat.
 * Records carry what the Decision API answered (model, latency, answers) and what the plugin did with it.
 */
import { clip, redact } from './trace.js'

export const RECORD_TYPE = 'plugin:vllm-sr/dsh/system-one'
export const RECORD_VERSION = 1
export const UI_MODES = ['card', 'compact', 'off']

/** A copy that survives a JSON round trip unchanged: the session log refuses undefined, NaN and -0. */
export function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value))
}

/** A tool call's subject as the cards show it, clipped and with secret-shaped strings redacted. */
export function subject(text, max = 200) {
  return redact(clip(text, max))
}

const escaped = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// a path starts after a separator and ends at one, so /work does not match inside /work2 or /x/work
const START = String.raw`(?<=^|[\s'"=:(])`
const END = String.raw`(?=$|[\s'"/;&|)<>,])`

/**
 * A call as the cards show it: paths in the session's working directory relative to it, the home directory as `~`,
 * and no leading `cd` into the working directory itself.
 */
export function relativeTo(text, workspace, home) {
  let out = String(text ?? '')
  const root = dir => (typeof dir === 'string' && dir.replace(/\/+$/, '').length > 1 ? escaped(dir.replace(/\/+$/, '')) : undefined)
  const work = root(workspace)
  if (work) {
    out = out.replace(new RegExp(`${START}${work}/`, 'g'), '').replace(new RegExp(`${START}${work}${END}`, 'g'), '.')
    out = out.replace(/^cd \.\s*&&\s*/, '')
  }
  const own = root(home)
  if (own) out = out.replace(new RegExp(`${START}${own}${END}`, 'g'), '~')
  return out
}

/**
 * @param {object} options
 * @param {((session: object, type: string, data: object) => unknown) | undefined} options.append - DeepSeek
 *   Harness's appendPluginRecord; without it nothing is recorded
 * @param {'card' | 'compact' | 'off'} options.ui - how the Web UI draws the records; off records nothing
 * @param {(error: unknown) => void} [options.onError] - a record that could not be written; the step goes on
 * @returns {(session: object | undefined, decision: object) => boolean} writes one record, true when it was written
 */
export function createRecorder({ append, ui, onError }) {
  if (ui === 'off' || typeof append !== 'function') return () => false
  return function record(session, decision) {
    if (!session) return false
    try {
      append(session, RECORD_TYPE, jsonSafe({ v: RECORD_VERSION, ui, ...decision }))
      return true
    } catch (error) {
      onError?.(error)
      return false
    }
  }
}

// System One unavailable after its retries (src/client.js unavailableText, and the Decision API's own errors)
const SERVICE = /^(?:Error:\s*)?(?:System One is unavailable\b|Decision API (?:unreachable\b|5\d\d\b|429\b|401\b|403\b)|no System One key\b)/
// a call that was stopped, or not allowed to run
const STOPPED = /\btool call aborted\b|\baborted before dispatch\b|\bthe user rejected tool\b|\bapproval for tool\b.*\bwas cancelled\b|\bno approval channel\b/

/**
 * How a system_one or system_one_screen call that ended in an error ended: 'service' (System One was unavailable),
 * 'stopped', or 'arguments' (anything else the call asked for, which System Two reads in the error and corrects). The
 * Web UI draws no row for the last, one calm line for the others (web/client.js, which reads older records' text the
 * same way).
 */
export function failureOf(message) {
  const said = String(message ?? '').trim()
  if (SERVICE.test(said)) return 'service'
  if (STOPPED.test(said)) return 'stopped'
  return 'arguments'
}

/**
 * What became of a call the guard asked about, read from the call's final result: the harness turns a rejected or
 * cancelled approval into an error whose message says so.
 * @returns {'allowed' | 'rejected' | 'cancelled' | 'failed'}
 */
export function approvalOutcome(result) {
  if (!result?.isError) return 'allowed'
  const message = String(result.error?.message ?? '')
  if (/\bthe user rejected tool\b/.test(message)) return 'rejected'
  if (/\bapproval for tool\b.*\bwas cancelled\b|\bno approval channel\b/.test(message)) return 'cancelled'
  return 'failed'
}
