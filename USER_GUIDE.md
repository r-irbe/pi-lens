# pi-lens User Guide

`pi-lens` provides real-time code diagnostics, language server navigation, structural AST rules, and call-graph intelligence for the `pi` coding agent and MCP-compatible clients (such as Claude Code).

## 1. Installation & Build

```bash
npm install
npm run build:dist
```

The package exposes three CLI entry points in `dist/mcp/`:
- `pi-lens` (`dist/mcp/cli.js`): Review-graph snapshot builder.
- `pi-lens-mcp` (`dist/mcp/server.js`): Model Context Protocol (MCP) stdio server.
- `pi-lens-analyze` (`dist/mcp/analyze-cli.js`): Per-edit and turn-end diagnostic CLI / hook runner.

## 2. MCP Server Configuration

Add `pi-lens-mcp` to your MCP client configuration (for example, `~/.claude.json` or `.mcp.json`):

```json
{
  "mcpServers": {
    "pi-lens": {
      "command": "node",
      "args": ["/path/to/pi-lens/dist/mcp/server.js", "--cwd", "/path/to/workspace"]
    }
  }
}
```

### Key MCP Tools

- `pilens_analyze`: Run the per-file diagnostic pipeline (`mode="warm"` uses the hot in-process LSP pool; `mode="fresh"` forks a worker against the latest build).
- `pilens_diagnostics`: Query session, file, or workspace diagnostics and manage finding dispositions.
- `pilens_lsp_navigation`: IDE navigation (`definition`, `references`, `hover`, `implementations`, `incomingCalls`, `outgoingCalls`, plus Lean 4 `.ilean` and proof-state queries).
- `pilens_symbol_search` / `pilens_module_report` / `pilens_read_symbol` / `pilens_read_enclosing`: Token-efficient symbol discovery and structural outline inspection before full-file reads.
- `pilens_ast_grep_search` / `pilens_ast_grep_replace`: Structural AST search and rewrite across supported languages.
- `pilens_project_scan` / `pilens_project_report`: Project-wide static analysis and dependency health reports.
- `pilens_health` / `pilens_latency` / `pilens_effective_config` / `pilens_rebuild`: Runtime telemetry, latency inspection, active configuration, and build refresh.

## 3. CLI Usage

### `pi-lens` (Review Graph Builder)

Builds or incrementally updates the workspace review-graph snapshot (`.pi-lens/review-graph.json`):

```bash
pi-lens build-graph [--cwd <dir>]
pi-lens --help
```

### `pi-lens-analyze` (Per-Edit & Turn-End CLI / Hook)

Runs fast per-edit structural/lint checks or triggers warm turn-end verification:

```bash
# Analyze a single file (fast cold path, skips cold LSP by default)
pi-lens-analyze --file=src/index.ts --cwd=/path/to/workspace

# Include LSP diagnostics in cold CLI mode
pi-lens-analyze --file=src/index.ts --lsp

# Run turn-end verification against a running warm MCP server
pi-lens-analyze --turn-end --cwd=/path/to/workspace

# Run as a Claude Code PostToolUse / Stop hook (reads hook JSON from stdin)
pi-lens-analyze --hook

# Print usage
pi-lens-analyze --help
```

## 4. Architecture Overview

1. **Lifecycle & Host Neutrality**: Core analysis lives under `clients/` and `tools/`, operating on `(filePath, content, cwd)`. Both the `pi` extension entry point (`index.ts`) and the MCP server (`mcp/server.ts`) drive the same `dispatchLintWithResult` and LSP coordinator facades.
2. **Edit-Time Lane**: On every file write or edit, `pi-lens` runs secret scanning, deterministic autofix/formatting, tree-sitter structural queries, `ast-grep` rules, and language-specific linters (`oxlint`, `biome`, `ruff`, `golangci-lint`, `clippy`, etc.).
3. **LSP Lane & Impact Cascade**: A warm language-server pool maintains open document state, collects push/pull diagnostics, and cascades verification to reverse-dependent neighbors using the call/import graph.
4. **Freshness Gating & Dispositions**: Findings are gated by file mtime, line bounds, and user/agent dispositions (`false-positive`, `suppress`, `defer`, `flagged`) so stale diagnostics are never injected into the agent context.
