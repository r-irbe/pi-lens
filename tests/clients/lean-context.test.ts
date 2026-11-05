import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	areServedRootPinDigestsCurrent,
	captureLeanCompilerIdentity,
	captureServedRootPinDigests,
	getILeanScanInvalidationStamp,
	invalidateILeanScans,
	isLeanCompilerIdentityCurrent,
	leanContextEnv,
	validateLeanContext,
} from "../../clients/lean-context.js";

const dirs: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const dir of dirs.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
});

it("validates only existing exact compiler context and canonical search-path-safe module directories", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lean-context-"));
	dirs.push(root);
	const compilerPath = path.join(root, "lean");
	fs.writeFileSync(compilerPath, "fixture", { mode: 0o755 });
	const context = {
		compilerPath,
		targetVersion: "4.36.0-rc1",
		moduleRoots: [root],
	};
	expect(validateLeanContext(context)).toEqual(context);
	const invalidRoot = path.join(root, `with${path.delimiter}delimiter`);
	fs.mkdirSync(invalidRoot);
	const alias = path.join(root, "alias");
	fs.symlinkSync(invalidRoot, alias, "dir");
	for (const input of [
		null,
		[],
		42,
		{ ...context, command: "sh" },
		{ ...context, env: {} },
		{ ...context, compilerPath: "lean" },
		{ ...context, compilerPath: path.join(root, "missing", "lean") },
		{ ...context, compilerPath: path.join(root, "sh") },
		{ ...context, targetVersion: "latest" },
		{ ...context, targetVersion: "4.35.0; bad" },
		{ ...context, moduleRoots: ["relative"] },
		{ ...context, moduleRoots: [compilerPath] },
		{ ...context, moduleRoots: [invalidRoot] },
		{ ...context, moduleRoots: [alias] },
		{ ...context, moduleRoots: Array(33).fill(root) },
	])
		expect(() => validateLeanContext(input)).toThrow(
			/environment_unavailable.*leanContext/,
		);
});

it("replaces ambient Lean paths without mutating the parent environment or reintroducing selection variables", () => {
	vi.stubEnv("LEAN_PATH", "/foreign/modules");
	vi.stubEnv("LEAN_SYSROOT", "/foreign/sysroot");
	vi.stubEnv("LEAN_SRC_PATH", "/foreign/source");
	vi.stubEnv("ELAN_TOOLCHAIN", "foreign");
	const context = {
		compilerPath: "/admitted/bin/lean",
		targetVersion: "4.35.0",
		moduleRoots: ["/admitted/modules"],
	};
	const env = leanContextEnv(context);
	expect(env.LEAN_PATH).toBe("/admitted/modules");
	for (const key of ["LEAN_SYSROOT", "LEAN_SRC_PATH", "ELAN_TOOLCHAIN"]) {
		expect(Object.hasOwn(env, key)).toBe(true);
		expect(env[key]).toBeUndefined();
	}
	expect(leanContextEnv({ ...context, moduleRoots: [] }).LEAN_PATH).toBe("");
	expect(process.env.LEAN_PATH).toBe("/foreign/modules");
});

it("captures compiler binary identity and detects in-place mutation or symlink replacement", () => {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-lean-compiler-id-"),
	);
	dirs.push(root);
	const compilerPath = path.join(root, "lean");
	fs.writeFileSync(compilerPath, "#!/bin/sh\necho v1\n", { mode: 0o755 });

	const identity = captureLeanCompilerIdentity(compilerPath);
	expect(identity).toBeDefined();
	expect(isLeanCompilerIdentityCurrent(identity)).toBe(true);

	// Mutate binary size/content
	fs.writeFileSync(compilerPath, "#!/bin/sh\necho v2-longer\n", {
		mode: 0o755,
	});
	expect(isLeanCompilerIdentityCurrent(identity)).toBe(false);

	// Symlink compiler is rejected
	const targetBin = path.join(root, "real-lean");
	fs.writeFileSync(targetBin, "#!/bin/sh\n", { mode: 0o755 });
	fs.unlinkSync(compilerPath);
	fs.symlinkSync(targetBin, compilerPath);
	expect(captureLeanCompilerIdentity(compilerPath)).toBeUndefined();
});

it("captures served-root pin digests and detects creation, mutation, deletion, or symlink escape", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lean-pins-"));
	dirs.push(root);
	const toolchainPath = path.join(root, "lean-toolchain");
	fs.writeFileSync(toolchainPath, "leanprover/lean4:v4.29.0-rc8\n", "utf8");

	const initial = captureServedRootPinDigests(root);
	expect(initial).toBeDefined();
	expect(areServedRootPinDigestsCurrent(root, initial)).toBe(true);

	// Creating lake-manifest.json invalidates currency
	const manifestPath = path.join(root, "lake-manifest.json");
	fs.writeFileSync(manifestPath, '{"version": 7}\n', "utf8");
	expect(areServedRootPinDigestsCurrent(root, initial)).toBe(false);

	const withManifest = captureServedRootPinDigests(root);
	expect(areServedRootPinDigestsCurrent(root, withManifest)).toBe(true);

	// Mutating lean-toolchain invalidates currency
	fs.writeFileSync(toolchainPath, "leanprover/lean4:v4.30.0\n", "utf8");
	expect(areServedRootPinDigestsCurrent(root, withManifest)).toBe(false);

	// Replacing lean-toolchain with a symlink invalidates digest capture
	const outside = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-lean-outside-"),
	);
	dirs.push(outside);
	const outsidePin = path.join(outside, "lean-toolchain");
	fs.writeFileSync(outsidePin, "leanprover/lean4:v4.30.0\n", "utf8");
	fs.unlinkSync(toolchainPath);
	fs.symlinkSync(outsidePin, toolchainPath);
	expect(captureServedRootPinDigests(root)).toBeUndefined();
});

it("advances invalidation stamp when invalidateILeanScans is called", () => {
	const before = getILeanScanInvalidationStamp();
	invalidateILeanScans("scope-1");
	const after = getILeanScanInvalidationStamp();
	expect(after).toBeGreaterThan(before);
});
