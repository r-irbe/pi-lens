export interface AllowScriptsProblem {
	kind: string;
	subject: string;
	message: string;
	remediation: string;
}
export interface LifecyclePackage {
	name: string;
	version: string;
	paths: string[];
}
export function splitPolicyKey(key: string): {
	name: string;
	version: string | undefined;
};
export function collectLifecyclePackages(lock: unknown): LifecyclePackage[];
export function installPhasesOf(manifest: unknown): string[];
export function checkAllowScriptsPolicy(
	pkg: unknown,
	lock: unknown,
	options?: { readPhases?: (installPath: string) => string[] | undefined },
): AllowScriptsProblem[];
export function formatAllowScriptsProblems(
	problems: AllowScriptsProblem[],
): string;
