---
section: Added
audience: internal
---

- The flake-shape ratchet gains two detectors: `in-process-mock` pins which non-boundary modules each test file mocks with `vi.mock`/`vi.doMock`, and `service-double` pins how many hand-rolled LSP client and service doubles it holds. Process and host boundaries (child processes, the filesystem, the network, the pi SDK) stay free, and a new in-process mock or double needs a `// flake-shape:` admission header. For every detector, a baseline row past the digest-pinned frozen mint now needs its `ADMITTED_AFTER_BASELINE` entry and header; before, a baseline row alone admitted anything (#4362).
