# Changelog

## 0.8.0 (2026-11-12)

- **vLLM Semantic Router routes on your words.** The router reads the last user message that has text, and the
  triage brief used to come after your request, so a correction such as "that's not right" was routed as the brief.
  The plugin's notices now go in before the request, and in a session on the router the request also comes after
  DeepSeek Harness's working-directory and time snapshots. Every notice the plugin adds starts with `[System One` or
  `[System Duo]`, the shield's too, so a router can leave out the ones that come later in a turn
  (`routing_input.skip_user_messages_matching`).
- **One session, one model.** Each conversation request to the router carries the agent session's random id as
  `x-session-id` and `x-conversation-id`. Until now every request looked like a new session to the router, which then
  fell back to a hash of the whole history, so its session protection could never keep a session on one model.
  Titles and compactions carry none; `routerSession: false` leaves the headers out.
- **The model under each turn.** Chat shows one muted line under each turn's answer: the model the router picked,
  whether it thinks, and its decision, as `DeepSeek-V4.1-Flash · thinking · agentic`, from the answer's headers
  (`x-vsr-selected-model`, `x-vsr-selected-decision`, and the `reasoning` of the trace the plugin asks for with
  `x-vsr-debug`). When the model is not the one the call before it got, the line shows that one first, faded, with an
  arrow. Only requests through the router have a line (`llmProvider`, `vllm-sr` by default); `modelLine: false` turns
  it off. DeepSeek Harness 0.2.2 and later take the request headers through `llm-pi-ai/request-headers`; for 0.2.1,
  and to read the answer's headers, the plugin wraps `fetch` for the router's chat request alone.

## 0.7.0 (2026-11-10)

- **System One calls about several inputs go as a batch.** They are named requests under `states`, "1", "2", ... in
  input order, each with its own state and questions, and nothing of a standard request beside them: the batch form
  of vLLM Semantic Router's System One API (runtime contract 4.0.0). A call about one input is a standard request, as
  before. The Decision API at app.vllm-sr.ai refuses the old form, the first input on top and the others under
  `states`, with 400 `invalid_request`, so with earlier versions a call about more than one input fails there:
  update to this one. A call's input tokens are the batch's own `usage`, which counts every entry. Nothing else the
  plugin does has changed.

## 0.6.12 (2026-11-06)

- **A new README.** The front page now shows what the plugin does at a glance: the vLLM Semantic Router logo and the
  DeepSeek Harness mark it is for, the launch film's "Make your agent think fast and slow.", three install lines that
  name no version, one real card per reflex and tool from the demo recordings, the 21 live sessions, a diagram of
  System One and System Two behind one router, the essential options and a short FAQ. The full reference (every
  option, the tools' questions, what Chat shows and its selectors, what is sent where, what we measured) moved to
  `docs/reference.md`, where the selector test now reads it. The images live in `docs/assets/` and stay out of the
  package. Nothing the plugin does has changed.

## 0.6.11 (2026-11-05)

- **System Two's System One calls work on the first try more often.** Over every `system_one` and
  `system_one_screen` call of the demo recordings, 14 of 94 `system_one` calls and 4 of 154 screen calls ended in an
  argument error. The rubric is now read in the shapes System Two writes when they can mean one thing only, and the
  summary's **Notes** line says how each was read: a span question's labels written beside its instructions (the
  pinned "Custom labels" session's first red row), a `threshold`, `type` or `instructions` written beside the
  questions, one question written in place of the object of questions (its second red row) or wrapped in its type, a
  question id written twice, a list of questions, JSON cut short of its last brackets, the next arguments run into
  `questions` by the model's tool-call markup, other names for a type, a preset or a signal, options, levels and labels
  in other shapes, a threshold as text or a percentage, a `text_field` of several fields. `redact` without a pii or
  span question replaces personal data; a copy that cannot be made (halu and evidence) is left out and the questions
  are answered; one path given as both `output` and `redact` is the copy's; `annotate` without a box question draws
  nothing and answers; `annotate: true` draws a copy beside each image; a span question of images or a box question
  of text is left out when other questions remain, and so is an image that does not exist; `attack` or `p_harm` asked
  beside `r_harm` reads each record's `user` part. `system_one_screen` reads `targets`, `checks` and `expected`, a
  question or a check written as its words alone, and a box question written as a check, and its `annotate` without
  an image extension names a folder (a file named `metrics/annotated` had made the next batch's `annotate` fail).
  Replayed offline through the tools' own code, the recordings' first tries go from 30 of 37 taken to 35 of 37; in a
  live test of six demo scenarios through `vllm-sr/auto`, first tries went from 15 of 22 to 26 of 28.
- **The tool descriptions show one example of each kind of question**, say where each field goes, and the parameters
  carry examples and their types (`redact` and `annotate`: true or a path).
- **What still fails says how to fix it**: a span question without labels shows the shape it takes, a path that does
  not exist names what its folder holds, a screen call that asks nothing says what it may ask, and the Decision API's
  reason for refusing a request is passed on.
- **Chat shows no red System One rows.** A call whose arguments System Two got wrong leaves no row, in the recorded
  sessions too: System Two reads the error and calls again, and only the call that works is shown. A call that found
  System One unavailable after its retries is one calm **Unavailable** line, with the details one click away, and
  System Two is told to go on without it; a stopped call says **Stopped**. Records name how a call failed
  (`failure`).

## 0.6.10 (2026-11-05)

- **The results never take the place of the input or of the redacted copy.** Marking the demo's 230 tickets, System
  Two gave one path for both the results and the redacted copy: the copy was written, then the results replaced it,
  while the card still named the copy. A call whose results or copy would land on the input file, or on each other, is
  now refused before System One is asked; until now an `output` naming the input file overwrote it with the results.

## 0.6.9 (2026-11-05)

- **A safety signal's results keep the flagged words out.** Asked to flag jailbreaks and harmful requests in the
  demo's chatbot inbox without quoting them, System Two looked at the head of the `system_one` results file to learn
  its fields; each row held the start of its message, a jailbreak among them, and `vllm-sr/auto`'s safety guard then
  declined the turn. A call that asks `attack`, `p_harm`, `r_harm` or `r_refusal` now writes each row's id and answers
  only.

## 0.6.8 (2026-11-05)

- **A batch waits out a spent per-minute budget.** Marking the demo's 230 tickets with `vllm-sr/vela3-turbo`, a
  `system_one` call failed with `429 rate_limit_exceeded` while the per-minute budget of the key or of its network
  address was spent: the client waited at most 10 s between tries and gave up after three, before the budget came
  back. A batch now waits as long as the gateway's `Retry-After` says, up to a minute, for up to six tries, and a
  cancel ends the wait. The reflexes keep their short limits, so no step is held for long, and a spent daily quota
  (`quota_exceeded`, back at 00:00 UTC) now fails at once instead of being tried again.

## 0.6.7 (2026-11-05)

- **Privacy's card shows the text as System Two read it.** System Two read a marked name masked wherever its parts
  recur (`Thanks [PERSON]` after `Priya Raman`), but the card's excerpts masked only the words the span model marked
  and showed `Thanks Priya`. The card's excerpts, and the `system_one` tool's examples of personal data, now come from
  the same masking as what System Two reads and the redacted copy.
- **A redacted copy counts the places it masked.** `32 span(s) in 16 item(s) replaced` counted what the span model
  marked, while the copy also masks each place where a marked name recurs; the count is now of the placeholders the
  copy holds, so it matches a count of the copy.

## 0.6.6 (2026-11-05)

- **A phone number has at least seven digits.** Privacy masked an image size in a command's output (`saved 960x540`)
  as a phone number; a size and a number of fewer than seven digits are no longer masked as one. The demo's
  transcripts and tickets keep every phone number masked.
- **A file path is no street address.** Privacy masked the directory in pip's warning (`The directory '…/.cache/pip'
  or its parent directory is not owned`) as a street address, hiding from System Two where its own tools wrote. A
  span with a path separator and no spaces is no longer masked as an address; an address has spaces, and the demo's
  three addresses stay masked.
- **`system_one_screen` reads a `find` list of objects.** Asked to find
  `[{"settings": "the Settings link"}, {"billing": "the Billing link"}]`, the screen tool looked for one target named
  `[object Object]` and found nothing. Each object in a list now names its targets, as `{"id": "what it is"}` or
  `{"id": ..., "description": ...}`, and two targets with one id are both looked for.

## 0.6.5 (2026-11-05)

- **halu and evidence read the sources when a record names its own context.** Checking draft replies with
  `state_fields: {"context": "question", "answer": "reply"}` and the policies as `sources`, the `system_one` tool read
  each customer's question in place of the policies: evidence marked the questions (shown with "(undefined)" for a
  source, and the card's excerpts cut from the wrong text) and halu flagged replies the policies back. The record's
  context is now read before the sources. Over the demo's 12 drafts, evidence now backs all 12 with policy lines,
  each with its file and line, and halu finds all five promises no policy makes (three under 0.6.4).
- **Privacy and the pii preset leave what only looks like personal data.** The span model marked message ids (`m01`)
  and an order number (`88231-B`) as names, an invoice number (`INV-2291`) as a card, the bare names of placeholders
  in a list (`'CREDIT_CARD', 'PERSON'`) as what they name, and a count (`230 tickets written`) as a driver's licence;
  Privacy masked them in what System Two read, and a second look at a redacted copy counted them. An id is no name,
  a card number has no letters, and a label's name or a number of up to three digits is not personal data (a card's
  few digits still are). Over the demo's transcripts and tickets Privacy masks the same 29 and 13 details as before,
  and a second look at the redacted transcripts finds nothing.

## 0.6.4 (2026-11-05)

- **A score on numbered levels uses their numbers.** System Two often writes a scale as `["1 = vague", "2 = clear",
  "3 = concrete"]`; the `system_one` tool answered it from 0, so a card said "3 = concrete 12 · mean 1.88" and the
  results file held 0-based scores. Levels that each start with their number, counting up by one, are now answered on
  that numbering (mean 2.88); other scales still count from 0.
- **`r_harm` and `r_refusal` read records' own `user` and `answer` fields** when the call names no `state_fields`,
  instead of refusing the call.
- **The done-check's "Backed by" passages name paths as the other cards do**, relative to the working directory and
  with the home directory as `~`, not `/home/<you>/…`.

## 0.6.3 (2026-11-05)

- **Redaction keeps each item's id.** The pii preset took ids such as `C-2103` for names, and the redacted copy said
  `"id": "[PERSON]"`, so its rows no longer matched the results. Spans in the field an id comes from are dropped.
- **A marked name is masked wherever its parts recur**, as whole words: "Priya Raman" once makes "Thanks Priya" become
  "Thanks [PERSON]", in a redacted copy and in what Privacy masks, and "Priyanka" stays.
- **Placeholders stay placeholders.** Reading a redacted copy, the span model marks `[EMAIL_ADDRESS]` again as an
  email address; the pii preset and Privacy now leave text that is already masked alone, so a second look at a copy
  counts only what is still there.
- **Masks keep the sentence's punctuation**: an address the model marks with its commas (", 2200 Mission Street,")
  becomes `, [STREET_ADDRESS],` rather than swallowing them.

## 0.6.2 (2026-11-04)

- **System One stays visible when a turn ends.** DeepSeek Harness folds a finished turn's tool calls into "Completed
  in …" and "Ran commands", and 0.6.1's routine lines and its `system_one` and `system_one_screen` rows folded away
  with them. Every System One line and card now stays outside the fold, and each call of either tool keeps one line in
  the turn (**System One**, the latency, the verdict) that opens its card again, also after a reload. While the turn
  runs, the call's own row shows the card as before. A batch's one line says what it found, its first question's
  answers (`team: billing 61, engineering 58`), here and with `systemOneUi: compact`.
- **Images through `vllm-sr/auto`**: the model now declares image input, so DeepSeek Harness reads a screenshot or a
  chart for System Two instead of stopping with "model "vllm-sr/auto" does not declare image input". The router sends
  every request that carries an image, tool calls included, to its vision decision.
- **Privacy** leaves the machine's account in a home directory (`/home/dev`, `C:\Users\dev`) and a prompt (`dev@box`)
  unmasked; 0.6.1 masked `pwd` output as a person. Someone else's home directory is still masked.
- **The `system_one` and `system_one_screen` tools** refuse a choice question without options before any request, and
  say how to write it, instead of returning "no answer" for it.

## 0.6.1 (2026-11-04)

- **Privacy** leaves a file's owner and group unmasked when the span model marks them together, as `dev dev` in
  `ls -l` output. 0.6.0 left only a lone account name, so most `ls -la` results still showed a Privacy card.
- **The `system_one` tool**: a threshold written beside its question (`"marks_threshold": 0.4`) is that question's,
  and a `text_field` that is not a field of the items names the fields that are, so System Two fixes its call at once.
- **README**: install a release by its exact version. pnpm installs no release younger than a day unless it is named
  (`minimumReleaseAge`), so a plain `@vllm-sr/dsh` gets the newest release that is a day old.

## 0.6.0 (2026-11-04)

System One answers more than verdicts: the `system_one` tool marks words with labels System Two invents, finds
personal data and writes a redacted copy, checks items against their sources, asks the router's signals and boxes what
it finds on images; a new tool, `system_one_screen`, is the eyes of computer use; and the done-check shows what backs
an answer.

- **Span questions in the `system_one` tool** (answered by `span_model`, `vllm-sr/vela3-turbo`):
  - custom labels, as `{"type": "span", "criteria": {"ERROR": "…", "COMPETITOR": "…"}}`: the words that carry each
    label, with a probability each; `threshold` drops the less likely ones;
  - presets: `{"preset": "pii"}` (the nine sensitive labels, or those `labels` picks; from `privacyAt`, 0.5, as the
    privacy reflex), `{"preset": "halu"}` (what an item's `sources` do not support) and `{"preset": "evidence"}` (the
    words of the sources that back the item, with their file and line);
  - router signals, as `{"signal": "attack"}`: `attack`, `p_harm`, `domain`, `factcheck`, `feedback`, `modality`,
    `scenario`, and `r_harm` and `r_refusal` over a `user` and an `answer` (`state_fields`). Each is sent under its
    trained name, whatever System Two calls it.
  - Decision and span questions go out in one call, each to its model; an id that names a signal never reaches that
    signal's head by accident.
  - A label set written as a choice (one option, or options named in capitals under "Mark …") is asked as a span
    question, a `type` beside the questions applies to those without one, and a question that fails for its items
    says why.
- **Requests stay within the Decision API's estimate**, which counts a state once for every question that reads it
  (131,072 tokens a request): the tool cuts its batches by bytes and questions, refuses an item no request could read,
  and the done-check fits what the turn read to its five questions (with the halu and evidence spans it would
  otherwise be refused on a long turn, `request_too_long`); privacy batches its windows the same way.
- **New parameters**: `sources` (the files items should agree with), `state_fields` (the parts of each record a
  question reads), `redact` (a copy of the items with what `pii` marked, or else what the span questions marked,
  replaced by its `[LABEL]`, in the input's format, nested fields included) and `annotate` (PNG copies of the images
  with the boxes found drawn in red, decoded and encoded without dependencies). A question keeps only the fields the
  Decision API reads; a box target written as `target`, `what`, `find` or `id` becomes its instructions.
- **`system_one_screen`** (`screenTool`, `screenModel` `vllm-sr/vela3-turbo`): on one screenshot, `find` returns the box
  and the pixel to click of each target, `check` and `expect` say what the screen shows, and `before` with `action` says
  whether the last action worked, from the two screenshots (`before` alone is judged as the last step). `annotate`
  saves a copy with the boxes in red and the click points in blue, beside the screenshot when given its own path.
  System Two is told to use it at each step of computer use.
- **Done-check**: the same one request to `vllm-sr/vela3-turbo` also marks the passages of what the turn read that back
  the answer (`evidence`, `doneEvidence`, `doneEvidenceAt`); the card lists them under **Backed by**, with the tool and
  file each came from (fact `backed`).
- **In the Web UI**, in 0.5.2's tool-row style with one model name in each head:
  - a span question shows its labels in their own hues, a tag for its preset or signal, and up to three items with the
    words marked around their most probable mark (personal data only as its label); a grounded one the backing
    passage with its `file:line`; a mixed batch names its span model inside the card ("Spans by");
  - a batch of images shows each image with the boxes found on it; the redacted copy, the annotated images and the
    sources are links;
  - a `system_one_screen` card shows the screenshot with each target's box and click point, the answers, and after an
    action the screens before and after with **Worked** or **Did not work** (red only on that verdict, the frame stays
    blue). Images are read once each through the Web UI's workspace files service and are never sent to System Two.
  - New selectors: `data-system-one="screen"` with `-image`, `-found`, `-expect` and `-action`; parts `qtag`,
    `examples`, `example`, `source`, `images`, `image`, `shot`, `box`, `point`, `targets`, `target`, `click`, `checks`,
    `expect`, `action`, `before`, `after`, `redacted`, `annotated`, `sources`, `evidence`, `backing`; the question's
    `data-system-one-kind`.
- **Privacy** leaves what is not personal data unmasked: the machine's own account and host names (as in `ls -la`),
  loopback and private network addresses, and the words the user wrote in the request itself.
- **Triage** asks "unclear?" as whether the request leaves out what to do or what to work on (47 of 48 right on our
  48-request probe set).

## 0.5.2 (2026-11-04)

System One's line looks and moves like the Web UI's own tool rows, every card stays blue, and the guard and the
done-check ask one model, `vllm-sr/vela3-turbo`, in one request each.

- **The System One line**: drawn as DeepSeek Harness draws a tool row: an icon in a 16 px slot, then **System One**
  in blue (its one accent), the latency, the reflex and what it decided in the row's 13 px muted text, a dot between
  each part. The pill badge is gone. A one-line element shows its chevron in the icon slot on hover and while open.
  While System One decides, the Web UI's own shimmer sweeps across the line (none with reduced motion), and its answer
  settles in the same place. The free-key line and the `system_one` row are drawn the same way.
- **Latency** stays where it was and reads `182 ms` under a second, `1.4 s` from a second up, in Chat and in what
  System Two is told.
- **Cards**: every card keeps its blue frame, tint and accent bar, the Guard card included. Red marks only what System
  One stopped, inside the card (a Dangerous or Critical level as a chip, the dangerous part of a command, a blocked
  call, removed text, "You rejected it"), and amber what it asks (your approval, System Two to go back). Allowed and
  done read blue, not green.
- **One model name** in a card's head: the model that answered. A second one, a span model that marked the words, is
  named in the card's rows (`[data-system-one-part="span-model"]`).
- **Guard on `vllm-sr/vela3-turbo` alone** (`guardModel`): one request answers the guard's questions with the model's
  d3 base, marks the dangerous part, and asks two of the router's safety signals: `p_harm` over the call and `r_harm`
  over the request and the call as its answer. A call `r_harm` is sure is harmful (0.9, `guardHarmAt`) is asked about
  even when its risk is low; one the guard asks about is denied when both signals are surer still (0.98,
  `guardHarmDenyAt`). On our 25-call A/B set (the demo prompts, routine work, risky and destructive commands): 75 of 75
  right over three runs, p50 641 ms, against 48 of 50 and p50 929 ms for `d3-ultra` deciding with `vela3-turbo`
  marking; on the 36-command probe, 35 of 36 as before. New facts `harm` ("Harmful call") and `request-harm` ("Harmful request").
- **Done-check on `vllm-sr/vela3-turbo` alone** (`doneModel`): one request answers its questions, marks the
  unsupported claims and asks `r_refusal`; an answer that declined (you rejected a step, or the request) is not sent
  back (`data-system-one-why="declined"`, fact `declined`, `doneRefusalAt`). On our 10 turns: 30 of 30 right over
  three runs, p50 630 ms, against 18 of 20 and p50 676 ms. `signals: false` leaves the signals out (about 100 ms
  less); a guard or done-check model that answers no span questions gets the questions over the text as before.
- **Privacy is on by default**, as every capability is: `privacy: false` turns it off.

## 0.5.1 (2026-11-04)

System One's elements in Chat take the blue of the vLLM logo and move more calmly.

- **Colour**: the badge, the accent bar of a card, its edge and tint, the info pills and the probability bars are in
  the vLLM logo's blue (`#30A2FF`) and its family, in light and dark themes, instead of ember. Red still marks what
  System One blocked or removed, amber what it asks you or sends back, and green what it allowed. The batch charts
  lead with the same blue; the **System Duo** pill is blue with a gold key.
- **Motion**: an element fades in and rises 6 px once, in 220 ms on an ease-out curve; its accent bar draws in, its
  rows follow 45 ms apart, and its bars and marked words fill in after them. No bounce, no ring, no glow, no sweep.
  With reduced motion nothing moves.
- **Deciding**: a decision that takes longer than 0.7 s is shown as a one-line **Deciding** element (what System One
  is doing, a slow sheen on the badge and a thin moving line) until its answer takes its place in the same element;
  so is a running `system_one` batch. A decision whose turn was stopped first says so. New selectors:
  `data-system-one-verdict="deciding"` (and `cancelled`), `[data-system-one-part="progress"]`; the record of a
  decision carries its `decision` id.
- **Privacy** writes a one-line "Nothing to mask" record for a result it checked and found clean, as the shield does.

## 0.5.0 (2026-11-04)

System One points at words: `vllm-sr/vela3-turbo` answers span questions, and four reflexes use them.

- **Shield**: in a passage it flagged, the span model marks the sentences that give orders, and only those go, as
  whole sentences; the text around them stays. The passage is scored again without them before the cut is trusted,
  and a cut that leaves an injection behind, or a span answer that fails, leaves the line removal of 0.4 to do it. The
  read tool's line numbers come off for the span model and its cuts are mapped back onto them. The injection card
  shows the removed text struck through.
- **Guard**: a call it flags names its dangerous part, the whole shell command the span sits in (as
  `git reset --hard v1.3`), highlighted in the card and quoted in the approval question and the block reason. Allowed
  calls cost no span question.
- **Done-check**: the words of the final answer that nothing the turn read supports (preset `halu`) are underlined in
  the card, and System Two goes back to re-verify just those claims.
- **Privacy** (`privacy: true`, off by default): personal data in the results of `privacyTools` (preset `pii`) becomes
  its label, as `[EMAIL_ADDRESS]`, before System Two reads it: by default the nine sensitive labels vllm-sr's router
  masks, while dates, organizations and places pass. A Privacy card shows what was masked, by label only;
  records never hold the data. Asked for while no span model answers, it says so once a session.
- `spans: auto` (the default) turns this on once the Decision API lists `span` for `spanModel`
  (`vllm-sr/vela3-turbo`); `on` and `off` force it. Switches: `shieldSpans`, `guardSpans`, `doneHalu`, `doneHaluAt`,
  `privacy`, `privacyAt`, `privacyLabels`, `privacyTools`.
- Chat names both models of a decision that used a span answer, in bold, as **vllm-sr/d3-ultra + vllm-sr/vela3-turbo**.
  New selectors: `[data-system-one-part="span"]` (with `data-system-one-span-label` and `data-system-one-probability`),
  `excerpts`, `excerpt`, `labels`, the root's `data-system-one-span-model` and `data-system-one-spans`, reflex
  `privacy` and the done-check's why `unsupported`.
- The Decision client returns each input's span answers and thresholds, and lists the published models.

## 0.4.2 (2026-11-04)

- Chat names System One's model in full and in bold, as **vllm-sr/d3-ultra**: in a card's head, in a one-line element
  once you open it, and in the batch row. Each element's root also carries it, as `data-system-one-model`.
- The free-key notice says plainly what happened: "Free API key created for app.vllm-sr.ai, saved in ~/.dsh/.env",
  with the terms, or why the site refused one. Chat hides notices, so it is also a **System Duo** line under your first
  request, which stays when the turn folds (`[data-system-one="notice"]`, verdict `created` or `failed`).
- A step no longer starts a 20-second timer once the free key is settled.

## 0.4.1 (2026-11-04)

- The install lines work on a clean machine. `dsh plugin add` installs plugins with pnpm, and Node 26, the current
  LTS, has no corepack to provide it, so the old first line left `dsh plugin add` stopping with "pnpm was not found".
  The first line now installs pnpm beside DeepSeek Harness: `npm install -g @deepseek-ai/dsh pnpm`. Checked in fresh
  Node 26 containers without pnpm, with and without git.
- Stable selectors for tests and screen recordings, listed in the README under "Selectors". Each element's root also
  carries `data-system-one-outcome` (your answer to a guard's approval), `data-system-one-why` (the done-check's
  reason), `data-system-one-tone` (its colour), `data-system-one-turn` and `data-system-one-step`. Inside it,
  `data-system-one-part` marks the badge, the latency, the verdict and outcome pills, the reason and the other parts,
  and `data-system-one-fact` marks each number.
- A card shows a call relative to the session's working directory, with the home directory as `~`: a guard line reads
  `bash cd orders-api && git reset --hard v1.3`, not the workspace's full path before the command.
- The batch row: question names keep their descenders, and a question's failed items show in red.
- The `system_one` tool takes the questions System Two writes on its first try. A question without a type takes the one
  its criteria imply (named options: `choice`; a list of levels: `score`; none, or yes and no: `noul`) instead of
  failing the call. A yes/no question written with criteria, as a choice has, kept no answer: the Decision API does
  not answer a `noul` question that carries criteria, so every item failed ("230 failed"). Its criteria now join its
  instructions, and the tool's description says a yes/no question takes none.
- The README's tagline and the package description no longer pitch "One key".

## 0.4.0 (2026-11-04)

System One shows up in the Web UI's Chat, where it acts.

- Every System One decision is drawn in the conversation with an ember **System One** badge and its latency: a
  triage card under the request, a guard line beside each reviewed call, a shield line after each screened result,
  and a done-check card after the answer. A decision that changed something (a call blocked or sent to you, an
  injection removed, a turn sent back) is a card that stays visible when the turn's work folds; routine checks are one
  line that folds with it. Parallel calls in one step share one element. Each shows the Decision API's answer: the
  probabilities, the model and the measured latency, and pops in with a short animation the first time it appears.
- A guard card shows your answer to the approval it asked for.
- The `system_one` tool's row shows the batch: items, questions, each question's answer distribution and the results
  file.
- `systemOneUi` (`card`, `compact` or `off`; default `card`) chooses how the decisions are drawn.
- How it works: each decision is written to the session as a plugin record (`plugin:vllm-sr/dsh/system-one`), which
  the model never sees and other clients skip, and the package's new browser half (`./client`, declared in
  `dsh.client`) draws the records. `@deepseek-ai/dsh-session` joins the optional peers, from the harness like the
  others.
- The `system_one` tool and the guard use the session's working directory, so relative paths work in the Web UI,
  where one process serves sessions in many directories.

## 0.3.1 (2026-11-04)

- `dsh plugin add` installs the plugin without peer dependency warnings. The DeepSeek Harness packages it uses
  (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-tools` and `@deepseek-ai/schemastery`) come from
  the harness itself, so they are now optional peers, and their ranges name what a supported DeepSeek Harness
  (0.2.1-rc.5 or a later 0.2 release) ships instead of `*`.
- The README's tagline is in English only.

The plugin's code and configuration are unchanged from 0.3.0.
