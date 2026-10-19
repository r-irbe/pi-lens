---
section: Fixed
audience: internal
---

- Make the `removeTempDirSync` give-up test deterministic by failing the directory's removal in the test instead of racing a live writer that a starved CI runner could not keep ahead of the first removal pass (closes #4349).
