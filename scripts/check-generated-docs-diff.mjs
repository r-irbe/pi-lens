import { appendFileSync, readFileSync } from "node:fs";
import { compareGeneratedDocs, GENERATED_LSP_DOCS } from "./lib/md-matrix.mjs";
import { gitExecFileSync } from "./lib/git-fixture-env.mjs";

const changed = GENERATED_LSP_DOCS.some((file) => {
	const previous = gitExecFileSync(["show", `HEAD:${file}`], {
		encoding: "utf8",
	});
	return compareGeneratedDocs(previous, readFileSync(file, "utf8"));
});

const output = process.env.GITHUB_OUTPUT;
if (output) {
	appendFileSync(output, `changed=${changed}\n`);
}
console.log(
	changed
		? "LSP docs contain a substantive change; refresh PR is eligible."
		: "LSP docs changed only in the generation date (or not at all); skipping refresh PR.",
);
