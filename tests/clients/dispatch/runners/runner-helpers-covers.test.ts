/**
 * #3968 — the `covers` field path of the runner-coverage seam.
 *
 * `LSPServerInfo.covers` is the CONFIG-declared channel (`lsp.servers.<id>.covers`);
 * its config-side producer is the stacked PR. This file pins the SEAM half
 * now so the field cannot silently stop being read: the mock stands in for
 * the registered-server projection exactly once, carries the shape that
 * producer will emit, and asserts the builtin fact table does NOT mask it.
 * A CUSTOM row's declared claim gates on the server's own command (a builtin
 * fact gates on the fact's commands — #3968 F2); the real-pipeline half of
 * that gate is proven over the real registry/config in
 * `shell-dialect-fold.test.ts`'s collision arms.
 *
 * Everything else about the seam (builtin facts, no-lsp, primary selection)
 * is covered over the real registry and real config in
 * `runner-helpers.test.ts` — this file must never widen to assert those.
 */
import { describe, expect, it, vi } from "vitest";

const { getServersForFileWithConfig } = vi.hoisted(() => ({
	getServersForFileWithConfig: vi.fn(),
}));

vi.mock("../../../../clients/lsp/config.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/lsp/config.js")
	>()),
	getServersForFileWithConfig,
}));

async function seam() {
	const { lspPrimaryCoversFile } =
		await import("../../../../clients/dispatch/runners/utils/runner-helpers.js");
	return lspPrimaryCoversFile;
}

describe("runner coverage seam — config-declared covers field path (#3968)", () => {
	it("honors a primary's own covers declaration over the builtin facts table", async () => {
		// The shape the stacked PR's config channel will produce: a custom
		// `shuck2` server claiming the shellcheck runner without any builtin
		// fact row.
		getServersForFileWithConfig.mockReturnValue([
			{
				id: "shuck2",
				role: "language",
				covers: ["shellcheck"],
			},
		]);
		const lspPrimaryCoversFile = await seam();
		const cover = lspPrimaryCoversFile(
			{ filePath: "/proj/x.zsh", pi: { getFlag: () => false } } as never,
			"shellcheck",
		);
		expect(cover?.serverId).toBe("shuck2");
		// No builtin fact and a builtin-shaped row (no custom provenance
		// info): no gate commands from the fact table — the declared channel
		// owns its availability story (#3968 F2 scopes the custom row's gate
		// to its own command, proven in the provenance block below).
		expect(cover?.gateCommands).toEqual([]);
	});

	it("a covers declaration naming a different runner never matches", async () => {
		getServersForFileWithConfig.mockReturnValue([
			{
				id: "shuck2",
				role: "language",
				covers: ["shellcheck"],
			},
		]);
		const lspPrimaryCoversFile = await seam();
		expect(
			lspPrimaryCoversFile(
				{ filePath: "/proj/x.zsh", pi: { getFlag: () => false } } as never,
				"taplo",
			),
		).toBeUndefined();
	});

	it("an entry with covers undefined (still builtin-shaped) never matches on its own", async () => {
		// bash has a BUILTIN fact, but a row WITHOUT one and WITHOUT covers —
		// e.g. python — must not answer true for any runner id.
		getServersForFileWithConfig.mockReturnValue([
			{ id: "python", role: "language" },
		]);
		const lspPrimaryCoversFile = await seam();
		expect(
			lspPrimaryCoversFile(
				{ filePath: "/proj/x.py", pi: { getFlag: () => false } } as never,
				"shellcheck",
			),
		).toBeUndefined();
	});
});

describe("runner coverage seam — claim provenance by row, never by id (#3968 F2)", () => {
	it("a custom row colliding with a builtin id never consults the builtin facts table (bash)", async () => {
		// The F2 defect shape: `lsp.servers.bash` registers a custom overlay
		// whose id collides with the builtin bash row. The builtin fact
		// (bash→shellcheck, gated on `bash-language-server`) belongs to the
		// BUILTIN row only — an id lookup would inherit a claim the declared
		// server never made and silently drop the shellcheck lane.
		getServersForFileWithConfig.mockReturnValue([
			{ id: "bash", custom: true, command: "my-shell-lsp", role: "language" },
		]);
		const lspPrimaryCoversFile = await seam();
		expect(
			lspPrimaryCoversFile(
				{ filePath: "/proj/x.zsh", pi: { getFlag: () => false } } as never,
				"shellcheck",
			),
		).toBeUndefined();
	});

	it("a custom row colliding with a builtin id never consults the builtin facts table (toml)", async () => {
		// Same provenance rule on the other fact-bearing id: the toml→taplo
		// fact must not transfer to a custom overlay of id `toml`.
		getServersForFileWithConfig.mockReturnValue([
			{ id: "toml", custom: true, command: "my-toml-lsp", role: "language" },
		]);
		const lspPrimaryCoversFile = await seam();
		expect(
			lspPrimaryCoversFile(
				{
					filePath: "/proj/config.toml",
					pi: { getFlag: () => false },
				} as never,
				"taplo",
			),
		).toBeUndefined();
	});

	it("a custom row on a non-colliding id with no covers makes no claim", async () => {
		getServersForFileWithConfig.mockReturnValue([
			{
				id: "zshz",
				custom: true,
				command: "zsh-language-server",
				role: "language",
			},
		]);
		const lspPrimaryCoversFile = await seam();
		expect(
			lspPrimaryCoversFile(
				{ filePath: "/proj/x.zsh", pi: { getFlag: () => false } } as never,
				"shellcheck",
			),
		).toBeUndefined();
	});

	it("a custom row's declared covers claim carries claimSource 'declared' and gates on the server's own command", async () => {
		// The claim's gate is the covering lane's OWN binary — symmetric with
		// the builtin facts, which gate on the covering lane's binaries. An
		// absent custom command means the claim is not honored and the CLI
		// runner runs: coverage never silently drops to a config typo.
		getServersForFileWithConfig.mockReturnValue([
			{
				id: "bash",
				custom: true,
				command: "my-shell-lsp",
				covers: ["shellcheck"],
				role: "language",
			},
		]);
		const lspPrimaryCoversFile = await seam();
		const cover = lspPrimaryCoversFile(
			{ filePath: "/proj/x.zsh", pi: { getFlag: () => false } } as never,
			"shellcheck",
		);
		expect(cover).toMatchObject({
			serverId: "bash",
			gateCommands: ["my-shell-lsp"],
			claimSource: "declared",
		});
	});

	it("a declared claim gates on the own command on a non-colliding id too", async () => {
		getServersForFileWithConfig.mockReturnValue([
			{
				id: "zshz",
				custom: true,
				command: "zsh-language-server",
				covers: ["shellcheck"],
				role: "language",
			},
		]);
		const lspPrimaryCoversFile = await seam();
		const cover = lspPrimaryCoversFile(
			{ filePath: "/proj/x.zsh", pi: { getFlag: () => false } } as never,
			"shellcheck",
		);
		expect(cover).toMatchObject({
			serverId: "zshz",
			gateCommands: ["zsh-language-server"],
			claimSource: "declared",
		});
	});

	it("a custom claim whose command projection is absent fails closed (older released writer shape)", async () => {
		// An LSPServerInfo carried across from an older released pi-lens build
		// (before the command projection) cannot name the gate binary — the
		// claim is not honored, so the CLI runner runs. Failing open here
		// would honor a gateless claim on a command pi-lens cannot even probe.
		getServersForFileWithConfig.mockReturnValue([
			{ id: "zshz", custom: true, covers: ["shellcheck"], role: "language" },
		]);
		const lspPrimaryCoversFile = await seam();
		expect(
			lspPrimaryCoversFile(
				{ filePath: "/proj/x.zsh", pi: { getFlag: () => false } } as never,
				"shellcheck",
			),
		).toBeUndefined();
	});

	it("an empty covers array on a custom row carries no claim", async () => {
		getServersForFileWithConfig.mockReturnValue([
			{
				id: "bash",
				custom: true,
				command: "my-shell-lsp",
				covers: [],
				role: "language",
			},
		]);
		const lspPrimaryCoversFile = await seam();
		expect(
			lspPrimaryCoversFile(
				{ filePath: "/proj/x.zsh", pi: { getFlag: () => false } } as never,
				"shellcheck",
			),
		).toBeUndefined();
	});

	it("a builtin-shaped row at a fact-bearing id reads the builtin fact, its gate, and claimSource 'builtin-fact'", async () => {
		// The provenance rule is symmetric: a NON-custom row keeps the builtin
		// facts and their gate commands — the F2 change must not starve the
		// real bash LSP's shellcheck deferral (the PR-2 red-first witness).
		getServersForFileWithConfig.mockReturnValue([
			{ id: "bash", role: "language" },
		]);
		const lspPrimaryCoversFile = await seam();
		const cover = lspPrimaryCoversFile(
			{ filePath: "/proj/deploy.sh", pi: { getFlag: () => false } } as never,
			"shellcheck",
		);
		expect(cover).toMatchObject({
			serverId: "bash",
			gateCommands: ["bash-language-server"],
			claimSource: "builtin-fact",
		});
	});
});
