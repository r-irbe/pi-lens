// Type declarations for probe-fixture.mjs (untyped .mjs imported from .ts tests).

export interface ProbeRow {
	lang: string;
	server?: string;
	serverId?: string;
	behavior: string;
	tier: number;
	tierLabel: string;
	mode: string;
	detail: string;
	firstPublish: string;
	cleanFixture: boolean;
}

export function createProbeFixture(deps: {
	lsp: {
		supportsLSP(file: string): boolean;
		touchFile(file: string, content: string, options: object): Promise<unknown>;
		getWorkspaceDiagnosticsSupport(file: string): Promise<{ mode?: string }>;
	};
	repoRoot: string;
	install: boolean;
	ensureTool?: (tool: string) => Promise<unknown>;
	initLSPConfig: unknown;
	getServersForFileWithConfig(
		file: string,
	): ReadonlyArray<{ id: string; role?: string }>;
	bootstrapFixtureWorkspace(
		fx: unknown,
		options: { initLSPConfig: unknown; repoRoot: string; workspace: string },
	): Promise<{ absFile: string }>;
	drainPublishTrace: {
		(sink: Array<{ server?: string }>, serverId: string): void;
		reset(offset: number): void;
	};
	pubLogSize(): number;
	sleep(ms: number): Promise<void>;
}): (
	fx: {
		lang: string;
		file: string;
		serverHint?: string;
		clean?: boolean;
		tools?: string[];
		auxiliaryServerIds?: readonly string[];
	},
	dst: string,
	row: ProbeRow,
) => Promise<void>;
