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
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WINDOWS = process.platform === "win32";
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

/**
 * pi is found by resolution, not by PATH.
 *
 * npm installs pired and pi as siblings, so pi's package is right there next to
 * ours whether the prefix is /usr/local or a per-user ~/.local. Relying on the
 * bare name instead meant that a prefix the user had not yet added to PATH gave
 * a working install that could not start — the failure landing at the first
 * engagement rather than at install time.
 */
function findPi() {
	if (process.env.PI_BIN) return process.env.PI_BIN;
	const require = createRequire(import.meta.url);
	try {
		const pkgPath = require.resolve("@earendil-works/pi-coding-agent/package.json");
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
		const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
		if (rel) {
			const abs = resolve(dirname(pkgPath), rel);
			if (existsSync(abs)) return abs;
		}
	} catch {
		// Not resolvable from here (a linked checkout, an unusual layout): fall
		// through to the sibling-binary and PATH lookups below.
	}
	// Installed layout: <prefix>/bin/pired next to <prefix>/bin/pi. Windows puts
	// the shims in the prefix itself, names them .cmd, and does not symlink them
	// — so neither the directory to look in nor the file to look for carries
	// over, and searching for a bare "pi" there always came up empty.
	const dirs = WINDOWS
		? [join(ROOT, "..", ".."), dirname(process.argv[1] || "")]
		: [dirname(process.argv[1] || ""), join(ROOT, "..", "..", "..", "bin")];
	for (const dir of dirs) {
		if (!dir) continue;
		for (const name of WINDOWS ? ["pi.cmd", "pi.exe"] : ["pi"]) {
			const sibling = join(dir, name);
			if (existsSync(sibling)) return sibling;
		}
	}
	return "pi";
}

/**
 * Quote one argument the way CommandLineToArgvW reads it back.
 *
 * Only needed for the cmd.exe hop below. Node's own `shell: true` joins the
 * arguments with spaces and quotes none of them, which loses every path holding
 * one — and "C:\Users\Jane Doe" is not an exotic home directory.
 */
function quoteForWindows(value) {
	const text = String(value);
	// Quoting is skipped only for a conservative safe set, never merely for the
	// absence of a space: cmd.exe reads a bare & | < > ^ as syntax, so a prompt
	// or a passthrough flag carrying one would run as a second command.
	if (/^[A-Za-z0-9_\-.:\\/=+@,]+$/.test(text)) return text;

	let quoted = '"';
	let backslashes = 0;
	for (const char of text) {
		if (char === "\\") {
			backslashes++;
		} else if (char === '"') {
			quoted += "\\".repeat(backslashes * 2 + 1) + '"';
			backslashes = 0;
		} else {
			quoted += "\\".repeat(backslashes) + char;
			backslashes = 0;
		}
	}
	return quoted + "\\".repeat(backslashes * 2) + '"';
}

const piBin = findPi();
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

// A resolved package bin is a JS file whose executable bit and shebang we do
// not control, so it is handed to the node that is already running us. A bare
// "pi" from PATH is a real command and is spawned as one.
const viaNode = piBin !== "pi" && /\.[cm]?js$/.test(piBin);
const options = { cwd: target, stdio: "inherit" };

function launch() {
	if (viaNode) return spawn(process.execPath, [piBin, ...piArgs], options);
	if (!WINDOWS || /\.exe$/i.test(piBin)) return spawn(piBin, piArgs, options);
	// Everything left on Windows is a .cmd shim, which node refuses to spawn
	// without a shell (CVE-2024-27980), including the bare "pi". Build the
	// command line here rather than take node's unquoted `shell: true`.
	const line = [piBin, ...piArgs].map(quoteForWindows).join(" ");
	return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
		...options,
		windowsVerbatimArguments: true,
	});
}

const child = launch();
child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
	process.stderr.write(`pired: failed to launch pi at ${piBin} (${err?.message || err}).\n`);
	process.exit(1);
});
