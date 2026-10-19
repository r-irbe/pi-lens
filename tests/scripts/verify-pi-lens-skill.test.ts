/**
 * #4359: the verify-pi-lens skill is the one home of the real-path probes that
 * each #4344 review round rebuilt and lost with its worktree. Recurrence this
 * guard prevents: a scenario or variant renamed or removed while its feature
 * recipe, the skill body or a contract still points at it, so the next
 * reviewer follows a dangling recipe. Static reads only; the live run is the
 * skill's own `verify.mjs drive`.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..", "..");
const skill = path.join(repoRoot, ".claude/skills/verify-pi-lens");
const read = (p: string) => fs.readFileSync(p, "utf8");
// The map in SKILL.md is the inventory: one row per feature file and scenario.
// Reading it (not walking the directories) keeps this test out of the tree-
// scanner census; a row naming a missing file reds below.
const rows = [
	...read(path.join(skill, "SKILL.md")).matchAll(
		/^\| `features\/([\w-]+\.md)` \| `([\w-]+)` /gm,
	),
];
const features = rows.map((m) => m[1]);
const scenarios = rows.map((m) => `${m[2]}.mjs`);

describe("verify-pi-lens skill (#4359)", () => {
	it("is named after its directory and carries a description", () => {
		const head = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(
			read(path.join(skill, "SKILL.md")),
		);
		expect(head?.[1]).toBe("verify-pi-lens");
		expect(head?.[2].length).toBeGreaterThan(40);
	});

	it("ships its helpers executable and names each in the body", () => {
		const body = read(path.join(skill, "SKILL.md"));
		for (const helper of [
			"env.sh",
			"setup.sh",
			"pyrefly-tee.sh",
			"verify.mjs",
		]) {
			const file = path.join(skill, "scripts", helper);
			expect(fs.statSync(file).mode & 0o111, helper).not.toBe(0);
			expect(body, helper).toContain(helper);
		}
	});

	it("gives every feature file the four sections and a row in the map", () => {
		const body = read(path.join(skill, "SKILL.md"));
		expect(features.length).toBeGreaterThanOrEqual(4);
		expect(scenarios.length).toBe(features.length);
		for (const file of features) {
			const text = read(path.join(skill, "features", file));
			expect(body, file).toContain(`features/${file}`);
			for (const h2 of [
				/^## Sub-features$/m,
				/^## How to get to it \(user POV\)$/m,
				/^## Driving it with .+$/m,
				/^## Gotchas$/m,
			]) {
				expect(text, `${file} ${h2}`).toMatch(h2);
			}
		}
	});

	it("keeps each feature recipe and its scenario's variants in step, both ways", async () => {
		const body = read(path.join(skill, "SKILL.md"));
		for (const [, feature, name] of rows) {
			const docs = read(path.join(skill, "features", feature));
			const file = `${name}.mjs`;
			const mod = (await import(
				pathToFileURL(path.join(skill, "scripts/scenarios", file)).href
			)) as { variants: string[]; setup: unknown; run: unknown };
			expect(typeof mod.setup, name).toBe("function");
			expect(typeof mod.run, name).toBe("function");
			expect(docs, name).toContain(`scripts/scenarios/${file}`);
			for (const variant of mod.variants) {
				expect(docs, `${name}/${variant}`).toContain(`\`${variant}\``);
				expect(body, `${name}/${variant}`).toContain(`\`${variant}\``);
			}
			// The reverse direction: a recipe ("**Goal, `variant`:**") for a variant
			// the module no longer exports is a dangling recipe (#4366 F3).
			const recipes = [...docs.matchAll(/\*\*Goal, `([\w-]+)`/g)].map(
				(m) => m[1],
			);
			expect(recipes.length, `${name} recipes`).toBeGreaterThan(0);
			for (const variant of recipes) {
				expect(mod.variants, `${feature} recipe ${variant}`).toContain(variant);
			}
		}
	});

	it("is pointed at by the reviewer and fixer contracts", () => {
		for (const doc of ["pi-lens-reviewer.md", "pi-lens-fixer.md"]) {
			expect(read(path.join(repoRoot, "docs", doc)), doc).toContain(
				".claude/skills/verify-pi-lens/SKILL.md",
			);
		}
	});
});
