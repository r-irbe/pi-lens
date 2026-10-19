/**
 * The known dispatch runner ids (#3968, PR 2): the identity source the
 * `lsp.servers.<id>.covers` validation projects from.
 *
 * THE RUNNERS REGISTRY IS THE IDENTITY SOURCE — there is no second list
 * here. The set is populated by `RunnerRegistry.register`
 * (`clients/dispatch/dispatcher.ts`), the one entrance every runner
 * definition goes through; no caller may hand-write a runner id into this
 * set. `clients/lsp/config.ts` asks `isKnownRunnerId` when it validates a
 * user-declared covers claim, so a member naming a runner the dispatch
 * system does not have is dropped with a visible record instead of
 * silently never matching.
 *
 * This is an IMPORT LEAF on purpose (the `clients/lsp/server-covers.ts`
 * precedent): `clients/lsp/config.ts` must answer "is this a runner id"
 * without importing the dispatcher's graph — the inverse edge already
 * exists (`clients/dispatch/runners/utils/runner-helpers.ts` imports
 * `clients/lsp/config.js`), so importing anything non-leaf from
 * `clients/dispatch/**` in the config loader would close a
 * `no-client-cycles` cycle (dependency-cruiser).
 *
 * FAIL DIRECTION (#48 rule: name the concrete obstruction, then choose).
 * An empty set is NOT "nothing is a runner"; it is "this process has not
 * built a runner registry yet". Concretely: `warmDispatchIntegration` is
 * fire-and-forget at session start (`index.ts`), so the first
 * `loadLSPConfig` can race the registry's population — failing closed
 * there would drop a VALID claim in one session and accept it in the
 * next, nondeterministic config semantics worse than the gap. When
 * `runnerIdentityPopulated()` is false the claim is therefore accepted
 * UNVALIDATED, and the loader discloses that skip through the bounded
 * `lsp-covers-unvalidated` ledger record (`clients/lsp/config.ts`) — never
 * silently. In a process where a runner registry never exists, no runner
 * can act on (or be deferred by) the claim, so an unvalidated acceptance
 * cannot change a verdict.
 */
let knownRunnerIds: Set<string> = new Set();

/** Called by `RunnerRegistry.register` — one runner id, one entrance. */
export function registerRunnerId(id: string): void {
	knownRunnerIds.add(id);
}

/**
 * True once some `RunnerRegistry` has registered at least one runner in
 * this process. Empty means "no registry yet", never "no runners exist".
 */
export function runnerIdentityPopulated(): boolean {
	return knownRunnerIds.size > 0;
}

/** The covers-validation question, answered from the registry's own ids. */
export function isKnownRunnerId(id: string): boolean {
	return knownRunnerIds.has(id);
}

/** Test-only seam: re-open the identity so a fresh registration is observed. */
export function resetRunnerIdentityForTests(): void {
	knownRunnerIds = new Set();
}
