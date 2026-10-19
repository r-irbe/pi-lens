---
section: Fixed
audience: user
---

- **Tab-indented files keep the formatter's own width (closes #4321)** — With no formatter config, pi-lens pinned tab style but also forced a tab width of 1 on Biome, Prettier and Ruff, so deferred formatting re-wrapped lines near the 80-column limit in files the formatter's defaults had already formatted. Tab evidence now pins the style only; the width is the formatter's default or your explicit config.
