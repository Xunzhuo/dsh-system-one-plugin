# Changelog

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
