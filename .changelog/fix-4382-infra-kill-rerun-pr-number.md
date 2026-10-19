---
section: Fixed
audience: internal
---

- The infra-kill rerun workflow takes a PR number only from a `pull_request` run's entry of this repository at the run's own head, so a master push run no longer targets another repository's namesake PR (issue 23, HTTP 403), and a refused PR comment write logs one warning without stopping the classify-and-rerun step (#4382).
