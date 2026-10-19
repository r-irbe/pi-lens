#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SHA = /^[0-9a-f]{40}$/i;
const FULL_VERSION = /^v?\d+\.\d+\.\d+$/;
const PREFIX_VERSION = /^v?\d+(?:\.\d+)?$/;
const USES = /^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#\s*(\S+))?/;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function parseActionPins(text, file = "<fixture>") {
	const pins = [];
	for (const [index, line] of text.split(/\r?\n/).entries()) {
		const match = line.match(USES);
		if (!match) continue;
		const at = match[1].lastIndexOf("@");
		if (at < 1) continue;
		const ref = match[1].slice(at + 1);
		if (!SHA.test(ref)) continue;
		const action = match[1].slice(0, at);
		const comment = match[2]?.trim() ?? "";
		pins.push({
			action,
			sha: ref.toLowerCase(),
			tag: comment,
			file,
			line: index + 1,
		});
	}
	return pins;
}

export function validatePins(pins, resolveTag, exemptions = {}) {
	return Promise.all(
		pins.map(async (pin) => {
			const key = `${pin.action}@${pin.sha}#${pin.tag}`;
			const location = `${pin.file}:${pin.line}`;
			if (exemptions[key]) return null;
			if (!pin.tag)
				return `${location}: ${pin.action}@${pin.sha} has no version comment`;
			let resolved;
			try {
				if (FULL_VERSION.test(pin.tag)) {
					resolved = await resolveTag(pin.action, pin.tag);
					if (!resolved || !SHA.test(resolved))
						throw new Error("GitHub API response has no commit SHA");
					resolved = resolved.toLowerCase();
				} else if (PREFIX_VERSION.test(pin.tag)) {
					const matches = await resolveTag(pin.action, pin.tag);
					if (!Array.isArray(matches))
						throw new Error("GitHub API response has no matching release tags");
					const matching = matches.filter(
						(match) => match.sha.toLowerCase() === pin.sha,
					);
					if (matching.length) return null;
					const nearest =
						matches.map((match) => match.tag).join(", ") || "none";
					return `${location}: ${pin.action}@${pin.sha} is not a ${pin.tag} release; nearest tags: ${nearest}`;
				} else {
					throw new Error(`unsupported version comment ${pin.tag}`);
				}
			} catch (error) {
				return `${location}: cannot resolve ${pin.action} tag ${pin.tag}: ${error.message}`;
			}
			return resolved === pin.sha
				? null
				: `${location}: ${pin.action} # ${pin.tag} resolves to ${resolved}, not ${pin.sha}`;
		}),
	).then((results) => results.filter(Boolean));
}

export async function workflowFiles(root = ROOT) {
	const found = [];
	async function walk(directory) {
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch (error) {
			if (error.code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (
				entry.name.endsWith(".yml") ||
				entry.name.endsWith(".yaml") ||
				entry.name === "action.yml"
			)
				found.push(path);
		}
	}
	await walk(join(root, ".github", "workflows"));
	await walk(join(root, ".github", "actions"));
	return found.sort();
}

export async function resolveGithubTag(
	action,
	tag,
	fetchImpl = fetch,
	env = process.env,
) {
	const [owner, repo] = action.split("/");
	if (!owner || !repo) throw new Error(`invalid action ${action}`);
	const base = env.GITHUB_API_URL || "https://api.github.com";
	const headers = { Accept: "application/vnd.github+json" };
	const token = env.GITHUB_TOKEN || env.GH_TOKEN;
	if (token) headers.Authorization = `Bearer ${token}`;
	const refUrl = `${base.replace(/\/$/, "")}/repos/${owner}/${repo}/git/ref/tags/${encodeURIComponent(tag)}`;
	const response = await fetchImpl(refUrl, { headers });
	if (!response.ok) throw new Error(`GitHub API ${response.status}`);
	const ref = await response.json();
	if (ref.object?.type !== "tag") return ref.object?.sha;
	const tagResponse = await fetchImpl(
		`${base.replace(/\/$/, "")}/repos/${owner}/${repo}/git/tags/${ref.object.sha}`,
		{ headers },
	);
	if (!tagResponse.ok) throw new Error(`GitHub API ${tagResponse.status}`);
	return (await tagResponse.json()).object?.sha;
}

export async function resolveGithubMatchingTags(
	action,
	prefix,
	fetchImpl = fetch,
	env = process.env,
) {
	const [owner, repo] = action.split("/");
	if (!owner || !repo) throw new Error(`invalid action ${action}`);
	const base = env.GITHUB_API_URL || "https://api.github.com";
	const headers = { Accept: "application/vnd.github+json" };
	const token = env.GITHUB_TOKEN || env.GH_TOKEN;
	if (token) headers.Authorization = `Bearer ${token}`;
	const url = `${base.replace(/\/$/, "")}/repos/${owner}/${repo}/git/matching-refs/tags/${encodeURIComponent(prefix + ".")}`;
	const response = await fetchImpl(url, { headers });
	if (!response.ok) throw new Error(`GitHub API ${response.status}`);
	const refs = await response.json();
	if (!Array.isArray(refs))
		throw new Error("GitHub API response is not a ref list");
	return Promise.all(
		refs
			.filter((ref) => ref.ref?.startsWith(`refs/tags/${prefix}.`))
			.map(async (ref) => ({
				tag: ref.ref.slice("refs/tags/".length),
				sha:
					ref.object?.type === "tag"
						? await resolveGithubTagObject(
								action,
								ref.object.sha,
								fetchImpl,
								env,
							)
						: ref.object?.sha,
			})),
	).then((tags) => {
		if (tags.some((tag) => !SHA.test(tag.sha || "")))
			throw new Error("GitHub API response has a ref without a commit SHA");
		return tags.map((tag) => ({ ...tag, sha: tag.sha.toLowerCase() }));
	});
}

async function resolveGithubTagObject(action, objectSha, fetchImpl, env) {
	const [owner, repo] = action.split("/");
	const base = env.GITHUB_API_URL || "https://api.github.com";
	const headers = { Accept: "application/vnd.github+json" };
	const token = env.GITHUB_TOKEN || env.GH_TOKEN;
	if (token) headers.Authorization = `Bearer ${token}`;
	const response = await fetchImpl(
		`${base.replace(/\/$/, "")}/repos/${owner}/${repo}/git/tags/${objectSha}`,
		{ headers },
	);
	if (!response.ok) throw new Error(`GitHub API ${response.status}`);
	return (await response.json()).object?.sha;
}

export async function checkActionPins({
	root = ROOT,
	fetchImpl = fetch,
	env = process.env,
} = {}) {
	let exemptions = {};
	const exemptionsFile = join(
		root,
		"scripts",
		"check-action-pins-exemptions.json",
	);
	try {
		const entries = JSON.parse(await readFile(exemptionsFile, "utf8"));
		for (const entry of entries) {
			if (
				!entry.action ||
				!entry.sha ||
				entry.tag === undefined ||
				!entry.reason
			)
				throw new Error("invalid action pin exemption");
			exemptions[`${entry.action}@${entry.sha.toLowerCase()}#${entry.tag}`] =
				entry.reason;
		}
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	const files = await workflowFiles(root);
	const pins = (
		await Promise.all(
			files.map(async (file) =>
				parseActionPins(await readFile(file, "utf8"), relative(root, file)),
			),
		)
	).flat();
	const resolved = new Map();
	return validatePins(
		pins,
		async (action, tag) => {
			const key = `${action}@${tag}`;
			if (!resolved.has(key))
				resolved.set(
					key,
					FULL_VERSION.test(tag)
						? resolveGithubTag(action, tag, fetchImpl, env)
						: resolveGithubMatchingTags(action, tag, fetchImpl, env),
				);
			return resolved.get(key);
		},
		exemptions,
	);
}

export async function main() {
	const errors = await checkActionPins();
	if (errors.length) {
		console.error(errors.join("\n"));
		process.exitCode = 1;
	} else {
		console.log("All pinned GitHub Actions match their version comments.");
	}
}

if (
	process.argv[1] &&
	pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
	await main();
