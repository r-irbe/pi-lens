import { createHash } from "node:crypto";

/**
 * Pin-and-restore for `ArchiveSpec.sha256` in installer tests (#3400).
 *
 * A registry archive is refused unless its bytes hash to the pinned sha256, and
 * installer tests serve stand-in bytes for REAL registry entries. The test pins
 * the bytes it serves for its own duration, so the extraction, verification and
 * swap steps it targets are still reached; whether the install is then
 * accepted or refused is still the production check's verdict, not the
 * fixture's. One helper (was three copies: the integration, refresh-strategy
 * and manifest tests) so the restore cannot be forgotten in one of them.
 *
 * `installer` is passed in rather than imported: each test file un-mocks the
 * real installer itself, after hoisting its own `PI_LENS_HOME`.
 */
interface ArchiveSpecLike {
	sha256?: Record<string, string>;
}

interface InstallerLike {
	TOOLS: ReadonlyArray<{ id: string; archive?: ArchiveSpecLike }>;
	resolveArchiveUrl: (
		spec: never,
		platform?: string,
		arch?: string,
	) => string | undefined;
}

export interface ArchivePinScope {
	/**
	 * Pin `toolId`'s resolved archive URL to the sha256 of `body`; `null` pins
	 * nothing (the URL is unpinned). Returns the URL.
	 */
	pin(
		toolId: string,
		body: Buffer | string | null,
		target?: { platform?: string; arch?: string },
	): string;
	/** Put every touched spec's pins back. Call from `afterEach`. */
	restoreAll(): void;
}

export function createArchivePinScope(
	installer: InstallerLike,
): ArchivePinScope {
	const restores: Array<() => void> = [];
	return {
		pin(toolId, body, target) {
			const spec = installer.TOOLS.find((t) => t.id === toolId)?.archive;
			if (!spec) throw new Error(`no archive spec for ${toolId}`);
			const url = installer.resolveArchiveUrl(
				spec as never,
				target?.platform,
				target?.arch,
			);
			if (!url) throw new Error(`${toolId} resolves no archive URL`);
			const before = spec.sha256;
			spec.sha256 =
				body === null
					? {}
					: { [url]: createHash("sha256").update(body).digest("hex") };
			restores.push(() => {
				spec.sha256 = before;
			});
			return url;
		},
		restoreAll() {
			for (const restore of restores.splice(0).reverse()) restore();
		},
	};
}
