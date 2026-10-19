---
section: Fixed
audience: user
---

- **A file whose language server cannot start is no longer reported clean (closes #4322)** — When a file's language server could not be started, or was still starting, and only an auxiliary scanner such as typos-lsp answered, `lens_diagnostics source=lsp` and pi's write-time LSP check reported the file as confirmed clean, so invalid JSON passed. `lens_diagnostics` did the same when nothing answered at all. The check now names the language server as not available and reports the file as unconfirmed, for a single file, a batch, a directory and a primary-only check; the auxiliary's own findings are still shown, and a batch says which files have only auxiliary findings, and a file nothing answered for is counted as unavailable rather than cached as clean. Such an answer no longer clears a language-server blocker or the footer's language-server rows. The LSP workspace diagnostics cache moves to version 4, so a clean result cached by an earlier version is checked again once.
