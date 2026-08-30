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
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(ROOT, "extensions", "pired.ts");
const THEME = join(ROOT, "themes", "pired.json");

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
/**
 * Everything pired does not own goes to pi.
 *
 * Passthrough used to require an explicit `--`, so reaching pi's own flags meant
 * `pired -- --resume` — two dashes to say something the launcher could have
 * worked out. There is no ambiguity to resolve: pired knows its own flags, and
 * anything else is pi's. `--` still works for the case where a value would
 * otherwise look like a flag.
 */
const OWN_VALUE_FLAGS = ["profile", "provider", "model", "thinking", "target", "prompt"];
const OWN_BOOL_FLAGS = ["no-theme", "no-panel", "fullscreen"];

const passIdx = process.argv.indexOf("--");
const own = passIdx >= 0 ? process.argv.slice(2, passIdx) : process.argv.slice(2);
const explicit = passIdx >= 0 ? process.argv.slice(passIdx + 1) : [];

const forwarded = [];
for (let i = 0; i < own.length; i++) {
	const a = own[i];
	const name = a.startsWith("--") ? a.slice(2) : "";
	if (OWN_BOOL_FLAGS.includes(name)) continue;
	if (OWN_VALUE_FLAGS.includes(name)) {
		// Skip its value too, unless the flag was given without one.
		if (own[i + 1] && !own[i + 1].startsWith("--")) i++;
		continue;
	}
	forwarded.push(a);
}
const passthrough = [...forwarded, ...explicit];

if (!existsSync(EXT)) {
	process.stderr.write(`pired: extension not found at ${EXT}\n`);
	process.exit(1);
}

const piBin = process.env.PI_BIN || "pi";
const piArgs = ["-e", EXT, "--pired-profile", profile, "--thinking", thinking, "--approve"];
if (provider) piArgs.push("--provider", provider);
if (model) piArgs.push("--model", model);
if (!has("no-theme") && existsSync(THEME)) piArgs.push("--theme", THEME, "--use-theme", "pired");
if (has("no-panel")) piArgs.push("--pired-panel", "off");
// pi renders inline in the scrollback by default, so the editor sits after the
// last output rather than on the terminal's final row and the screen has blank
// space beneath it. `fullscreen` takes the alternate screen and pins the layout
// to the terminal — which is also what the top-right panel rail was drawn for.
// Not the default: inline keeps the conversation in scrollback, which is the
// behaviour pi ships and some people prefer.
if (has("fullscreen")) piArgs.push("--tui-mode", "fullscreen");
if (promptText) piArgs.push("-p", promptText);
piArgs.push(...passthrough);

const child = spawn(piBin, piArgs, { cwd: target, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
	process.stderr.write(`pired: failed to launch pi (${err?.message || err}). Is pi installed and on PATH?\n`);
	process.exit(1);
});
