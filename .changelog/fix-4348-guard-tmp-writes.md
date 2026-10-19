---
section: Fixed
audience: internal
---

- `guard-bash.mjs` denies agent writes under `/tmp` (redirects, `tee`, `cp`/`mv`/`install` targets, `mkdir`, `touch`), exempting the harness's `/tmp/claude-<uid>/` and reads (#4348).
