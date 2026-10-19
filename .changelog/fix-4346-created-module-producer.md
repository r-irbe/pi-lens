---
section: Fixed
audience: user
---

- **A module created outside pi-lens now clears its importer's missing import (refs #4346)** — A module written by a shell, `cp` or codegen reached no language server, so pyright and Pyrefly kept the importer's missing import for the server's life when only the importer was diagnosed. Before `lsp_diagnostics` answers, pi-lens now announces the files an importer resolves to as Created to any server that has not heard of them. This covers every file that is not answered from a fresh clean cache entry, including one pi's write hook just touched, and a module moved into place with `mv`. Workspace edits that create, rename or delete files now send their watched-file events too. The review graph adds the importer's edge for a newly created module, so a cached clean answer is refused when that module later changes. Extracting a large file's symbols no longer grows with the square of its size: a 12,000-line Python file now takes 0.4 s in a review-graph build (was 9.6 s) and 0.09 s for its imports (was 9 s).
