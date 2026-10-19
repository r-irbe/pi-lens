---
section: Changed
audience: internal
---

- **LSP client registry extracted (refs #2372)** — `LSPService`'s client identity and lifecycle (the client map and its key, single-flight spawn, the circuit breaker, leases, capacity and idle eviction, adopted roots, and the client half of shutdown) moved into `clients/lsp/client-registry.ts`. The service composes it, and the `LspCapabilities` lifecycle group's read members route to it. Keys, timings, records and log phases are unchanged.
