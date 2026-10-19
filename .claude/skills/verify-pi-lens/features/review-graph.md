# Review graph

The review graph (import and call edges) behind `pilens_module_report`,
`pilens_project_report`, `pilens_symbol_search` and the dependency check that
scopes cache invalidation. Scenario: `scripts/scenarios/review-graph.mjs`.

## Sub-features

- Full build from the project files.
- Incremental update for the files a tool call touched
  (`buildOrUpdateGraph(cwd, changedFiles, facts)`); `pilens_analyze` warm calls
  it.
- Importer edges: `usedBy` in a module report and the reverse-dependency index.

## How to get to it (user POV)

An agent asks "who uses this module?" with `pilens_module_report` after a file
was created in the session.

## Driving it with the pi-lens MCP server

`scripts/verify.mjs drive review-graph <variant>`.

- **Goal, `mcp-create-after-build`: build the graph from an importer, create the
  module it imports, analyze the module, then ask who uses it.**
  - JSON: `pilens_module_report` for `src/b.ts` has `available: true` and
    `api[b].usedBy` names `src/a.ts`.
  - File state: `src/b.ts` exists.
- **Goal, `builder-incremental`: the #4344 reviewer's shape, in process.** A
  full build with `b.ts` missing, create it, update with only `[b.ts]`, then
  read the importers of `b.ts` from the graph.
  - Control: a fresh full build lists `src/a.ts` as an importer.
  - The incremental update must list the same: the update reparses the
    importers a created file answers (#4346).

Evidence in `$EVIDENCE/review-graph-<variant>-<stamp>-<pid>/`: `steps.json` (importer lists
per build), `mcp-wire.jsonl` for the MCP variant, `summary.json`.

## Gotchas

- `usedBy` is symbol-level: the importer must call `b()` inside a function. A
  top-level call or `export const b = 1` gives an empty `usedBy` on a healthy
  graph (observed while building the scenario).
- The in-process variant imports the tree's built twins, so the tree must be
  built (`doctor` checks).
- Graph persistence is debounced; the driver exits the process after the run.
