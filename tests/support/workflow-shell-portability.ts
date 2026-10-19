export const BASH4_NEEDLES = [
	{ name: "mapfile", bashVersion: "4.0" },
	{ name: "readarray", bashVersion: "4.0" },
	{ name: "${var,,}", bashVersion: "4.0" },
	{ name: "${var^^}", bashVersion: "4.0" },
	{ name: "declare -A", bashVersion: "4.0" },
	{ name: "|&", bashVersion: "4.0" },
	{ name: ";;&", bashVersion: "4.0" },
] as const;

export type Workflow = {
	on?: {
		workflow_call?: {
			inputs?: Record<string, { default?: unknown; options?: unknown }>;
		};
	};
	jobs?: Record<
		string,
		{
			"runs-on"?: unknown;
			strategy?: { matrix?: Record<string, unknown> };
			steps?: Array<{
				name?: unknown;
				run?: unknown;
				shell?: unknown;
				if?: unknown;
			}>;
		}
	>;
};

export type WorkflowFinding = {
	workflow: string;
	job: string;
	step: string;
	needle: string;
};

export function findBash4PortabilityFindings(
	workflow: Workflow,
	workflowName: string,
	callerInputs: Record<string, unknown> = {},
): WorkflowFinding[] {
	const findings: WorkflowFinding[] = [];
	for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
		if (!canRunOnMacOS(workflow, job, callerInputs)) continue;
		for (const step of job.steps ?? []) {
			if (
				typeof step.run !== "string" ||
				!isBashStep(step) ||
				excludesMacOS(step.if)
			)
				continue;
			const code = lexShell(step.run);
			for (const needle of BASH4_NEEDLES) {
				if (needlePattern(needle.name).test(code))
					findings.push({
						workflow: workflowName,
						job: jobName,
						step: typeof step.name === "string" ? step.name : "(unnamed)",
						needle: needle.name,
					});
			}
		}
	}
	return findings;
}

function isMacOS(value: unknown): boolean {
	return typeof value === "string" && value.startsWith("macos-");
}

function containsMacOS(value: unknown): boolean {
	if (isMacOS(value)) return true;
	if (Array.isArray(value)) return value.some(containsMacOS);
	if (value && typeof value === "object")
		return Object.values(value).some(containsMacOS);
	return false;
}

function canRunOnMacOS(
	workflow: Workflow,
	job: NonNullable<Workflow["jobs"]>[string],
	callerInputs: Record<string, unknown>,
): boolean {
	const runsOn = job["runs-on"];
	if (isMacOS(runsOn)) return true;
	if (typeof runsOn !== "string") return false;
	const matrixName = runsOn.match(/\bmatrix\.([A-Za-z_][\w-]*)\b/)?.[1];
	const matrix = job.strategy?.matrix;
	if (matrixName && containsMacOS(matrix?.[matrixName])) return true;
	if (
		matrixName &&
		Array.isArray(matrix?.include) &&
		(matrix.include as unknown[]).some(
			(entry) =>
				entry &&
				typeof entry === "object" &&
				containsMacOS((entry as Record<string, unknown>)[matrixName]),
		)
	)
		return true;
	const inputNames = [...runsOn.matchAll(/\binputs\.([A-Za-z_][\w-]*)\b/g)].map(
		(match) => match[1],
	);
	const inputs = workflow.on?.workflow_call?.inputs ?? {};
	return inputNames.some((name) => {
		const input = inputs[name];
		return (
			containsMacOS(callerInputs[name]) ||
			containsMacOS(input) ||
			(input !== undefined &&
				input.default === undefined &&
				input.options === undefined)
		);
	});
}

function excludesMacOS(value: unknown): boolean {
	return (
		typeof value === "string" &&
		/^(?:runner\.os\s*!=\s*['"]macOS['"]|matrix\.os\s*!=\s*['"]macos-latest['"])$/.test(
			value.trim(),
		)
	);
}

function isBashStep(step: { shell?: unknown }): boolean {
	if (step.shell === undefined) return true;
	return typeof step.shell === "string" && /^bash(?:\s|$)/.test(step.shell);
}

function needlePattern(needle: string): RegExp {
	if (needle === "${var,,}") return /\$\{[A-Za-z_][\w]*,,?[^}]*\}/;
	if (needle === "${var^^}") return /\$\{[A-Za-z_][\w]*\^\^?[^}]*\}/;
	if (needle === "declare -A")
		return /(?:^|[;\n]|&&|\|\|?|\||\$\()\s*declare\s+-A\b/;
	if (needle === "mapfile" || needle === "readarray")
		return new RegExp(`(?:^|[;\\n]|&&|\\|\\|?|\\||\\$\\()\\s*${needle}\\b`);
	if (needle === "|&") return /\|&/;
	if (needle === ";;&") return /;;&/;
	return new RegExp(`\\b${needle}\\b`);
}

/**
 * Lex executable shell text. Single-quoted prose and quoted heredocs are
 * opaque. Exported for the #2940 pinned-npm gate, which needs the same
 * "comments and string bodies are not commands" lexing over the release
 * workflow's runs. Line continuations are joined; `lexShellAligned` is the
 * same lexing without the join, so its offsets are the source's.
 */
export function lexShell(source: string): string {
	return lexShellAligned(source).replace(/\\\r?\n[ \t]*/g, "");
}

/**
 * `lexShell` with every character kept in place: blanked characters become
 * spaces and newlines stay, so an offset into the result is an offset into
 * `source` (#4339). A backslash escapes the next character outside single
 * quotes, so `it\'s`, `"a \" b"` and `$'a\'b'` do not open or close a string;
 * the escaped character is literal data and is blanked. A comment ends at its
 * newline even when it ends in a backslash, as in bash.
 */
export function lexShellAligned(source: string): string {
	const chars = source.split("");
	let quote: "'" | '"' | "$'" | undefined;
	let comment = false;
	let quotedHeredoc: string | undefined;
	let heredocPending: string | undefined;
	let lineStart = true;
	for (let index = 0; index < chars.length; index++) {
		const char = chars[index];
		if (quotedHeredoc !== undefined) {
			const line = chars
				.slice(index)
				.join("")
				.match(/^([^\n]*)(?:\n|$)/)?.[1];
			if (lineStart && line?.replace(/^\t+/, "") === quotedHeredoc)
				quotedHeredoc = undefined;
			else if (char !== "\n") chars[index] = " ";
			lineStart = char === "\n";
			continue;
		}
		if (char === "\n") {
			comment = false;
			quote = undefined;
			lineStart = true;
			if (heredocPending !== undefined) {
				quotedHeredoc = heredocPending;
				heredocPending = undefined;
			}
			continue;
		}
		lineStart = false;
		if (comment) {
			chars[index] = " ";
			continue;
		}
		if (quote === "'" || quote === "$'") {
			chars[index] = " ";
			if (quote === "$'" && char === "\\" && !isLineEnd(chars[index + 1]))
				chars[++index] = " ";
			else if (char === "'") quote = undefined;
			continue;
		}
		if (quote === '"') {
			if (char === '"') {
				quote = undefined;
				chars[index] = " ";
			} else if (char === "\\") {
				chars[index] = " ";
				if (!isLineEnd(chars[index + 1])) chars[++index] = " ";
			} else if (char === "$" && chars[index + 1] === "{")
				index = preserveExpansion(chars, index);
			else if (char === "$" && chars[index + 1] === "(")
				index = preserveCommandSubstitution(chars, index);
			else chars[index] = " ";
			continue;
		}
		if (char === "\\") {
			if (!isLineEnd(chars[index + 1])) chars[++index] = " ";
		} else if (
			char === "#" &&
			(index === 0 || /[\s;]/.test(source[index - 1]))
		) {
			comment = true;
			chars[index] = " ";
		} else if (char === "$" && chars[index + 1] === "'") {
			quote = "$'";
			chars[index] = " ";
			chars[++index] = " ";
		} else if (char === "'" || char === '"') {
			quote = char;
			chars[index] = " ";
		} else if (char === "<" && chars[index + 1] === "<") {
			const match = source
				.slice(index + 2)
				.match(/^[-\t ]*(?:(['"])([^'"\s]+)\1|\\([^\s]+)|([^\s]+))/);
			if (match && (match[1] || match[3]))
				heredocPending = match[2] ?? match[3];
		}
	}
	return chars.join("");
}

/**
 * The one right-hand side that binds a variable to the exact npm pin: the
 * `packageManager` read every pinned workflow step makes (#2940, #4339).
 */
const NPM_PIN_SOURCE = `"$(node -p "require('./package.json').packageManager.replace(/^npm@/, '')")"`;

/**
 * Whether `variable` holds the exact npm pin at `offset` of one `run:` script.
 * Each step is its own shell, so the bind is per script (#4339 review F1). The
 * last assignment to `variable` before `offset` in the lexed script must be a
 * whole statement, `<variable>=` at command position, then exactly
 * `NPM_PIN_SOURCE`, then the end of the statement. So a comment or string
 * that mentions `packageManager`, a later `<variable>=latest`, an `echo`
 * argument, and a prefix that only sets the variable for one command all
 * leave it unbound (review F2). Control flow and subshells are not modelled.
 */
export function npmPinBoundAt(
	run: string,
	variable: string,
	offset: number,
): boolean {
	const lexed = lexShellAligned(run);
	const assignments = [
		...lexed
			.slice(0, offset)
			.matchAll(new RegExp(`(?<![\\w$])${variable}\\+?=`, "g")),
	];
	const last = assignments.at(-1)?.index;
	if (last === undefined) return false;
	const value = last + variable.length + 1;
	return (
		/(?:^|\n|;|&&|\|\|)[ \t]*$/.test(lexed.slice(0, last)) &&
		run.startsWith(NPM_PIN_SOURCE, value) &&
		/^[ \t]*(?:$|\n|;|&&|\|\|)/.test(lexed.slice(value + NPM_PIN_SOURCE.length))
	);
}

function isLineEnd(char: string | undefined): boolean {
	return char === undefined || char === "\n" || char === "\r";
}

function preserveCommandSubstitution(chars: string[], start: number): number {
	let quote: "'" | '"' | "$'" | undefined;
	let comment = false;
	let depth = 1;
	let end = start + 1;
	for (; end < chars.length; end++) {
		const char = chars[end];
		const next = chars[end + 1];
		if (comment) {
			if (char === "\n") comment = false;
			continue;
		}
		if (quote === "'" || quote === "$'") {
			if (quote === "$'" && char === "\\") end++;
			else if (char === "'") quote = undefined;
			continue;
		}
		if (quote === '"') {
			if (char === "$" && next === "(") {
				depth++;
				end++;
			} else if (char === "\\") end++;
			else if (char === '"') quote = undefined;
			continue;
		}
		if (char === "\\") {
			end++;
			continue;
		}
		if (char === "#" && (end === 0 || /[\s;]/.test(chars[end - 1]))) {
			comment = true;
			continue;
		}
		if (char === "$" && next === "'") {
			quote = "$'";
			end++;
		} else if (char === "'") quote = char;
		else if (char === '"') quote = char;
		else if (char === "$" && next === "(") {
			depth++;
			end++;
		} else if (char === ")" && --depth === 0) {
			// Aligned, so the lexed body fills exactly the span it replaces.
			const lexed = lexShellAligned(chars.slice(start + 2, end).join(""));
			for (let offset = 0; offset < lexed.length; offset++)
				chars[start + 2 + offset] = lexed[offset];
			return end;
		}
	}
	return chars.length - 1;
}

function preserveExpansion(chars: string[], start: number): number {
	let depth = 0;
	for (let index = start; index < chars.length; index++) {
		if (chars[index] === "{") depth++;
		if (chars[index] === "}" && --depth === 0) return index;
	}
	return chars.length - 1;
}
