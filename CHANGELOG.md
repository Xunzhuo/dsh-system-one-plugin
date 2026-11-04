# Changelog

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
