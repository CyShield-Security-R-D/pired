import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const piRoot = resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");
const piCli = join(piRoot, "dist/cli.js");
const loader = pathToFileURL(join(piRoot, "dist/core/extensions/loader.js")).href;

// A checkout has dev dependencies that hide pi's jiti alias resolution failures.
// Pack and install outside the checkout, then use pi's real loader and launcher.
describe.skipIf(process.platform === "win32")("installed package on Linux/macOS", () => {
	let sandbox: string;
	let prefix: string;
	let installed: string;
	let archive: string;
	let env: NodeJS.ProcessEnv;
	const run = (command: string, args: string[], cwd = sandbox) => execFileSync(command, args, {
		cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 45_000,
	});

	beforeAll(() => {
		sandbox = mkdtempSync(join(tmpdir(), "pired-installed-"));
		prefix = join(sandbox, "prefix with spaces");
		installed = join(prefix, "lib/node_modules/pired");
		const home = join(sandbox, "home");
		mkdirSync(home);
		mkdirSync(join(prefix, "bin"), { recursive: true });
		env = {
			HOME: home, PATH: `${join(prefix, "bin")}:${process.env.PATH}`, SHELL: "/bin/sh", TERM: "dumb",
			NPM_PREFIX: prefix, npm_config_prefix: prefix, npm_config_cache: join(sandbox, "npm-cache"),
			npm_config_offline: "true", npm_config_audit: "false", npm_config_fund: "false",
			npm_config_userconfig: join(home, ".npmrc"),
			PI_CODING_AGENT_DIR: join(home, ".pi/agent"), PI_OFFLINE: "1",
			PIRED_SKIP_PI: "1", PIRED_SKIP_SUBAGENTS: "1", PIRED_YES: "1", PIRED_NO_ANIM: "1",
		};
		const packed = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", sandbox], root));
		archive = join(sandbox, packed[0].filename);
		const pi = join(prefix, "bin/pi");
		writeFileSync(pi, `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const child = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(piCli)}, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(child.status ?? 1);
`);
		// Give the shim ESM semantics without installing any runtime dependencies.
		writeFileSync(join(prefix, "package.json"), '{"type":"module"}');
		chmodSync(pi, 0o755);
	}, 60_000);

	afterAll(() => {
		if (sandbox) rmSync(sandbox, { recursive: true, force: true });
	});

	it("upgrades an existing global install and verifies the actual pi extension", () => {
		const old = join(sandbox, "old-pired");
		mkdirSync(old);
		writeFileSync(join(old, "package.json"), JSON.stringify({
			name: "pired", version: "0.0.0", bin: { pired: "pired.mjs" },
		}));
		writeFileSync(join(old, "pired.mjs"), '#!/usr/bin/env node\nconsole.log("old pired");\n');
		run("npm", ["install", "--global", "--ignore-scripts", "--install-links", old]);
		expect(run(join(prefix, "bin/pired"), ["--help"])).toContain("old pired");

		env.PIRED_SOURCE = archive;
		const output = run("/bin/sh", [join(root, "install.sh"), "--yes"]);
		expect(output).toContain("reinstall from");
		expect(output).toContain("pi loaded the pired extension");
		expect(output).toContain("Ready.");
		expect(existsSync(join(installed, "node_modules"))).toBe(false);
		expect(run(join(prefix, "bin/pired"), ["--", "--help"])).toMatch(/^\s*--pired-profile\s/m);
	}, 60_000);

	it("loads both packed extensions through pi without checkout dependencies", () => {
		// Install independently so this check does not depend on test order.
		run("npm", ["install", "--global", "--ignore-scripts", archive]);
		const result = JSON.parse(run(process.execPath, ["--input-type=module", "-e", `
import { loadExtensions } from ${JSON.stringify(loader)};
const result = await loadExtensions([
  ${JSON.stringify(join(installed, "extensions/pired.ts"))},
  ${JSON.stringify(join(installed, "extensions/hosts.ts"))},
], process.cwd());
console.log(JSON.stringify({ errors: result.errors, extensions: result.extensions.map(e => ({
  flags: [...e.flags.keys()], commands: [...e.commands.keys()]
})) }));
`]));
		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(2);
		expect(result.extensions[0].flags).toContain("pired-profile");
		expect(result.extensions[0].commands).toContain("panel");
		expect(result.extensions[1].commands).toContain("provider");
		expect(existsSync(join(installed, "node_modules"))).toBe(false);
	}, 60_000);

	it("rejects an upgrade with the original context-guard import failure", () => {
		run("npm", ["install", "--global", "--ignore-scripts", archive]);
		const broken = join(sandbox, "broken-pired");
		cpSync(installed, broken, { recursive: true });
		const guard = join(broken, "extensions/lib/context-guard.ts");
		writeFileSync(guard, readFileSync(guard, "utf8").replace(
			'from "@earendil-works/pi-ai/compat"',
			'from "@earendil-works/pi-ai/api/openai-completions.lazy"',
		));
		const result = spawnSync("/bin/sh", [join(root, "install.sh"), "--yes"], {
			cwd: sandbox, env: { ...env, PIRED_SOURCE: broken }, encoding: "utf8", timeout: 45_000,
		});
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("pi could not load its extension");
		expect(result.stdout).not.toContain("Ready.");
	}, 60_000);
});
