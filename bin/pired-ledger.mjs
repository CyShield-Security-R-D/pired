#!/usr/bin/env node
/**
 * `record` and `recall` for a process that never loaded pired.
 *
 *   pired-ledger recall gaps
 *   pired-ledger record kind=finding title="SQLi in /search" severity=high
 *   pired-ledger scope
 *
 * A shell, in the sense ADR-006 means: read argv, touch the disk, print. Every
 * decision lives in ledger.mjs, which is covered — this file resolves the
 * engagement, wires the host ports, and hands the same tool objects the
 * extension builds the same args the model would have given them.
 */
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LEDGER_USAGE, parseLedgerArgv, renderScope, resultText } from "./ledger.mjs";
import { pickEngagement } from "./state.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENG = join(homedir(), ".pired", "engagements");

/**
 * Node refuses to strip types under node_modules, so a globally installed pired
 * cannot import core/*.ts where it sits. Same staging cache and same reason as
 * pired-state; from a checkout this is a no-op.
 */
const SRC_DIRS = ["core", join("extensions", "lib")];

async function mirrorTs(from, to) {
  await mkdir(to, { recursive: true });
  for (const name of await readdir(from)) {
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
    const src = join(from, name);
    const dst = join(to, name);
    const a = await stat(src);
    const b = await stat(dst).catch(() => null);
    if (!b || b.mtimeMs < a.mtimeMs || b.size !== a.size) await copyFile(src, dst);
  }
}

async function sourceRoot() {
  if (!ROOT.includes(`${sep}node_modules${sep}`)) return ROOT;
  const stage = join(homedir(), ".pired", "cache", "src");
  for (const dir of SRC_DIRS) await mirrorTs(join(ROOT, dir), join(stage, dir));
  return stage;
}

async function engagementEntries() {
  const dirs = await readdir(ENG).catch(() => []);
  return Promise.all(dirs.map(async (name) => ({
    name,
    mtimeMs: await stat(join(ENG, name)).then((s) => s.mtimeMs).catch(() => -1),
  })));
}

/**
 * The scope the child is working under, read from the target directory.
 *
 * The same two filenames the extension reads, in the same order — a child whose
 * cwd is the target sees what its parent saw.
 */
function loadScope(cwd) {
  for (const rel of ["pired.scope.json", ".pired/scope.json"]) {
    const path = join(cwd, rel);
    if (!existsSync(path)) continue;
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // Malformed is the same as absent here: the caller is told there is no
      // authorization rather than being handed half a boundary.
    }
  }
  return undefined;
}

async function main() {
  let plan;
  try {
    plan = parseLedgerArgv(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`pired-ledger: ${err.message}\n\n${LEDGER_USAGE}`);
    process.exit(2);
  }

  if (plan.help) {
    process.stdout.write(LEDGER_USAGE);
    process.exit(0);
  }

  if (plan.verb === "scope") {
    const scope = loadScope(process.cwd());
    process.stdout.write(plan.json ? `${JSON.stringify(scope ?? null, null, 2)}\n` : `${renderScope(scope)}\n`);
    process.exit(0);
  }

  const asked = plan.engagement;
  const chosen = asked
    ? { name: asked, reason: "asked" }
    : pickEngagement({ cwdName: basename(process.cwd()), entries: await engagementEntries() });
  const name = chosen.name;
  if (!name || !existsSync(join(ENG, name))) {
    process.stderr.write(
      "pired-ledger: no engagement found. Start one with `pired`, or name it with --engagement.\n",
    );
    process.exit(2);
  }

  const src = await sourceRoot();
  const { Workspace } = await import(pathToFileURL(join(src, "core", "workspace.ts")).href);
  const { createCoreTools } = await import(pathToFileURL(join(src, "core", "tools.ts")).href);
  const { makeHostServices } = await import(pathToFileURL(join(src, "extensions", "lib", "host.ts")).href);

  const services = makeHostServices();
  const workspace = await Workspace.open(join(ENG, name), name, services);
  const tools = createCoreTools({ workspace });
  const tool = tools.find((t) => t.name === plan.verb);
  if (!tool) {
    process.stderr.write(`pired-ledger: no ${plan.verb} tool\n`);
    process.exit(2);
  }

  try {
    // A tool reports failure by throwing — there is no in-band error flag on
    // ToolResult — so reaching here is success and the catch below is the only
    // non-zero path.
    const result = await tool.execute(plan.args, { cwd: process.cwd(), services });
    process.stdout.write(plan.json ? `${JSON.stringify(result, null, 2)}\n` : `${resultText(result)}\n`);
  } catch (err) {
    process.stderr.write(`pired-ledger: ${err?.message ?? String(err)}\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`pired-ledger: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
