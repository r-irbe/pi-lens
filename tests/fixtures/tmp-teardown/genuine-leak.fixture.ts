// Fixture for tests/support/tmp-root-teardown.test.ts (#2912): the two leaks the
// sweep must NOT hide. A raw root the file never removes is a forgotten cleanup;
// a directory made by `mkdirSync` is in no registry (it stands for a sibling
// worker's live root, which this worker must never delete).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";

it("leaves a raw mkdtemp root and a plain mkdir root behind", () => {
	const raw = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2912-genuine-raw-"));
	const plain = path.join(os.tmpdir(), "pi-lens-2912-genuine-mkdir-sibling");
	fs.mkdirSync(plain, { recursive: true });
	expect([raw, plain].every((dir) => fs.existsSync(dir))).toBe(true);
});
