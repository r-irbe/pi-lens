/**
 * Builtin runner-cover facts (#3968): dispatch runner capabilities a builtin
 * LSP server subsumes, keyed by server id, with the availability gates a
 * runner must probe before honoring the fact.
 *
 * This is the ONE importable home for those facts, deliberately LEAF-shaped:
 * `clients/dispatch/runners/utils/runner-helpers.ts` (the #233 self-skip
 * seam) must read them without importing the server registry
 * (`clients/lsp/server.ts`) — that import direction closes a dependency
 * cycle through the installer's graph and is forbidden by the
 * `no-client-cycles` boundary rule (dependency-cruiser, #2125). The facts
 * are plain data about the builtin table's own rows, so they need no import
 * at all; `clients/lsp/server.ts` re-exports the type beside
 * {@link LSPServerInfo} whose `covers` field it complements.
 *
 * `gateCommands` are the probeable commands the RUNNER must see present
 * (`DispatchContext.hasTool`) before honouring the fact — without them the
 * covering lane cannot actually run, and skipping would silently regress
 * coverage. The runner adds its OWN tool's gate (an embedded linter still
 * needs its binary).
 *
 * Facts (#3968):
 * - `bash` embeds `shellcheck` (bash-language-server lints through it).
 * - `shuck` embeds shellcheck-equivalent lint (binary `shuck`, native
 *   `C/S/P/X/K` codes).
 * - `toml` embeds the `taplo` linter (the LSP binary IS `taplo`, which is
 *   why the old seam call passed the literal server id `toml`).
 */
export interface ServerRunnerCoverFact {
	/** The dispatch runner ids this server subsumes. */
	runnerIds: readonly string[];
	/** Commands whose `hasTool` verdict gates the covering lane. */
	gateCommands: readonly string[];
}

export const BUILTIN_SERVER_RUNNER_COVERS: ReadonlyMap<
	string,
	ServerRunnerCoverFact
> = new Map([
	[
		"bash",
		{ runnerIds: ["shellcheck"], gateCommands: ["bash-language-server"] },
	],
	["shuck", { runnerIds: ["shellcheck"], gateCommands: ["shuck"] }],
	["toml", { runnerIds: ["taplo"], gateCommands: ["taplo"] }],
]);
