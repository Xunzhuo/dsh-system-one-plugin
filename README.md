# @vllm-sr/dsh

**System Duo** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): *Thinking, fast and slow.*

An agent's LLM thinks slowly, in tokens. System One, a decision model, answers the many small questions around it in
about half a second each, with calibrated probabilities: is this command dangerous, does this file try to give the
agent orders, is the work really done, which team should get each of these 230 tickets.

- **System Two**, the LLM, plans and acts: `vllm-sr/auto` from [vLLM Semantic Router](https://github.com/vllm-project/semantic-router),
  which sends each step to the right open model.
- **System One**, the decision models, decide: `vllm-sr/vela3-turbo` guards each call, checks the work and looks at
  screenshots, in one request each, and `vllm-sr/d3-ultra` triages requests, screens tool results and answers the
  `system_one` tool's rubrics. They answer typed questions (choice, yes/no, score, box, spans, router signals) with
  probabilities, from one forward pass per question instead of generated text.

Both take a free [System Duo](https://app.vllm-sr.ai) key, which the plugin gets for you: System One answers at `https://app.vllm-sr.ai/v1/systemone`,
and `vllm-sr/auto` at `https://app.vllm-sr.ai/v1/chat/completions`.

## Quick start

```bash
npm install -g @deepseek-ai/dsh pnpm
dsh plugin --profile web add @vllm-sr/dsh@0.6.9
dsh web
```

The first line installs DeepSeek Harness (0.2.1-rc.5 or a later 0.2 release, on Node 24.9 or later) and pnpm, which
`dsh plugin` uses to install plugins; without pnpm, `dsh plugin add` stops with "pnpm was not found". Name the
version: pnpm installs no release younger than a day (its `minimumReleaseAge` supply-chain policy), so a plain
`@vllm-sr/dsh` or `@latest` gets the newest release that is at least a day old; a version you name is installed as
asked. On a machine with git, the package can also come straight from GitHub:
`dsh plugin --profile web add github:Xunzhuo/dsh-system-one-plugin`.

On its first start the plugin gets a free System Duo key, with the same small proof of work the site's "Get your API
key" button runs in the browser, and saves it in DeepSeek Harness's credential store and in `~/.dsh/.env` (readable
by you only). A line under your first request says so: "Free API key created for app.vllm-sr.ai, saved in
~/.dsh/.env", or why the site refused one. `vllm-sr/auto` becomes the default model; choose another model
in the app and System One keeps working beside it.

Headless:

```bash
dsh plugin --profile headless add @vllm-sr/dsh@0.6.9
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
| Guard | `tools/pre-execute` | risk (Safe, Normal, Dangerous, Critical), leaks secrets?, on task?, harmful? (router signals) | the call runs, waits for your approval (Web UI), or is denied with the reason (headless) |
| Shield | `tools/post-execute` | does this passage give orders to an AI agent? | flagged passages are scored again line by line, and only the injected lines are removed |
| Privacy | `tools/post-execute` | which words are personal data? | names, e-mail addresses, phone numbers and the like become `[LABEL]` before System Two reads them |
| Done-check | `agent/turn-stopping` | complete?, checked?, waiting for you?, declined? (router signal), which words nothing read supports, what backs the answer | an unfinished turn goes back once or twice to finish and verify |
| Tool | `system_one` | any rubric the LLM writes, over a file of items or images: choices, yes/no, scores, boxes, the words that carry its labels, personal data, claims its sources don't back, router signals | one result row per item (JSONL or CSV), a summary, and on request a redacted copy or annotated images |
| Screen | `system_one_screen` | on one screenshot: where to click, what the screen shows, whether the last action worked | the pixel to click and the box of each target, the answers, and a verdict on the action |

### Span answers and router signals (vllm-sr/vela3-turbo)

`vllm-sr/vela3-turbo` answers the decisions with its d3 base, and also span questions (which words of a text carry a
label, with code-point offsets and a probability each) and the router's signals (the trained heads `vllm-sr/auto`'s
router reads). Once the Decision API lists `span` for it (`spans: auto`, the default), every capability below is on:

- **Guard**: one request answers the guard's questions, names the shell command that does the damage, and asks the
  router's harm heads beside them: `p_harm` over the call, and `r_harm` over the request and the call as its answer.
  A call they are sure is harmful (`r_harm` from 0.9) is asked about even when its risk is low, and a call the guard
  asks about is denied when both are surer still (0.98).
- **Shield**: in a passage it flagged, the sentences that give orders go, and the text around them stays. The passage
  is scored again without them, and a cut that leaves an injection behind falls back to removing lines.
- **Done-check**: one request answers its questions, marks the words of the final answer that nothing the turn read
  supports (preset `halu`) and the passages of what it read that back the answer (`evidence`), and asks `r_refusal`:
  System Two goes back to re-verify just the unsupported claims, the card shows the backing passages as **Backed by**
  with the tool and file they came from, and an answer that declined (you rejected a step, or the request) is not
  pushed to carry on.
- **Privacy** (on by default; `privacy: false` turns it off): personal data in tool results (preset `pii`, 17 labels)
  becomes its label, as `[EMAIL_ADDRESS]`, before System Two reads it: the nine sensitive labels by default (names,
  e-mail and street addresses, phone, card, bank and ID numbers, IP addresses), while dates, organizations and places
  pass. What is not personal data stays: the machine's own account and host names (as in `ls -la`), loopback and
  private network addresses, and the words you wrote in the request itself. A small card shows what was masked, by
  label only.

The guard and the done-check asked `vllm-sr/d3-ultra` for the decision and `vllm-sr/vela3-turbo` for the words until
0.5.1, because the d3 models answer no span questions. On our A/B sets the one request does as well or better:

| Over the same cases | `d3-ultra` decides, `vela3-turbo` marks (until 0.5.1) | `vela3-turbo` alone, one request (0.5.2) |
| --- | --- | --- |
| Guard, 25 calls (the demo prompts, routine work, risky and destructive commands) | 48 of 50 right (2 runs), p50 929 ms | 75 of 75 right (3 runs), p50 641 ms |
| Done-check, 10 turns | 18 of 20 right, p50 676 ms | 30 of 30 right, p50 630 ms |

The router signals alone cannot replace the guard's questions: `r_harm` tells an allowed call from a flagged one but
not a question from a block, and `attack` reads commands as prompts (it called `ls -la` a jailbreak). Beside the
questions, they cost about 100 ms; `signals: false` leaves them out.

### The `system_one` tool

System Two calls `system_one` when one judgment applies to many items: the records of a JSONL, JSON or CSV file, the
lines of a text file, a list of strings, or images. It writes the rubric; each question is one of:

| Question | What System One answers for each item |
| --- | --- |
| `{"type": "choice", "criteria": {...}}` | the option that fits, with its confidence |
| `{"type": "noul", "instructions": "..."}` | the probability of yes |
| `{"type": "score", "criteria": [...]}` | the expected level of an ordered scale, from 0, or on the levels' own numbers (`"1 = vague"`, `"2 = clear"`) |
| `{"type": "box", "instructions": "..."}` | where an image shows it, as a box in fractions of the image (images only) |
| `{"type": "span", "criteria": {"ERROR": "...", "COMPETITOR": "..."}}` | the words that carry each of your labels, with offsets and a probability each |
| `{"preset": "pii"}` | personal data: the nine sensitive labels, or the ones `labels` picks (`"all"` for every label it knows) |
| `{"preset": "halu"}` | the words of the item that its `sources` do not support |
| `{"preset": "evidence"}` | the words of the `sources` that back the item, with their file and line |
| `{"signal": "attack"}` | a vLLM Semantic Router signal: `attack`, `p_harm`, `domain`, `factcheck`, `feedback`, `modality` or `scenario`; `r_harm` and `r_refusal` judge a reply, from `state_fields` `user` and `answer` |

Span questions, presets and signals go to `span_model` (`vllm-sr/vela3-turbo`), the others to `model`, in one call.
Each call writes one result row per item (`<file>.s1.jsonl` beside its file, `<folder>.s1.jsonl` beside a folder of
images, or a CSV) and returns a summary System Two reads instead of the items. A question carries only `type`,
`instructions` and `criteria` (span questions also `over` and `threshold`); other fields are dropped. Instructions
written as `question`, `description` or `prompt` count, and so does a box question's target written as `target`,
`what`, `find` or `id`. A label set written as a choice (one option, or options named in capitals under instructions
such as "Mark the words of …") is asked as a span question, and a `type` written beside the questions applies to those
that have none. A question that fails for its items says why in the summary. Requests stay within the Decision API's
estimate, which counts an item's state once for every question that reads it; an item no request could read is
refused with what to change. Beside the rubric:

- `sources`: the files the items should agree with (docs, a policy, a changelog), for `halu` and `evidence`.
- `state_fields`: the fields of each record a question reads, as `{"user": "question", "answer": "reply"}`. With
  `sources`, a record's `context` (the question a reply answers) is read before the sources, and evidence found in
  it names that field instead of a file and line.
- `redact`: a copy of the items with what `pii` marked (else what the span questions marked) replaced by its
  `[LABEL]`, in the input's format: `true` for `<file>.redacted.<ext>`, or a path. Each item's id stays, as do the
  ids in its text that the span model takes for names (`C-2087`), and a marked person's name is masked wherever it
  or a part of it recurs in the item.
- `annotate`: a directory for PNG copies of the images with the boxes found drawn in red.

The results file holds one row per item: its id, its answers and the start of its text. A call that asks `attack`,
`p_harm`, `r_harm` or `r_refusal` keeps ids and answers only, so reading the results brings none of the flagged
words into System Two's context.

### Screens (`system_one_screen`)

For computer use, System One is the eyes of each step. System Two gives it one screenshot and asks:

- `find`: what to locate, as `{"pay": "the Pay now button"}`. Each target comes back with its box, the pixel to click
  (the box's centre) and a confidence; below 0.4 it is not on the screen.
- `check`: yes/no, choice or score questions about the screen, as the `system_one` tool takes them.
- `expect`: what the screen should show now, in words; answered yes or no.
- `before` and `action`: the screenshot from before the last action and what that action was; System One says
  whether it worked, from the two screenshots (`before` alone is judged as the last step of the task).
- `annotate`: a PNG copy with the boxes in red and the click points in blue (beside the screenshot when given its own
  path).

It answers in about a second (`screenModel`, `vllm-sr/vela3-turbo` by default). Coordinates are pixels of the
screenshot, from its top left corner.

## See it in the Web UI

In `dsh web`, System One shows up in the conversation itself, where it acted, in a line drawn like the Web UI's own
tool rows: an icon, **System One** in the blue of the vLLM logo, and the decision's latency (`182 ms`, or `1.4 s` from
a second up):

- **Triage**: a card under your request with the kind of work, the effort, how unclear and how risky it is, and the
  brief System Two was given.
- **Guard**: a line beside each reviewed call with its verdict and risk. A call that was blocked or sent to you for
  approval becomes a card with the reason, and with your answer once you give it.
- **Shield**: a line after each screened tool result. A result that tried to give the agent orders becomes a card
  that says how many lines were removed.
- **Done-check**: a card after the answer: done, waiting on you, or sent back to finish, with the passages that back
  the answer under **Backed by**.
- **`system_one` tool**: its row shows the batch: items, questions, each question's answer distribution and the
  results file. A span question shows its labels in their own colours and a few items with the words marked (personal
  data only as its label), a grounded one the passage and the `file:line` it came from, and a preset or signal its
  name. A batch of images shows each image with the boxes found on it. The redacted copy, the annotated images and
  the sources are links that open the file.
- **`system_one_screen` tool**: a card with the screenshot, each target's box and the point to click, the answers about
  the screen, whether it is the expected one, and, after an action, the screens before and after with **Worked** or
  **Did not work**.
- **Free key**: a **System Duo** line under your first request when the plugin created a key, or could not.
- **Spans** (vllm-sr/vela3-turbo): the words a span answer marked, in the card that used them: removed injections
  struck through, a command's dangerous part, unsupported claims of the answer underlined, and masked personal data as
  label chips in a **Privacy** card.

Routine checks (an allowed call, a clean result) are one line. When a turn ends, DeepSeek Harness folds its work
("Completed in …", "Ran commands"), and System One stays outside the fold: each line and card keeps its place, and each
`system_one` or `system_one_screen` call keeps one line (**System One**, the latency, the verdict) that opens its card
again. A reloaded session shows the same. Parallel calls in one step share one line or card. A decision that takes longer than a moment shows as **Deciding**, with the Web UI's own shimmer across its line,
until its answer settles in its place; every card fades in once, the first time it appears (no motion with reduced
motion). Every card keeps its blue frame: red marks only what System One stopped, inside it (a Dangerous level, the
dangerous part of a command, a blocked call, removed text, your rejection), and amber what it asks (your approval, or
System Two to go back). Each element shows the Decision API's own answer: the probabilities, the model that answered
(one name, in bold, as `vllm-sr/vela3-turbo`; a second model, such as a span model, is named inside the card) and the
measured latency.

Set `systemOneUi` to `compact` for one line per decision, or to `off` to hide them.

### Selectors

For tests and screen recordings, each System One element in Chat is one root marked `data-system-one`, with stable
attributes that say what it shows:

| Attribute | Values |
| --- | --- |
| `data-system-one` | `card`, `compact` (one line), `tool` (the `system_one` row, and the line a finished turn keeps for each call), `screen` (the same for `system_one_screen`) or `notice` (the free-key line) |
| `data-system-one-reflex` | `triage`, `guard`, `shield`, `privacy`, `done`, `tool`, `screen` or `key` |
| `data-system-one-verdict` | triage `brief`; guard `allow`, `ask` or `deny`; shield `clean`, `removed` or `flagged`; privacy `masked` or `clean`; done-check `stop` or `continue`; tool and screen `running` or `done`; key `created` or `failed`; `deciding` while System One has not answered yet, `cancelled` when the turn stopped first; `error` when System One did not answer |
| `data-system-one-outcome` | guard, once you answer its approval: `allowed`, `rejected`, `cancelled` or `failed` |
| `data-system-one-why` | done-check: `complete`, `waiting`, `declined`, `unfinished`, `unchecked` or `unsupported` |
| `data-system-one-tone` | the tone of what it decided: `ok` and `info` (blue), `warn` (amber: it asks you, or sends System Two back), `bad` (red: it blocked or removed something) or `muted`; a card's frame is blue whatever its tone |
| `data-system-one-count` | how many decisions it holds (a batch: how many items) |
| `data-system-one-turn`, `data-system-one-step` | where it acted (the step for guard and shield) |
| `data-system-one-model` | the model that answered, as `vllm-sr/d3-ultra` |
| `data-system-one-span-model`, `data-system-one-spans` | the span model that marked words, as `vllm-sr/vela3-turbo`, and how many |
| `data-system-one-image` | a screen row's screenshot, as given; on each `shot`, the image's file name |
| `data-system-one-found` | a screen row: how many targets were found; a `target`: `yes` or `no`; a batch `image`: how many boxes it shows |
| `data-system-one-expect` | a screen row with `expect`: `yes` (the expected screen) or `no` |
| `data-system-one-action` | a screen row with `before` and `action`: `succeeded` or `failed` |

Inside a root, `data-system-one-part` marks `icon` (the line's icon slot), `badge` (**System One**, in blue),
`latency`, `reflex`, `summary`, `model`, `head`, `toggle` (the button of a one-line element), `rows`, `verdict`,
`outcome`, `subject`, `facts`, `note`, `span-model` (a second model, named in a card), `more` and `progress` (the
shimmer while it decides), in the batch row also `stack`, `legend`, `failed`, `results` and `raw`, and in the free-key
line `icon`, `badge` (**System Duo**), `summary` and `links`. Span answers add `excerpts`, each `excerpt`, every marked
`span` (with `data-system-one-span-label` and `data-system-one-probability`) and, in a Privacy card, the `labels`. A
done-check's passages are `evidence`, each `backing` with its `source`. Each batch question (`data-system-one-question`,
with its type in `data-system-one-kind`: `choice`, `noul`, `score`, `box` or `span`) may show a `qtag` (its preset or
signal) and `examples`, each `example` (`data-system-one-item`) with its marked `span`s and the `source` of a
passage; the batch row adds `images`, each `image` (`data-system-one-item`) with its `shot`, and the links
`redacted`, `annotated` and `sources`. The screen row shows the `shot` with each `box` (`data-system-one-box`, the
target) and `point` (where to click), the `targets`, each `target` (`data-system-one-target`) with its `click`, the
`checks`, `expect`, and an `action` with the `before` and `after` screens, and `annotated`. Each number is a
`data-system-one-fact`: `kind`, `effort`, `unclear` and `risky` (triage), `risk`, `leaks`, `on-task`, and the router
signals `harm` (the call) and `request-harm` (the request it serves) (guard), `passages`, `injection` and `spans`
(shield), `masked` (privacy), `complete`, `checked`, `waiting`, the router signal `declined`, `unsupported` and
`backed` (done-check), and in a screen row each check by its id. Decision rows carry `data-system-one-decision` and
`data-system-one-call`. For example:

| Element | Selector |
| --- | --- |
| Triage card | `[data-system-one-reflex="triage"]` |
| Guard card that asked you (its "Asked you" amber) | `[data-system-one-reflex="guard"][data-system-one-verdict="ask"]` |
| The same card once you rejected the call (its "You rejected it" red) | `[data-system-one-reflex="guard"][data-system-one-outcome="rejected"]` |
| Injection removed | `[data-system-one-reflex="shield"][data-system-one-verdict="removed"]` |
| A routine check (one line) | `[data-system-one="compact"][data-system-one-reflex="guard"]`, and `"shield"` |
| Done-check | `[data-system-one-reflex="done"]` |
| Batch row, finished | `[data-system-one="tool"][data-system-one-verdict="done"]` |
| **System One** in blue, and its latency | `[data-system-one-part="badge"]`, `[data-system-one-part="latency"]` |
| System One still deciding | `[data-system-one-verdict="deciding"]`, and its shimmer `[data-system-one-part="progress"]` |
| "Dangerous", and "You rejected it" | `[data-system-one-fact="risk"]`, `[data-system-one-part="outcome"]` |
| The reason | `[data-system-one-part="note"]` |
| The model's name (bold) | `[data-system-one-part="model"]` |
| Free key created | `[data-system-one="notice"][data-system-one-verdict="created"]` |
| The words a span answer marked | `[data-system-one-part="span"]` (`[data-system-one-span-label="INJECTION"]`, `"DANGEROUS"`, `"unsupported"`, a PII label) |
| Privacy card | `[data-system-one-reflex="privacy"][data-system-one-verdict="masked"]` |
| Done-check that sent claims back | `[data-system-one-reflex="done"][data-system-one-why="unsupported"]` |
| What backs a done answer | `[data-system-one-reflex="done"] [data-system-one-part="evidence"]` |
| A batch's span question, and its marked items | `[data-system-one-kind="span"]`, `[data-system-one-part="example"]` |
| The words of one label | `[data-system-one-part="example"] [data-system-one-span-label="ERROR"]` |
| A batch image with a box | `[data-system-one-part="image"]:not([data-system-one-found="0"])` |
| The redacted copy | `[data-system-one-part="redacted"]` |
| Screen row, finished | `[data-system-one="screen"][data-system-one-verdict="done"]` |
| The screenshot, a box and its click point | `[data-system-one="screen"] > [data-system-one-part="rows"] > [data-system-one-part="shot"]`, `[data-system-one-part="box"]`, `[data-system-one-part="point"]` |
| An action that did not work (red) | `[data-system-one="screen"][data-system-one-action="failed"]` |
| A target found | `[data-system-one-part="target"][data-system-one-found="yes"]` |

## Your data

System One sends what it decides about: the user's request (clipped), each tool call it reviews, the passages of tool
results it screens, the end of the turn (with what the turn read, for the done-check's span answers), the items and
sources given to the `system_one` tool, and the screenshots given to `system_one_screen`. Privacy, on by default,
sends the results of `privacyTools` to System One whole. System Two receives the
conversation as any LLM provider does. System Duo logs requests to improve the services and to train models; read its
[terms](https://app.vllm-sr.ai/terms) and [privacy](https://app.vllm-sr.ai/privacy) pages before you use it with
private code or data. Each reflex can be turned off.

The local trace (`~/.dsh/system-one/trace.jsonl`, readable by you only) records every decision with its probabilities
and redacts secret-shaped strings; it never records keys. Set `trace: off` to disable it.

For the Web UI, each decision is also written to the session's own log as a plugin record
(`plugin:vllm-sr/dsh/system-one`): its answers, model, latency and verdict, and the reviewed call in short with
secret-shaped strings redacted. The model never sees these records, other clients skip them, and they stay with the
session when it is resumed or forked. `systemOneUi: off` writes none.

## Configuration

Every field has a default. Set any of them on the `system-one` row of a profile patch
(`~/.dsh/profiles/<name>/cordis.patch.yml`):

```yaml
- id: system-one
  config:
    model: vllm-sr/d3-ultra        # triage, shield and the system_one tool; vllm-sr/d3-flash is a little faster
    guardModel: vllm-sr/vela3-turbo  # the guard: its questions, router signals and the dangerous part in one request
    doneModel: vllm-sr/vela3-turbo   # the done-check: its questions, unsupported claims and refusal in one request
    autoKeys: true                 # fetch the free System Duo key on first use
    guardAskMode: ask              # what a flagged call does: ask (wait for approval) or deny
    guardAskAt: 1.8                # risk score (0 Safe to 3 Critical) that asks
    guardDenyAt: 2.5               # risk score that always denies
    guardExfiltrationAt: 0.7       # "leaks secrets" probability that denies
    signals: true                  # ask the router's safety signals beside the guard's and the done-check's questions
    guardHarmAt: 0.9               # r_harm that asks about a call the questions allowed
    guardHarmDenyAt: 0.98          # r_harm and p_harm, both this sure, deny a call the questions asked about
    doneRefusalAt: 0.5             # r_refusal from which an answer that declined is not sent back
    guardTools: [bash, write, edit, apply_patch, web_fetch]
    shieldTools: [web_fetch, read, bash]
    triage: true
    doneCheck: true
    tool: true
    trace: ~/.dsh/system-one/trace.jsonl   # or off
    systemOneUi: card              # how Chat shows System One: card, compact (one line each) or off
    spans: auto                    # span answers: auto (once spanModel lists span), on or off
    spanModel: vllm-sr/vela3-turbo
    shieldSpans: true              # remove injected words, not lines
    guardSpans: true               # name the dangerous part of a flagged call
    doneHalu: true                 # send unsupported claims back
    doneHaluAt: 0.6                # the lowest probability of an unsupported word that counts
    doneEvidence: true             # show what backs the answer
    doneEvidenceAt: 0.5            # the lowest probability of a backing passage that counts
    privacy: true                  # mask personal data before System Two reads it; false turns it off
    privacyAt: 0.5                 # the lowest probability of a personal-data span that is masked
    privacyLabels: [PERSON, EMAIL_ADDRESS, PHONE_NUMBER, STREET_ADDRESS, CREDIT_CARD, IBAN_CODE, US_SSN, US_DRIVER_LICENSE, IP_ADDRESS]
    privacyTools: [web_fetch, bash, read]
    screenTool: true               # the system_one_screen tool, for computer use
    screenModel: vllm-sr/vela3-turbo
```

`systemOneUi` applies to decisions made after a restart with the new value; decisions already in a session keep the
form they were recorded with. The tool's custom row is drawn for the default `toolName`, `system_one`, and for
`system_one_screen`.

With privacy on (the default), System Two sees `[LABEL]` placeholders instead of personal data in the results of
`privacyTools`, so it cannot copy a real value into a file it writes from what it read; it is told to ask you
instead. Placeholders already in a result, as in a redacted copy, are left as they are, and so are their bare names
(`'CREDIT_CARD'` in a list), ids such as `m01`, sizes such as `960x540` and file paths that the span model takes for
names, numbers or addresses. Span records keep labels
and offsets of personal data, never the data itself. A guard or done-check model
that answers no span questions (a d3 model) gets the questions over the text, and `spanModel` marks the words in a
second request.

The key comes from the credential reference `VLLM_SR_API_KEY` (`llmKeyEnv`), which both systems use. A separate
System One key in `DECISION_API_KEY` (`apiKeyEnv`), as plugin 0.2 kept it, still wins for System One; a 0.2 key for
`vllm-sr/auto` keeps working too.
If the decision service cannot be reached, a guarded call falls back to `guardOnError` (default `allow`); the
harness's own sandbox and approvals still apply.

## Measured

On our recorded runs, from one workstation with the network included:

| What | Result |
| --- | --- |
| A guard decision (`vllm-sr/vela3-turbo`, one request with its signals and the dangerous part) | p50 655 ms, p90 678 ms (36 commands) |
| Guard | 35 of 36 right on our 36-command probe set: 16 of 16 risky commands stopped, 9 of 9 that must be denied denied, 19 of 20 safe ones allowed |
| Guard and done-check, `vela3-turbo` alone against the `d3-ultra` split | see the A/B table under "Span answers and router signals" |
| Shield | 22 of 22 right on our 22-passage probe set: 10 of 10 injections caught, 12 of 12 clean passages kept |
| Triage of 230 tickets | 121 s and 117,877 LLM prompt tokens, against 543 s and at least 510,986 for the LLM alone |
| Triage, unclear? | 47 of 48 right on our 48-request probe set: 32 of 32 clear requests go ahead (at most 0.40), 15 of 16 vague ones ("Fix it.") ask first |
| UI screenshots | 5 of 5 broken screens found and boxed, no false alarms, 3.96 s for 12 |
| Dashboard charts | 7 of 7 charts with an anomaly found and boxed, no false alarms, 6 of 7 kinds right (a flatline read as a drop), 4.24 s for 16 |
| Draft replies against 4 policies | every reply's backing policy line found; 5 of 5 planted unsupported promises marked, 3.91 s for 12 |

The probe sets are ours and small: read them as a smoke test, not a benchmark.

## Develop

```bash
npm test                                         # unit tests with a fake decision service and a fake key site
VLLM_SR_API_KEY=... node probes/guard-probe.mjs vllm-sr/d3-ultra      # live calibration of the guard
VLLM_SR_API_KEY=... node probes/shield-probe.mjs vllm-sr/d3-ultra     # live calibration of the shield
```

A `v*` tag publishes the package to npm from GitHub Actions with trusted publishing, with no npm token in the
repository; see [RELEASING.md](https://github.com/Xunzhuo/dsh-system-one-plugin/blob/main/RELEASING.md).

## Trademarks

DeepSeek Harness is a trademark of DeepSeek, named here only to identify the harness the plugin works with.
The plugin is not a DeepSeek product, and DeepSeek does not endorse System Duo.

## License

Apache-2.0
