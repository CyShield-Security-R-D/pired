/**
 * The launcher's decisions, separated from the launch.
 *
 * `pired.mjs` is a script: it reads process.argv, touches the filesystem and
 * spawns a child, so nothing in it could be reached from a test. Everything that
 * makes a decision lives here instead, taking its world as arguments — argv, a
 * platform string, an `exists` predicate — and returning a value.
 *
 * That matters more here than the line count suggests. Two of this project's
 * shipped bugs were in exactly this code: pi could not be found on Windows
 * (wrong directory, wrong filename, no symlink), and reaching pi's own flags
 * needed a redundant `--`. Both are pure functions of the inputs above, and
 * neither would have survived a test.
 *
 * Plain JavaScript on purpose. This file is on the startup path of a CLI whose
 * engines floor is Node 22.19, and a launcher that needs type-stripping to boot
 * is a launcher with one more way to fail before it prints anything.
 */

import { dirname, join } from "node:path";

/** Flags pired owns that take a value; everything else is pi's. */
export const OWN_VALUE_FLAGS = ["profile", "provider", "model", "thinking", "target", "prompt"];
/** Flags pired owns that do not. */
export const OWN_BOOL_FLAGS = ["no-theme", "no-panel", "fullscreen"];
export const PROFILES = ["review", "recon", "pentest"];

/**
 * The value after `--name`, or `def`.
 *
 * A flag given without a value takes the default rather than swallowing the next
 * flag: `pired --model --resume` asked for pi's `--resume`, not for a model
 * called "--resume".
 *
 * @param {string[]} argv
 * @param {string} name
 * @param {string} [def]
 * @returns {string | undefined}
 */
export function argValue(argv, name, def) {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
}

/**
 * @param {string[]} argv
 * @param {string} name
 * @returns {boolean}
 */
export function hasFlag(argv, name) {
	return argv.includes(`--${name}`);
}

/**
 * Split pired's own arguments from pi's.
 *
 * Passthrough used to require an explicit `--`, so reaching pi's own flags meant
 * `pired -- --resume` — two dashes to say something the launcher could have
 * worked out. There is no ambiguity to resolve: pired knows its own flags, and
 * anything else is pi's. `--` still works, for the case where a value would
 * otherwise look like a flag.
 *
 * @param {string[]} argv
 * @returns {{ own: string[]; forwarded: string[]; explicit: string[]; passthrough: string[] }}
 */
export function partition(argv) {
	const passIdx = argv.indexOf("--");
	const own = passIdx >= 0 ? argv.slice(0, passIdx) : argv.slice();
	const explicit = passIdx >= 0 ? argv.slice(passIdx + 1) : [];

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
	return { own, forwarded, explicit, passthrough: [...forwarded, ...explicit] };
}

/**
 * Find pi by resolution, not by PATH.
 *
 * npm installs pired and pi as siblings, so pi's package is right there next to
 * ours whether the prefix is /usr/local or a per-user ~/.local. Relying on the
 * bare name instead meant that a prefix the user had not yet added to PATH gave
 * a working install that could not start — the failure landing at the first
 * engagement rather than at install time.
 *
 * `env`, `exists` and `resolvePackage` are injected so the search order can be
 * tested on a platform that is not the one running the test.
 *
 * @param {object} opts
 * @param {Record<string, string | undefined>} [opts.env]
 * @param {string} opts.platform
 * @param {string} opts.root
 * @param {string | undefined} opts.argv1
 * @param {(path: string) => boolean} opts.exists
 * @param {(() => { dir: string; bin: string } | undefined)} [opts.resolvePackage]
 *   Where npm put pi's package, when it is resolvable from here at all.
 * @returns {string} An absolute path, or the bare name so PATH gets its chance.
 */
export function findPi({ env = {}, platform, root, argv1, exists, resolvePackage }) {
	if (env.PI_BIN) return env.PI_BIN;
	const windows = platform === "win32";
	const pkg = resolvePackage?.();
	if (pkg?.dir && pkg.bin) {
		const abs = join(pkg.dir, pkg.bin);
		if (exists(abs)) return abs;
	}
	// Installed layout: <prefix>/bin/pired next to <prefix>/bin/pi. Windows puts
	// the shims in the prefix itself, names them .cmd, and does not symlink them
	// — so neither the directory to look in nor the file to look for carries
	// over, and searching for a bare "pi" there always came up empty.
	const dirs = windows
		? [join(root, "..", ".."), argv1 ? dirname(argv1) : ""]
		: [argv1 ? dirname(argv1) : "", join(root, "..", "..", "..", "bin")];
	for (const dir of dirs) {
		if (!dir) continue;
		for (const name of windows ? ["pi.cmd", "pi.exe"] : ["pi"]) {
			const candidate = join(dir, name);
			if (exists(candidate)) return candidate;
		}
	}
	return "pi";
}

/**
 * The pi command line pired's own flags imply.
 *
 * @param {object} opts
 * @param {string} opts.ext Absolute path to the pired extension.
 * @param {string} opts.theme Absolute path to the pired theme.
 * @param {string[]} opts.argv pired's own arguments, without node and the script.
 * @param {(path: string) => boolean} [opts.exists]
 * @returns {string[]}
 */
export function buildPiArgs({ ext, theme, argv, exists = () => true }) {
	const profileArg = argValue(argv, "profile");
	const profile = PROFILES.includes(profileArg) ? profileArg : "review";
	const args = ["-e", ext, "--pired-profile", profile, "--thinking", argValue(argv, "thinking", "high"), "--approve"];

	const provider = argValue(argv, "provider");
	const model = argValue(argv, "model");
	if (provider) args.push("--provider", provider);
	if (model) args.push("--model", model);
	if (!hasFlag(argv, "no-theme") && exists(theme)) args.push("--theme", theme, "--use-theme", "pired");
	if (hasFlag(argv, "no-panel")) args.push("--pired-panel", "off");
	// pi renders inline in the scrollback by default, so the editor sits after the
	// last output rather than on the terminal's final row and the screen has blank
	// space beneath it. `fullscreen` takes the alternate screen and pins the layout
	// to the terminal — which is also what the top-right panel rail was drawn for.
	// Not the default: inline keeps the conversation in scrollback, which is the
	// behaviour pi ships and some people prefer.
	if (hasFlag(argv, "fullscreen")) args.push("--tui-mode", "fullscreen");
	const prompt = argValue(argv, "prompt");
	if (prompt) args.push("-p", prompt);
	args.push(...partition(argv).passthrough);
	return args;
}

/**
 * Quote one argument the way CommandLineToArgvW reads it back.
 *
 * Only needed for the cmd.exe hop below. Node's own `shell: true` joins the
 * arguments with spaces and quotes none of them, which loses every path holding
 * one — and "C:\\Users\\Jane Doe" is not an exotic home directory.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function quoteForWindows(value) {
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

/**
 * What to hand `spawn`, and why.
 *
 * Three cases, and each one is a thing that does not work if you get it wrong:
 * a resolved package bin is a JS file whose executable bit and shebang we do not
 * control, so it goes to the node already running us; a real executable is
 * spawned as one; and everything left on Windows is a .cmd shim, which node
 * refuses to spawn without a shell (CVE-2024-27980) — so the command line is
 * built here rather than left to node's unquoted `shell: true`.
 *
 * @param {object} opts
 * @param {string} opts.piBin
 * @param {string[]} opts.piArgs
 * @param {string} opts.platform
 * @param {string} opts.execPath The node already running us.
 * @param {string} [opts.comspec] `process.env.ComSpec`, when it is set.
 * @returns {{ command: string; args: string[]; via: "node" | "direct" | "cmd"; windowsVerbatimArguments?: boolean }}
 */
export function launchPlan({ piBin, piArgs, platform, execPath, comspec }) {
	const windows = platform === "win32";
	if (piBin !== "pi" && /\.[cm]?js$/.test(piBin)) {
		return { command: execPath, args: [piBin, ...piArgs], via: "node" };
	}
	if (!windows || /\.exe$/i.test(piBin)) {
		return { command: piBin, args: piArgs, via: "direct" };
	}
	const line = [piBin, ...piArgs].map(quoteForWindows).join(" ");
	return {
		command: comspec || "cmd.exe",
		args: ["/d", "/s", "/c", `"${line}"`],
		via: "cmd",
		windowsVerbatimArguments: true,
	};
}

