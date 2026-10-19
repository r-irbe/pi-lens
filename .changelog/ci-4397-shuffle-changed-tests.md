---
section: Changed
audience: internal
---

- A PR's added or changed test files run alone and under two fixed shuffle seeds in `Targeted tests (advisory)` (#4397). `scripts/ci-shuffle-changed-tests.mjs` reds a file whose cases share state, within a 6-minute budget and a 20-file cap. A start that ran no test is unproven, not clean. Ten order-dependent cases on master are fixed, in `lens-diagnostics`, `flake-shape-ratchet`, `lsp-diagnostics` and three `lsp-diagnostics-*` test files.
