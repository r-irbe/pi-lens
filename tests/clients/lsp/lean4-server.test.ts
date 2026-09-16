import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	detectFileKind,
	getFileKindLabel,
	getLanguageId,
	KIND_EXTENSIONS,
} from "../../../clients/file-kinds.js";
import { getToolPlan } from "../../../clients/dispatch/plan.js";
import {
	getLspCapableKinds,
	getPrimaryDispatchGroup,
} from "../../../clients/language-policy.js";
import {
	CppServer,
	getServerForExtension,
	Lean4Server,
	LSP_SERVERS,
	resolveLeanFallbackFlags,
} from "../../../clients/lsp/server.js";
import { getStrategy } from "../../../clients/lsp/wait-policy/strategies.js";
import { EXCLUDED_DIRS } from "../../../clients/file-utils.js";
import { isExternalOrVendorFile } from "../../../clients/path-utils.js";
import { isGeneratedOrArtifact } from "../../../clients/generated-artifacts.js";
import {
	detectProjectLanguageProfile,
	rootMarkersForFile,
} from "../../../clients/language-profile.js";
});
