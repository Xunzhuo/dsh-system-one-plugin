# @vllm-sr/dsh

**System Duo** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): *Thinking, fast and slow. One
key.* (快思考，慢思考，一把 key)

An agent's LLM thinks slowly, in tokens. System One, a decision model, answers the many small questions around it in
about half a second each, with calibrated probabilities: is this command dangerous, does this file try to give the
agent orders, is the work really done, which team should get each of these 230 tickets.

- **System Two**, the LLM, plans and acts: `vllm-sr/auto` from [vLLM Semantic Router](https://github.com/vllm-project/semantic-router),
  which sends each step to the right open model.
- **System One**, the decision model, decides: `vllm-sr/d3-ultra`. It answers typed questions (choice, yes/no, score,
  box) with probabilities, from one forward pass per question instead of generated text.

Both come from [System Duo](https://app.vllm-sr.ai) with one free key, and the plugin gets that key for you: System One
answers at `https://app.vllm-sr.ai/v1/systemone`, and `vllm-sr/auto` at `https://app.vllm-sr.ai/v1/chat/completions`.

## Quick start

```bash
npm install -g @deepseek-ai/dsh                 # DeepSeek Harness 0.2.1-rc.5 or a later 0.2 release, Node 24.9 or later
dsh plugin --profile web add @vllm-sr/dsh
dsh web
```

The package can also come straight from GitHub: `dsh plugin --profile web add github:Xunzhuo/dsh-system-one-plugin`.

On its first start the plugin gets one free System Duo key, with the same small proof of work the site's "Get your
API key" button runs in the browser, and saves it in DeepSeek Harness's credential store and in `~/.dsh/.env` (readable
by you only). A notice in the session says so. `vllm-sr/auto` becomes the default model; choose another model
in the app and System One keeps working beside it.

Headless:

```bash
dsh plugin --profile headless add @vllm-sr/dsh
dsh headless "Triage tickets.jsonl: route each ticket, score its urgency, flag churn risk"
```

A headless run reads its key when it starts. If there is none yet, the first run fetches and saves it, and the LLM
answers from the next run (or start `dsh web` once first). In CI, set `VLLM_SR_API_KEY` to a key from
[app.vllm-sr.ai](https://app.vllm-sr.ai) instead; a key you set yourself is always used and never replaced.

Had the earlier `dsh-system-one` 0.2 from GitHub or a local path? Replace it with
`dsh plugin --profile web remove dsh-system-one`, then add `@vllm-sr/dsh` as above. Your keys and the `system-one` row
of your profile patch stay as they are.

## What it does

| Reflex | Hook | What System One answers | What happens |
| --- | --- | --- | --- |
| Triage | `agent/pre-step` | kind of work, effort, unclear?, risky? | a one-line brief joins the request, with hints (use `system_one` for batch work, ask first when unclear) |
| Guard | `tools/pre-execute` | risk (Safe, Normal, Dangerous, Critical), leaks secrets?, on task? | the call runs, waits for your approval (Web UI), or is denied with the reason (headless) |
| Shield | `tools/post-execute` | does this passage give orders to an AI agent? | flagged passages are scored again line by line, and only the injected lines are removed |
| Done-check | `agent/turn-stopping` | complete?, checked?, waiting for you? | an unfinished turn goes back once or twice to finish and verify |
| Tool | `system_one` | any rubric the LLM writes, over a file of items or images | one result row per item (JSONL or CSV) and a summary |

## Your data

System One sends what it decides about: the user's request (clipped), each tool call it reviews, the passages of tool
results it screens, the end of the turn, and the items given to the `system_one` tool. System Two receives the
conversation as any LLM provider does. System Duo logs requests to improve the services; read its
[terms](https://app.vllm-sr.ai/terms) and [privacy](https://app.vllm-sr.ai/privacy) pages before you use it with
private code or data. Each reflex can be turned off.

The local trace (`~/.dsh/system-one/trace.jsonl`, readable by you only) records every decision with its probabilities
and redacts secret-shaped strings; it never records keys. Set `trace: off` to disable it.

## Configuration

Every field has a default. Set any of them on the `system-one` row of a profile patch
(`~/.dsh/profiles/<name>/cordis.patch.yml`):

```yaml
- id: system-one
  config:
    model: vllm-sr/d3-ultra        # vllm-sr/d3-flash is a little faster; d3-ultra is the most accurate
    autoKeys: true                 # fetch the free System Duo key on first use
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

The key comes from the credential reference `VLLM_SR_API_KEY` (`llmKeyEnv`), which both systems use. A separate
System One key in `DECISION_API_KEY` (`apiKeyEnv`), as plugin 0.2 kept it, still wins for System One; a 0.2 key for
`vllm-sr/auto` keeps working too.
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
VLLM_SR_API_KEY=... node probes/guard-probe.mjs vllm-sr/d3-ultra      # live calibration of the guard
VLLM_SR_API_KEY=... node probes/shield-probe.mjs vllm-sr/d3-ultra     # live calibration of the shield
```

## Trademarks

DeepSeek Harness is a registered trademark of DeepSeek, named here only to identify the harness the plugin works with.
The plugin is not a DeepSeek product, and DeepSeek does not endorse System Duo.

## License

Apache-2.0
