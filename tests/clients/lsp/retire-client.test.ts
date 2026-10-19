/**
 * #3585: every retirement path drops everything keyed to the retired client's
 * lifetime, through the one `retireClient`.
 *
 * Recurrence this file prevents: each of the four retirement paths (capacity
 * eviction, idle eviction, notify-stall demotion, the dead-client
 * respawn) repeated its own cleanup block, and a path that missed one entry
 * leaked it into the replacement (#3502 readiness, #3537 timeout streak, and
 * #3585 `auxNotifyDrainLatencyEwma` — a replacement inherited its
 * predecessor's adaptive wedge window). The population scan at the bottom
 * fails when a `clients.delete(` appears outside `retireClient`.
 *
 * Production chain: the REAL `LSPService.getClientForFile` spawns the client
 * (config and client factory are the process boundary); each path is then
 * entered through its real method. Keyed state is read from the service's own
 * maps.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stripCommentsAndStrings } from "../../support/session-state-scan.js";
import { assertNonEmptyScan } from "../../support/sweep-kit.js";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();

vi.mock("../../../clients/lsp/config.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/lsp/config.js")>()),
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../../../clients/lsp/client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/lsp/client.js")>()),
	createLSPClient,
}));

const FLOOR_MS = 5_000;

function fakeClient(label: string) {
	let alive = true;
	let exitedAt: number | null = null;
	return {
		label,
		root: "/repo",
		serverId: "typescript",
		kill: () => {
			alive = false;
			exitedAt = Date.now();
		},
		isAlive: vi.fn(() => alive),
		isBusy: vi.fn(() => false),
		wasShutdownIntentional: () => false,
		getExitedAt: () => exitedAt,
		shutdown: vi.fn(async () => undefined),
		notify: {
			open: vi.fn(async () => undefined),
			change: vi.fn(async () => undefined),
		},
		diagnosticsVersion: 0,
		getWorkspaceDiagnosticsSupport: vi.fn(() => ({
			advertised: false,
			mode: "push-only",
			diagnosticProviderKind: "unavailable",
		})),
	};
}

type Fake = ReturnType<typeof fakeClient>;

type Raw = {
	state: {
		clients: Map<string, Fake>;
		clientSpawnedAt: Map<string, number>;
		demonstratedReady: Set<string>;
		demonstratedCold: Set<string>;
	};
	clientRegistry: {
		clientLastUsedAt: Map<string, number>;
		idleEvictionTimers: Map<string, unknown>;
		makeCapacityForClient(key: string): Promise<boolean>;
	};
	auxNotifyInflight: Map<string, { client: unknown; unacked: number }>;
	auxNotifyDrainLatencyEwma: Map<string, number>;
	notifyWriteBackpressureStreak: Map<string, number>;
	outstandingAuxNotifyWrites: Map<string, unknown>;
	noteAuxNotifyIssued(key: string, client: unknown): void;
	auxNotifyWedgeBudgetMs(key: string): number;
	demoteForNotifyStall(
		key: string,
		entry: { client: Fake; info: { id: string } },
		filePath: string,
		reason: unknown,
	): void;
	getClientForFile(filePath: string): Promise<{ client: Fake } | undefined>;
	shutdown(): Promise<void>;
};

function configureServer() {
	getServersForFileWithConfig.mockReturnValue([
		{
			id: "typescript",
			name: "typescript",
			extensions: [".ts"],
			idleEviction: "transparent",
			root: async () => "/repo",
			spawn: vi.fn(async () => ({ process: {}, source: "test" })),
		},
	]);
}

/** Seed one entry in every map keyed to the client's lifetime. */
function seedLifetimeState(
	raw: Raw,
	key: string,
	client: Fake,
	resolveSettled: () => void,
): void {
	// A notify write still outstanding when the client retires: its waiter must be
	// released, not left parked on a generation that no longer exists.
	raw.outstandingAuxNotifyWrites.set(key, {
		wedgeTimer: undefined,
		resolveSettled,
	});
	raw.state.demonstratedReady.add(key);
	raw.state.demonstratedCold.add(key);
	raw.notifyWriteBackpressureStreak.set(key, 2);
	raw.auxNotifyDrainLatencyEwma.set(key, 850);
	raw.noteAuxNotifyIssued(key, client);
	raw.clientRegistry.clientLastUsedAt.set(key, 1);
}

function expectRetired(raw: Raw, key: string): void {
	expect(raw.state.clients.has(key)).toBe(false);
	expect(raw.state.clientSpawnedAt.has(key)).toBe(false);
	expect(raw.clientRegistry.clientLastUsedAt.has(key)).toBe(false);
	expect(raw.state.demonstratedReady.has(key)).toBe(false);
	expect(raw.state.demonstratedCold.has(key)).toBe(false);
	expect(raw.notifyWriteBackpressureStreak.has(key)).toBe(false);
	expect(raw.clientRegistry.idleEvictionTimers.has(key)).toBe(false);
	expect(raw.outstandingAuxNotifyWrites.has(key)).toBe(false);
	// #3585: the two entries the paths disagreed on.
	expect(raw.auxNotifyInflight.has(key)).toBe(false);
	expect(raw.auxNotifyDrainLatencyEwma.has(key)).toBe(false);
}

describe("#3585 retireClient — one retirement for every path", () => {
	let raw: Raw;
	let key: string;
	let first: Fake;
	let resolveSettled: ReturnType<typeof vi.fn<() => void>>;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		process.env.PI_LENS_TS_IDLE_EVICT_MS = "20";
		process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS = String(FLOOR_MS / 5);
		configureServer();
		first = fakeClient("first");
		createLSPClient.mockResolvedValueOnce(first);
		const { LSPService } = await import("../../../clients/lsp/index.js");
		raw = new LSPService() as unknown as Raw;
		await raw.getClientForFile("/repo/main.ts");
		key = [...raw.state.clients.keys()][0] as string;
		resolveSettled = vi.fn<() => void>();
		seedLifetimeState(raw, key, first, resolveSettled);
	});

	afterEach(async () => {
		await raw.shutdown();
		delete process.env.PI_LENS_TS_IDLE_EVICT_MS;
		delete process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS;
		delete process.env.PI_LENS_LSP_CLIENT_CEILING;
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	/**
	 * The replacement earns its own wedge window: with the predecessor's EWMA
	 * carried over, an 8-deep backlog on the replacement would be priced at
	 * 2 x 850 x 8 = 13 600 ms instead of the fixed floor.
	 */
	function replacementBudgetMs(replacement: Fake): number {
		for (let i = 0; i < 8; i++) raw.noteAuxNotifyIssued(key, replacement);
		return raw.auxNotifyWedgeBudgetMs(key);
	}

	const PATHS: Array<[string, () => Promise<void>]> = [
		[
			"capacity eviction",
			async () => {
				process.env.PI_LENS_LSP_CLIENT_CEILING = "1";
				await expect(
					raw.clientRegistry.makeCapacityForClient("go:/other"),
				).resolves.toBe(true);
			},
		],
		[
			"idle eviction",
			async () => {
				// `seedLifetimeState` bypassed the warm-reuse that arms the timer.
				await raw.getClientForFile("/repo/main.ts");
				expect(raw.clientRegistry.idleEvictionTimers.has(key)).toBe(true);
				await vi.advanceTimersByTimeAsync(20);
			},
		],
		[
			"notify-stall demotion",
			async () => {
				raw.demoteForNotifyStall(
					key,
					{ client: first, info: { id: "typescript" } },
					"/repo/main.ts",
					{ consecutiveTimeouts: 3 },
				);
			},
		],
		[
			"dead-client respawn",
			async () => {
				// Die AFTER the early-exit window so the respawn is not breaker-cooled.
				vi.setSystemTime(Date.now() + 120_000);
				first.kill();
				createLSPClient.mockResolvedValueOnce(fakeClient("respawned"));
				const respawned = await raw.getClientForFile("/repo/main.ts");
				expect(respawned?.client.label).toBe("respawned");
			},
		],
	];

	it.each(PATHS)(
		"%s drops the retired client's entire lifetime state",
		async (name, retire) => {
			await retire();
			expect(resolveSettled).toHaveBeenCalledTimes(1);
			if (name === "dead-client respawn") {
				// The replacement re-registers its own clients/spawnedAt/lastUsed
				// entries; only the predecessor-keyed ones are asserted gone.
				expect(raw.state.clients.get(key)).not.toBe(first);
				expect(raw.state.demonstratedCold.has(key)).toBe(false);
				expect(raw.notifyWriteBackpressureStreak.has(key)).toBe(false);
				expect(raw.auxNotifyInflight.has(key)).toBe(false);
				expect(raw.auxNotifyDrainLatencyEwma.has(key)).toBe(false);
				return;
			}
			expectRetired(raw, key);
		},
	);

	it.each(PATHS)(
		"%s leaves the replacement priced at the fixed wedge floor, not its predecessor's EWMA",
		async (_name, retire) => {
			await retire();
			expect(replacementBudgetMs(fakeClient("replacement"))).toBe(FLOOR_MS);
		},
	);
});

describe("#3585 retirement population", () => {
	/**
	 * Recurrence: a fifth retirement path (or a refactor of one of the four)
	 * that deletes from `clients` directly and so skips part of the cleanup —
	 * the shape behind #3502 and #3537. Scanned over comment-and-string-blanked
	 * source so prose quoting the needle cannot satisfy or excuse it.
	 */
	it("only retireClient removes an entry from the client map", () => {
		const dir = path.resolve(__dirname, "../../../clients/lsp");
		const offenders: string[] = [];
		const helperFiles: string[] = [];
		let scanned = 0;
		for (const file of fs.readdirSync(dir, { recursive: true }) as string[]) {
			if (!file.endsWith(".ts") || file.endsWith(".d.ts")) continue;
			scanned += 1;
			const source = fs.readFileSync(path.join(dir, file), "utf8");
			const blanked = stripCommentsAndStrings(source);
			const helper = blanked.match(
				/\bretireClient\(key: string\): void \{[\s\S]*?\n\t\}\n/,
			);
			if (helper) helperFiles.push(file);
			const outside = helper ? blanked.replace(helper[0], "") : blanked;
			for (const hit of outside.matchAll(/\bclients\s*\.\s*delete\s*\(/g)) {
				const line = outside.slice(0, hit.index).split("\n").length;
				offenders.push(`${file}:${line}`);
			}
		}
		// Shape 10: a walk that found nothing must not read as a clean population.
		assertNonEmptyScan("clients/lsp sources", scanned, 10);
		expect(helperFiles, "retireClient is defined exactly once").toEqual([
			"client-registry.ts",
		]);
		expect(offenders).toEqual([]);
	});

	/**
	 * Recurrence (#2372 slice 3): `LSPState` holds the registry's own Map
	 * objects for the service's readers. A later slice that writes through
	 * that alias (or reaches into the registry's maps) bypasses retirement
	 * and the breaker, the same shape as #3502 and #3537. Blanked source.
	 */
	it("only client-registry.ts writes the registry's shared maps", () => {
		const dir = path.resolve(__dirname, "../../../clients/lsp");
		// Every mutable registry map or set, public or private. `unavailableLogged`
		// and `permanentlyBroken` are public, so a writer outside the registry is
		// reachable (PR #4374 review F2).
		const FIELDS = [
			"clients",
			"inFlight",
			"broken",
			"clientSpawnedAt",
			"permanentlyBroken",
			"unavailableLogged",
		];
		const FIELD_RE = FIELDS.join("|");
		const WRITE_RE = "set|delete|clear|add";
		/**
		 * Documented allowance. `unavailableLogged` is added by the service when
		 * it records the one-time unavailable notice (index.ts), and deleted by the
		 * registry on retirement (client-registry.ts, excluded below). The service's
		 * add is legitimate; any other writer, or a second add, is not. The count
		 * is exact, so a new add beside it reds the test.
		 */
		const ALLOWED = [
			{
				file: "index.ts",
				field: "unavailableLogged",
				verb: "add",
				count: 1,
				reason: "service logs the one-time unavailable notice",
			},
		];
		const seen = new Map<string, number>();
		const offenders: string[] = [];
		let scanned = 0;
		for (const file of fs.readdirSync(dir, { recursive: true }) as string[]) {
			if (!file.endsWith(".ts") || file.endsWith(".d.ts")) continue;
			if (file === "client-registry.ts") continue;
			scanned += 1;
			const blanked = stripCommentsAndStrings(
				fs.readFileSync(path.join(dir, file), "utf8"),
			);
			const lineOf = (index: number) =>
				blanked.slice(0, index).split("\n").length;
			// Direct writes: `state.X.set(` or `clientRegistry.X.delete(`.
			for (const hit of blanked.matchAll(
				new RegExp(
					`\\b(?:state|clientRegistry)\\s*\\.\\s*(${FIELD_RE})\\s*\\.\\s*(${WRITE_RE})\\s*\\(`,
					"g",
				),
			)) {
				const [, field, verb] = hit;
				const allowed = ALLOWED.find(
					(a) => a.file === file && a.field === field && a.verb === verb,
				);
				if (allowed) {
					const key = `${file}|${field}|${verb}`;
					seen.set(key, (seen.get(key) ?? 0) + 1);
					continue;
				}
				offenders.push(`${file}:${lineOf(hit.index)} ${field}.${verb}`);
			}
			// Aliases: a local bound to a shared map, the whole `state`/`clientRegistry`
			// object, or destructured from either. Writes through them are never allowed.
			const aliases = new Map<string, string | null>();
			for (const m of blanked.matchAll(
				new RegExp(
					`\\b(?:const|let|var)\\s+(\\w+)\\s*=\\s*(?:[\\w$]+\\s*\\.\\s*)?(?:state|clientRegistry)\\s*\\.\\s*(${FIELD_RE})\\b`,
					"g",
				),
			))
				aliases.set(m[1], m[2]);
			for (const m of blanked.matchAll(
				/\b(?:const|let|var)\s+(\w+)\s*=\s*(?:[\w$]+\s*\.\s*)?(?:state|clientRegistry)\s*;/g,
			))
				aliases.set(m[1], null);
			for (const m of blanked.matchAll(
				/\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:[\w$]+\s*\.\s*)?(?:state|clientRegistry)\b(?!\s*\.)/g,
			)) {
				for (const entry of m[1].split(",")) {
					const parts = entry.trim().match(/^(\w+)\s*(?::\s*(\w+))?/);
					if (parts && FIELDS.includes(parts[1]))
						aliases.set(parts[2] ?? parts[1], parts[1]);
				}
			}
			for (const [alias, field] of aliases) {
				const re = field
					? new RegExp(`\\b${alias}\\s*\\.\\s*(${WRITE_RE})\\s*\\(`, "g")
					: new RegExp(
							`\\b${alias}\\s*\\.\\s*(${FIELD_RE})\\s*\\.\\s*(${WRITE_RE})\\s*\\(`,
							"g",
						);
				for (const hit of blanked.matchAll(re))
					offenders.push(`${file}:${lineOf(hit.index)} alias ${alias}`);
			}
		}
		assertNonEmptyScan("clients/lsp sources", scanned, 10);
		for (const a of ALLOWED) {
			expect(
				seen.get(`${a.file}|${a.field}|${a.verb}`) ?? 0,
				`allowance ${a.field}.${a.verb} in ${a.file}: ${a.reason}`,
			).toBe(a.count);
		}
		expect(offenders).toEqual([]);
	});
});
