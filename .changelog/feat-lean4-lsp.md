---
section: Added
---

- **Lean 4 language server support via lake serve** — adds interactive Lean 4 language server integration, root detection across `lakefile.lean`, `lakefile.toml`, and `lean-toolchain`, proof goal and expected term type inspection (`$/lean/plainGoal` and `$/lean/plainTermGoal` via `lsp_navigation`), Mathlib-tuned diagnostic wait policies and timeouts (25s client wait/init, 5s aggregate wait), and `.lean` file classification across dispatch plans, language policy, and diagnostic pipelines.
