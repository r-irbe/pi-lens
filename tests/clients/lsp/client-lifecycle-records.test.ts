/**
 * #2372 slice 3: the client lifecycle records that no other test pinned
 * before ClientRegistry moved out of LSPService.
 *
 * Recurrence this file prevents: a move or split of the client registry
 * (spawn, respawn, shutdown) that keeps every key and breaker test green but
 * silently changes what the logs say: the reset record counting clients
 * after teardown (always 0), a per-key log line that repeats on every reuse
 * or respawn, the respawn record measuring lifetime from detection instead
 * of the recorded death, or a shutdown that leaves cooldowns behind.
 *
 * Production chain: the real `LSPService.getClientForFile` acquires through
 * the real registry; config and the client factory are the process boundary,
 * and the two log sinks are spied with their real modules spread.
 */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeMapKey } from "../../../clients/path-utils.js";

const FIXTURE_ROOT = path.join(
	process.cwd(),
	"client-lifecycle-records-fixture",
);

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();
const logLatency = vi.fn();
const logSessionStart = vi.fn();

vi.mock("../../../clients/lsp/config.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/lsp/config.js")>()),
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../../../clients/lsp/client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/lsp/client.js")>()),
	createLSPClient,
}));
vi.mock("../../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../clients/latency-logger.js")
	>()),
	logLatency,
}));
vi.mock("../../../clients/sessionstart-logger.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../clients/sessionstart-logger.js")
	>()),
	logSessionStart,
}));

function makeFakeClient(serverId: string) {
	const fake = {
		alive: true,
		intentional: false,
		exitedAt: undefined as number | undefined,
		serverId,
		root: FIXTURE_ROOT,
		diagnosticsVersion: 0,
		isAlive: () => fake.alive,
		wasShutdownIntentional: () => fake.intentional,
		getExitedAt: () => fake.exitedAt,
		shutdown: vi.fn(async () => {
			fake.intentional = true;
			fake.alive = false;
		}),
		notify: {
			open: vi.fn(async () => undefined),
			change: vi.fn(async () => undefined),
		},
		die(at: number, intentional: boolean) {
			fake.exitedAt = at;
			fake.intentional = intentional;
			fake.alive = false;
		},
	};
	return fake;
}

function makeServer(id: string, extension: string) {
	return {
		id,
		name: id,
		extensions: [extension],
		root: async () => FIXTURE_ROOT,
		spawn: vi.fn(async () => ({ process: {}, source: "test" })),
	};
}

function sessionLines(prefix: string): string[] {
	return logSessionStart.mock.calls
		.map(([line]) => String(line))
		.filter((line) => line.startsWith(prefix));
}

interface LatencyRecord {
	phase?: string;
	metadata?: Record<string, unknown>;
}

function latencyRecords(phase: string): LatencyRecord[] {
	return logLatency.mock.calls
		.map(([entry]) => entry as LatencyRecord | undefined)
		.filter((entry): entry is LatencyRecord => entry?.phase === phase);
}

describe("client lifecycle records (#2372 ClientRegistry move)", () => {
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		logLatency.mockReset();
		logSessionStart.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("lsp_service_reset counts the clients alive when shutdown starts, then every client is gone", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const alpha = makeServer("alpha", ".fa");
		const beta = makeServer("beta", ".fb");
		getServersForFileWithConfig.mockImplementation((file: string) =>
			file.endsWith(".fa") ? [alpha] : [beta],
		);
		const fakes: Array<ReturnType<typeof makeFakeClient>> = [];
		createLSPClient.mockImplementation(async ({ serverId }) => {
			const fake = makeFakeClient(serverId);
			fakes.push(fake);
			return fake;
		});

		expect(
			await service.getClientForFile(path.join(FIXTURE_ROOT, "a.fa")),
		).toBeDefined();
		expect(
			await service.getClientForFile(path.join(FIXTURE_ROOT, "b.fb")),
		).toBeDefined();
		expect(service.getAliveClientCount()).toBe(2);

		await service.shutdown({ reason: "session_shutdown" });

		const [reset] = latencyRecords("lsp_service_reset");
		expect(reset?.metadata).toMatchObject({
			reason: "session_shutdown",
			aliveClients: 2,
		});
		for (const fake of fakes) {
			expect(fake.shutdown).toHaveBeenCalledWith({
				reason: "session_shutdown",
			});
		}
		expect(service.getStatus()).toEqual([]);
		expect(service.checkDestroyed()).toBe(true);
	});

	it("shutdown clears breaker cooldowns", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		getServersForFileWithConfig.mockReturnValue([makeServer("alpha", ".fa")]);
		createLSPClient.mockRejectedValue(new Error("initialize failed"));

		expect(
			await service.getClientForFile(path.join(FIXTURE_ROOT, "a.fa")),
		).toBeUndefined();
		const [cooled] = service.getBrokenStatus();
		expect(cooled).toMatchObject({
			serverId: "alpha",
			root: normalizeMapKey(FIXTURE_ROOT),
			failures: 1,
			permanentlyBroken: false,
		});
		expect(cooled.cooldownUntil).toBeGreaterThan(Date.now());

		await service.shutdown({ fast: true });

		expect(service.getBrokenStatus()).toEqual([]);
	});

	it("writes the warm-start line once per key however often the client is reused", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const server = makeServer("alpha", ".fa");
		getServersForFileWithConfig.mockReturnValue([server]);
		createLSPClient.mockImplementation(async ({ serverId }) =>
			makeFakeClient(serverId),
		);
		const file = path.join(FIXTURE_ROOT, "a.fa");

		for (let i = 0; i < 4; i++) {
			expect(await service.getClientForFile(file)).toBeDefined();
		}

		expect(server.spawn).toHaveBeenCalledTimes(1);
		expect(sessionLines("lsp warm-start alpha: reused")).toHaveLength(1);
	});

	it("writes the workspace-diag probe line once per key across a respawn", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const server = makeServer("alpha", ".fa");
		getServersForFileWithConfig.mockReturnValue([server]);
		const fakes: Array<ReturnType<typeof makeFakeClient>> = [];
		createLSPClient.mockImplementation(async ({ serverId }) => {
			const fake = makeFakeClient(serverId);
			fakes.push(fake);
			return fake;
		});
		const file = path.join(FIXTURE_ROOT, "a.fa");

		expect(await service.getClientForFile(file)).toBeDefined();
		// An intentional exit is not breaker evidence, so the next acquisition
		// retires the dead client and respawns in the same call.
		fakes[0].die(Date.now(), true);
		const respawned = await service.getClientForFile(file);

		expect(respawned?.client).toBe(fakes[1]);
		expect(server.spawn).toHaveBeenCalledTimes(2);
		expect(sessionLines("lsp workspace-diag probe alpha:")).toHaveLength(1);
		expect(sessionLines("lsp spawn alpha: success")).toHaveLength(2);
	});

	it("lsp_server_respawn measures lifetime from the recorded death and names an unintended exit", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const internal = service as unknown as {
			state: { clientSpawnedAt: Map<string, number> };
		};
		getServersForFileWithConfig.mockReturnValue([makeServer("alpha", ".fa")]);
		const fakes: Array<ReturnType<typeof makeFakeClient>> = [];
		createLSPClient.mockImplementation(async ({ serverId }) => {
			const fake = makeFakeClient(serverId);
			fakes.push(fake);
			return fake;
		});
		const file = path.join(FIXTURE_ROOT, "a.fa");
		const key = `alpha:${normalizeMapKey(FIXTURE_ROOT)}`;

		expect(await service.getClientForFile(file)).toBeDefined();
		// Death recorded 5s after a spawn an hour ago: detection time must not
		// stretch the lifetime.
		const spawnedAt = Date.now() - 60 * 60_000;
		internal.state.clientSpawnedAt.set(key, spawnedAt);
		fakes[0].die(spawnedAt + 5_000, false);

		await service.getClientForFile(file);

		const [respawn] = latencyRecords("lsp_server_respawn");
		expect(respawn?.metadata).toMatchObject({
			serverId: "alpha",
			uptimeMs: 5_000,
			intentional: false,
		});
		expect(normalizeMapKey(String(respawn?.metadata?.root))).toBe(
			normalizeMapKey(FIXTURE_ROOT),
		);
	});
});
