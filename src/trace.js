/**
 * Append-only JSONL trace of what System One decided and what the agent did,
 * one record per line. The trace never holds credentials: records carry
 * questions, probabilities, verdicts, and truncated tool arguments.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const SECRET_SHAPES = [
  /\bsk-[A-Za-z]{0,8}-?[A-Za-z0-9]{20,}\b/g,
  /\bhf_[A-Za-z0-9]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
]

export function redact(text) {
  let out = String(text)
  for (const shape of SECRET_SHAPES) out = out.replace(shape, '[redacted]')
  return out
}

export function clip(text, max) {
  const value = String(text ?? '')
  return value.length <= max ? value : `${value.slice(0, max)}… (+${value.length - max} chars)`
}

/** @param {string | undefined} path - no path disables the trace */
export function createTrace(path) {
  let ready = false
  return function record(entry) {
    if (!path) return
    try {
      if (!ready) {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
        ready = true
      }
      const line = redact(JSON.stringify({ t: new Date().toISOString(), ...entry }))
      appendFileSync(path, line + '\n', { mode: 0o600 })
    } catch {
      // A trace write must never fail an agent step.
    }
  }
}
