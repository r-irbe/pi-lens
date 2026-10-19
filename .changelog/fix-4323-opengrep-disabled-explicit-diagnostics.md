---
section: Fixed
audience: user
---

- **An explicit LSP check no longer starts Opengrep when it is switched off (closes #4323)** — `lens_diagnostics source=lsp` in pi, `pilens_diagnostics` over MCP and `lsp_navigation workspaceDiagnostics` started the Opengrep security scanner for an all-server check even with `--no-opengrep` or `opengrep.enabled=false` in `~/.pi-lens/config.json`. They now leave every auxiliary scanner the configuration switches off unstarted, as the write-time check and `pilens_analyze` already did, for a single file, a batch, a directory and the primary-only fallback. A primary-only check no longer shows a switched-off scanner's earlier findings, a batch cached before the switch is not served to the narrower check, and `lsp_navigation workspaceDiagnostics` without a path leaves out the rows of a switched-off scanner that is still running. The turn-end actionable-warnings report (`lens-actionable-warnings`) no longer starts a switched-off scanner either, and an explicit single-file check names the scanner it skipped: `No auxiliary findings. Switched off, not run: opengrep.`
