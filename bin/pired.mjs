#!/usr/bin/env node
/**
 * pired launcher — one command for the full experience: pi + the pired extension
 * + the fx-like theme + visible thinking. Everything the security layer needs,
 * with the sleek UI applied.
 *
 * Usage:
 *   pired [--profile review|recon|pentest] [--provider NAME] [--model ID]
 *         [--target DIR] [--thinking off|low|medium|high|max] [--no-theme]
 *         [--prompt "one-shot"] [-- <extra pi args>]
 *
 * Models come from ~/.pired/models.json (pired registers them into pi):
 *   --provider lmstudio  --model qwen3.8-27b            (local)
 *   --provider openrouter --model qwen/qwen3.8-27b      (hosted)
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(ROOT, "extensions", "pired.ts");
const THEME = join(ROOT, "themes", "fxred.json");

function arg(name, def) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : def;
}
function has(name) {
	return process.argv.includes(`--${name}`);
}

const profile = ["review", "recon", "pentest"].includes(arg("profile")) ? arg("profile") : "review";
const provider = arg("provider");
const model = arg("model");
const thinking = arg("thinking", "high");
const targetRaw = arg("target", ".");
const target = isAbsolute(targetRaw) ? targetRaw : resolve(process.cwd(), targetRaw);
const promptText = arg("prompt");
const passIdx = process.argv.indexOf("--");
const passthrough = passIdx >= 0 ? process.argv.slice(passIdx + 1) : [];

if (!existsSync(EXT)) {
	process.stderr.write(`pired: extension not found at ${EXT}\n`);
	process.exit(1);
}

const piBin = process.env.PI_BIN || "pi";
const piArgs = ["-e", EXT, "--pired-profile", profile, "--thinking", thinking, "--approve"];
if (provider) piArgs.push("--provider", provider);
if (model) piArgs.push("--model", model);
if (!has("no-theme") && existsSync(THEME)) piArgs.push("--theme", THEME, "--use-theme", "fxred");
if (promptText) piArgs.push("-p", promptText);
piArgs.push(...passthrough);

const child = spawn(piBin, piArgs, { cwd: target, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
	process.stderr.write(`pired: failed to launch pi (${err?.message || err}). Is pi installed and on PATH?\n`);
	process.exit(1);
});
