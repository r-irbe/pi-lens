import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { removeTempDirSync } from "../test-utils.js";
import {
	buildILeanModuleGraph,
	findILeanRoot,
	lookupILeanDeclaration,
	lookupGeneratedCDeclaration,
	lookupExternCDeclaration,
	lookupLeanExternForCSymbol,
	lookupItpConceptForLeanDeclaration,
});
