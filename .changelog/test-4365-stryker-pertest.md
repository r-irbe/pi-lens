---
section: Added
audience: internal
---

- A manual `stryker-pertest` workflow mutates one `clients/` module with the vitest runner and per-test coverage, and `scripts/stryker-pertest.mjs candidates` lists the tests that cover mutated code but kill no mutant; four no-throw-only tests it flagged and a stronger sibling subsumes are removed (#4365).
