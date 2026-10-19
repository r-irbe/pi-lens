---
section: Fixed
audience: internal
---

- Tests drain a log sink before reading its offset, line count or rows (#4381). `config-resolved-phase` and its session-wiring sibling read a `sessionstart.log` offset while their own lines were still queued. The new `tests/config/sink-read-drain-sweep.test.ts` fails any test read of an in-process sink that no awaited drain of that sink precedes.
