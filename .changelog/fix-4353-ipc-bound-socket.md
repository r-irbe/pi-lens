---
section: Fixed
audience: user
---

- **MCP warm socket restarts after a kill on a long TMPDIR; a second pi session keeps its own endpoint.** The server and the warm-attach host now unlink only the socket file Node bound, never an unrelated file, and the pid-scoped endpoint is `pi-lens-mcp-<pid>-diagnostics-<hash>.sock` so the pid survives the path cut. The tmp-fixture hygiene owner also stops excusing creator-run leaks (#4353, #4354).
