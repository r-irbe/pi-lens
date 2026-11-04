---
section: Fixed
audience: user
---

- **Explicit Lean compiler context** — Add an experimental, trust-gated `lsp.serverOverrides.lean.leanContext` for an installed exact-version compiler and admitted module roots. Lean LSP and generated-style Lean C checks refuse missing or mismatched environments instead of certifying a different ambient toolchain; ordinary C errors remain diagnostics and analyzer/build-lock restrictions still apply.
