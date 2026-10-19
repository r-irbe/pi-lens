---
section: Fixed
audience: internal
---

- CI: the LSP census and ast-grep version steps call the installed binaries (`node_modules/.bin/vitest`, `node_modules/.bin/ast-grep`) instead of an on-demand `npx`, which reds the nightly SonarCloud master gate on S6505/S8543 (refs #4339).
