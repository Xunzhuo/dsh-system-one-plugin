<p align="center">
<a href="https://github.com/vllm-project/semantic-router"><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Xunzhuo/dsh-system-one-plugin/main/docs/assets/brand/vllm-sr-dark.png"><img alt="vLLM Semantic Router" src="https://raw.githubusercontent.com/Xunzhuo/dsh-system-one-plugin/main/docs/assets/brand/vllm-sr-light.png" height="54"></picture></a>&nbsp;&nbsp;&nbsp;&nbsp;<a href="https://github.com/deepseek-ai/deepseek-harness"><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Xunzhuo/dsh-system-one-plugin/main/docs/assets/brand/for-deepseek-harness-dark.png"><img alt="for DeepSeek Harness" src="https://raw.githubusercontent.com/Xunzhuo/dsh-system-one-plugin/main/docs/assets/brand/for-deepseek-harness-light.png" height="54"></picture></a>
</p>

<h1 align="center">System Duo</h1>

<h3 align="center">Make your agent think <i>fast</i> and <i>slow</i>.</h3>

<p align="center">
<code>@vllm-sr/dsh</code> gives your DeepSeek Harness agent a System One: fast decision models that triage, guard, shield, mask and check every step, while System Two, <code>vllm-sr/auto</code>, thinks it through.
</p>

<p align="center">
<a href="https://www.npmjs.com/package/@vllm-sr/dsh"><img alt="npm" src="https://img.shields.io/npm/v/@vllm-sr/dsh?style=flat-square&label=npm&color=D9441F"></a>
<a href="https://github.com/Xunzhuo/dsh-system-one-plugin/blob/main/LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-2C4CA8?style=flat-square"></a>
<a href="https://app.vllm-sr.ai/#harness"><img alt="Live demo: 21 sessions" src="https://img.shields.io/badge/live%20demo-21%20sessions-16181D?style=flat-square"></a>
</p>

<p align="center">
<a href="https://app.vllm-sr.ai/#harness"><img alt="Make your agent think fast and slow, from the System Duo launch film" src="https://raw.githubusercontent.com/Xunzhuo/dsh-system-one-plugin/main/docs/assets/hero.gif" width="100%"></a>
</p>

## Quick start

```bash
npm install -g @deepseek-ai/dsh pnpm
dsh plugin --profile web add @vllm-sr/dsh
dsh web
```

On its first run the plugin fetches its own free key from [System Duo](https://app.vllm-sr.ai), for research and
evaluation use ([terms](https://app.vllm-sr.ai/terms), [privacy](https://app.vllm-sr.ai/privacy)), and makes
`vllm-sr/auto` your default model. You need Node 24.9 or later; the first line installs DeepSeek Harness and pnpm,
which `dsh plugin` uses to install plugins.

pnpm installs a release only once it is a day old, so a new version of the plugin reaches these lines a day after it
is published.

## What System One does in your agent loop

Five reflexes run on their own, and two tools are there when System Two needs them. Every card below is a real one
from the demo recordings: each number is System One's answer in that run.

<table>
<tr>
<td width="50%" valign="top">
<b>Triage</b> &middot; every request<br>
Reads each request first. A bare “Fix it.” gets a question back.<br><br>
<img alt="Triage card for the request Fix it: code work, small effort, Unclear 1.00; System Two is told to ask one short clarifying question" src="https://raw.githubusercontent.com/Xunzhuo/dsh-system-one-plugin/main/docs/assets/features/triage.png" width="100%">
</td>
<td width="50%" valign="top">
<b>Guard</b> &middot; before each tool call<br>
Asks before risky commands. A force-push waits for you: Dangerous, 2.00 of 3.<br><br>
<img alt="Guard card: Asked you; risk Dangerous, 2.00 of 3; git reset --hard v1.3 marked in red as the dangerous part" src="https://raw.githubusercontent.com/Xunzhuo/dsh-system-one-plugin/main/docs/assets/features/guard.png" width="100%">
</td>
</tr>
</table>

<table>
<tr>
<td width="50%" valign="top">
<b>Shield</b> &middot; after each tool result<br>
Strips hidden instructions before System Two reads them: 284 characters from one README.<br><br>
<img alt="Shield card: Injection removed, injection 1.00; the one span of 284 characters that gave orders to AI agents struck through" src="https://raw.githubusercontent.com/Xunzhuo/dsh-system-one-plugin/main/docs/assets/features/shield.png" width="100%">
</td>
<td width="50%" valign="top">
<b>Privacy</b> &middot; after each tool result, on by default<br>
Masks personal data as <code>[LABEL]</code> before System Two sees it: 29 details in one file.<br><br>
<img alt="Privacy card: 29 personal details masked in chat transcripts, shown by label only" src="https://raw.githubusercontent.com/Xunzhuo/dsh-system-one-plugin/main/docs/assets/features/privacy.png" width="100%">
</td>
</tr>
</table>

<table>
<tr>
<td width="50%" valign="top">
<b>Done-check</b> &middot; when a turn ends<br>
Backs “done” with evidence, complete 0.99 and checked 1.00, or sends the turn back.<br><br>
<img alt="Done-check card: The work is done; Complete 0.99, Checked 1.00, Backed 8, with the passages of the turn that back the answer" src="https://raw.githubusercontent.com/Xunzhuo/dsh-system-one-plugin/main/docs/assets/features/done-check.png" width="100%">
</td>
<td width="50%" valign="top">
<b><code>system_one</code></b> &middot; when System Two asks<br>
Typed questions over records and images: 230 tickets routed, scored and flagged in 7.0 s.<br><br>
<img alt="system_one batch card: 230 items, 3 questions, 26 requests in 7.0 s; churn risk, team and urgency for every ticket" src="https://raw.githubusercontent.com/Xunzhuo/dsh-system-one-plugin/main/docs/assets/features/system-one.png" width="100%">
</td>
</tr>
</table>

<table>
<tr>
<td valign="top">
<b>Computer use</b> &middot; <code>system_one_screen</code><br>
Sees the screen, picks the target, checks the result, and Guard stops the risky click: “Delete This Repository” waits for you at Dangerous, 2.10 of 3.<br><br>
<img alt="A system_one_screen card finds the Delete This Repository button (1.00) and checks the page (As expected 1.00, Worked 0.99); the Guard card asks before the click: Dangerous, 2.10 of 3" src="https://raw.githubusercontent.com/Xunzhuo/dsh-system-one-plugin/main/docs/assets/features/computer-use.png" width="100%">
</td>
</tr>
</table>

## See it live

<a href="https://app.vllm-sr.ai/#harness"><img alt="21 real sessions, from the System Duo launch film" src="https://raw.githubusercontent.com/Xunzhuo/dsh-system-one-plugin/main/docs/assets/live-sessions.jpg" width="100%"></a>

Open **[app.vllm-sr.ai/#harness](https://app.vllm-sr.ai/#harness)** and press **Start DeepSeek Harness**: 21 real
sessions recorded with this plugin open in your browser, read-only, with each System One card where it happened.
Fifteen run in the Web UI, from batch triage of 230 tickets to a judge scoring subject lines; six drive a full desktop
with mail, a spreadsheet, Gitea, an admin console and a web store. Then try your own in a sandbox, on a free key.

## How it works

<picture>
<source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Xunzhuo/dsh-system-one-plugin/main/docs/assets/how-it-works-dark.png">
<img alt="One router. Two minds. System One, the Decision Models d3-ultra, d3-flash, vela3-turbo and vela3-flash, decides in a blink; System Two, vllm-sr/auto, reasons in depth. In the DeepSeek Harness loop, Triage reads each request, Guard each tool call, Shield and Privacy each result, and the done-check the end of the turn." src="https://raw.githubusercontent.com/Xunzhuo/dsh-system-one-plugin/main/docs/assets/how-it-works-light.png" width="100%">
</picture>

- **System One, fast.** The Decision Models answer typed questions with calibrated probabilities in a fraction of a
  second: is this command dangerous, does this file give the agent orders, is the work really done. By default
  `vllm-sr/d3-ultra` triages, scores Shield's passages and answers the `system_one` tool, and `vllm-sr/vela3-turbo`
  runs Guard, Privacy, the done-check, every span answer and the screen.
- **System Two, slow.** `vllm-sr/auto` plans, reasons and acts, picking the right open model for each request. The
  plugin makes it your default model; choose any other model in the app and System One keeps working beside it.
- **One router.** vLLM Semantic Router serves System One and routes System Two at
  [app.vllm-sr.ai](https://app.vllm-sr.ai), and both take the one free key the plugin fetches. The router works with
  any model, open or closed.

Part of [System Duo](https://app.vllm-sr.ai), built by
[vLLM Semantic Router](https://github.com/vllm-project/semantic-router) with
[AMD](https://www.amd.com/en/products/accelerators/instinct.html).

## Configuration

It works as installed. To change it, set fields on the `system-one` row of your profile's patch,
`~/.dsh/profiles/web/cordis.patch.yml` (or `headless`):

```yaml
- id: system-one
  config:
    privacy: true      # mask personal data before System Two reads it; false turns it off
    triage: true       # each reflex and tool can be turned off
    guard: true
    shield: true
    doneCheck: true
    tool: true         # the system_one tool
    screenTool: true   # system_one_screen, for computer use
    autoKeys: true     # fetch the free key on first run
    systemOneUi: card  # how Chat shows System One: card, compact or off
```

**Your key** is kept in DeepSeek Harness's credential store and in `~/.dsh/.env`, readable by you only. In CI, set
`VLLM_SR_API_KEY` to a key from [app.vllm-sr.ai](https://app.vllm-sr.ai); a key you set yourself is always used and
never replaced.

Every option, the questions the tools take, what Chat shows and its selectors, what is sent where, and what we
measured: **[the full reference](https://github.com/Xunzhuo/dsh-system-one-plugin/blob/main/docs/reference.md)**.

## FAQ

**Is it free?** Yes, for research and evaluation: the plugin fetches a free key, and commercial use is not permitted
([terms](https://app.vllm-sr.ai/terms)).

**What leaves my machine?** What System One decides about: your request (clipped), the tool calls it reviews, the
passages of tool results it screens, the end of each turn, and what System Two hands its tools. Privacy sends the
results it masks to System One whole, and System Two gets the conversation, as any LLM provider does. System Duo logs
requests to improve its services and train models, so read its [privacy page](https://app.vllm-sr.ai/privacy) before
you use it with private code or data. Every reflex can be turned off, and the local trace never records keys.

**Does it run headless or in CI?** Yes: `dsh plugin --profile headless add @vllm-sr/dsh`, then
`dsh headless "…"`. A headless run reads its key when it starts, so its first run fetches the key and the LLM answers
from the next; in CI, set `VLLM_SR_API_KEY`.

**What if System One is unreachable?** Your agent carries on. A guarded call falls back to `guardOnError` (`allow` by
default) while DeepSeek Harness's own sandbox and approvals still apply, and a tool call that finds System One
unavailable shows one calm **Unavailable** line.

**Why didn't I get the newest release?** pnpm, which `dsh plugin add` uses, installs a release only once it is a day
old. To take one sooner, name its version, as `@vllm-sr/dsh@<version>`.

**I had `dsh-system-one` 0.2.** Run `dsh plugin --profile web remove dsh-system-one`, then add `@vllm-sr/dsh`; your
keys and your `system-one` settings stay.

## Links

[System Duo](https://app.vllm-sr.ai) &middot;
[Live demo](https://app.vllm-sr.ai/#harness) &middot;
[Docs](https://app.vllm-sr.ai/docs#deepseek-harness) &middot;
[Reference](https://github.com/Xunzhuo/dsh-system-one-plugin/blob/main/docs/reference.md) &middot;
[Changelog](https://github.com/Xunzhuo/dsh-system-one-plugin/blob/main/CHANGELOG.md) &middot;
[vLLM Semantic Router](https://github.com/vllm-project/semantic-router) &middot;
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)

## License

[Apache-2.0](https://github.com/Xunzhuo/dsh-system-one-plugin/blob/main/LICENSE).

DeepSeek Harness is a trademark of DeepSeek. This plugin and System Duo are not DeepSeek products.
