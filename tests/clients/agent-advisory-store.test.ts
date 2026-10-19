/**
 * #3612: the agent advisory queue (#3748) as the `agent-advisories` session
 * store, through real scopes and the real queue.
 *
 * The recurrences these prevent: a carried advisory also counted as dropped
 * when its old scope's entry is pruned; an advisory the gap prune already
 * dropped lost for good; and a sidecar (a past turn's queue) re-delivering
 * an advisory the model has already seen.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
	_resetAgentNudgeForTests,
	agentAdvisoryStore,
	consumeAgentNudge,
	queueAgentAdvisory,
} from "../../clients/agent-nudge.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	type AdoptContext,
	beginScope,
	retireScope,
} from "../../clients/session-scope.js";

function ctx(source: AdoptContext["source"]): AdoptContext {
	return {
		reason: "reload",
		source,
		savedAt: source === "slot" ? undefined : 1,
		sessionManager: undefined,
		cwd: "/",
	};
}

function texts(scope: ReturnType<typeof beginScope>): string[] {
	return (consumeAgentNudge(undefined, scope)?.messages ?? []).map(
		(message) => message.content,
	);
}

function dropped(): string[] {
	return getDegradationSummary()
		.filter((group) => group.kind === "agent-advisory-dropped")
		.flatMap((group) => group.latestReasons.map((r) => r.subject));
}

beforeEach(() => {
	_resetAgentNudgeForTests();
	resetDegradationLedger();
});

describe("#3612 the agent-advisories store", () => {
	it("snapshots only its own scope's advisories", () => {
		const own = beginScope({ role: "primary" });
		const other = beginScope({ role: "secondary" });
		queueAgentAdvisory("mine", own.capture());
		queueAgentAdvisory("theirs", other.capture());

		expect(agentAdvisoryStore.snapshot(own)).toEqual(["mine"]);
	});

	it("re-tags the predecessor's advisory from the slot, with no drop record", () => {
		const before = beginScope({ role: "primary" });
		queueAgentAdvisory("lost edit", before.capture());
		const payload = agentAdvisoryStore.snapshot(before);
		retireScope(before, "reload");
		const after = beginScope({ role: "primary" });

		void agentAdvisoryStore.restore(after, payload, ctx("slot"));

		expect(texts(after)).toEqual([expect.stringContaining("lost edit")]);
		expect(dropped()).toEqual([]);
	});

	it("queues a slot advisory the prune already dropped in the reload gap", () => {
		const before = beginScope({ role: "primary" });
		queueAgentAdvisory("lost edit", before.capture());
		const payload = agentAdvisoryStore.snapshot(before);
		retireScope(before, "reload");
		// A context call between the shutdown and the start prunes it.
		expect(consumeAgentNudge(undefined, before)).toBeUndefined();
		const after = beginScope({ role: "primary" });

		void agentAdvisoryStore.restore(after, payload, ctx("slot"));

		expect(texts(after)).toEqual([expect.stringContaining("lost edit")]);
	});

	it("adopts nothing from a sidecar, a past turn's queue", () => {
		const after = beginScope({ role: "primary" });

		void agentAdvisoryStore.restore(
			after,
			["seen already"],
			ctx("own-sidecar"),
		);

		expect(texts(after)).toEqual([]);
	});
});
