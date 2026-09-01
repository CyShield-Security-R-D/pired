import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { argValue, buildPiArgs, findPi, hasFlag, launchPlan, partition, quoteForWindows } from "./launch.mjs";

/**
 * The launcher, which until now was the only shipping code in the project with
 * no test at all — and which shipped two bugs in a fortnight: pi unreachable on
 * Windows, and pi's own flags needing a redundant `--`.
 */

describe("reading a flag's value", () => {
	it("takes the word after it", () => {
		expect(argValue(["--model", "qwen3.8-27b"], "model")).toBe("qwen3.8-27b");
	});

	it("falls back to the default when the flag is absent", () => {
		expect(argValue([], "thinking", "high")).toBe("high");
	});

	it("does not swallow the next flag as a value", () => {
		// `pired --model --resume` asked pi for --resume, not for a model called
		// "--resume".
		expect(argValue(["--model", "--resume"], "model", "def")).toBe("def");
	});

	it("reports a bare boolean flag", () => {
		expect(hasFlag(["--fullscreen"], "fullscreen")).toBe(true);
		expect(hasFlag(["--fullscreen"], "no-panel")).toBe(false);
	});
});

describe("splitting pired's arguments from pi's", () => {
	it("forwards a flag pired does not own, with no `--` needed", () => {
		expect(partition(["--resume"]).passthrough).toEqual(["--resume"]);
		expect(partition(["-r"]).passthrough).toEqual(["-r"]);
	});

	it("keeps pired's own flags and their values out of pi's line", () => {
		expect(partition(["--profile", "recon", "--model", "x", "--resume"]).passthrough).toEqual(["--resume"]);
	});

	it("drops pired's boolean flags without eating what follows", () => {
		expect(partition(["--no-panel", "--resume"]).passthrough).toEqual(["--resume"]);
		expect(partition(["--fullscreen", "-c"]).passthrough).toEqual(["-c"]);
	});

	it("does not eat the next flag when one of its own was given no value", () => {
		expect(partition(["--model", "--resume"]).passthrough).toEqual(["--resume"]);
	});

	it("still honours an explicit `--`, for a value that looks like a flag", () => {
		const p = partition(["--profile", "recon", "--", "--model", "--weird"]);
		expect(p.explicit).toEqual(["--model", "--weird"]);
		expect(p.passthrough).toEqual(["--model", "--weird"]);
	});

	it("forwards a bare positional argument", () => {
		expect(partition(["some-session-id"]).passthrough).toEqual(["some-session-id"]);
	});
});

describe("the pi command line", () => {
	const base = { ext: "/pired/extensions/pired.ts", theme: "/pired/themes/pired.json" };

	it("always loads the extension and arms the profile", () => {
		const args = buildPiArgs({ ...base, argv: [] });
		expect(args.slice(0, 6)).toEqual(["-e", base.ext, "--pired-profile", "review", "--thinking", "high"]);
	});

	it("takes a profile it knows and ignores one it does not", () => {
		expect(buildPiArgs({ ...base, argv: ["--profile", "pentest"] })).toContain("pentest");
		expect(buildPiArgs({ ...base, argv: ["--profile", "wizard"] })).toContain("review");
	});

	it("passes the provider and model through when given", () => {
		const args = buildPiArgs({ ...base, argv: ["--provider", "lmstudio", "--model", "qwen"] });
		expect(args).toEqual(expect.arrayContaining(["--provider", "lmstudio", "--model", "qwen"]));
	});

	it("applies the theme by default and drops it on request", () => {
		expect(buildPiArgs({ ...base, argv: [] })).toContain("--use-theme");
		expect(buildPiArgs({ ...base, argv: ["--no-theme"] })).not.toContain("--use-theme");
	});

	it("does not reach for a theme file that is not there", () => {
		expect(buildPiArgs({ ...base, argv: [], exists: () => false })).not.toContain("--theme");
	});

	it("turns the panel off, and takes the alternate screen, only when asked", () => {
		expect(buildPiArgs({ ...base, argv: ["--no-panel"] })).toEqual(expect.arrayContaining(["--pired-panel", "off"]));
		expect(buildPiArgs({ ...base, argv: [] })).not.toContain("--pired-panel");
		expect(buildPiArgs({ ...base, argv: ["--fullscreen"] })).toContain("fullscreen");
		expect(buildPiArgs({ ...base, argv: [] })).not.toContain("--tui-mode");
	});

	it("carries a one-shot prompt as pi's -p", () => {
		const args = buildPiArgs({ ...base, argv: ["--prompt", "review the auth module"] });
		expect(args).toEqual(expect.arrayContaining(["-p", "review the auth module"]));
	});

	it("puts pi's own flags last, after everything pired set", () => {
		const args = buildPiArgs({ ...base, argv: ["--profile", "recon", "--resume"] });
		expect(args[args.length - 1]).toBe("--resume");
	});

	it("never forwards --target: it is a working directory, not a pi flag", () => {
		expect(buildPiArgs({ ...base, argv: ["--target", "/srv/app"] })).not.toContain("/srv/app");
	});
});

describe("finding pi", () => {
	const never = () => false;

	it("obeys PI_BIN above everything", () => {
		expect(findPi({ env: { PI_BIN: "/opt/pi" }, platform: "linux", root: "/x", argv1: "/x/bin/pired", exists: () => true }))
			.toBe("/opt/pi");
	});

	it("prefers the resolved package bin, which is where npm actually put it", () => {
		const found = findPi({
			platform: "linux", root: "/x", argv1: "/x/bin/pired", exists: () => true,
			resolvePackage: () => ({ dir: "/n/pi-coding-agent", bin: "./dist/cli.js" }),
		});
		expect(found).toBe(join("/n/pi-coding-agent", "./dist/cli.js"));
	});

	it("falls through when the package resolves but its bin is missing", () => {
		const found = findPi({
			platform: "linux", root: "/x", argv1: "/usr/local/bin/pired",
			exists: (p: string) => p === "/usr/local/bin/pi",
			resolvePackage: () => ({ dir: "/n/pi", bin: "./gone.js" }),
		});
		expect(found).toBe("/usr/local/bin/pi");
	});

	it("finds the sibling shim next to our own bin", () => {
		expect(findPi({
			platform: "linux", root: "/usr/local/lib/node_modules/pired", argv1: "/usr/local/bin/pired",
			exists: (p: string) => p === "/usr/local/bin/pi",
		})).toBe("/usr/local/bin/pi");
	});

	it("looks in the npm prefix on Windows, where the shims live", () => {
		// Not next to our bin and not named "pi": the two halves of the bug.
		const root = "C:/Users/j/AppData/Roaming/npm/node_modules/pired";
		expect(findPi({
			platform: "win32", root, argv1: "C:/Users/j/AppData/Roaming/npm/pired.cmd",
			exists: (p: string) => p === join(root, "..", "..", "pi.cmd"),
		})).toBe(join(root, "..", "..", "pi.cmd"));
	});

	it("accepts a pi.exe as well as a pi.cmd", () => {
		const root = "C:/npm/node_modules/pired";
		expect(findPi({
			platform: "win32", root, argv1: "C:/npm/pired.cmd",
			exists: (p: string) => p === join(root, "..", "..", "pi.exe"),
		})).toBe(join(root, "..", "..", "pi.exe"));
	});

	it("never looks for a bare `pi` on Windows, which always came up empty", () => {
		const probed: string[] = [];
		findPi({
			platform: "win32", root: "C:/npm/node_modules/pired", argv1: "C:/npm/pired.cmd",
			exists: (p: string) => { probed.push(p); return false; },
		});
		expect(probed.every((p) => /\.(cmd|exe)$/.test(p))).toBe(true);
	});

	it("gives up on the bare name, so PATH still gets its chance", () => {
		expect(findPi({ platform: "linux", root: "/x", argv1: "/x/bin/pired", exists: never })).toBe("pi");
	});
});

describe("quoting for cmd.exe", () => {
	it("leaves a plain argument alone", () => {
		expect(quoteForWindows("--thinking")).toBe("--thinking");
		expect(quoteForWindows("C:\\npm\\pi.cmd")).toBe("C:\\npm\\pi.cmd");
	});

	it("quotes a path with a space — 'Jane Doe' is not an exotic home directory", () => {
		expect(quoteForWindows("C:\\Users\\Jane Doe\\pi.cmd")).toBe('"C:\\Users\\Jane Doe\\pi.cmd"');
	});

	it("quotes cmd.exe's syntax characters even with no space in sight", () => {
		// A bare & would otherwise end the command and start a second one.
		for (const ch of ["&", "|", "<", ">", "^", "%", "(", ")", "!"]) {
			expect(quoteForWindows(`a${ch}b`).startsWith('"')).toBe(true);
		}
	});

	it("escapes an embedded quote the way CommandLineToArgvW reads it back", () => {
		expect(quoteForWindows('say "hi"')).toBe('"say \\"hi\\""');
	});

	it("doubles the backslashes that precede a quote, and only those", () => {
		expect(quoteForWindows('a\\\\"b')).toBe('"a\\\\\\\\\\"b"');
	});

	it("doubles a trailing backslash so it does not escape the closing quote", () => {
		expect(quoteForWindows("C:\\Program Files\\")).toBe('"C:\\Program Files\\\\"');
	});
});

describe("deciding how to spawn", () => {
	const piArgs = ["-e", "/ext.ts"];

	it("hands a resolved .js bin to the node already running us", () => {
		// Its executable bit and shebang are not ours to rely on.
		const plan = launchPlan({ piBin: "/n/pi/dist/cli.js", piArgs, platform: "linux", execPath: "/usr/bin/node" });
		expect(plan).toMatchObject({ command: "/usr/bin/node", via: "node" });
		expect(plan.args).toEqual(["/n/pi/dist/cli.js", ...piArgs]);
	});

	it("spawns a real executable as one", () => {
		expect(launchPlan({ piBin: "/usr/local/bin/pi", piArgs, platform: "linux", execPath: "/usr/bin/node" }))
			.toMatchObject({ command: "/usr/local/bin/pi", args: piArgs, via: "direct" });
	});

	it("spawns the bare name directly, so PATH resolves it", () => {
		expect(launchPlan({ piBin: "pi", piArgs, platform: "linux", execPath: "/usr/bin/node" }))
			.toMatchObject({ command: "pi", via: "direct" });
	});

	it("spawns a .exe directly on Windows", () => {
		expect(launchPlan({ piBin: "C:\\npm\\pi.exe", piArgs, platform: "win32", execPath: "node.exe" }))
			.toMatchObject({ command: "C:\\npm\\pi.exe", via: "direct" });
	});

	it("goes through cmd.exe for a .cmd shim, which node refuses to spawn otherwise", () => {
		// CVE-2024-27980: node will not spawn a .cmd without a shell.
		const plan = launchPlan({
			piBin: "C:\\npm\\pi.cmd", piArgs, platform: "win32", execPath: "node.exe", comspec: "C:\\Windows\\cmd.exe",
		});
		expect(plan).toMatchObject({ command: "C:\\Windows\\cmd.exe", via: "cmd", windowsVerbatimArguments: true });
		expect(plan.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
	});

	it("quotes the whole cmd line itself rather than taking node's unquoted shell", () => {
		const plan = launchPlan({
			piBin: "C:\\Program Files\\npm\\pi.cmd", piArgs: ["-p", "look at auth & authz"],
			platform: "win32", execPath: "node.exe",
		});
		const line = plan.args[3];
		expect(line).toContain('"C:\\Program Files\\npm\\pi.cmd"');
		expect(line).toContain('"look at auth & authz"');
	});

	it("falls back to cmd.exe when ComSpec is unset", () => {
		expect(launchPlan({ piBin: "C:\\npm\\pi.cmd", piArgs, platform: "win32", execPath: "node.exe" }).command)
			.toBe("cmd.exe");
	});
});
