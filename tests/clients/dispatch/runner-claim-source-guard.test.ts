/**
 * #3968 F4 — the closed-taxonomy guard on `claimSource`, observed at the
 * dispatcher's latency seam.
 *
 * `isRunnerClaimSource` admits only the two provenance values into the durable
 * latency row. Runner definitions are a typed API, but embedders and plugins
 * can return untyped objects, so free text must not reach the row. The
 * recurrence this prevents: opening the guard to any string (the verify at
 * `8d444595` mutated it that way and the 5-file / 99-test PR suite stayed
 * green) lets a plugin's arbitrary text into `latency.log` metadata.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
	clearLatencyReports,
	createDispatchContext,
	dispatchForFile,
	getLatencyReports,
	RunnerRegistry,
} from "../../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import type { RunnerResult } from "../../../clients/dispatch/types.js";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "../test-utils.js";

describe("claimSource latency admission (#3968 F4)", () => {
	const projectRoot = setupTestEnvironment("pi-lens-claim-source-").tmpDir;
	const filePath = join(projectRoot, "fixture.ts");

	afterAll(async () => {
		await cleanupTestEnvironmentsDrained("pi-lens-claim-source-");
	});

	beforeEach(() => {
		clearLatencyReports();
		writeFileSync(filePath, "const fixture = 1;\n");
	});

	/** Real dispatchForFile; the stub runner returns an untyped result. */
	async function latencyRowFor(result: Record<string, unknown>) {
		const registry = new RunnerRegistry();
		registry.register({
			id: "fixture-runner",
			appliesTo: ["jsts"],
			priority: 1,
			run: async () => result as unknown as RunnerResult,
		});
		const ctx = createDispatchContext(
			filePath,
			projectRoot,
			{ getFlag: () => false },
			new FactStore(),
		);
		await dispatchForFile(
			ctx,
			[{ mode: "all", runnerIds: ["fixture-runner"] }],
			registry,
		);
		return getLatencyReports()
			.at(-1)
			?.runners.find((r) => r.runnerId === "fixture-runner");
	}

	const skipped = {
		status: "skipped",
		diagnostics: [],
		semantic: "none",
		skipReason: "covered-by-primary",
	};

	it("drops a claimSource outside the taxonomy from a skipped row", async () => {
		const row = await latencyRowFor({
			...skipped,
			claimSource: "attacker free text",
		});
		expect(row).toMatchObject({
			status: "skipped",
			skipReason: "covered-by-primary",
		});
		expect(row).not.toHaveProperty("claimSource");
	});

	it("keeps each taxonomy claimSource on a skipped row", async () => {
		for (const claimSource of ["declared", "builtin-fact"]) {
			clearLatencyReports();
			const row = await latencyRowFor({ ...skipped, claimSource });
			expect(row).toMatchObject({
				skipReason: "covered-by-primary",
				claimSource,
			});
		}
	});

	it("drops even a taxonomy claimSource when the runner did not skip", async () => {
		const row = await latencyRowFor({
			status: "succeeded",
			diagnostics: [],
			semantic: "none",
			claimSource: "declared",
		});
		expect(row).toMatchObject({ status: "succeeded" });
		expect(row).not.toHaveProperty("claimSource");
	});
});
