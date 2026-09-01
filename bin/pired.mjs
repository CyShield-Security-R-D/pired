#!/usr/bin/env node
/**
 * pired launcher — one command for the full experience: pi + the pired extension
 * + the fx-like theme + visible thinking. Everything the security layer needs,
 * with the sleek UI applied.
 *
 * Usage:
 *   pired [--profile review|recon|pentest] [--provider NAME] [--model ID]
 *         [--target DIR] [--thinking off|low|medium|high|max] [--no-theme]
 *         [--no-panel] [--fullscreen] [--prompt "one-shot"] [<pi args>]
 *
 * Any flag pired does not own is forwarded to pi, so `pired -r`, `pired -c` and
 * `pired --session <id>` work directly. `--` still forces passthrough when a
 * value would otherwise look like a flag.
 *
 * Models come from ~/.pired/models.json (pired registers them into pi):
 *   --provider lmstudio  --model qwen3.8-27b            (local)
 *   --provider openrouter --model qwen/qwen3.8-27b      (hosted)
 *
 * This file is the shell: read the world, call the decisions, spawn. Every
 * decision it makes lives in launch.mjs, where a test can reach it.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { argValue, buildPiArgs, findPi, launchPlan } from "./launch.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(ROOT, "extensions", "pired.ts");
// The LLM-host layer: pi's /login gains "Add an LLM host…", and /host manages
// them. A separate extension because it is not the security layer.
const HOSTS_EXT = join(ROOT, "extensions", "hosts.ts");
const THEME = join(ROOT, "themes", "pired.json");
const argv = process.argv.slice(2);

if (!existsSync(EXT)) {
	process.stderr.write(`pired: extension not found at ${EXT}\n`);
	process.exit(1);
}

/** Where npm put pi's package, if it is resolvable from here at all. */
function resolvePiPackage() {
	try {
		const require = createRequire(import.meta.url);
		const pkgPath = require.resolve("@earendil-works/pi-coding-agent/package.json");
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
		const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
		return bin ? { dir: dirname(pkgPath), bin } : undefined;
	} catch {
		// Not resolvable from here (a linked checkout, an unusual layout): the
		// sibling-binary and PATH lookups in findPi take over.
		return undefined;
	}
}

const piBin = findPi({
	env: process.env,
	platform: process.platform,
	root: ROOT,
	argv1: process.argv[1],
	exists: existsSync,
	resolvePackage: resolvePiPackage,
});
const piArgs = buildPiArgs({ exts: [EXT, HOSTS_EXT], theme: THEME, argv, exists: existsSync });

const targetRaw = argValue(argv, "target", ".");
const target = isAbsolute(targetRaw) ? targetRaw : resolve(process.cwd(), targetRaw);

const plan = launchPlan({
	piBin,
	piArgs,
	platform: process.platform,
	execPath: process.execPath,
	comspec: process.env.ComSpec,
});

const child = spawn(plan.command, plan.args, {
	cwd: target,
	stdio: "inherit",
	...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
});
child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
	process.stderr.write(`pired: failed to launch pi at ${piBin} (${err?.message || err}).\n`);
	process.exit(1);
});
