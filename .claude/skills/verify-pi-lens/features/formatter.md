# Formatter

The format step that runs after pi writes or edits a file:
`FormatService.formatFile` selects the formatter for the file (project config
and style evidence decide), runs it in place, and reports a per-formatter
outcome. Scenario: `scripts/scenarios/formatter.mjs`.

## Sub-features

- Selection by file kind and project config (`getFormattersForFile`).
- The agreement gate: a formatter runs only when the project has evidence for
  its tool (for ruff, a `[tool.ruff]` table); otherwise the outcome is
  `unavailable` with `success: true`.
- Style preservation: biome, prettier, ruff and shfmt refuse to impose a stock
  style on a file with no config and no indentation evidence (#1144).
- Idempotence: a second pass changes nothing.

## How to get to it (user POV)

An agent writes a badly formatted file; pi-lens formats it before the turn
ends and the file on disk is the formatted text.

## Driving it with the tool layer

The hook that calls `formatFile` belongs to pi, so the routine check drives
`formatFile` directly on the tree's built twins. The model-driven path
(`scripts/run-harness.mjs`) is for a diff in `index.ts`, not for a formatter
change. Setup once: `scripts/setup.sh pyrefly` (the venv also holds ruff).

`scripts/verify.mjs drive formatter python-ruff`:

- **Goal, `python-ruff`: format a mis-formatted python file the way pi-lens does after a
  write, then format it again.**
  - Summary JSON (`steps.json`): a `ruff` row with `success: true` and
    `outcome` not `unavailable` (the check that catches a vacuous pass), and
    `anyChanged: true`; the second summary has `anyChanged: false`.
  - File state: the file equals the expected formatted text byte for byte.

For the per-language sweep over repo fixtures run
`node scripts/smoke-tools.mjs --format <lang>` after `npm run build:dist`, with
the env pins from `scripts/env.sh`.

## Gotchas

- `success: true` with `outcome: "unavailable"` is not a format. Always assert
  the outcome and the file bytes.
- pi-lens resolves a project-local ruff from `<project>/.venv/bin`; the scenario
  symlinks the shared venv there.
- Call `recordRead(file)` first, or the external-modification guard skips the
  file.
- A tab-width or indentation change (#4321) needs a fixture with a config that
  states it; add a variant here rather than a new script.
