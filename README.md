# dsh-system-one

System One for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). An agent's LLM thinks slowly, in
tokens. System One, a decision model, answers the many small questions around it in about half a second each, with
calibrated probabilities: is this command dangerous, does this file try to give the agent orders, is the work really
done, which team should get each of these 230 tickets.

- **System Two**, the LLM, plans and acts: `vllm-sr/auto` from [vLLM Semantic Router](https://github.com/vllm-project/semantic-router)
  at [mom.vllm-sr.ai](https://mom.vllm-sr.ai).
- **System One**, the decision model, decides: `vllm-sr/d3-ultra` at [decision.vllm-sr.ai](https://decision.vllm-sr.ai).
  It answers typed questions (choice, yes/no, score, box) with probabilities, from one forward pass per question
  instead of generated text.

Both services are free, and the plugin gets the keys for you.

## Quick start

```bash
npm install -g @deepseek-ai/dsh                 # DeepSeek Harness 0.2.1 or later, Node 24.9 or later
dsh plugin --profile web add dsh-system-one
dsh web
```

On its first start the plugin gets one free key from each service, with the same small proof of work their "Get a
key" buttons run in the browser, and saves both in DeepSeek Harness's credential store and in `~/.dsh/.env`
(readable by you only). A notice in the session says so. `vllm-sr/auto` becomes the default model; choose another model
in the app and System One keeps working beside it.

Headless:

```bash
dsh plugin --profile headless add dsh-system-one
dsh headless "Triage tickets.jsonl: route each ticket, score its urgency, flag churn risk"
```

A headless run reads its keys when it starts. If there are none yet, the first run fetches and saves them, and the LLM
answers from the next run (or start `dsh web` once first). In CI, set `VLLM_SR_API_KEY` and `DECISION_API_KEY`
instead; keys you set yourself are always used and never replaced.

## What it does

| Reflex | Hook | What System One answers | What happens |
| --- | --- | --- | --- |
| Triage | `agent/pre-step` | kind of work, effort, unclear?, risky? | a one-line brief joins the request, with hints (use `system_one` for batch work, ask first when unclear) |
| Guard | `tools/pre-execute` | risk (Safe, Normal, Dangerous, Critical), leaks secrets?, on task? | the call runs, waits for your approval (Web UI), or is denied with the reason (headless) |
| Shield | `tools/post-execute` | does this passage give orders to an AI agent? | flagged passages are scored again line by line, and only the injected lines are removed |
| Done-check | `agent/turn-stopping` | complete?, checked?, waiting for you? | an unfinished turn goes back once or twice to finish and verify |
| Tool | `system_one` | any rubric the LLM writes, over a file of items or images | one result row per item (JSONL or CSV) and a summary |

## Your data

System One sends the decision service what it decides about: the user's request (clipped), each tool call it
reviews, the passages of tool results it screens, the end of the turn, and the items given to the `system_one` tool.
The LLM service receives the conversation as any LLM provider does. Both services log requests to improve them; read
their terms and privacy pages ([mom.vllm-sr.ai](https://mom.vllm-sr.ai/privacy),
[decision.vllm-sr.ai](https://decision.vllm-sr.ai/privacy)) before you use them with private code or data. Each
reflex can be turned off.

The local trace (`~/.dsh/system-one/trace.jsonl`, readable by you only) records every decision with its probabilities
and redacts secret-shaped strings; it never records keys. Set `trace: off` to disable it.

## Configuration

Every field has a default. Set any of them on the `system-one` row of a profile patch
(`~/.dsh/profiles/<name>/cordis.patch.yml`):

```yaml
- id: system-one
  config:
    model: vllm-sr/d3-ultra        # vllm-sr/d3-flash is a little faster; d3-ultra is the most accurate
    autoKeys: true                 # fetch free keys on first use
    guardAskMode: ask              # what a flagged call does: ask (wait for approval) or deny
    guardAskAt: 1.8                # risk score (0 Safe to 3 Critical) that asks
    guardDenyAt: 2.5               # risk score that always denies
    guardExfiltrationAt: 0.7       # "leaks secrets" probability that denies
    guardTools: [bash, write, edit, apply_patch, web_fetch]
    shieldTools: [web_fetch, read, bash]
    triage: true
    doneCheck: true
    tool: true
    trace: ~/.dsh/system-one/trace.jsonl   # or off
```

The keys come from the credential references `DECISION_API_KEY` and `VLLM_SR_API_KEY` (`apiKeyEnv`, `llmKeyEnv`).
If the decision service cannot be reached, a guarded call falls back to `guardOnError` (default `allow`); the
harness's own sandbox and approvals still apply.

## Measured

On our recorded runs, from one workstation with the network included:

| What | Result |
| --- | --- |
| A decision | p50 0.49 s, p90 0.52 s (53 guard decisions) |
| Guard | 35 of 36 right on our 36-command probe set: 16 of 16 risky commands stopped, 19 of 20 safe ones allowed |
| Shield | 22 of 22 right on our 22-passage probe set: 10 of 10 injections caught, 12 of 12 clean passages kept |
| Triage of 230 tickets | 121 s and 117,877 LLM prompt tokens, against 543 s and at least 510,986 for the LLM alone |
| UI screenshots | 5 of 5 broken screens found and boxed, no false alarms, 3.96 s for 12 |

The probe sets are ours and small: read them as a smoke test, not a benchmark.

## Develop

```bash
npm test                                         # unit tests with a fake decision service and a fake key site
DECISION_API_KEY=... node probes/guard-probe.mjs vllm-sr/d3-ultra     # live calibration of the guard
DECISION_API_KEY=... node probes/shield-probe.mjs vllm-sr/d3-ultra    # live calibration of the shield
```

## License

Apache-2.0
