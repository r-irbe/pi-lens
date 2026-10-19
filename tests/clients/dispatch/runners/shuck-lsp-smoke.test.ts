/**
 * #3968 — builtin `shuck` LSP smoke, serialized `lsp-spawn-heavy` lane.
 *
 * A real `shuck server` child is the subject (defect shape 16: test vectors
 * generated from the real binary at the pinned provenance
 * `ewhauser/shuck@21e04198463a54be70aa7826acc4dcdbe7996b2b` — v0.2.3, MIT —
 * not invented): a real initialize handshake over the production LSP runner,
 * a real diagnostics publish for a seeded native code, and the
 * ShellCheck-alias suppression fact the server owns. Everything above the
 * child boundary (registry row, config selection, runner conversion, rule
 * identity) is production code; nothing here is mocked, so the file lives in
 * the lane.
 *
 * When `shuck` is not on PATH the suite reports loudly and skips (the
 * availability route the registry already discloses elsewhere; the fixture
 * row in `scripts/smoke-tools.mjs` shows the nightly the same skip).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isSpawnableCommand } from "../../../../clients/installer/index.js";
import lspRunner from "../../../../clients/dispatch/runners/lsp.js";
import {
	initLSPConfig,
	resetLSPConfigStateForTests,
} from "../../../../clients/lsp/config.js";
import {
	getLSPService,
	resetLSPService,
} from "../../../../clients/lsp/index.js";
import {
	makeRealRunnerEnv,
	type RealRunnerEnv,
} from "../../../support/real-runner-ctx.js";

const shuckOnPath = await isSpawnableCommand("shuck");
const d = shuckOnPath ? describe : describe.skip;

function reportUnavailableServer(): void {
	process.stderr.write(
		`[CI LOUD] skipping real shuck smoke: the pinned binary is not on PATH ` +
			`(brew install ewhauser/tap/shuck-cli; pinned @21e04198, v0.2.3)\n`,
	);
}

if (!shuckOnPath) reportUnavailableServer();

interface LiveClient {
	getRawCapabilityKeys(): string[];
	getSaveOptions?: () => { includeText: boolean } | undefined;
}

// Shown even when the real suite skips: the skip is a visible count, not a
// silent drop (defect shape 8).
it("reports the shuck-smoke availability verdict visibly", async () => {
	expect(typeof shuckOnPath).toBe("boolean");
});

d("shuck builtin LSP — real binary smoke (#3968)", () => {
	let env: RealRunnerEnv;

	beforeAll(async () => {
		env = makeRealRunnerEnv({ kind: "shell" });
		await initLSPConfig(env.cwd);
	});

	afterAll(async () => {
		await getLSPService().shutdown();
		resetLSPService({ fast: true });
		resetLSPConfigStateForTests();
		env?.cleanup();
	});

	// The real-binary vector (see tests/fixtures/tool-smoke/shuck/bad.zsh):
	// `echo $undefined_var` at file scope is C006 "referenced before
	// assignment", error severity — rendered as rule `shuck:C006` through
	// convertLspDiagnostics's `"<source>:<code>"` identity.
	it("publishes the seeded zsh defect with native rule identity through the real wire", async () => {
		const { ctx } = env.addFile(
			"bad.zsh",
			"#!/usr/bin/env zsh\nzparseopts -D -E -F -- a=opts\nlocal -A counts\necho $undefined_var\n",
		);

		const result = await lspRunner.run(ctx);
		const diagnostic = result.diagnostics.find(
			(item) => item.rule === "shuck:C006",
		);

		expect(result.status).toBe("failed");
		expect(result.semantic).toBe("blocking");
		expect(diagnostic).toMatchObject({
			rule: "shuck:C006",
			severity: "error",
			semantic: "blocking",
		});
		expect(getLSPService().getAliveServerIds()).toContain("shuck");
	}, 45_000);

	// Pinned suppression fact @21e04198 (suppression spec 006 / shellcheck
	// map): a leading `# shellcheck disable=SC2034` kills the aliased shuck
	// rule (C001, unused assignment) BEFORE any pi-lens filter runs — so the
	// surviving diagnostics show the server honored the alias, not a pi-lens
	// suppression lane.
	it("honors `# shellcheck disable=SC…` alias directives server-side", async () => {
		const { ctx } = env.addFile(
			"aliased.zsh",
			"# shellcheck disable=SC2034\nx=1\necho $undefined_var\n",
		);

		const result = await lspRunner.run(ctx);
		const rules = result.diagnostics.map((item) => item.rule);

		expect(rules).toContain("shuck:C006"); // the real defect still reports
		expect(rules).not.toContain("shuck:C001"); // the SC2034 alias is suppressed
	}, 45_000);

	// Pinned capability facts @21e04198 (shuck-server capabilities): sync is
	// declared (textDocumentSync top-level capability) with NO save option —
	// the didSave invariant: the shared capability inventory must answer
	// "none" for shuck, so a didSave never follows a landed didOpen/didChange.
	// The negotiated incremental change kind is read as a behavior (the real
	// wire above drives didOpen; a full-sync-only server would break the test
	// above's update flow) rather than a registry claim.
	it("negotiates a textDocumentSync capability with no save option on the live client", async () => {
		const { ctx } = env.addFile("synccheck.zsh", "autoload -Uz compinit\n");
		await lspRunner.run(ctx);

		const service = getLSPService() as unknown as {
			state: { clients: Map<string, LiveClient> };
		};
		const live = [...service.state.clients.entries()].filter(([key]) =>
			key.startsWith("shuck:"),
		);
		expect(live.length).toBeGreaterThan(0);
		const client = live[0]![1];
		expect(client.getRawCapabilityKeys()).toContain("textDocumentSync");
		// didSave invariant: negotiated save is none — no didSave is ever sent.
		expect(client.getSaveOptions?.() ?? undefined).toBeUndefined();
	}, 45_000);
});
