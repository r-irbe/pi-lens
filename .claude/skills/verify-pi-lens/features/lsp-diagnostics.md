# LSP diagnostics with a real server

The `pilens_diagnostics` tool with `source: "lsp"` (the `lsp_diagnostics` tool
inside pi) asks a live language server about files, replays persisted findings
from the workspace-diagnostics cache, and announces file changes to the server.
Scenario: `scripts/scenarios/lsp-created-module.mjs`, server Pyrefly 1.3.2.

## Sub-features

- Fresh scan: open the files, wait for the server's diagnostics, render them.
- Cache replay: a repeat call answers from the persisted entry without the
  server (milliseconds, not a rescan).
- File-change events: a file pi-lens opens for the first time is announced as
  Created (1) if it was born after the client started, else Changed (2). Only a
  Created clears Pyrefly's cached failed module lookup (#4320).
- Cache expiry: a Created drops finding-bearing entries of that server so an
  importer is rescanned; clean entries keep serving.

## How to get to it (user POV)

An agent edits or creates a module, then asks pi-lens whether the importing
file is clean: `pilens_diagnostics {source: "lsp", scope: "paths", paths: [...]}`.
The user-visible failure is a stale `missing-import` that only a restart clears.

## Driving it with the pi-lens MCP server

Setup once: `scripts/setup.sh pyrefly`. Every run: `scripts/verify.mjs doctor`
first. Variants run as `scripts/verify.mjs drive lsp-created-module <variant>`.
Each recipe is a loose goal; the checks under it are strict and the scenario
asserts them.

- **Goal, `issue`: create the missing module, then re-check the importer.** The
  module is written straight to disk, behind pi-lens (the reporter's steps),
  and listed first in one call.
  - Diagnostics: step 1 has `missing-import` for both `probe.py` and `bad.py`;
    step 2 has none for `probe.py` and still has it for `bad.py` (a real
    missing module must keep reporting).
  - Wire (`lsp-wire.in`): a `workspace/didChangeWatchedFiles` carrying
    `new_module.py` with `"type":1`.
  - File state: `src/fixturepkg/new_module.py` exists.
- **Goal, `importer-first`: same, but ask about the importer before the module.**
  Same checks, in the same call. This is the order the cache lookup used to get
  wrong (#4344 r1 F1). Directory scopes sort paths, so layout decides the order.
- **Goal, `importer-only`: the module appears behind pi-lens and only the
  importer is re-checked.** No path ever opens the module. The call resolves
  the importer's own imports and announces the module as Created before it
  answers (#4346), so the importer must be clean on that call.
- **Goal, `replay`: edit an unrelated file, then re-check the findings.**
  - Timing: the replay after the edit is within `max(5 x warm replay, 150 ms)`.
    A spurious Created drops every finding-bearing entry (measured on #4344: 6 ms
    became 321 ms with `fileCreated: 2`).
  - Wire: the edited file is announced `"type":2`, never `1`.
  - Diagnostics: the finding lines are identical before and after.

Evidence in `$EVIDENCE/lsp-created-module-<variant>-<stamp>-<pid>/`: `mcp-wire.jsonl` (every
JSON-RPC frame, timestamped), `lsp-wire.in` / `lsp-wire.out` (both LSP
directions through `pyrefly-tee.sh`), `steps.json` (each call with its args,
elapsed ms, full result), `summary.json`, and a copy of the pi-lens home with
its logs. The expiry records (`fileCreated`) are in those logs.

## Gotchas

- Pyrefly needs `search-path=["src"]` and a `python-interpreter-path`; the
  scenario writes both. Without them the first scan is `missing-import` for
  everything.
- The server is a project-configured custom server (`.pi-lens/lsp.json`); the
  MCP server marks the project trusted, so the scenario needs no trust setup.
- A cold first call takes about a second (spawn and index); only compare the
  timing of warm calls.
- Do not read a clean result as proof: the scenario also asserts that `bad.py`
  still reports, so a server that returns nothing fails.
- The scenarios pass no `concurrency`. A change that depends on call
  concurrency needs the tool layer (see
  `tests/tools/lsp-diagnostics-created-module-4320.test.ts`).
