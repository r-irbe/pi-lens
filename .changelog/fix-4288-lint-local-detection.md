---
section: Fixed
audience: internal
---

- The local PR-body preflight (`check-pr-body.mjs --lint-local`) now reads the closed issue's labels through `gh api` and validates any present `## Detection` section, so it agrees with CI's "PR body (advisory)" check (refs #4288).
