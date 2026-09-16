---
section: Added
---

- **Lean 4 language server support via lake serve**: adds interactive Lean 4 language server integration, root detection (`lakefile.lean`, `lakefile.toml`, `lean-toolchain`), proof goal and expected term type inspection (`$/lean/plainGoal`, `$/lean/plainTermGoal`), module hierarchy dependency navigation (`moduleImports`, `moduleImportedBy`), repository hygiene (`.lake` exclusion, vendor classification, `lake-manifest.json` lockfile artifact handling, `lakefile.lean` config role), and Mathlib-tuned diagnostic wait policies (25s client/init timeouts, 5s aggregate wait).
