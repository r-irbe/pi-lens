/**
 * lsp_navigation tool definition
 *
 * Extracted from index.ts for maintainability.
 */

import * as nodeFs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Type } from "../clients/deps/typebox.js";
import { logLatency } from "../clients/latency-logger.js";
import {
	newLspMutationCorrelationId,
	recordLspMutationOutcome,
	type LspMutationContext,
} from "../clients/lsp-mutation.js";
import type { LSPCallHierarchyItem } from "../clients/lsp/client.js";
import { uriToPath } from "../clients/path-utils.js";
import { escapeRegExp } from "../clients/string-utils.js";
import { isRecordableProjectPath } from "../clients/file-utils.js";
import { compactRenderResult } from "./render-compact.js";
import {
	applyWorkspaceEdit,
	refuseStaleWorkspaceEdit,
	summarizeWorkspaceEdit,
	workspaceEditTextPaths,
} from "../clients/lsp/edits.js";
import { configDisabledAuxiliaryLspServerIds } from "../clients/dispatch/auxiliary-lsp.js";
import { hashDiagnosticContent } from "../clients/lsp/diagnostic-binding.js";
import {
	getLSPService,
	type LSPWorkspaceScopeAttribution,
} from "../clients/lsp/capabilities.js";
import type { SearchReadLocation } from "../clients/search-read-registration.js";
import { buildLspNavigationEnvelope } from "./lsp-structured-output.js";
import { SYMBOL_KIND_NAMES } from "../clients/lsp-document-symbols.js";
import { resolveLanguageRootForFile } from "../clients/language-profile.js";
import {
	buildILeanModuleGraph,
	lookupILeanDeclaration,
	lookupGeneratedCDeclaration,
	lookupExternCDeclaration,
	lookupLeanExternForCSymbol,
	lookupItpConceptForLeanDeclaration,
							usedDocumentSymbolFallback = true;
						}
					}
				}
				if (
					stillEmpty &&
					(operation === "moduleImports" ||
						operation === "moduleImportedBy") &&
					filePath?.endsWith(".lean")
				) {
					const root = resolveLanguageRootForFile(
						filePath,
						ctx.cwd || ".",
					);
					const graph = buildILeanModuleGraph(root);
					const rel = path
						.relative(root, filePath)
						.replace(/\.lean$/, "")
						.replace(/[/\\]/g, ".");
					if (operation === "moduleImports") {
						const imps = graph.imports.get(rel) ?? [];
						if (imps.length > 0) {
							result = imps.map((name) => ({
								name,
								kind: "module",
							}));
						}
					} else {
						const impBy = graph.importedBy.get(rel) ?? [];
						if (impBy.length > 0) {
							result = impBy.map((name) => ({
								name,
								kind: "module",
							}));
						}
					}
				}
				if (
					stillEmpty &&
					(operation === "moduleImports" || operation === "moduleImportedBy") &&
					filePath?.endsWith(".lean")
				) {
					const root = resolveLanguageRootForFile(filePath, ctx.cwd || ".");
					const graph = buildILeanModuleGraph(root);
					const rel = path
						.relative(root, filePath)
						.replace(/\.lean$/, "")
						.replace(/[/\\]/g, ".");
					if (operation === "moduleImports") {
						const imps = graph.imports.get(rel) ?? [];
						if (imps.length > 0) {
							result = imps.map((name) => ({
								name,
								kind: "module",
							}));
						}
					} else {
						const impBy = graph.importedBy.get(rel) ?? [];
						if (impBy.length > 0) {
							result = impBy.map((name) => ({
								name,
								kind: "module",
							}));
						}
					}
				}
				if (
					stillEmpty &&
					operation === "implementation" &&
					filePath?.endsWith(".lean") &&
					navToken
				) {
					const root = resolveLanguageRootForFile(filePath, ctx.cwd || ".");
					const decls = lookupILeanDeclaration(root, navToken);
					for (const decl of decls) {
						const cLoc = lookupGeneratedCDeclaration(
							root,
							decl.module,
							decl.name,
						);
						if (cLoc) {
							result = [
								{
									uri: pathToFileURL(cLoc.filePath).href,
									range: {
										start: { line: cLoc.line, character: 0 },
										end: {
											line: cLoc.line,
											character: cLoc.symbol.length,
										},
									},
								},
							];
							usedDocumentSymbolFallback = true;
							break;
						}
					}
				}
				if (
					stillEmpty &&
					operation === "definition" &&
					navToken &&
					filePath &&
					/\.(c|h|cpp|hpp|cc)$/i.test(filePath)
				) {
					const root = ctx.cwd || ".";
					const externDecl = lookupLeanExternForCSymbol(root, navToken);
					if (externDecl) {
						result = [externDecl];
						usedDocumentSymbolFallback = true;
					}
				}
				if (
					(stillEmpty || operation === "itpConcept") &&
					(operation === "itpConcept" ||
						(operation === "hover" && filePath?.endsWith(".lean"))) &&
					navToken
				) {
					const root = filePath
						? resolveLanguageRootForFile(filePath, ctx.cwd || ".")
						: ctx.cwd || ".";
					const itpMatches = lookupItpConceptForLeanDeclaration(navToken, root);
					if (itpMatches.length > 0) {
						if (operation === "itpConcept") {
							result = itpMatches;
							usedDocumentSymbolFallback = true;
						}
					}
				}
				if (
					operation === "definition" &&
					filePath?.endsWith(".lean") &&
					result
				) {
					const locations = Array.isArray(result)
						? result
						: typeof result === "object"
							? [result]
							: [];
					for (const loc of locations) {
						if (
							loc &&
							typeof loc === "object" &&
							"uri" in loc &&
							typeof loc.uri === "string"
						) {
							try {
								const targetFile = fileURLToPath(loc.uri);
								if (nodeFs.existsSync(targetFile)) {
									const lines = nodeFs
										.readFileSync(targetFile, "utf8")
										.split("\n");
									const targetLine = loc.range?.start?.line ?? 0;
									const checkRange = lines
										.slice(Math.max(0, targetLine - 2), targetLine + 3)
										.join("\n");
									const externMatch = checkRange.match(
										/@\[extern\s+"([^"]+)"\]/,
									);
									if (externMatch) {
										const cSymbol = externMatch[1];
										const root = resolveLanguageRootForFile(
											filePath,
											ctx.cwd || ".",
										);
										const cMatch = lookupExternCDeclaration(root, cSymbol);
										if (cMatch) {
											const cLoc = {
												uri: pathToFileURL(cMatch.filePath).href,
												range: {
													start: {
														line: cMatch.line,
														character: 0,
													},
													end: {
														line: cMatch.line,
														character: cMatch.symbol.length,
													},
												},
											};
											if (Array.isArray(result)) {
												result.push(cLoc);
											} else {
												result = [result, cLoc];
											}
											break;
										}
									}
								}
							} catch {
								// ignore read error
							}
						}
					}
				}
				if (
					mutationContext &&
					requestedApply &&
					!mutationContext.summaryEmitted
				) {
					const outcome =
						operation === "rename_file" &&
						result &&
						typeof result === "object" &&
						"applied" in result &&
						(result as { applied?: unknown }).applied === false
							? "failed"
							: operation === "executeCommand" &&
								  result &&
								  typeof result === "object" &&
								  "executed" in result &&
								  (result as { executed?: unknown }).executed === false
								? "failed"
								: "skipped";
					recordLspMutationOutcome(mutationContext, outcome);
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (msg.startsWith("__UNSUPPORTED__ ")) {
					return finalize(
						{
							content: [
								{
									type: "text" as const,
									text: msg.replace("__UNSUPPORTED__ ", ""),
								},
							],
							isError: true,
							details: {
								operation,
								supported: false,
								emptyReason: "unsupported",
							},
						},
						{ operation, filePath, failureKind: "unsupported", resultCount: 0 },
					);
				}
				if (msg.startsWith("__BADINPUT__ ")) {
					return finalize(
						{
							content: [
								{
									type: "text" as const,
									text: msg.replace("__BADINPUT__ ", ""),
								},
							],
							isError: true,
							details: {},
						},
						{ operation, filePath, failureKind: "bad_input", resultCount: 0 },
					);
				}
				return finalize(
					{
						content: [
							{
								type: "text" as const,
								text: `LSP error: ${err instanceof Error ? err.message : String(err)}`,
							},
						],
						isError: true,
						details: {},
					},
					{ operation, filePath, failureKind: "lsp_error", resultCount: 0 },
				);
			}

			const isEmpty = !result || (Array.isArray(result) && result.length === 0);
			const fileCtx = filePath ? " at " + path.basename(filePath) : "";
			const lineCtx = line ? ":" + line + ":" + character : "";
			let output = isEmpty
				? "No results for " + operation + fileCtx + lineCtx
				: JSON.stringify(result);
			if (
				!isEmpty &&
				operation === "goal" &&
				typeof result === "object" &&
				result !== null &&
				"rendered" in result
			) {
				const goalObj = result as { rendered?: string };
				if (typeof goalObj.rendered === "string") {
					output = goalObj.rendered;
				}
			} else if (
				!isEmpty &&
				operation === "termGoal" &&
				typeof result === "object" &&
				result !== null &&
				"goal" in result
			) {
				const termGoalObj = result as { goal?: string };
				if (typeof termGoalObj.goal === "string") {
					output = termGoalObj.goal;
				}
			} else if (
				!isEmpty &&
				(operation === "moduleImports" || operation === "moduleImportedBy") &&
				Array.isArray(result)
			) {
				const imports = result as Array<{
					module?: { name?: string; uri?: string };
					kind?: { isPrivate?: boolean; isAll?: boolean; metaKind?: string };
				}>;
				const lines = imports.map((imp) => {
					const name = imp.module?.name ?? "(unknown)";
					const uri = imp.module?.uri ? ` (${imp.module.uri})` : "";
					const meta =
						imp.kind?.metaKind && imp.kind.metaKind !== "nonMeta"
							? ` [${imp.kind.metaKind}]`
							: "";
					return `- ${name}${meta}${uri}`;
				});
				output = lines.length > 0 ? lines.join("\n") : "None";
			}
			if (isEmpty && operation === "workspaceSymbol" && !rawPath) {
				output +=
					"\nHint: provide path to scope workspaceSymbol to the active language server/root.";
			}
			if (usedDocumentSymbolFallback) {
				output +=
					"\nNote: served from documentSymbol fallback due to empty primary result.";
			}
			if (
				operation === "references" &&
				Array.isArray(result) &&
				result.length <= 2
			) {
				output +=
					"\nHint: references from usage sites can be partial; retry from the symbol definition for broader cross-file results.";
			}
			const actionStats =
				operation === "codeAction" && Array.isArray(result)
					? classifyCodeActions(result as Array<{ kind?: string }>)
					: null;
			if (operation === "codeAction" && actionStats) {
				if (actionStats.quickfix === 0 && actionStats.refactor > 0) {
					output +=
						"\nNote: no diagnostic quick fixes returned; refactor-only actions available.";
				}
			}
			if (isEmpty && operation === "goal") {
				output +=
					"\nHint: Goal inspection requires placing the cursor inside an active tactic block (e.g. after 'by', on a tactic line, or before 'sorry'). On headers or non-tactic lines, no goals exist.";
			}
			if (!isEmpty && operation === "goal" && output.includes("✝")) {
				output +=
					"\nNote: Hypotheses marked with '✝' are inaccessible hygienic names generated by Lean. Use 'rename_i' or bind them explicitly to reference them in tactics.";
			}
			if (!isEmpty && operation === "goal" && output.trim() === "no goals") {
				output +=
					" (Proof complete: no remaining open goals at this position).";
			}
			if (!isEmpty && operation === "termGoal") {
				output +=
					"\nHint: This is the expected type that any expression placed at this cursor position must satisfy.";
			}

			const resultCount =
				operation === "goal" &&
				result &&
				typeof result === "object" &&
				"goals" in result &&
				Array.isArray((result as { goals?: unknown[] }).goals) &&
				(result as { goals: unknown[] }).goals.length > 0
					? (result as { goals: unknown[] }).goals.length
					: Array.isArray(result)
						? result.length
						: result
							? 1
							: 0;
			const searchReads = collectSearchReadsForOperation(
				operation,
				result,
				callHierarchyItem,
			);
			return finalize(
				{
					content: [{ type: "text" as const, text: output }],
					details: {
						operation,
						supported,
						searchReads: searchReads.length > 0 ? searchReads : undefined,
						emptyReason: isEmpty
							? emptyReasonForOperation(operation)
							: undefined,
						codeActionKinds: actionStats ?? undefined,
						columnResolution:
							columnResolution?.strategy === "explicit"
								? undefined
								: columnResolution,
						resultCount,
					},
				},
				{
					operation,
					filePath: rawPath ? filePath : "(workspace)",
					failureKind: isEmpty
						? "empty_result"
						: usedDocumentSymbolFallback
							? "fallback_success"
							: "success",
					resultCount,
				},
			);
		},
	};
}
