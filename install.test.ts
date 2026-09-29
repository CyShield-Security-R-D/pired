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
	/** Where the stub pi keeps installed packages: `<packages>/<name>/package.json`. */
	packages: string;
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
		packages: join(root, "packages"),
		source: join(root, "source"),
		nodeDir: join(root, "node"),
	};
	for (const dir of [box.home, join(box.prefix, "bin"), box.stub, box.packages, box.source, box.nodeDir]) {
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
			'    case "$*" in *pi-coding-agent*) [ "${NPM_PI_FAILS:-0}" = 1 ] && { echo "npm error code E404" >&2; exit 1; } ;; esac',
			'    mkdir -p "$NPM_PREFIX/bin"',
			'    cp "$PIRED_STUB" "$NPM_PREFIX/bin/pired"',
			'    chmod +x "$NPM_PREFIX/bin/pired"',
			// Installing pi has to leave a pi behind, or the step that registers the
			// subagents package has nothing to register it with.
			'    case "$*" in *pi-coding-agent*) cp "$PI_STUB" "$NPM_PREFIX/bin/pi" ;; esac ;;',
			"esac",
			"exit 0",
			"",
		].join("\n"),
	);

	// Two pis from one body: the one already on the box answers --version with
	// PI_HAVE, the one npm installs with PI_LATEST. Both default to a pi that
	// meets the floor, so a test that is not about the floor never meets it.
	const pi = (versionVariable: string) =>
		[
			"#!/bin/sh",
			'echo "pi $*" >> "$CALLS"',
			'manifest() { mkdir -p "$PACKAGES/$1"; printf \'{"name":"%s","version":"%s"}\\n\' "$1" "$2" > "$PACKAGES/$1/package.json"; }',
			// What the registry would hand out as latest, per package, so a test
			// about one package's floor does not move the other's.
			'latest() { case "$1" in pi-mcp-adapter) echo "${MCP_LATEST:-3.3.0}" ;; *) echo "${SUBAGENTS_LATEST:-0.71.0}" ;; esac; }',
			'case "$1" in',
			`  --version) echo "\${${versionVariable}:-0.87.1}" ;;`,
			"  list)",
			'    echo "User packages:"',
			'    while IFS= read -r source; do',
			'      [ -n "$source" ] || continue',
			'      echo "  $source"',
			// pi prints where a package is installed on the line below its source,
			// and only when it is installed — the line the installer reads the version under.
			'      name=${source#npm:}; name=${name%@[0-9]*}',
			'      if [ -f "$PACKAGES/$name/package.json" ]; then echo "    $PACKAGES/$name"; fi',
			'    done < "$REGISTERED" ;;',
			"  install)",
			'    spec=${2#npm:}; name=${spec%@[0-9]*}',
			// 1 fails every install; a package name fails only that one, so a test
			// can show one package's failure leaves the other's install alone.
			'    case "${PI_INSTALL_FAILS:-0}" in 1|"$name") echo "npm error 404 Not Found" >&2; exit 1 ;; esac',
			// pi reporting success and recording nothing is the failure the old
			// registration step was guarded against; it is still possible here.
			'    [ "${PI_INSTALL_SILENT:-0}" = 1 ] && exit 0',
			// pi matches a recorded entry by package name and replaces it
			// (addSourceToSettings), so an exact version installed over npm:x leaves
			// npm:x@<version> in its place: a pin, which is what an undo creates.
			'    if [ "$name" = "$spec" ]; then version=$(latest "$name"); else version=${spec#"$name"@}; fi',
			'    { grep -vx -e "npm:$name" -e "npm:$name@[0-9].*" "$REGISTERED"; echo "$2"; } > "$REGISTERED.next"',
			'    mv "$REGISTERED.next" "$REGISTERED"',
			'    manifest "$name" "$version" ;;',
			"  update)",
			'    [ "${PI_UPDATE_FAILS:-0}" = 1 ] && { echo "npm error code ETARGET" >&2; exit 1; }',
			'    grep -qx "$2" "$REGISTERED" || { echo "Error: No matching package found for $2" >&2; exit 1; }',
			// What pi 0.87.1 does with PI_OFFLINE=1 in the environment: says it
			// updated the package, exits 0, and leaves the old version on disk.
			'    [ "${PI_UPDATE_SILENT:-0}" = 1 ] && { echo "Updated $2"; exit 0; }',
			'    manifest "${2#npm:}" "$(latest "${2#npm:}")"',
			'    echo "Updated $2" ;;',
			"esac",
			"exit 0",
			"",
		].join("\n");
	script(join(box.stub, "pi"), pi("PI_HAVE"));
	script(join(box.stub, "pi-template"), pi("PI_LATEST"));
	script(join(box.stub, "pired-template"), [
		"#!/bin/sh",
		'echo "pired $* offline=${PI_OFFLINE:-0}" >> "$CALLS"',
		'if [ "$*" = "-- --help" ]; then',
		'  [ "${PIRED_VERIFY_FAILS:-0}" = 1 ] && { echo "Error: failed to load extension" >&2; exit 1; }',
		'  echo "Usage: pi [options]"',
		'  [ "${PIRED_VERIFY_MISSING_FLAG:-0}" = 1 ] || echo "  --pired-profile <value>  pired profile"',
		"fi",
		"exit 0",
		"",
	].join("\n"));

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
				PACKAGES: box.packages,
				PI_STUB: join(box.stub, "pi-template"),
				PIRED_STUB: join(box.stub, "pired-template"),
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

/**
 * Packages pi has recorded, as `pi list` will print them. A `[source, version]`
 * pair is also installed on disk with that version; a bare source is recorded
 * but has no package.json to read, which is what a hand-edited settings file or
 * an interrupted install leaves.
 */
function registered(box: Sandbox, ...packages: (string | [string, string])[]): void {
	const sources: string[] = [];
	for (const entry of packages) {
		const [source, version] = typeof entry === "string" ? [entry, undefined] : entry;
		sources.push(source);
		if (version === undefined) continue;
		const name = source.replace(/^npm:/, "").replace(/@\d.*$/, "");
		mkdirSync(join(box.packages, name), { recursive: true });
		writeFileSync(join(box.packages, name, "package.json"), `${JSON.stringify({ name, version }, null, 2)}\n`);
	}
	writeFileSync(box.registered, sources.map((source) => `${source}\n`).join(""));
}

function installedVersion(box: Sandbox, name: string): string | undefined {
	const manifest = join(box.packages, name, "package.json");
	return existsSync(manifest) ? (JSON.parse(readFileSync(manifest, "utf8")) as { version?: string }).version : undefined;
}

/**
 * What `npm rm -g` of pi leaves behind: pi's agent directory with its settings
 * file, and no pi to ask what the file records. The stub pi keeps its records
 * in `registered`, so this only has to exist.
 */
function leftBehind(box: Sandbox, agentDir = join(box.home, ".pi", "agent")): void {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ packages: ["npm:pi-subagents"] })}\n`);
}

/** A pi already in the prefix, answering --version with PI_HAVE, as the one on PATH does. */
function piInPrefix(box: Sandbox): void {
	script(join(box.prefix, "bin", "pi"), readFileSync(join(box.stub, "pi"), "utf8"));
}

/** A command the operator types, through the same stub pi and npm the installer drove. */
function operator(box: Sandbox, command: string): void {
	execFileSync("/bin/sh", ["-c", command], {
		stdio: "ignore",
		env: { PATH: `${box.stub}:/usr/bin:/bin`, CALLS: box.calls, REGISTERED: box.registered, PACKAGES: box.packages },
	});
}

const undoLine = (result: RunResult): string => result.stdout.split("\n").find((line) => line.includes("Undo:")) ?? "";

/** The line indented beneath the Undo line, where a second package's undo goes, or "". */
const undoNext = (result: RunResult): string => {
	const lines = result.stdout.split("\n");
	const below = lines[lines.findIndex((line) => line.includes("Undo:")) + 1] ?? "";
	return /^ {8}\S/.test(below) ? below.trim() : "";
};

const piInstalls = (result: RunResult): string[] => result.calls.filter((call) => call.startsWith("pi install"));
const piUpdates = (result: RunResult): string[] => result.calls.filter((call) => call.startsWith("pi update"));
const piUpgrades = (result: RunResult): string[] =>
	result.calls.filter((call) => call.startsWith("npm install") && call.includes("@earendil-works/pi-coding-agent"));

describe.each(shells())("install.sh under %s", (shell) => {
	const start = (box: Sandbox, options: Parameters<typeof run>[1] = {}) => run(box, { ...options, shell });

	it("loads the extension through pi when verifying an upgrade", () => {
		const box = sandbox();
		script(join(box.prefix, "bin", "pired"), "#!/bin/sh\nexit 0\n");
		const result = start(box);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("reinstall from");
		expect(result.calls).toContain("pired -- --help offline=1");
		expect(result.stdout).toContain("pi loaded the pired extension");
	});

	it.each(["PIRED_VERIFY_FAILS", "PIRED_VERIFY_MISSING_FLAG"])("rejects a broken extension when %s=1", (failure) => {
		const box = sandbox();
		const result = start(box, { env: { [failure]: "1" } });
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("pi could not load its extension");
		expect(result.stdout).not.toContain("Ready.");
		if (failure === "PIRED_VERIFY_FAILS") expect(result.stdout).toContain("Error: failed to load extension");
	});

	it("installs pi-subagents after pired, because the delegation the prompt hints at should exist on a fresh box", () => {
		const box = sandbox();
		const result = start(box);

		expect(result.status).toBe(0);
		expect(piInstalls(result)).toEqual(["pi install npm:pi-subagents", "pi install npm:pi-mcp-adapter"]);
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

	it("declines pi-subagents when PIRED_SKIP_SUBAGENTS=1, and stops offering to undo what it did not do", () => {
		const box = sandbox();
		const result = start(box, { env: { PIRED_SKIP_SUBAGENTS: "1" } });

		expect(result.status).toBe(0);
		expect(piInstalls(result)).toEqual(["pi install npm:pi-mcp-adapter"]);
		expect(result.stdout).toContain("skipped — PIRED_SKIP_SUBAGENTS=1");
		expect(result.stdout).not.toContain("pi remove npm:pi-subagents");
		expect(result.stdout).toContain("Ready.");
	});

	it("leaves an already-registered subagents package alone rather than installing a second one", () => {
		const box = sandbox();
		registered(box, ["npm:pi-subagents", "0.71.0"]);
		const result = start(box);

		expect(piInstalls(result)).toEqual(["pi install npm:pi-mcp-adapter"]);
		expect(piUpdates(result)).toEqual([]);
		expect(result.stdout).toMatch(/- subagents\s+~\/\.pi\s+0\.71\.0 — already registered with pi/);
		expect(result.stdout).toMatch(/ok\s+subagents\s+already registered with pi, 0\.71\.0/);
	});

	it("counts a fork as already registered, because the ecosystem is mostly forks and the operator chose theirs", () => {
		const box = sandbox();
		registered(box, "npm:@gotgenes/pi-subagents");
		const result = start(box);

		expect(piInstalls(result)).toEqual(["pi install npm:pi-mcp-adapter"]);
		expect(result.stdout).toContain("already registered with pi");
	});

	it("is not fooled by an unrelated package into thinking delegation is installed", () => {
		const box = sandbox();
		registered(box, "npm:@narumitw/pi-btw", "npm:pi-subagents-bridge");
		const result = start(box);

		expect(piInstalls(result)).toEqual(["pi install npm:pi-subagents", "pi install npm:pi-mcp-adapter"]);
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
		expect(piInstalls(result)).toEqual(["pi install npm:pi-subagents", "pi install npm:pi-mcp-adapter"]);
		expect(result.stdout).toContain("could not install npm:pi-subagents");
		expect(result.stdout).toContain("Ready.");
	});

	it("asks again at the step when the survey had no pi to ask, rather than installing over a package already there", () => {
		// `npm rm -g pired pi` leaves ~/.pi and its packages behind. The next install
		// brings a new pi, so the survey has nothing to ask and the plan says it will
		// install — but by the step there is a pi with an answer.
		const box = sandbox();
		rmSync(join(box.stub, "pi"), { force: true });
		leftBehind(box);
		registered(box, ["npm:pi-subagents", "0.71.0"]);
		const result = start(box);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("+ subagents");
		expect(piInstalls(result)).toEqual(["pi install npm:pi-mcp-adapter"]);
		expect(piUpdates(result)).toEqual([]);
		expect(result.stdout).toMatch(/ok\s+subagents\s+already registered with pi/);
		// The plan could not know, and its undo said as much rather than offering
		// to remove a package this run then left exactly where it was.
		expect(undoLine(result)).toContain("pi remove npm:pi-subagents  # only if the step installs it");
	});

	it("upgrades one found at the step instead when it is below the floor, since the plan already promised a current one", () => {
		const box = sandbox();
		rmSync(join(box.stub, "pi"), { force: true });
		leftBehind(box);
		registered(box, ["npm:pi-subagents", "0.66.0"]);
		const result = start(box);

		expect(result.status).toBe(0);
		expect(piInstalls(result)).toEqual(["pi install npm:pi-mcp-adapter"]);
		expect(piUpdates(result)).toEqual(["pi update npm:pi-subagents"]);
		expect(installedVersion(box, "pi-subagents")).toBe("0.71.0");
	});

	it.each([
		["~/.pi/agent", undefined],
		["PI_CODING_AGENT_DIR", "agent-elsewhere"],
	])(
		"does not promise pi remove when %s is left behind with no pi to ask, and gives the upgrade's own undo at the step",
		(_, elsewhere) => {
			// The plan said "+ subagents" and `pi remove npm:pi-subagents`; the step
			// found the operator's 0.66.0 and moved it to latest, so following that
			// undo would have removed a package they had before the run.
			const box = sandbox();
			rmSync(join(box.stub, "pi"), { force: true });
			const agentDir = elsewhere ? join(box.root, elsewhere) : undefined;
			leftBehind(box, agentDir);
			registered(box, ["npm:pi-subagents", "0.66.0"]);
			const result = start(box, { env: agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {} });

			expect(result.stdout).toContain("Only the pi this run installs can say what");
			expect(undoLine(result)).toContain("pi remove npm:pi-subagents  # only if the step installs it");
			expect(result.stdout).toMatch(/ok\s+subagents\s+npm:pi-subagents 0\.66\.0 -> 0\.71\.0/);
			expect(result.stdout).toContain("already registered at 0.66.0, so updated rather than installed");
			expect(result.stdout).toContain("undo: pi install npm:pi-subagents@0.66.0  # pins it; pi install npm:pi-subagents unpins");
		},
	);

	it("says the plan's pi remove does not apply when the one found at the step had no version to go back to", () => {
		const box = sandbox();
		rmSync(join(box.stub, "pi"), { force: true });
		leftBehind(box);
		registered(box, "npm:pi-subagents");
		const result = start(box);

		expect(piUpdates(result)).toEqual(["pi update npm:pi-subagents"]);
		expect(result.stdout).toContain("already registered, with no version to read, so updated rather than installed");
		expect(result.stdout).toContain("the plan's pi remove would take away a package that was here before this run");
	});

	it("promises pi remove outright when pi has recorded nothing on this box, because there is nothing for the step to find", () => {
		const box = sandbox();
		const result = start(box, { noPi: true, args: ["--dry-run"] });

		expect(result.stdout).not.toContain("Only the pi this run installs");
		expect(undoLine(result)).toMatch(/ · pi remove npm:pi-subagents$/);
	});

	it("promises nothing it cannot deliver when there is no pi to register it with", () => {
		const box = sandbox();
		const result = start(box, { noPi: true, env: { PIRED_SKIP_PI: "1" } });

		expect(result.status).toBe(0);
		expect(piInstalls(result)).toEqual([]);
		expect(result.stdout).toContain("skipped — no pi to register it with");
		expect(result.stdout).not.toContain("+ subagents");
	});

	// pired's delegation runs only through pi-subagents 0.71 (ADR-027), and 0.71
	// supports no pi older than 0.86.1. The box this was written on had pi 0.85.1
	// and pi-subagents 0.66.0 — both below — with the installer reporting both as
	// "already installed".

	it("upgrades a pi older than 0.86.1 with the same npm install a fresh one gets, and says so in the plan", () => {
		const box = sandbox();
		const result = start(box, { env: { PI_HAVE: "0.85.1" } });

		expect(result.status).toBe(0);
		expect(result.stdout).toMatch(/\^ pi\s+\S+\s+0\.85\.1 -> latest\s+\(pired needs >= 0\.86\.1\)/);
		expect(piUpgrades(result)).toEqual([
			"npm install --global --ignore-scripts --loglevel http --min-release-age=0 @earendil-works/pi-coding-agent",
		]);
		expect(result.stdout).toMatch(/ok\s+pi\s+0\.85\.1 -> 0\.87\.1/);
		// The old pi was on PATH, not in the prefix: it is left where it is, and
		// the plan says which one pired will run.
		expect(result.stdout).toContain("stays as it is; pired runs the new one in");
		expect(result.stdout).toContain("Ready.");
	});

	it("upgrades pi before installing pired, so the plan's order is the run's order", () => {
		const box = sandbox();
		const result = start(box, { env: { PI_HAVE: "0.85.1" } });

		const upgrade = result.calls.findIndex((call) => call.includes("@earendil-works/pi-coding-agent"));
		const pired = result.calls.findIndex((call) => call.startsWith("npm install") && call.includes(box.source));
		expect(upgrade).toBeGreaterThan(-1);
		expect(pired).toBeGreaterThan(upgrade);
	});

	it("keeps a pi that already meets the floor rather than reinstalling it on every run", () => {
		const box = sandbox();
		const result = start(box);

		expect(result.status).toBe(0);
		expect(piUpgrades(result)).toEqual([]);
		expect(result.stdout).toMatch(/- pi\s+\S+\s+0\.87\.1 — already installed/);
		expect(result.stdout).toMatch(/ok\s+pi\s+0\.87\.1/);
	});

	it("reads an unreadable pi version as below the floor, because 'could not tell' is not 'new enough'", () => {
		const box = sandbox();
		const result = start(box, { env: { PI_HAVE: "unknown" }, args: ["--dry-run"] });

		expect(result.stdout).toMatch(/\^ pi\s+\S+\s+version unknown -> latest/);
	});

	it("keeps an old pi when PIRED_SKIP_PI=1, and says what delegation will not have", () => {
		const box = sandbox();
		const result = start(box, { env: { PI_HAVE: "0.85.1", PIRED_SKIP_PI: "1" } });

		expect(result.status).toBe(0);
		expect(piUpgrades(result)).toEqual([]);
		expect(result.stdout).toContain("0.85.1 kept — PIRED_SKIP_PI=1; delegation needs >= 0.86.1");
		expect(result.stdout).toMatch(/!!\s+pi\s+0\.85\.1 kept \(PIRED_SKIP_PI=1\) — pired's delegation needs pi >= 0\.86\.1/);
		expect(result.stdout).toContain("Ready.");
	});

	it("holds back pi-subagents on a pi kept below its floor, rather than installing a package onto a host it does not support", () => {
		const box = sandbox();
		const result = start(box, { env: { PI_HAVE: "0.85.1", PIRED_SKIP_PI: "1" } });

		expect(piInstalls(result)).toEqual([]);
		expect(result.stdout).toContain("skipped — pi-subagents 0.71.0 needs pi >= 0.86.1");
		expect(result.stdout).not.toContain("+ subagents");
		expect(result.stdout).not.toContain("pi remove npm:pi-subagents");
	});

	it("holds back an old pi-subagents the same way, and leaves its version on disk alone", () => {
		const box = sandbox();
		registered(box, ["npm:pi-subagents", "0.66.0"]);
		const result = start(box, { env: { PI_HAVE: "0.85.1", PIRED_SKIP_PI: "1" } });

		expect(piUpdates(result)).toEqual([]);
		expect(result.stdout).toContain("0.66.0 kept — 0.71.0 needs pi >= 0.86.1");
		expect(installedVersion(box, "pi-subagents")).toBe("0.66.0");
	});

	it("warns rather than fails when the pi upgrade does not install, and leaves whether pired loads on the old pi to the verify step", () => {
		const box = sandbox();
		const result = start(box, { env: { PI_HAVE: "0.85.1", NPM_PI_FAILS: "1" } });

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("could not upgrade 0.85.1 — pired's delegation needs >= 0.86.1");
		expect(result.stdout).toContain(`retry: npm install -g --prefix ${box.prefix} @earendil-works/pi-coding-agent`);
		expect(result.stdout).toContain("Ready.");
		// The subagents step asks pi again, finds it still below the floor, and
		// does not install 0.71 onto it.
		expect(piInstalls(result)).toEqual([]);
		expect(result.stdout).toContain("held back — pi-subagents 0.71.0 needs pi >= 0.86.1");
	});

	it("does not claim a pi upgrade npm reported but did not deliver", () => {
		const box = sandbox();
		const result = start(box, { env: { PI_HAVE: "0.85.1", PI_LATEST: "0.85.1" } });

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("still 0.85.1 — pired needs >= 0.86.1");
		expect(result.stdout).not.toMatch(/ok\s+pi\s/);
	});

	it("upgrades an npm:pi-subagents older than 0.71.0 with pi update, and reads the version back from disk", () => {
		const box = sandbox();
		registered(box, ["npm:pi-subagents", "0.66.0"]);
		const result = start(box);

		expect(result.status).toBe(0);
		expect(result.stdout).toMatch(/\^ subagents\s+~\/\.pi\s+0\.66\.0 -> latest\s+\(pired needs >= 0\.71\.0\)/);
		expect(piUpdates(result)).toEqual(["pi update npm:pi-subagents"]);
		expect(piInstalls(result)).toEqual(["pi install npm:pi-mcp-adapter"]);
		expect(installedVersion(box, "pi-subagents")).toBe("0.71.0");
		expect(result.stdout).toMatch(/ok\s+subagents\s+npm:pi-subagents 0\.66\.0 -> 0\.71\.0/);
	});

	it("offers the version an upgrade replaced as its undo, not the removal of a package the operator already had", () => {
		const box = sandbox();
		registered(box, ["npm:pi-subagents", "0.66.0"]);
		const result = start(box, { args: ["--dry-run"] });

		expect(result.stdout).toContain("pi install npm:pi-subagents@0.66.0");
		expect(result.stdout).not.toContain("pi remove npm:pi-subagents");
		expect(piUpdates(result)).toEqual([]);
	});

	it("says in the undo that going back pins the package, because pi records the exact version in place of the entry it had", () => {
		const box = sandbox();
		registered(box, ["npm:pi-subagents", "0.66.0"]);
		const result = start(box, { args: ["--dry-run"] });

		expect(undoLine(result)).toMatch(/ · pi install npm:pi-subagents@0\.66\.0 {2}# pins it; pi install npm:pi-subagents unpins$/);
	});

	it("warns about the pin its own undo leaves on the next run, rather than skipping past a package delegation cannot use", () => {
		// The operator took the undo, which turned npm:pi-subagents into
		// npm:pi-subagents@0.66.0. The next run found a pin, left it alone as it
		// should, and said so on a neutral skip line.
		const box = sandbox();
		registered(box, ["npm:pi-subagents", "0.66.0"]);
		const upgrade = start(box);
		expect(installedVersion(box, "pi-subagents")).toBe("0.71.0");

		// Pasted as printed, comment and all: the shell runs the command and
		// nothing after the #.
		const undo = undoLine(upgrade).split(" · ").at(-1) ?? "";
		expect(undo).toMatch(/^pi install npm:pi-subagents@0\.66\.0 {2}#/);
		operator(box, undo);
		expect(readFileSync(box.registered, "utf8")).toBe("npm:pi-mcp-adapter\nnpm:pi-subagents@0.66.0\n");
		expect(installedVersion(box, "pi-subagents")).toBe("0.66.0");

		writeFileSync(box.calls, "");
		const next = start(box);
		expect(next.status).toBe(0);
		expect(piUpdates(next)).toEqual([]);
		expect(next.stdout).toMatch(/!!\s+subagents\s+npm:pi-subagents@0\.66\.0 — pinned, left alone/);
		expect(next.stdout).toContain("to lift the pin: pi install npm:pi-subagents");
	});

	it.each([
		["already meets the floor", {}],
		["is kept below it by PIRED_SKIP_PI=1", { PI_HAVE: "0.85.1", PIRED_SKIP_PI: "1" }],
	])("leaves pi out of the undo when the pi on the box %s, because npm rm -g of its name removed the operator's own", (_, env) => {
		const box = sandbox();
		const result = start(box, { env, args: ["--dry-run"] });

		expect(undoLine(result)).toContain(`Undo: npm rm -g --prefix ${box.prefix} pired · rm -rf ~/.pired`);
		expect(undoLine(result)).not.toContain("@earendil-works/pi-coding-agent");
	});

	it("removes a pi it installs from the prefix it installs it into, since a bare npm rm -g acts on npm's own", () => {
		const box = sandbox();
		const result = start(box, { noPi: true, args: ["--dry-run"] });

		expect(undoLine(result)).toContain(`Undo: npm rm -g --prefix ${box.prefix} pired @earendil-works/pi-coding-agent · rm -rf ~/.pired`);
	});

	it("removes the new pi an upgrade puts in the prefix, and leaves the old one outside it alone", () => {
		const box = sandbox();
		const result = start(box, { env: { PI_HAVE: "0.85.1" }, args: ["--dry-run"] });

		expect(undoLine(result)).toContain(`npm rm -g --prefix ${box.prefix} pired @earendil-works/pi-coding-agent ·`);
		expect(undoLine(result)).not.toContain("@earendil-works/pi-coding-agent@0.85.1");
	});

	it("undoes an upgrade in the prefix by reinstalling the version it replaced there, not by removing pi", () => {
		const box = sandbox();
		piInPrefix(box);
		const result = start(box, { env: { PI_HAVE: "0.85.1" }, args: ["--dry-run"] });

		expect(undoLine(result)).toContain(`Undo: npm rm -g --prefix ${box.prefix} pired · rm -rf ~/.pired`);
		expect(undoLine(result)).toContain(`· npm install -g --prefix ${box.prefix} @earendil-works/pi-coding-agent@0.85.1`);
	});

	it("leaves pi out of the undo when the pi it upgrades in place could not say its version, since there is nothing to go back to", () => {
		const box = sandbox();
		piInPrefix(box);
		const result = start(box, { env: { PI_HAVE: "unknown" }, args: ["--dry-run"] });

		expect(result.stdout).toMatch(/\^ pi\s+\S+\s+version unknown -> latest/);
		expect(undoLine(result)).not.toContain("@earendil-works/pi-coding-agent");
	});

	it("upgrades both on a box that has pi 0.85.1 and pi-subagents 0.66.0, pi first", () => {
		const box = sandbox();
		registered(box, ["npm:pi-subagents", "0.66.0"]);
		const result = start(box, { env: { PI_HAVE: "0.85.1" } });

		expect(result.status).toBe(0);
		const upgrade = result.calls.findIndex((call) => call.includes("@earendil-works/pi-coding-agent"));
		const update = result.calls.indexOf("pi update npm:pi-subagents");
		expect(upgrade).toBeGreaterThan(-1);
		expect(update).toBeGreaterThan(upgrade);
		expect(installedVersion(box, "pi-subagents")).toBe("0.71.0");
	});

	it("upgrades a registered npm:pi-subagents whose version cannot be read", () => {
		const box = sandbox();
		registered(box, "npm:pi-subagents");
		const result = start(box);

		expect(result.stdout).toMatch(/\^ subagents\s+~\/\.pi\s+version unknown -> latest/);
		expect(piUpdates(result)).toEqual(["pi update npm:pi-subagents"]);
		expect(result.stdout).toMatch(/ok\s+subagents\s+npm:pi-subagents 0\.71\.0/);
	});

	it("keeps a current npm:pi-subagents without asking pi to update it", () => {
		const box = sandbox();
		registered(box, ["npm:pi-subagents", "0.72.3"]);
		const result = start(box);

		expect(piUpdates(result)).toEqual([]);
		expect(piInstalls(result)).toEqual(["pi install npm:pi-mcp-adapter"]);
		expect(installedVersion(box, "pi-subagents")).toBe("0.72.3");
	});

	it("warns with the retry command when pi update fails, because pired still installs and runs without delegation", () => {
		const box = sandbox();
		registered(box, ["npm:pi-subagents", "0.66.0"]);
		const result = start(box, { env: { PI_UPDATE_FAILS: "1" } });

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("npm:pi-subagents is 0.66.0 — pired's delegation needs >= 0.71.0");
		expect(result.stdout).toContain("retry: pi update npm:pi-subagents");
		expect(result.stdout).toContain("Ready.");
		expect(result.stdout).not.toMatch(/ok\s+subagents/);
	});

	it("does not believe a pi update that reports success and moves nothing, which pi 0.87.1 does under PI_OFFLINE=1", () => {
		const box = sandbox();
		registered(box, ["npm:pi-subagents", "0.66.0"]);
		const result = start(box, { env: { PI_UPDATE_SILENT: "1" } });

		expect(result.status).toBe(0);
		expect(piUpdates(result)).toEqual(["pi update npm:pi-subagents"]);
		expect(result.stdout).toContain("npm:pi-subagents is 0.66.0 — pired's delegation needs >= 0.71.0");
		expect(result.stdout).not.toMatch(/ok\s+subagents/);
	});

	it("warns when a fresh install lands below the floor, rather than calling it installed", () => {
		const box = sandbox();
		const result = start(box, { env: { SUBAGENTS_LATEST: "0.70.1" } });

		expect(result.status).toBe(0);
		expect(piInstalls(result)).toEqual(["pi install npm:pi-subagents", "pi install npm:pi-mcp-adapter"]);
		expect(result.stdout).toContain("npm:pi-subagents is 0.70.1 — pired's delegation needs >= 0.71.0");
		expect(result.stdout).toContain("retry: pi update npm:pi-subagents");
	});

	it("leaves a fork alone whatever its version, and says what pired's delegation needs from it", () => {
		const box = sandbox();
		registered(box, ["npm:@gotgenes/pi-subagents", "0.40.0"]);
		const result = start(box);

		expect(result.status).toBe(0);
		expect(piInstalls(result)).toEqual(["pi install npm:pi-mcp-adapter"]);
		expect(piUpdates(result)).toEqual([]);
		expect(result.stdout).toContain("npm:@gotgenes/pi-subagents — already registered with pi, left alone");
		expect(result.stdout).toContain("pired's delegation needs pi-subagents >= 0.71.0 features");
		expect(installedVersion(box, "@gotgenes/pi-subagents")).toBe("0.40.0");
	});

	it("reads npm:pi-subagents ahead of a fork registered beside it, since that is the one it can upgrade", () => {
		const box = sandbox();
		registered(box, ["npm:@gotgenes/pi-subagents", "0.40.0"], ["npm:pi-subagents", "0.66.0"]);
		const result = start(box);

		expect(piUpdates(result)).toEqual(["pi update npm:pi-subagents"]);
		expect(installedVersion(box, "@gotgenes/pi-subagents")).toBe("0.40.0");
	});

	it("leaves a pinned npm:pi-subagents alone, because pi update does not move a pin and the pin was the operator's", () => {
		const box = sandbox();
		registered(box, ["npm:pi-subagents@0.66.0", "0.66.0"]);
		const result = start(box);

		expect(result.status).toBe(0);
		expect(piInstalls(result)).toEqual(["pi install npm:pi-mcp-adapter"]);
		expect(piUpdates(result)).toEqual([]);
		expect(result.stdout).toContain("npm:pi-subagents@0.66.0 — pinned, left alone");
		expect(result.stdout).toContain("To lift the pin: pi install npm:pi-subagents");
		// Left alone, but not quietly: below the floor pired has no delegation.
		expect(result.stdout).toMatch(/!!\s+subagents\s+npm:pi-subagents@0\.66\.0 — pinned, left alone/);
	});

	it("counts a pin at or above the floor as current", () => {
		const box = sandbox();
		registered(box, ["npm:pi-subagents@0.71.0", "0.71.0"]);
		const result = start(box);

		expect(piUpdates(result)).toEqual([]);
		expect(result.stdout).toMatch(/ok\s+subagents\s+already registered with pi, 0\.71\.0/);
	});

	it("leaves an old pi-subagents alone when PIRED_SKIP_SUBAGENTS=1, the same as a missing one", () => {
		const box = sandbox();
		registered(box, ["npm:pi-subagents", "0.66.0"]);
		const result = start(box, { env: { PIRED_SKIP_SUBAGENTS: "1" } });

		expect(result.status).toBe(0);
		expect(piUpdates(result)).toEqual([]);
		expect(result.stdout).toContain("skipped — PIRED_SKIP_SUBAGENTS=1");
		expect(installedVersion(box, "pi-subagents")).toBe("0.66.0");
	});

	// pired's scope gate checks MCP calls on pi-mcp-adapter's approval-broker
	// event. Below 2.33.0 the adapter did not raise it for a call it had cached
	// as approved for the session, so one grant let later calls past the gate.

	it("installs pi-mcp-adapter after pi-subagents, so the plan's order is the run's order", () => {
		const box = sandbox();
		const result = start(box);

		expect(result.status).toBe(0);
		expect(piInstalls(result)).toEqual(["pi install npm:pi-subagents", "pi install npm:pi-mcp-adapter"]);
		expect(installedVersion(box, "pi-mcp-adapter")).toBe("3.3.0");
		expect(result.stdout).toMatch(/ok\s+mcp\s+npm:pi-mcp-adapter 3\.3\.0/);
		expect(result.stdout).toContain("Ready.");

		const subagentsRow = result.stdout.indexOf("+ subagents");
		const mcpRow = result.stdout.indexOf("+ mcp");
		expect(subagentsRow).toBeGreaterThan(-1);
		expect(mcpRow).toBeGreaterThan(subagentsRow);
	});

	it("names the mcp row in the plan, and names pi's directory in it, because it too writes outside the prefix", () => {
		const box = sandbox();
		const result = start(box, { args: ["--dry-run"] });

		expect(result.status).toBe(0);
		expect(result.stdout).toMatch(/\+ mcp\s+~\/\.pi\s+npm:pi-mcp-adapter — MCP servers through one proxy tool, loads in every pi/);
		expect(undoNext(result)).toBe("pi remove npm:pi-mcp-adapter");
	});

	it("changes nothing in pi on a dry run, even with a pi-mcp-adapter below the floor to update", () => {
		const box = sandbox();
		registered(box, ["npm:pi-mcp-adapter", "2.20.0"]);
		const result = start(box, { args: ["--dry-run"] });

		expect(result.stdout).toMatch(/\^ mcp\s+~\/\.pi\s+2\.20\.0 -> latest\s+\(pired needs >= 2\.33\.0\)/);
		expect(piInstalls(result)).toEqual([]);
		expect(piUpdates(result)).toEqual([]);
		expect(installedVersion(box, "pi-mcp-adapter")).toBe("2.20.0");
		expect(readFileSync(box.registered, "utf8")).toBe("npm:pi-mcp-adapter\n");
	});

	it("declines pi-mcp-adapter when PIRED_SKIP_MCP=1, and stops offering to undo what it did not do", () => {
		const box = sandbox();
		const result = start(box, { env: { PIRED_SKIP_MCP: "1" } });

		expect(result.status).toBe(0);
		expect(piInstalls(result)).toEqual(["pi install npm:pi-subagents"]);
		expect(result.stdout).toContain("skipped — PIRED_SKIP_MCP=1");
		expect(result.stdout).not.toContain("pi remove npm:pi-mcp-adapter");
		expect(undoNext(result)).toBe("");
		expect(result.stdout).toContain("Ready.");
	});

	it("leaves an old pi-mcp-adapter alone when PIRED_SKIP_MCP=1, the same as a missing one", () => {
		const box = sandbox();
		registered(box, ["npm:pi-mcp-adapter", "2.20.0"]);
		const result = start(box, { env: { PIRED_SKIP_MCP: "1" } });

		expect(piUpdates(result)).toEqual([]);
		expect(installedVersion(box, "pi-mcp-adapter")).toBe("2.20.0");
	});

	it.each([
		["PIRED_SKIP_SUBAGENTS", "pi install npm:pi-mcp-adapter"],
		["PIRED_SKIP_MCP", "pi install npm:pi-subagents"],
	])("still installs the other package when %s=1, because each opt-out names one package", (optOut, other) => {
		const box = sandbox();
		const result = start(box, { env: { [optOut]: "1" } });

		expect(result.status).toBe(0);
		expect(piInstalls(result)).toEqual([other]);
		expect(result.stdout).toContain(`skipped — ${optOut}=1`);
	});

	it("leaves an already-registered pi-mcp-adapter at the floor alone rather than installing a second one", () => {
		const box = sandbox();
		registered(box, ["npm:pi-mcp-adapter", "2.33.0"]);
		const result = start(box);

		expect(piInstalls(result)).toEqual(["pi install npm:pi-subagents"]);
		expect(piUpdates(result)).toEqual([]);
		expect(result.stdout).toMatch(/- mcp\s+~\/\.pi\s+2\.33\.0 — already registered with pi/);
		expect(result.stdout).toMatch(/ok\s+mcp\s+already registered with pi, 2\.33\.0/);
		expect(installedVersion(box, "pi-mcp-adapter")).toBe("2.33.0");
	});

	it.each(["npm:@someone/pi-mcp-adapter", "git:github.com/someone/pi-mcp-adapter@v2"])(
		"counts %s as registered, whatever its version, and says what the scope check relies on from it",
		(fork) => {
			const box = sandbox();
			registered(box, [fork, "1.0.0"]);
			const result = start(box);

			expect(result.status).toBe(0);
			expect(piInstalls(result)).toEqual(["pi install npm:pi-subagents"]);
			expect(piUpdates(result)).toEqual([]);
			expect(result.stdout).toContain(`${fork} — already registered with pi, left alone`);
			expect(result.stdout).toContain(
				"pired's MCP scope check relies on the adapter's approval-broker event, which a fork may not have",
			);
		},
	);

	it("is not fooled by a package whose name only resembles the adapter's into thinking MCP is installed", () => {
		const box = sandbox();
		registered(box, "npm:pi-mcp-adapter-extras", "npm:pi-mcp", "npm:@acme/pi-mcp", "git:github.com/someone/pi-mcp-adapters");
		const result = start(box);

		expect(piInstalls(result)).toEqual(["pi install npm:pi-subagents", "pi install npm:pi-mcp-adapter"]);
	});

	it("still finishes the install when pi-mcp-adapter cannot be installed, and pi-subagents is not taken down with it", () => {
		const box = sandbox();
		const result = start(box, { env: { PI_INSTALL_FAILS: "pi-mcp-adapter" } });

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("could not install npm:pi-mcp-adapter — pired works without it");
		expect(result.stdout).toContain("retry: pi install npm:pi-mcp-adapter");
		expect(result.stdout).not.toMatch(/ok\s+mcp/);
		expect(result.stdout).toMatch(/ok\s+subagents\s+npm:pi-subagents 0\.71\.0/);
		expect(result.stdout).toContain("Ready.");
	});

	it("does not claim a pi-mcp-adapter pi reported installing but did not record", () => {
		const box = sandbox();
		const result = start(box, { env: { PI_INSTALL_SILENT: "1" } });

		expect(result.status).toBe(0);
		expect(piInstalls(result)).toContain("pi install npm:pi-mcp-adapter");
		expect(result.stdout).toContain("could not install npm:pi-mcp-adapter");
		expect(result.stdout).not.toMatch(/ok\s+mcp/);
	});

	it.each(["2.20.0", "2.32.9"])(
		"updates an npm:pi-mcp-adapter at %s with pi update, because below 2.33.0 a session grant bypasses the scope check",
		(old) => {
			const box = sandbox();
			registered(box, ["npm:pi-mcp-adapter", old]);
			const result = start(box);

			expect(result.status).toBe(0);
			expect(piUpdates(result)).toEqual(["pi update npm:pi-mcp-adapter"]);
			expect(piInstalls(result)).toEqual(["pi install npm:pi-subagents"]);
			// Read back from disk, not taken from pi's exit code.
			expect(installedVersion(box, "pi-mcp-adapter")).toBe("3.3.0");
			expect(result.stdout).toMatch(new RegExp(`ok\\s+mcp\\s+npm:pi-mcp-adapter ${old.replace(/\./g, "\\.")} -> 3\\.3\\.0`));
			// The operator had it, so the undo goes back to their version rather than removing it.
			expect(undoNext(result)).toBe(`pi install npm:pi-mcp-adapter@${old}  # pins it; pi install npm:pi-mcp-adapter unpins`);
		},
	);

	it("updates a registered npm:pi-mcp-adapter whose version cannot be read", () => {
		const box = sandbox();
		registered(box, "npm:pi-mcp-adapter");
		const result = start(box);

		expect(result.stdout).toMatch(/\^ mcp\s+~\/\.pi\s+version unknown -> latest/);
		expect(piUpdates(result)).toEqual(["pi update npm:pi-mcp-adapter"]);
		expect(result.stdout).toMatch(/ok\s+mcp\s+npm:pi-mcp-adapter 3\.3\.0/);
	});

	it("does not believe a pi update of pi-mcp-adapter that reports success and moves nothing", () => {
		const box = sandbox();
		registered(box, ["npm:pi-mcp-adapter", "2.20.0"]);
		const result = start(box, { env: { PI_UPDATE_SILENT: "1" } });

		expect(result.status).toBe(0);
		expect(piUpdates(result)).toEqual(["pi update npm:pi-mcp-adapter"]);
		expect(result.stdout).toContain("npm:pi-mcp-adapter is 2.20.0 — pired's MCP scope check needs >= 2.33.0");
		expect(result.stdout).toContain("retry: pi update npm:pi-mcp-adapter");
		expect(result.stdout).not.toMatch(/ok\s+mcp/);
		expect(result.stdout).toContain("Ready.");
	});

	it("warns when a fresh pi-mcp-adapter install lands below the floor, rather than calling it installed", () => {
		const box = sandbox();
		const result = start(box, { env: { MCP_LATEST: "2.32.0" } });

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("npm:pi-mcp-adapter is 2.32.0 — pired's MCP scope check needs >= 2.33.0");
		expect(result.stdout).toContain("retry: pi update npm:pi-mcp-adapter");
		// The other package's floor is its own.
		expect(result.stdout).toMatch(/ok\s+subagents\s+npm:pi-subagents 0\.71\.0/);
	});

	it("leaves a pinned npm:pi-mcp-adapter below the floor alone, and warns that the scope check needs 2.33.0", () => {
		const box = sandbox();
		registered(box, ["npm:pi-mcp-adapter@2.20.0", "2.20.0"]);
		const result = start(box);

		expect(result.status).toBe(0);
		expect(piUpdates(result)).toEqual([]);
		expect(piInstalls(result)).toEqual(["pi install npm:pi-subagents"]);
		expect(result.stdout).toMatch(/- mcp\s+~\/\.pi\s+npm:pi-mcp-adapter@2\.20\.0 — pinned, left alone/);
		expect(result.stdout).toContain(
			"pired's MCP scope check needs pi-mcp-adapter >= 2.33.0. To lift the pin: pi install npm:pi-mcp-adapter",
		);
		expect(result.stdout).toMatch(/!!\s+mcp\s+npm:pi-mcp-adapter@2\.20\.0 — pinned, left alone/);
		expect(result.stdout).toContain("pired's MCP scope check needs >= 2.33.0; to lift the pin: pi install npm:pi-mcp-adapter");
		expect(installedVersion(box, "pi-mcp-adapter")).toBe("2.20.0");
	});

	it("counts a pi-mcp-adapter pinned at or above the floor as current", () => {
		const box = sandbox();
		registered(box, ["npm:pi-mcp-adapter@2.33.0", "2.33.0"]);
		const result = start(box);

		expect(piUpdates(result)).toEqual([]);
		expect(result.stdout).toMatch(/ok\s+mcp\s+already registered with pi, 2\.33\.0/);
	});

	it("holds back pi-mcp-adapter on a pi kept below 0.86.1, the same as pi-subagents", () => {
		const box = sandbox();
		const result = start(box, { env: { PI_HAVE: "0.85.1", PIRED_SKIP_PI: "1" } });

		expect(result.status).toBe(0);
		expect(piInstalls(result)).toEqual([]);
		expect(result.stdout).toContain("skipped — pired registers it only on pi >= 0.86.1");
		expect(result.stdout).toContain("held back — pired registers it only on pi >= 0.86.1");
		expect(result.stdout).not.toContain("+ mcp");
		expect(result.stdout).not.toContain("pi remove npm:pi-mcp-adapter");
	});

	it("holds back an old pi-mcp-adapter the same way, and leaves its version on disk alone", () => {
		const box = sandbox();
		registered(box, ["npm:pi-mcp-adapter", "2.20.0"]);
		const result = start(box, { env: { PI_HAVE: "0.85.1", PIRED_SKIP_PI: "1" } });

		expect(piUpdates(result)).toEqual([]);
		expect(result.stdout).toContain("2.20.0 kept — pired updates it only on pi >= 0.86.1");
		expect(installedVersion(box, "pi-mcp-adapter")).toBe("2.20.0");
	});

	it("holds back pi-mcp-adapter at the step when the pi upgrade does not install", () => {
		const box = sandbox();
		const result = start(box, { env: { PI_HAVE: "0.85.1", NPM_PI_FAILS: "1" } });

		expect(result.status).toBe(0);
		expect(piInstalls(result)).toEqual([]);
		expect(result.stdout).toContain("+ mcp");
		expect(result.stdout).toContain("held back — pired registers it only on pi >= 0.86.1");
	});

	it("promises no mcp row it cannot deliver when there is no pi to register it with", () => {
		const box = sandbox();
		const result = start(box, { noPi: true, env: { PIRED_SKIP_PI: "1" } });

		expect(result.status).toBe(0);
		expect(piInstalls(result)).toEqual([]);
		expect(result.stdout).toMatch(/- mcp\s+skipped — no pi to register it with/);
		expect(result.stdout).not.toContain("+ mcp");
		expect(result.stdout).not.toContain("pi remove npm:pi-mcp-adapter");
	});

	it("asks again at the step for pi-mcp-adapter too, and updates one found there instead of promising pi remove", () => {
		const box = sandbox();
		rmSync(join(box.stub, "pi"), { force: true });
		leftBehind(box);
		registered(box, ["npm:pi-mcp-adapter", "2.20.0"]);
		const result = start(box);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("subagents and mcp steps ask it, and upgrade or keep a package they find there.");
		expect(undoLine(result)).toContain("pi remove npm:pi-subagents  # only if the step installs it");
		expect(undoNext(result)).toBe("pi remove npm:pi-mcp-adapter  # only if the step installs it");
		expect(piInstalls(result)).toEqual(["pi install npm:pi-subagents"]);
		expect(piUpdates(result)).toEqual(["pi update npm:pi-mcp-adapter"]);
		expect(result.stdout).toMatch(/ok\s+mcp\s+npm:pi-mcp-adapter 2\.20\.0 -> 3\.3\.0/);
		expect(result.stdout).toContain("undo: pi install npm:pi-mcp-adapter@2.20.0  # pins it; pi install npm:pi-mcp-adapter unpins");
	});

	it("gives each package's undo a line of its own, so one's # comment never swallows the other's command", () => {
		// Both on one line, pasting it ran the first undo and read the second as
		// part of the first's "# pins it" comment.
		const box = sandbox();
		registered(box, ["npm:pi-subagents", "0.66.0"], ["npm:pi-mcp-adapter", "2.20.0"]);
		const upgrade = start(box);

		expect(undoLine(upgrade)).toMatch(/ · pi install npm:pi-subagents@0\.66\.0 {2}# pins it; pi install npm:pi-subagents unpins$/);
		expect(undoNext(upgrade)).toBe("pi install npm:pi-mcp-adapter@2.20.0  # pins it; pi install npm:pi-mcp-adapter unpins");
		expect(installedVersion(box, "pi-mcp-adapter")).toBe("3.3.0");

		// Pasted as printed, comment and all, the next line runs its own command.
		operator(box, undoNext(upgrade));
		expect(readFileSync(box.registered, "utf8")).toBe("npm:pi-subagents\nnpm:pi-mcp-adapter@2.20.0\n");
		expect(installedVersion(box, "pi-mcp-adapter")).toBe("2.20.0");

		// And the pin it leaves is warned about on the next run, not moved.
		writeFileSync(box.calls, "");
		const next = start(box);
		expect(piUpdates(next)).toEqual([]);
		expect(next.stdout).toMatch(/!!\s+mcp\s+npm:pi-mcp-adapter@2\.20\.0 — pinned, left alone/);
	});
});

/**
 * install.ps1 refuses to run anywhere but Windows, so what can be tested off it
 * is what it decides: the file is dot-sourced with its one entry call stripped,
 * and the functions that choose whether to touch pi are called directly.
 *
 * `pwsh` on PATH (or PWSH=<path>) is enough — PowerShell 7 runs on Linux and
 * macOS, and parses the same language Windows PowerShell 5.1 does for
 * everything this file uses.
 */
const POWERSHELL_CHECKS = String.raw`
$ErrorActionPreference = "Stop"
$installer, $registered, $pi, $brokenPi, $absentPi, $packagesRoot, $versionFile = $args

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
# "source" is recorded with nothing on disk; "source|version" is also installed,
# and pi prints its path on the line below, as pi list does.
function Listing([string[]]$packages, [string]$root = $packagesRoot) {
	$lines = @("User packages:")
	foreach ($package in $packages) {
		$source, $version = $package -split '\|', 2
		$lines += "  " + $source
		if (-not $version) { continue }
		$name = ($source -replace '^npm:', '') -replace '@\d.*$', ''
		$directory = Join-Path $root $name
		New-Item -ItemType Directory -Force -Path $directory | Out-Null
		Set-Content -LiteralPath (Join-Path $directory "package.json") -Value ('{"name":"' + $name + '","version":"' + $version + '"}')
		$lines += "    " + $directory
	}
	Set-Content -LiteralPath $registered -Value ($lines -join ([char]10))
}
function Reports([string]$version) { Set-Content -LiteralPath $versionFile -Value $version }
function StateOf([string]$piPath, [bool]$doPi, [bool]$ready = $true) { (Get-SubagentsState -Pi $piPath -DoPi $doPi -PiReady $ready).State }
function McpStateOf([string]$piPath, [bool]$doPi, [bool]$ready = $true) { (Get-McpState -Pi $piPath -DoPi $doPi -PiReady $ready).State }

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

Listing @("npm:pi-subagents@0.66.0|0.66.0")
Check "a pinned package is found by its source, not by the path printed under it" (Test-SubagentsRegistered $pi)

$env:PIRED_SKIP_SUBAGENTS = "1"
Listing @("npm:pi-subagents|0.66.0")
Check "the opt-out wins over everything else" ((StateOf $pi $false) -eq "declined")
$env:PIRED_SKIP_SUBAGENTS = ""

Check "no pi and none coming is not a promise" ((StateOf "" $false) -eq "nopi")
Check "a pi arriving in this run is a box to install into" ((StateOf "" $true) -eq "missing")

Listing @("npm:pi-subagents|0.71.0")
Check "an already-registered package at the floor is left alone" ((StateOf $pi $false) -eq "present")

Listing @("npm:pi-subagents|0.66.0")
$state = Get-SubagentsState -Pi $pi -DoPi $false
Check "a package below the floor is upgraded" ($state.State -eq "old")
Check "and the plan can say from what" ("$($state.Version)" -eq "0.66.0")
Check "but not onto a pi kept below its own floor" ((StateOf $pi $false $false) -eq "held")

Listing @("npm:pi-subagents")
Check "a package with no version on disk to read is upgraded" ((StateOf $pi $false) -eq "old")

Listing @("npm:pi-subagents@0.66.0|0.66.0")
Check "a pin below the floor is left alone, since pi update does not move one" ((StateOf $pi $false) -eq "pinned")
Listing @("npm:pi-subagents@0.71.0|0.71.0")
Check "a pin at the floor is current" ((StateOf $pi $false) -eq "present")

Listing @("npm:@gotgenes/pi-subagents|0.40.0")
Check "a fork is left alone whatever its version" ((StateOf $pi $false) -eq "fork")
Listing @("npm:@gotgenes/pi-subagents|0.40.0", "npm:pi-subagents|0.66.0")
Check "npm:pi-subagents is read ahead of a fork beside it" ((StateOf $pi $false) -eq "old")
Listing @("git:github.com/someone/pi-subagents@v2")
Check "a git checkout is the operator's too" ((StateOf $pi $false) -eq "fork")

Listing @()
Check "a pi with nothing registered gets the package" ((StateOf $pi $false) -eq "missing")
Check "unless it is a pi kept below its floor" ((StateOf $pi $false $false) -eq "held")

# pi-mcp-adapter: the same decisions against its own name and its own floor.
Listing @("npm:pi-mcp-adapter")
Check "finds the adapter pi records" (Test-McpRegistered $pi)
Check "and does not take it for pi-subagents" (-not (Test-SubagentsRegistered $pi))
Listing @("npm:pi-subagents")
Check "nor pi-subagents for the adapter" (-not (Test-McpRegistered $pi))
Listing @("npm:pi-mcp-adapter-extras", "npm:pi-mcp", "npm:@acme/pi-mcp")
Check "is not fooled by a name that only resembles the adapter's" (-not (Test-McpRegistered $pi))

$env:PIRED_SKIP_MCP = "1"
Listing @("npm:pi-mcp-adapter|2.20.0")
Check "the adapter's opt-out declines it" ((McpStateOf $pi $false) -eq "declined")
Check "and only it" ((StateOf $pi $false) -eq "missing")
$env:PIRED_SKIP_MCP = ""
$env:PIRED_SKIP_SUBAGENTS = "1"
Check "pi-subagents' opt-out leaves the adapter alone" ((McpStateOf $pi $false) -eq "old")
$env:PIRED_SKIP_SUBAGENTS = ""

Check "no pi and none coming is no adapter either" ((McpStateOf "" $false) -eq "nopi")
Check "a pi arriving in this run gets the adapter" ((McpStateOf "" $true) -eq "missing")

Listing @("npm:pi-mcp-adapter|2.33.0")
Check "an adapter at 2.33.0 is left alone" ((McpStateOf $pi $false) -eq "present")
Listing @("npm:pi-mcp-adapter|2.32.9")
$state = Get-McpState -Pi $pi -DoPi $false
Check "an adapter below 2.33.0 is updated, since a session grant there bypasses the scope check" ($state.State -eq "old")
Check "and the plan can say from what" ("$($state.Version)" -eq "2.32.9")
Check "but not on a pi kept below pired's floor" ((McpStateOf $pi $false $false) -eq "held")
Listing @("npm:pi-mcp-adapter")
Check "an adapter with no version on disk to read is updated" ((McpStateOf $pi $false) -eq "old")
Listing @("npm:pi-mcp-adapter@2.20.0|2.20.0")
Check "an adapter pinned below the floor is left alone" ((McpStateOf $pi $false) -eq "pinned")
Listing @("npm:@someone/pi-mcp-adapter|1.0.0")
Check "a scoped fork of the adapter is left alone whatever its version" ((McpStateOf $pi $false) -eq "fork")
Listing @("git:github.com/someone/pi-mcp-adapter@v2")
Check "so is a git checkout of it" ((McpStateOf $pi $false) -eq "fork")
Listing @()
Check "a pi kept below its floor gets no adapter" ((McpStateOf $pi $false $false) -eq "held")

Reports "0.85.1"
$state = Get-PiState $pi
Check "a pi below 0.86.1 is upgraded" ($state.State -eq "old")
Check "and the plan can say from what" ("$($state.Version)" -eq "0.85.1")
Reports "0.86.1"
Check "the floor itself is enough" ((Get-PiState $pi).State -eq "present")
Reports "0.87.1"
Check "a newer pi is kept" ((Get-PiState $pi).State -eq "present")
Reports "not a version"
Check "a pi that cannot say is upgraded" ((Get-PiState $pi).State -eq "old")
Check "a pi that fails is upgraded" ((Get-PiState $brokenPi).State -eq "old")
Check "no pi is installed" ((Get-PiState "").State -eq "missing")

$env:PIRED_SKIP_PI = "1"
Reports "0.85.1"
Check "PIRED_SKIP_PI=1 keeps an old pi, to be warned about" ((Get-PiState $pi).State -eq "held")
Check "PIRED_SKIP_PI=1 with no pi declines" ((Get-PiState "").State -eq "declined")
Reports "0.87.1"
Check "PIRED_SKIP_PI=1 changes nothing for a current pi" ((Get-PiState $pi).State -eq "present")
$env:PIRED_SKIP_PI = ""

Check "a pre-release reads as its release" ((ConvertTo-Version "0.86.1-beta.2") -eq [version]"0.86.1")
Check "text with no version is no version" ($null -eq (ConvertTo-Version "garbage"))

# Node writes pi list in UTF-8, and PowerShell decodes it with
# [Console]::OutputEncoding - the OEM code page on a default Windows install.
# Latin-1 stands in for it here. Without UTF-8 for the call, the e-acute in the
# profile path arrives as two characters, Test-Path finds nothing, and a current
# package reads as "version unknown" on every run.
$console = [Console]::OutputEncoding
[Console]::OutputEncoding = [System.Text.Encoding]::GetEncoding("iso-8859-1")
Listing @("npm:pi-subagents|0.71.0") (Join-Path $packagesRoot ("Jos" + [char]0xE9))
Check "a profile path with a non-ASCII letter reads as the path pi printed" ((StateOf $pi $false) -eq "present")
Check "and the console's own encoding is put back after the call" ([Console]::OutputEncoding.WebName -eq "iso-8859-1")
[Console]::OutputEncoding = $console

# The undo line. $prefix stands in for NPM_PREFIX or the %APPDATA%\npm fallback,
# where a bare npm rm -g would act on npm's own prefix instead.
$prefix = Join-Path $packagesRoot "prefix"
function Undo([string]$piState, $piVersion, [bool]$inPrefix, [string]$subagentsState = "present", $subagentsVersion = $null, [bool]$unasked = $false, [string]$mcpState = "present", $mcpVersion = $null, [bool]$mcpUnasked = $false) {
	Get-UndoText -Prefix $prefix -OwnsTree $false -PiState $piState -PiVersion $piVersion -PiInPrefix $inPrefix -SubagentsState $subagentsState -SubagentsVersion $subagentsVersion -SubagentsUnasked $unasked -McpState $mcpState -McpVersion $mcpVersion -McpUnasked $mcpUnasked
}
$bare = "Undo: npm rm -g --prefix " + [char]34 + $prefix + [char]34 + " pired; Remove-Item -Recurse -Force ~\.pired"
Check "a pi that already met the floor is not in the undo" ((Undo "present" ([version]"0.87.1") $false) -eq $bare)
Check "nor is one PIRED_SKIP_PI=1 kept" ((Undo "held" ([version]"0.85.1") $false) -eq $bare)
Check "a pi this run installs is removed from the prefix it went into" ((Undo "missing" $null $false).StartsWith("Undo: npm rm -g --prefix " + [char]34 + $prefix + [char]34 + " pired @earendil-works/pi-coding-agent;"))
Check "so is the new one an upgrade puts in front of a pi outside the prefix" ((Undo "old" ([version]"0.85.1") $false).Contains(" pired @earendil-works/pi-coding-agent;"))
$back = Undo "old" ([version]"0.85.1") $true
Check "an upgrade in the prefix is undone by going back, not by removing pi" ((-not $back.Contains(" pired @earendil-works")) -and $back.EndsWith("; npm install -g --prefix " + [char]34 + $prefix + [char]34 + " @earendil-works/pi-coding-agent@0.85.1"))
Check "and one whose version could not be read is left out" ((Undo "old" $null $true) -eq $bare)
Check "a fresh pi-subagents is removed" ((Undo "present" $null $false "missing").EndsWith("; pi remove npm:pi-subagents"))
Check "an upgraded one goes back, and the undo says that pins it" ((Undo "present" $null $false "old" ([version]"0.66.0")).EndsWith("; pi install npm:pi-subagents@0.66.0  # pins it; pi install npm:pi-subagents unpins"))
Check "one the plan could not see is removed only if the step installs it" ((Undo "missing" $null $false "missing" $null $true).EndsWith("; pi remove npm:pi-subagents  # only if the step installs it"))
Check "a fresh adapter alone rides the Undo line" ((Undo "present" $null $false "present" $null $false "missing").EndsWith("; pi remove npm:pi-mcp-adapter"))
# A package's undo ends its line: the one after takes its own, or pasting the
# first would read the second as part of its # comment.
$both = (Undo "present" $null $false "old" ([version]"0.66.0") $false "old" ([version]"2.20.0")) -split [char]10
Check "a second package's undo gets a line of its own" ($both.Count -eq 2)
Check "the first still ends the Undo line" ($both[0].EndsWith("; pi install npm:pi-subagents@0.66.0  # pins it; pi install npm:pi-subagents unpins"))
Check "and the adapter's goes back to its version beneath it" ($both[1].Trim() -eq "pi install npm:pi-mcp-adapter@2.20.0  # pins it; pi install npm:pi-mcp-adapter unpins")
$unseen = (Undo "missing" $null $false "missing" $null $true "missing" $null $true) -split [char]10
Check "an adapter the plan could not see is removed only if the step installs it" ($unseen[1].Trim() -eq "pi remove npm:pi-mcp-adapter  # only if the step installs it")

$env:PI_CODING_AGENT_DIR = Join-Path $packagesRoot "agent"
Check "no pi to ask and no settings file is a certain missing" (-not (Test-PackageUnasked -Pi "" -State "missing"))
New-Item -ItemType Directory -Force -Path $env:PI_CODING_AGENT_DIR | Out-Null
Set-Content -LiteralPath (Join-Path $env:PI_CODING_AGENT_DIR "settings.json") -Value "{}"
Check "no pi to ask and a settings file left behind is a guess" (Test-PackageUnasked -Pi "" -State "missing")
Check "a pi that was asked is not a guess" (-not (Test-PackageUnasked -Pi $pi -State "missing"))
$env:PI_CODING_AGENT_DIR = ""

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

		// A pi that prints its version and its listing and nothing else, one that
		// fails, and one that is not there — the three answers a real box can give.
		const versionFile = join(box.root, "pi-version");
		writeFileSync(versionFile, "0.87.1\n");
		const listing = join(box.stub, "listing-pi");
		script(
			listing,
			`#!/bin/sh\ncase "$1" in --version) exec cat "${versionFile}" ;; esac\nexec cat "${box.registered}"\n`,
		);
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
				box.packages,
				versionFile,
			],
			{ encoding: "utf8", env: { HOME: box.home, PATH: "/usr/bin:/bin" } },
		);

		expect(output.trim()).toBe("ok");
	});
});

describe("the installers agree with each other", () => {
	const sh = readFileSync(INSTALLER, "utf8");
	const ps1 = readFileSync(join(import.meta.dirname, "install.ps1"), "utf8");

	it("installs the same packages from both scripts", () => {
		expect(sh).toContain('SUBAGENTS_PACKAGE="npm:pi-subagents"');
		expect(ps1).toContain('$SubagentsPackage = "npm:pi-subagents"');
		expect(sh).toContain('MCP_PACKAGE="npm:pi-mcp-adapter"');
		expect(ps1).toContain('$McpPackage = "npm:pi-mcp-adapter"');
	});

	it("holds both scripts to the same floors, because one README states them for both", () => {
		expect(sh).toContain("PI_FLOOR=0.86.1");
		expect(sh).toContain("SUBAGENTS_FLOOR=0.71.0");
		expect(sh).toContain("MCP_FLOOR=2.33.0");
		expect(ps1).toContain('$PiFloor = [version]"0.86.1"');
		expect(ps1).toContain('$SubagentsFloor = [version]"0.71.0"');
		expect(ps1).toContain('$McpFloor = [version]"2.33.0"');
	});

	it("upgrades each package the same way from both scripts, with pi update on the one package", () => {
		expect(sh).toContain('"$PI" update "$SUBAGENTS_PACKAGE"');
		expect(ps1).toContain('@("update", $SubagentsPackage)');
		expect(sh).toContain('"$PI" update "$MCP_PACKAGE"');
		expect(ps1).toContain('@("update", $McpPackage)');
	});

	it("spells the opt-outs the same way on both platforms, because one name is documented for both", () => {
		for (const optOut of ["PIRED_SKIP_SUBAGENTS", "PIRED_SKIP_MCP"]) {
			expect(sh).toContain(optOut);
			expect(ps1).toContain(optOut);
		}
	});

	it("wires each opt-out to its own package in both scripts, not only into the comments that document it", () => {
		expect(sh).toContain("PKG_SKIP=PIRED_SKIP_MCP");
		expect(ps1).toContain('Skip = "PIRED_SKIP_MCP"');
		expect(sh).toContain("PKG_SKIP=PIRED_SKIP_SUBAGENTS");
		expect(ps1).toContain('Skip = "PIRED_SKIP_SUBAGENTS"');
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
		expect(help.stdout).toContain("PIRED_SKIP_MCP");
		// The three that the old `sed -n '2,37p'` cut off.
		expect(help.stdout).toContain("PIRED_SKIP_PI");
		expect(help.stdout).toContain("PIRED_YES");
		expect(help.stdout).toContain("PIRED_NO_ANIM");
		expect(help.stdout).not.toContain("set -eu");
	});
});
