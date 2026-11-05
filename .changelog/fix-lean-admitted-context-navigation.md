---
section: Changed
audience: user
---

- **Admitted-context gate and root-confined `.ilean` navigation for Lean 4** — `lsp_navigation` and `pilens_lsp_navigation` now gate all Lean semantic and interactive operations on a live `SessionScope` and a current admitted `LeanContext` (`compilerPath`, `targetVersion`, `moduleRoots`) before host readiness or live LSP client calls, confine offline `.ilean` discovery and `pedagogicalWalkthrough` to admitted `moduleRoots` (omitting workspace-wide `@[extern]` C expansion on `.lean` definitions), bind pathless `workspaceSymbol` and `executeCommand` to a pure warm-route snapshot, and record pre-execution context refusals under `lean-context-unavailable`.
