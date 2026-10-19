---
section: Fixed
audience: user
---

- **pi no longer exits when a persist worker reports a result without a staged-file path (closes #4400)** — the project-snapshot and review-graph persist workers hand their result back with the path of the file they staged. A reporter on 4.4.3 hit a result without that path in an RPC chat, and the host removed it unchecked, so the resulting `ERR_INVALID_ARG_TYPE` ended pi. Why that result had no path is not yet known. The host now cleans up and promotes the stage path it sent itself and only trusts the path in a result when no request is left to look it up. A stage file the host cannot remove (a directory in its place, a Windows handle held by antivirus) no longer ends pi either: the snapshot persist continues and a `project-snapshot-stage-reap-failed` degradation count records it. Reported by timges.
