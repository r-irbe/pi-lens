/**
 * #3733 (N4 of #3609, catalog shape 25): the LSP service is a process
 * singleton, so the generation that fences work against a retired service
 * must be one counter per process, not one per module evaluation.
 *
 * The recurrence this prevents: `clients/lsp/server.ts` built its
 * `lsp-launch-availability` source at module scope. A process that evaluates
 * the `clients/` graph twice (source and dist) held two counters for one
 * service, so `resetLSPService` reached through graph 2 bumped only graph 2's
 * counter, and a handle captured through graph 1 stayed current: its late
 * `getLSPService()` could build a server for a retired service.
 *
 * `vi.resetModules` plus a dynamic import evaluates `lsp/server.js` a second
 * time, as a second graph does. Specifiers are `.js`, the artifact the
 * runtime loads (catalog shape 14).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { _seedProcessSingletonCellForTests } from "../../../clients/process-singletons.js";
import { _resetProcessSingletonsForTests } from "../../../clients/process-singletons.js";

type ServerModule = typeof import("../../../clients/lsp/server.js");

/** A fresh evaluation of the module, sharing `globalThis` with every other. */
async function evaluateServerModule(): Promise<ServerModule> {
	vi.resetModules();
	return (await import("../../../clients/lsp/server.js")) as ServerModule;
}

beforeEach(() => {
	_resetProcessSingletonsForTests();
});

describe("#3733 LSP service generation is per process", () => {
	it("goes stale in evaluation 1 when evaluation 2 resets the service", async () => {
		const first = await evaluateServerModule();
		const second = await evaluateServerModule();

		const captured = first.captureLspServiceGeneration();
		expect(captured.isCurrent()).toBe(true);
		second.resetLspLaunchAvailabilityGeneration();

		expect(captured.isCurrent()).toBe(false);
		expect(
			captured.guardedWrite("after-reset", () => "landed"),
		).toBeUndefined();
	});

	it("goes stale in evaluation 2 when evaluation 1 resets the service", async () => {
		const first = await evaluateServerModule();
		const second = await evaluateServerModule();

		const captured = second.captureLspServiceGeneration();
		first.resetLspLaunchAvailabilityGeneration();

		expect(captured.isCurrent()).toBe(false);
	});

	it("stays current across evaluations while no reset happens", async () => {
		const first = await evaluateServerModule();
		const second = await evaluateServerModule();

		const captured = first.captureLspServiceGeneration();

		expect(second.captureLspServiceGeneration().generation).toBe(
			captured.generation,
		);
		expect(captured.isCurrent()).toBe(true);
	});

	it("never repeats a generation when a cell of another build is replaced", async () => {
		_seedProcessSingletonCellForTests("lsp.service.generation", {
			schema: "pi-lens.process-singletons",
			version: 99,
			value: { generation: 7 },
		});
		const server = await evaluateServerModule();

		const before = server.captureLspServiceGeneration();
		expect(before.generation).toBe(7);
		server.resetLspLaunchAvailabilityGeneration();

		expect(before.isCurrent()).toBe(false);
		expect(server.captureLspServiceGeneration().generation).toBe(8);
	});

	it.each(["seven", -3, 1.5])(
		"starts at 0 when the other build's cell carries %j as its count",
		async (count) => {
			_seedProcessSingletonCellForTests("lsp.service.generation", {
				schema: "pi-lens.process-singletons",
				version: 99,
				value: { generation: count },
			});
			const server = await evaluateServerModule();

			expect(server.captureLspServiceGeneration().generation).toBe(0);
		},
	);

	it("starts at 0 when the other build's cell holds no value at all", async () => {
		_seedProcessSingletonCellForTests("lsp.service.generation", {
			schema: "pi-lens.process-singletons",
			version: 99,
		});
		const server = await evaluateServerModule();

		expect(server.captureLspServiceGeneration().generation).toBe(0);
	});

	it("reads the cell another build replaced after a handle was captured", async () => {
		const first = await evaluateServerModule();
		const captured = first.captureLspServiceGeneration();
		_seedProcessSingletonCellForTests("lsp.service.generation", {
			schema: "pi-lens.process-singletons",
			version: 99,
			value: { generation: 7 },
		});
		const second = await evaluateServerModule();
		second.resetLspLaunchAvailabilityGeneration();

		expect(captured.isCurrent()).toBe(false);
	});
});
