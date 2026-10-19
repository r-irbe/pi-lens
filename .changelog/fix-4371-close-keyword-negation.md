---
section: Fixed
audience: internal
---

- The close-keyword lint rejects a closing keyword inside a markdown table row or after a negation or hedge ("not fixed: #N", "Whether this closes #N"), and `--verify-merged` reports an issue GitHub closed only through such a line (#4371).
