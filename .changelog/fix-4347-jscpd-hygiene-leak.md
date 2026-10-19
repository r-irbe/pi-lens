---
section: Fixed
audience: internal
---

- The real-factory bridge-rebind test no longer strands a `pi-lens-jscpd-*` directory in the shared tmpdir: its unawaited session_start scans now write their report roots under a root the test harness owns. The ast-grep temp-rule scan joins the same scanner temp-root seam. The tmp-fixture hygiene exemption scan now reads code, so a comment or string that mentions `os.tmpdir()` or `REPO_ROOT` no longer exempts a mkdtemp site (#4347).
