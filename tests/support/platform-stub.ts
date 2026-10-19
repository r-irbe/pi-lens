/**
 * Force `process.platform` for a test. Only code that reads the platform live
 * (not into a module-load-time const) observes it. The one home for this stub:
 * eight suites had each hand-rolled the same `Object.defineProperty(process,
 * "platform", ...)` pair (#1506 net-count fold).
 */
export function setPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", {
		value: platform,
		configurable: true,
	});
}

/** Run `body` under `platform`, restoring the real one even if it throws. */
export function withPlatform<T>(platform: NodeJS.Platform, body: () => T): T {
	const original = process.platform;
	setPlatform(platform);
	try {
		return body();
	} finally {
		setPlatform(original);
	}
}
