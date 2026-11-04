/**
 * #2523 AC2: `bounded()` cannot be called with one bound, and firing the
 * signal settles it without waiting the deadline out.
 *
 * The compile-time half is the load-bearing one. Every earlier attempt at
 * this discipline was a convention — "remember to pass the signal too" — and
 * conventions are what #2523's sweep found 187 exceptions to. A missing bound
 * has to be a type error, so the `@ts-expect-error` cases below are assertions
 * about the TYPE, checked by the repo's lint/typecheck gate: if `bounded`
 * ever accepts one bound, `@ts-expect-error` becomes an UNUSED suppression
 * and `tsc` fails on it. That is the direction that matters — the test cannot
 * silently stop guarding.
 */

import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bounded } from "../../clients/deadline-utils.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";

/** A promise that never settles: the wedged dependency #2523 measured. */
function wedged<T>(): Promise<T> {
	return new Promise<T>(() => {});
}

function summaryFor(kind: string) {
	return getDegradationSummary().find((group) => group.kind === kind);
}

/**
 * Never CALLED — only type-checked. `@ts-expect-error` is a compile-time
 * assertion, and executing a one-bound call would run code the type forbids
 * (a `ms: undefined` reaches `AbortSignal.timeout(NaN)`), which is a property
 * of its own and is asserted separately below.
 */
async function _oneBoundCallsDoNotTypeCheck(
	signal: AbortSignal,
): Promise<void> {
	// @ts-expect-error #2523 AC2: `signal` is required — a deadline alone
	// leaves Escape unable to release the hook (measured: still blocked
	// 30011ms after the abort fired).
	await bounded(Promise.resolve(1), {
		ms: 5,
		hook: "turn_end",
		label: "deadline-only",
	});
	// @ts-expect-error #2523 AC2: `ms` is required — a signal alone leaves a
	// dependency that wedges with nobody pressing Escape running forever
	// (measured: 400000ms, the harness ceiling).
	await bounded(Promise.resolve(1), {
		signal,
		hook: "turn_end",
		label: "signal-only",
	});
}

describe("#2523 AC2 bounded() requires BOTH bounds", () => {
	beforeEach(() => {
		resetDegradationLedger();
	});
	afterEach(() => {
		resetDegradationLedger();
	});

	it("accepts the both-bounds call, and only that one", () => {
		// The compile-time half of this assertion lives in
		// `_oneBoundCallsDoNotTypeCheck` above: if `bounded` ever accepts one
		// bound, its `@ts-expect-error` comments become unused suppressions and
		// the typecheck gate fails. This case pins the positive direction.
		const controller = new AbortController();
		expect(typeof _oneBoundCallsDoNotTypeCheck).toBe("function");
		expect(
			bounded(Promise.resolve(1), {
				ms: 5,
				signal: controller.signal,
				hook: "turn_end",
				label: "both",
			}),
		).toBeInstanceOf(Promise);
	});

	it("settles immediately on a non-finite budget instead of throwing", async () => {
		// The runtime companion to the type assertion: a JS caller can still
		// hand over `undefined`, and `AbortSignal.timeout(NaN)` throws
		// ERR_OUT_OF_RANGE. A helper whose job is keeping a hook from blowing up
		// must not blow up inside one.
		const controller = new AbortController();
		await expect(
			bounded(Promise.resolve("never seen"), {
				ms: undefined as unknown as number,
				signal: controller.signal,
				hook: "turn_end",
				label: "non-finite-budget",
			}),
		).resolves.toBeUndefined();
		expect(summaryFor("hook-await-exceeded")?.count).toBe(1);
	});

	it("treats a missing `signal` as never-aborting instead of throwing", async () => {
		// #2530 round 3 F5. `ms` is guarded with `Number.isFinite` before use
		// (the case above), but `signal.aborted` is read unguarded a few lines
		// later. The type marks `signal` required, same as `ms`, but a JS caller
		// — or a caller that only checked the compiler on `ms` — can still hand
		// over `undefined`, and `bounded(p, { ms, hook, label })` throws
		// `Cannot read properties of undefined (reading 'aborted')` before the
		// budget or the work ever gets a chance to settle it.
		await expect(
			bounded(Promise.resolve("answer"), {
				ms: 1000,
				signal: undefined as unknown as AbortSignal,
				hook: "turn_end",
				label: "no-signal",
			}),
		).resolves.toBe("answer");
		// And the deadline half of the same call still works with no signal.
		await expect(
			bounded(wedged<string>(), {
				ms: 20,
				signal: undefined as unknown as AbortSignal,
				hook: "turn_end",
				label: "no-signal-deadline",
			}),
		).resolves.toBeUndefined();
	});

	it("returns the value when the work settles inside both bounds", async () => {
		const controller = new AbortController();
		await expect(
			bounded(Promise.resolve("answer"), {
				ms: 1000,
				signal: controller.signal,
				hook: "turn_end",
				label: "fast",
			}),
		).resolves.toBe("answer");
		expect(summaryFor("hook-await-exceeded")).toBeUndefined();
	});

	it("settles on the SIGNAL without waiting the deadline out", async () => {
		const controller = new AbortController();
		const startedAt = Date.now();
		const pending = bounded(wedged<string>(), {
			// A deadline far beyond any plausible test runtime: if the abort leg
			// were missing, this test would time out rather than pass late, so a
			// regression cannot hide behind a generous assertion.
			ms: 60_000,
			signal: controller.signal,
			hook: "turn_end",
			label: "escape",
		});
		controller.abort();
		await expect(pending).resolves.toBeUndefined();
		expect(Date.now() - startedAt).toBeLessThan(5_000);
	});

	it("records NOTHING when the caller's own signal aborts", async () => {
		// Review round 2 (F1). The caller's signal IS Escape / turn cancel — a
		// deliberate user action, not a degraded environment. Round 1 recorded
		// `hook-await-exceeded` (warning tier, a `⚠` line in `pilens_health`)
		// on BOTH causes, which is the exact inversion clients/bootstrap.ts
		// already documents as fixed: `if (unavailableReason !== "aborted")`
		// exists because writing a deliberate cancel to the ledger made it
		// indistinguishable from an unhealthy analyzer graph. `bounded()` is
		// meant to become THE bound primitive at 187 sites, so shipping the
		// inversion here would ship it everywhere.
		const controller = new AbortController();
		const pending = bounded(wedged<string>(), {
			ms: 60_000,
			signal: controller.signal,
			hook: "turn_end",
			label: "escape",
		});
		controller.abort();
		await expect(pending).resolves.toBeUndefined();
		expect(summaryFor("hook-await-exceeded")).toBeUndefined();
		expect(summaryFor("hook-await-abandoned")).toBeUndefined();
		expect(getDegradationSummary()).toEqual([]);
	});

	it("records an INFORMATIONAL row when the shutdown signal fires", async () => {
		// The third cause, modelled on `abandonedError`
		// (clients/bootstrap.ts): teardown is neither a budget blow-out nor a
		// user cancel. It is a tally — the same reasoning that put
		// `log-sink-rotated` in `INFORMATIONAL_DEGRADATION_KINDS` rather than
		// giving a designed-for event the marker a real degradation gets.
		const caller = new AbortController();
		const shutdown = new AbortController();
		const startedAt = Date.now();
		const pending = bounded(wedged<string>(), {
			// Small enough that the PRE-FIX implementation (which ignores
			// `shutdownSignal` entirely) reds on the assertion after ~1s rather
			// than hanging the suite out to the vitest ceiling.
			ms: 1_000,
			signal: caller.signal,
			shutdownSignal: shutdown.signal,
			hook: "session_shutdown",
			label: "drainPendingWrites",
		});
		shutdown.abort();
		await expect(pending).resolves.toBeUndefined();
		// Settles on the shutdown signal, it does not wait the budget out.
		expect(Date.now() - startedAt).toBeLessThan(500);
		expect(summaryFor("hook-await-exceeded")).toBeUndefined();
		const group = summaryFor("hook-await-abandoned");
		expect(group?.count).toBe(1);
		expect(group?.latestReasons.at(-1)?.subject).toBe(
			"session_shutdown:drainPendingWrites",
		);
	});

	it("names the CALLER's abort ahead of both other causes", async () => {
		// `abandonedError`'s precedence, kept exactly so `bounded()` is a true
		// superset of `awaitWithinBounds`: caller, then shutdown, then the
		// deadline. A turn cancelled while the session also happens to be
		// tearing down is still a cancel, and still records nothing.
		const caller = new AbortController();
		const shutdown = new AbortController();
		caller.abort();
		shutdown.abort();
		await expect(
			bounded(wedged<void>(), {
				ms: 0,
				signal: caller.signal,
				shutdownSignal: shutdown.signal,
				hook: "turn_end",
				label: "precedence",
			}),
		).resolves.toBeUndefined();
		expect(getDegradationSummary()).toEqual([]);
	});

	it("names the CALLER's abort ahead of shutdown when both fire AFTER the call, in the same tick", async () => {
		// #2530 round 3 F4. The case above pre-aborts BOTH signals before
		// `bounded()` is even called, which only exercises the two
		// `if (...aborted)` PRE-checks at the top of the abandon race — never
		// the listener path below them, and never the `cause ??= reason`
		// first-fire-wins guard that path depends on (with only one signal
		// ever pre-aborted, `fire()` is never called twice, so first-wins vs
		// last-wins cannot be told apart). Here both signals are still LIVE
		// when `bounded()` starts, and both fire after it, in the same tick —
		// caller first, then shutdown — so the caller's abort must still win
		// and nothing must reach the ledger.
		const caller = new AbortController();
		const shutdown = new AbortController();
		const pending = bounded(wedged<void>(), {
			ms: 60_000,
			signal: caller.signal,
			shutdownSignal: shutdown.signal,
			hook: "turn_end",
			label: "post-call-precedence",
		});
		caller.abort();
		shutdown.abort();
		await expect(pending).resolves.toBeUndefined();
		expect(getDegradationSummary()).toEqual([]);
	});

	it("settles on the DEADLINE when nothing aborts, naming the budget", async () => {
		const controller = new AbortController();
		await expect(
			bounded(wedged<string>(), {
				ms: 20,
				signal: controller.signal,
				hook: "session_start",
				label: "dropStaleFiles",
			}),
		).resolves.toBeUndefined();
		const group = summaryFor("hook-await-exceeded");
		expect(group?.latestReasons.at(-1)?.subject).toBe(
			"session_start:dropStaleFiles",
		);
		expect(group?.latestReasons.at(-1)?.reason).toContain("20ms budget");
	});

	it("records ONE rising-edge row per (hook, label), not one per exceedance", async () => {
		// AC7: exceedance must be visible without flooding. A hook that blows
		// its budget on every turn of a long session writes one row.
		const controller = new AbortController();
		for (let i = 0; i < 5; i++) {
			await bounded(wedged<void>(), {
				ms: 5,
				signal: controller.signal,
				hook: "turn_end",
				label: "sweepInlineBlockerFreshness",
			});
		}
		expect(summaryFor("hook-await-exceeded")?.count).toBe(1);
		// A DIFFERENT await under the same hook is its own subject, so the
		// ledger still answers which await is slow, not merely that one is.
		await bounded(wedged<void>(), {
			ms: 5,
			signal: controller.signal,
			hook: "turn_end",
			label: "readCachedDiagnosticsForServers",
		});
		expect(summaryFor("hook-await-exceeded")?.count).toBe(2);
	});

	it("distinguishes `no answer inside the bound` from a value of undefined", async () => {
		// Defect shape 10: a bound that fired must not read like a clean answer.
		// `undefined` is the return either way — the LEDGER is what separates
		// them, which is why the exceeded path records and the resolved path
		// does not.
		const controller = new AbortController();
		await expect(
			bounded(Promise.resolve(undefined), {
				ms: 1000,
				signal: controller.signal,
				hook: "turn_end",
				label: "legitimately-undefined",
			}),
		).resolves.toBeUndefined();
		expect(summaryFor("hook-await-exceeded")).toBeUndefined();
	});

	it("propagates the work's own rejection instead of swallowing it", async () => {
		const controller = new AbortController();
		await expect(
			bounded(Promise.reject(new Error("runner blew up")), {
				ms: 1000,
				signal: controller.signal,
				hook: "agent_end",
				label: "runAutofix",
			}),
		).rejects.toThrow("runner blew up");
		expect(summaryFor("hook-await-exceeded")).toBeUndefined();
	});

	it("suppresses a LATE rejection from work the bound already abandoned", async () => {
		// Without this, every timed-out hook await would surface as an
		// unhandled rejection a few hundred ms after the hook returned — a
		// process-level crash risk introduced by the very helper meant to make
		// hooks safe.
		const controller = new AbortController();
		let rejectLate: ((error: Error) => void) | undefined;
		const late = new Promise<void>((_resolve, reject) => {
			rejectLate = reject;
		});
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			await expect(
				bounded(late, {
					ms: 10,
					signal: controller.signal,
					hook: "turn_end",
					label: "late-rejector",
				}),
			).resolves.toBeUndefined();
			rejectLate?.(new Error("too late"));
			// Two macrotask turns: `unhandledRejection` fires at the end of a
			// microtask checkpoint, so one turn is enough, and the second is
			// slack against a slow CI host.
			await new Promise((resolve) => setTimeout(resolve, 0));
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("leaves neither a listener nor a composite behind on the hook signal", async () => {
		// Node >=22.19 supports AbortSignal.any, but its dependant storage is
		// private and not consistently exposed as an own symbol (Node 26 hides
		// it). Observe REAL composites through a call-through spy, retaining
		// them until source abort instead of depending on storage layout or GC.
		// No mock implementation: native cancellation must remain load-bearing.
		const any = vi.spyOn(AbortSignal, "any");
		try {
			const controller = new AbortController();
			const shutdown = new AbortController();
			const unrelated = new AbortController();
			const signal = controller.signal;

			// Positive controls: public listener introspection sees an actual
			// listener, and the recorder sees an actual native composite.
			const onAbort = () => {};
			expect(getEventListeners(signal, "abort")).toHaveLength(0);
			signal.addEventListener("abort", onAbort);
			expect(getEventListeners(signal, "abort")).toHaveLength(1);
			signal.removeEventListener("abort", onAbort);
			expect(getEventListeners(signal, "abort")).toHaveLength(0);
			const positive = AbortSignal.any([signal, new AbortController().signal]);
			expect(any).toHaveBeenCalledTimes(1);
			expect(any.mock.results[0]?.value).toBe(positive);
			let positiveAborts = 0;
			positive.addEventListener("abort", () => positiveAborts++);
			expect(positive.aborted).toBe(false);
			// Negative control: an unrelated abort must not trip the witness.
			unrelated.abort();
			expect(positive.aborted).toBe(false);
			expect(positiveAborts).toBe(0);

			for (let i = 0; i < 200; i++) {
				await bounded(Promise.resolve(i), {
					ms: 1000,
					signal,
					shutdownSignal: shutdown.signal,
					hook: "session_start",
					label: "loop",
				});
			}
			expect(getEventListeners(signal, "abort")).toHaveLength(0);
			expect(getEventListeners(shutdown.signal, "abort")).toHaveLength(0);

			// A completed await must leave no composite still linked to either
			// long-lived source. Keeping returned composites alive makes the
			// historical any-per-call regression observable without forcing GC.
			const composites = any.mock.results.slice(1).map((result) => {
				expect(result.type).toBe("return");
				return result.value as AbortSignal;
			});
			const reason = new Error("hook finished");
			controller.abort(reason);
			shutdown.abort(reason);
			expect(positive.aborted).toBe(true);
			expect(positive.reason).toBe(reason);
			expect(positiveAborts).toBe(1);
			expect(composites.filter((composite) => composite.aborted)).toEqual([]);
			// Also catch unlinked throwaway composites: bounded's one-timer,
			// direct-source-listener contract needs no composite at all.
			expect(any).toHaveBeenCalledTimes(1);
		} finally {
			any.mockRestore();
		}
	});

	it("arms exactly ONE setTimeout per call, through the real global timer", async () => {
		// #2530 round 3 F1. `tests/config/hook-await-bounds.test.ts` used to pin
		// "one timer" with a SOURCE-SHAPE assertion — counting `setTimeout(`
		// occurrences in the text of `bounded()`'s own body, sliced from its
		// `export async function bounded<T>(` marker to end-of-file. That slice
		// is blind to a helper hoisted ABOVE the marker: a second timer armed by
		// a function `bounded()` calls, defined earlier in the same file, never
		// appears in the counted text at all — measured, that mutation left the
		// structural assertion at 24/24 green. `clients/deadline-utils.js` calls
		// the bare global `setTimeout` (not a wrapped one), so a real runtime
		// probe exists after all: `vi.spyOn(globalThis, "setTimeout")` sees
		// every timer `bounded()` actually arms, regardless of which function in
		// the file armed it. The structural case is deleted; this replaces it.
		const spy = vi.spyOn(globalThis, "setTimeout");
		try {
			const controller = new AbortController();
			await bounded(Promise.resolve("value"), {
				ms: 1000,
				signal: controller.signal,
				hook: "turn_end",
				label: "single-timer",
			});
			expect(spy).toHaveBeenCalledTimes(1);
		} finally {
			spy.mockRestore();
		}
	});

	it("removes its abort listener when the WORK wins the race", async () => {
		// The mutation target for the `finally`: with the listener now
		// registered on the SOURCE signal, dropping the cleanup makes the
		// count grow with the loop instead of returning to baseline. Kept
		// separate from the composite assertion above so the two failure modes
		// do not share a message.
		const controller = new AbortController();
		const signal = controller.signal;
		const before = getEventListeners(signal, "abort").length;
		for (let i = 0; i < 50; i++) {
			await bounded(Promise.resolve(i), {
				ms: 60_000,
				signal,
				shutdownSignal: new AbortController().signal,
				hook: "turn_end",
				label: "cleanup",
			});
		}
		expect(getEventListeners(signal, "abort").length).toBe(before);
	});

	it("settles immediately, and records, when the budget is zero", async () => {
		// `turn_start`, `context`, `session_shutdown` and `session_before_fork`
		// carry a 0ms budget in clients/hook-budgets.ts: "may not await at
		// all". A zero budget must therefore settle without waiting, and must
		// still be visible rather than silently returning nothing.
		const controller = new AbortController();
		await expect(
			bounded(Promise.resolve("never seen"), {
				ms: 0,
				signal: controller.signal,
				hook: "turn_start",
				label: "anything",
			}),
		).resolves.toBeUndefined();
		expect(summaryFor("hook-await-exceeded")?.count).toBe(1);
	});

	it("settles immediately when the signal is ALREADY aborted", async () => {
		// A hook entered after Escape was pressed must not spend its budget
		// discovering that.
		const controller = new AbortController();
		controller.abort();
		const startedAt = Date.now();
		await expect(
			bounded(wedged<void>(), {
				ms: 60_000,
				signal: controller.signal,
				hook: "agent_settled",
				label: "already-aborted",
			}),
		).resolves.toBeUndefined();
		expect(Date.now() - startedAt).toBeLessThan(5_000);
		// Entering a hook after Escape was pressed is still the caller
		// cancelling, so it is still not a degradation (F1).
		expect(getDegradationSummary()).toEqual([]);
	});
});
