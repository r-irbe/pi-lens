import type { ChildProcessWithoutNullStreams } from "node:child_process";

export type McpFrameDirection = "send" | "recv" | "stderr";

export interface McpStdioClientOptions {
	args?: string[];
	onFrame?: (dir: McpFrameDirection, text: string) => void;
}

export interface McpResponse {
	jsonrpc?: "2.0";
	id?: number;
	result?: {
		content?: Array<{ type?: string; text?: string }>;
		isError?: boolean;
		[key: string]: unknown;
	};
	error?: { message: string; [key: string]: unknown };
}

export class McpStdioClient {
	constructor(
		serverJs: string,
		cwd: string,
		env: NodeJS.ProcessEnv,
		options?: McpStdioClientOptions,
	);
	readonly child: ChildProcessWithoutNullStreams;
	readonly stderr: string[];
	readonly exited: Promise<number | null>;
	request(
		method: string,
		params?: unknown,
		timeoutMs?: number,
	): Promise<McpResponse>;
	notify(method: string, params?: unknown): void;
	callToolText(
		name: string,
		args: Record<string, unknown>,
		timeoutMs?: number,
	): Promise<{ ok: boolean; text: string }>;
	close(): Promise<void>;
}
