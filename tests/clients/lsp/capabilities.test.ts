import { describe, expect, it, vi } from "vitest";
import { LSPService } from "../../../clients/lsp/index.js";
import {
	adaptLspService,
	getLSPService,
	type LspCapabilities,
} from "../../../clients/lsp/capabilities.js";

describe("LspCapabilities adapter", () => {
	it("forwards flat and grouped calls to the same service", () => {
		const service = new LSPService();
		const getAliveServerIds = vi
			.spyOn(service, "getAliveServerIds")
			.mockReturnValue(["ts"]);
		const facade = adaptLspService(service);

		expect(facade.getAliveServerIds()).toEqual(["ts"]);
		expect(facade.clients?.getAliveServerIds()).toEqual(["ts"]);
		expect(facade.clients?.getAliveServerIds).toBeDefined();
		expect(getAliveServerIds).toHaveBeenCalledTimes(2);
		expect(adaptLspService(service)).toBe(facade);
	});

	// #2372 slice 3: the registry owns the client half of shutdown, but the
	// group's shutdown must stay the service's, which also tears down the
	// per-generation touch state; a route straight to the registry would not.
	it("routes the lifecycle group's shutdown to the service, which tears down touch state too", async () => {
		const service = new LSPService();
		const shutdown = vi.spyOn(service, "shutdown");
		const facade = adaptLspService(service);

		await facade.clients?.shutdown({ fast: true });

		expect(shutdown).toHaveBeenCalledWith({ fast: true });
		expect(facade.clients?.checkDestroyed()).toBe(true);
	});

	it("keeps the singleton lifecycle compatibility export on the facade", () => {
		const facade: LspCapabilities = getLSPService();
		expect(facade.documents).toBeDefined();
		expect(facade.diagnostics).toBeDefined();
		expect(facade.navigation).toBeDefined();
		expect(facade.workspace).toBeDefined();
	});
});
