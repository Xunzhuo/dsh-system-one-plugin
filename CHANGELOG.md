# Changelog

## 0.3.1 (2026-11-04)

- `dsh plugin add` installs the plugin without peer dependency warnings. The DeepSeek Harness packages it uses
  (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-tools` and `@deepseek-ai/schemastery`) come from
  the harness itself, so they are now optional peers, and their ranges name what a supported DeepSeek Harness
  (0.2.1-rc.5 or a later 0.2 release) ships instead of `*`.
- The README's tagline is in English only.

The plugin's code and configuration are unchanged from 0.3.0.
