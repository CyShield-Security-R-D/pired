import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The installers run on a box that has nothing, which is exactly the box nobody
 * tests on. These run the real `install.sh` against stub `npm` and `pi` binaries
 * on a sandboxed PATH and HOME: no network, no npm, nothing written outside a
 * temporary directory. What is asserted is what the operator sees and what the
 * script actually invoked — the two things a broken installer gets wrong.
 *
 * install.ps1 refuses to run anywhere but Windows, so it is held to two weaker
 * standards: the parity assertions at the bottom, which always run, and — where
 * a `pwsh` exists to load it with — its own decision functions, called directly.
 */

const INSTALLER = join(import.meta.dirname, "install.sh");

/** The shells a `curl … | sh` can land in. dash is Ubuntu's /bin/sh; busybox is an Alpine container. */
function shells(): string[] {
	const found = ["/bin/sh"];
	for (const candidate of ["/bin/dash", "/usr/bin/dash"]) {
		if (existsSync(candidate)) {
			found.push(candidate);
			break;
		}
	}
	for (const candidate of ["/bin/busybox", "/usr/bin/busybox"]) {
		if (existsSync(candidate)) {
			found.push(`${candidate} sh`);
			break;
		}
	}
	return found;
}

type Sandbox = {
	root: string;
	home: string;
	prefix: string;
	stub: string;
	calls: string;
	registered: string;
	source: string;
	nodeDir: string;
};

let sandboxes: string[] = [];

afterEach(() => {
	for (const root of sandboxes) rmSync(root, { recursive: true, force: true });
	sandboxes = [];
});

function script(path: string, body: string): void {
	writeFileSync(path, body);
	chmodSync(path, 0o755);
}

function sandbox(): Sandbox {
	const root = mkdtempSync(join(tmpdir(), "pired-install-test-"));
	sandboxes.push(root);

	const box: Sandbox = {
		root,
		home: join(root, "home"),
		prefix: join(root, "prefix"),
		stub: join(root, "stub"),
		calls: join(root, "calls"),
		registered: join(root, "registered"),
		source: join(root, "source"),
		nodeDir: join(root, "node"),
	};
	for (const dir of [box.home, join(box.prefix, "bin"), box.stub, box.source, box.nodeDir]) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(box.calls, "");
	writeFileSync(box.registered, "");
	writeFileSync(join(box.source, "package.json"), JSON.stringify({ name: "pired", version: "0.0.0" }));

	// Only node, never the whole bin directory it lives in: a real `pi` sits
	// beside the node that pi's own installer put there, and a test that let it
	// onto PATH would be installing packages into the tester's ~/.pi.
	symlinkSync(process.execPath, join(box.nodeDir, "node"));

	// `npm install --global` has to leave a pired behind, because the installer
	// checks for the binary rather than trusting npm's exit code.
	script(
		join(box.stub, "npm"),
		[
			"#!/bin/sh",
			'echo "npm $*" >> "$CALLS"',
			'case "$1" in',
			'  -v) echo "11.6.2" ;;',
			'  prefix) echo "$NPM_PREFIX" ;;',
			"  install)",
			'    mkdir -p "$NPM_PREFIX/bin"',
			`    printf '#!/bin/sh\\nexit 0\\n' > "$NPM_PREFIX/bin/pired"`,
			'    chmod +x "$NPM_PREFIX/bin/pired"',
			// Installing pi has to leave a pi behind, or the step that registers the
			// subagents package has nothing to register it with.
			'    case "$*" in *pi-coding-agent*) cp "$PI_STUB" "$NPM_PREFIX/bin/pi" ;; esac ;;',
			"esac",
			"exit 0",
			"",
		].join("\n"),
	);

	const pi = [
		"#!/bin/sh",
		'echo "pi $*" >> "$CALLS"',
		'case "$1" in',
		'  --version) echo "0.85.1" ;;',
		"  list)",
		'    echo "User packages:"',
		'    cat "$REGISTERED" ;;',
		"  install)",
		'    [ "${PI_INSTALL_FAILS:-0}" = 1 ] && { echo "npm error 404 Not Found" >&2; exit 1; }',
		// pi reporting success and recording nothing is the failure the old
		// registration step was guarded against; it is still possible here.
		'    [ "${PI_INSTALL_SILENT:-0}" = 1 ] && exit 0',
		'    echo "  $2" >> "$REGISTERED" ;;',
		"esac",
		"exit 0",
		"",
	].join("\n");
	script(join(box.stub, "pi"), pi);
	script(join(box.stub, "pi-template"), pi);

	return box;
}

type RunResult = { stdout: string; status: number; calls: string[] };

function run(
	box: Sandbox,
	options: { shell?: string; args?: string[]; env?: Record<string, string>; noPi?: boolean } = {},
): RunResult {
	if (options.noPi) rmSync(join(box.stub, "pi"), { force: true });

	const [command, ...shellArgs] = (options.shell ?? "/bin/sh").split(" ");
	let status = 0;
	let stdout = "";
	try {
		stdout = execFileSync(command as string, [...shellArgs, INSTALLER, ...(options.args ?? [])], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				// Deliberately not process.env: the tester's own HOME, PATH and npm
				// configuration are the whole thing being kept out of this.
				HOME: box.home,
				PATH: `${box.stub}:${box.nodeDir}:/usr/bin:/bin`,
				TERM: "dumb",
				SHELL: "/bin/sh",
				CALLS: box.calls,
				REGISTERED: box.registered,
				PI_STUB: join(box.stub, "pi-template"),
				NPM_PREFIX: box.prefix,
				PIRED_SOURCE: box.source,
				PIRED_NO_ANIM: "1",
				PIRED_YES: "1",
				...(options.env ?? {}),
			},
		});
	} catch (error) {
		const failure = error as { status?: number; stdout?: string; stderr?: string };
		status = failure.status ?? 1;
		stdout = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
	}

	const calls = readFileSync(box.calls, "utf8").split("\n").filter(Boolean);
	return { stdout, status, calls };
}

function registered(box: Sandbox, ...packages: string[]): void {
	writeFileSync(box.registered, packages.map((name) => `  ${name}\n`).join(""));
}

const piInstalls = (result: RunResult): string[] => result.calls.filter((call) => call.startsWith("pi install"));

describe.each(shells())("install.sh under %s", (shell) => {
	const start = (box: Sandbox, options: Parameters<typeof run>[1] = {}) => run(box, { ...options, shell });

	it("installs pi-subagents after pired, because the delegation the prompt hints at should exist on a fresh box", () => {
		const box = sandbox();
		const result = start(box);

		expect(result.status).toBe(0);
		expect(piInstalls(result)).toEqual(["pi install npm:pi-subagents"]);
		expect(result.stdout).toContain("subagents  npm:pi-subagents");
		expect(result.stdout).toContain("Ready.");

		// Order is the plan's order. Registering a delegation extension before the
		// harness it delegates for is a half-install if the second step fails.
		const piredInstall = result.calls.findIndex((call) => call.startsWith("npm install --global"));
		const subagentsInstall = result.calls.findIndex((call) => call.startsWith("pi install"));
		expect(piredInstall).toBeGreaterThan(-1);
		expect(subagentsInstall).toBeGreaterThan(piredInstall);
	});

	it("names the subagents row in the plan, and names pi's directory in it, because that is the only thing it writes outside its own prefix", () => {
		const box = sandbox();
		const result = start(box, { args: ["--dry-run"] });

		expect(result.status).toBe(0);
		expect(result.stdout).toMatch(/\+ subagents\s+~\/\.pi\s+npm:pi-subagents/);
		expect(result.stdout).toContain("pi remove npm:pi-subagents");
	});

	it("changes nothing at all on a dry run, including in pi", () => {
		const box = sandbox();
		const result = start(box, { args: ["--dry-run"] });

		expect(result.calls.filter((call) => call.startsWith("pi install"))).toEqual([]);
		expect(result.calls.filter((call) => call.startsWith("npm install"))).toEqual([]);
		expect(readFileSync(box.registered, "utf8")).toBe("");
	});

	it("declines to touch pi when PIRED_SKIP_SUBAGENTS=1, and stops offering to undo what it did not do", () => {
		const box = sandbox();
		const result = start(box, { env: { PIRED_SKIP_SUBAGENTS: "1" } });

		expect(result.status).toBe(0);
		expect(piInstalls(result)).toEqual([]);
		expect(result.stdout).toContain("skipped — PIRED_SKIP_SUBAGENTS=1");
		expect(result.stdout).not.toContain("pi remove npm:pi-subagents");
		expect(result.stdout).toContain("Ready.");
	});

	it("leaves an already-registered subagents package alone rather than installing a second one", () => {
		const box = sandbox();
		registered(box, "npm:pi-subagents");
		const result = start(box);

		expect(piInstalls(result)).toEqual([]);
		expect(result.stdout).toContain("already registered with pi");
	});

	it("counts a fork as already registered, because the ecosystem is mostly forks and the operator chose theirs", () => {
		const box = sandbox();
		registered(box, "npm:@gotgenes/pi-subagents");
		const result = start(box);

		expect(piInstalls(result)).toEqual([]);
		expect(result.stdout).toContain("already registered with pi");
	});

	it("is not fooled by an unrelated package into thinking delegation is installed", () => {
		const box = sandbox();
		registered(box, "npm:@narumitw/pi-btw", "npm:pi-subagents-bridge");
		const result = start(box);

		expect(piInstalls(result)).toEqual(["pi install npm:pi-subagents"]);
	});

	it("still finishes the install when pi-subagents cannot be installed, because pired works without it", () => {
		const box = sandbox();
		const result = start(box, { env: { PI_INSTALL_FAILS: "1" } });

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("could not install npm:pi-subagents");
		expect(result.stdout).toContain("retry: pi install npm:pi-subagents");
		expect(result.stdout).toContain("Ready.");
		// The failure is a warning, not a checkmark, and not a dead end.
		expect(result.stdout).not.toMatch(/ok\s+subagents/);
	});

	it("does not claim a package pi reported installing but did not record, which is how the old registration step lied", () => {
		const box = sandbox();
		const result = start(box, { env: { PI_INSTALL_SILENT: "1" } });

		expect(result.status).toBe(0);
		expect(piInstalls(result)).toEqual(["pi install npm:pi-subagents"]);
		expect(result.stdout).toContain("could not install npm:pi-subagents");
		expect(result.stdout).toContain("Ready.");
	});

	it("asks again at the step when the survey had no pi to ask, rather than installing over a package already there", () => {
		// `npm rm -g pired pi` leaves ~/.pi and its packages behind. The next install
		// brings a new pi, so the survey has nothing to ask and the plan says it will
		// install — but by the step there is a pi with an answer.
		const box = sandbox();
		rmSync(join(box.stub, "pi"), { force: true });
		registered(box, "npm:pi-subagents");
		const result = start(box);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("+ subagents");
		expect(piInstalls(result)).toEqual([]);
		expect(result.stdout).toMatch(/ok\s+subagents\s+already registered with pi/);
	});

	it("promises nothing it cannot deliver when there is no pi to register it with", () => {
		const box = sandbox();
		const result = start(box, { noPi: true, env: { PIRED_SKIP_PI: "1" } });

		expect(result.status).toBe(0);
		expect(piInstalls(result)).toEqual([]);
		expect(result.stdout).toContain("skipped — no pi to register it with");
		expect(result.stdout).not.toContain("+ subagents");
	});
});

/**
 * install.ps1 refuses to run anywhere but Windows, so what can be tested off it
 * is what it decides: the file is dot-sourced with its one entry call stripped,
 * and the two functions that choose whether to touch pi are called directly.
 *
 * `pwsh` on PATH is enough — PowerShell 7 runs on Linux and macOS, and parses
 * the same language Windows PowerShell 5.1 does for everything this file uses.
 */
const POWERSHELL_CHECKS = String.raw`
$ErrorActionPreference = "Stop"
$installer, $registered, $pi, $brokenPi, $absentPi = $args

# Syntax first: an installer that does not parse cannot be caught by any other
# assertion here, and nobody runs it on Linux to find out.
$errors = $null
$tokens = $null
[System.Management.Automation.Language.Parser]::ParseFile($installer, [ref]$tokens, [ref]$errors) | Out-Null
if ($errors) {
	$errors | ForEach-Object { "FAIL: parse error on line $($_.Extent.StartLineNumber): $($_.Message)" }
	exit 1
}

# Everything but the entry call, which would exit 1 on this platform by design.
$source = (Get-Content -Raw -LiteralPath $installer) -replace '(?m)^Invoke-PiredInstaller\s*$', ''
. ([scriptblock]::Create($source))

$failures = @()
function Check([string]$name, [bool]$ok) { if (-not $ok) { $script:failures += $name } }
function Listing([string[]]$packages) {
	$lines = @("User packages:")
	foreach ($package in $packages) { $lines += "  " + $package }
	Set-Content -LiteralPath $registered -Value ($lines -join ([char]10))
}

Listing @("npm:pi-subagents")
Check "finds the package pi records" (Test-SubagentsRegistered $pi)

Listing @("npm:@gotgenes/pi-subagents")
Check "finds a scoped fork" (Test-SubagentsRegistered $pi)

Listing @("npm:@narumitw/pi-btw", "npm:pi-subagents-bridge", "npm:@narumitw/pi-plan-mode")
Check "is not fooled by a neighbouring package" (-not (Test-SubagentsRegistered $pi))

Listing @()
Check "an empty listing is not a package" (-not (Test-SubagentsRegistered $pi))

Check "no pi means no answer" (-not (Test-SubagentsRegistered ""))
Check "a pi that fails is not a package" (-not (Test-SubagentsRegistered $brokenPi))
Check "a pi that is not there at all does not throw" (-not (Test-SubagentsRegistered $absentPi))

$env:PIRED_SKIP_SUBAGENTS = "1"
Listing @("npm:pi-subagents")
Check "the opt-out wins over everything else" ((Get-SubagentsState -Pi $pi -DoPi $false) -eq "declined")
$env:PIRED_SKIP_SUBAGENTS = ""

Check "no pi and none coming is not a promise" ((Get-SubagentsState -Pi "" -DoPi $false) -eq "nopi")
Check "a pi arriving in this run is a box to install into" ((Get-SubagentsState -Pi "" -DoPi $true) -eq "missing")
Check "an already-registered package is left alone" ((Get-SubagentsState -Pi $pi -DoPi $false) -eq "present")

Listing @()
Check "a pi with nothing registered gets the package" ((Get-SubagentsState -Pi $pi -DoPi $false) -eq "missing")

if ($failures.Count -gt 0) {
	$failures | ForEach-Object { "FAIL: " + $_ }
	exit 1
}
"ok"
`;

function powershell(): string | undefined {
	if (process.env.PWSH && existsSync(process.env.PWSH)) return process.env.PWSH;
	try {
		return execFileSync("command", ["-v", "pwsh"], { encoding: "utf8", shell: "/bin/sh" }).trim() || undefined;
	} catch {
		return undefined;
	}
}

const pwsh = powershell();

describe.skipIf(!pwsh)("install.ps1 decides the same way", () => {
	it("asks pi what it has, and only then whether to add to it", () => {
		const box = sandbox();
		const checks = join(box.root, "checks.ps1");
		writeFileSync(checks, POWERSHELL_CHECKS);

		// A pi that prints the listing and nothing else, one that fails, and one
		// that is not there — the three answers a real box can give.
		const listing = join(box.stub, "listing-pi");
		script(listing, `#!/bin/sh\nexec cat "${box.registered}"\n`);
		const broken = join(box.stub, "broken-pi");
		script(broken, "#!/bin/sh\nexit 1\n");

		const output = execFileSync(
			pwsh as string,
			[
				"-NoProfile",
				"-NonInteractive",
				"-File",
				checks,
				join(import.meta.dirname, "install.ps1"),
				box.registered,
				listing,
				broken,
				join(box.stub, "absent-pi"),
			],
			{ encoding: "utf8", env: { HOME: box.home, PATH: "/usr/bin:/bin" } },
		);

		expect(output.trim()).toBe("ok");
	});
});

describe("the installers agree with each other", () => {
	const sh = readFileSync(INSTALLER, "utf8");
	const ps1 = readFileSync(join(import.meta.dirname, "install.ps1"), "utf8");

	it("installs the same package from both scripts", () => {
		expect(sh).toContain('SUBAGENTS_PACKAGE="npm:pi-subagents"');
		expect(ps1).toContain('$SubagentsPackage = "npm:pi-subagents"');
	});

	it("spells the opt-out the same way on both platforms, because one name is documented for both", () => {
		expect(sh).toContain("PIRED_SKIP_SUBAGENTS");
		expect(ps1).toContain("PIRED_SKIP_SUBAGENTS");
	});

	it("still refuses to register pired itself on both platforms, which is the decision this one sits next to", () => {
		for (const source of [sh, ps1]) {
			expect(source).toContain("ADR-017");
			expect(source).toContain("ADR-021");
		}
	});

	it("documents the flag in --help, which a fixed line range had already silently truncated away", () => {
		const box = sandbox();
		const help = run(box, { args: ["--help"] });
		expect(help.status).toBe(0);
		expect(help.stdout).toContain("PIRED_SKIP_SUBAGENTS");
		// The three that the old `sed -n '2,37p'` cut off.
		expect(help.stdout).toContain("PIRED_SKIP_PI");
		expect(help.stdout).toContain("PIRED_YES");
		expect(help.stdout).toContain("PIRED_NO_ANIM");
		expect(help.stdout).not.toContain("set -eu");
	});
});
