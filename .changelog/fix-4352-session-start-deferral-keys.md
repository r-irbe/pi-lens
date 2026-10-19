---
section: Fixed
audience: user
---

- **The ast-grep export scan waits out its startup defer again** (refs #4352) — Its defer entry was keyed under a name no task used, so the scan started on the next tick and could freeze the TUI right after startup or `/new`. The entry now matches the task, and a misspelled task name fails the build.
