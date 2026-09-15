#!/usr/bin/env node
/**
 * `record` and `recall` for a process that never loaded pired.
 *
 *   pired-ledger recall gaps
 *   pired-ledger record kind=finding title="SQLi in /search" severity=high
 *   pired-ledger scope
 *   pired-ledger pass next
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
import { LEDGER_USAGE, parseLedgerArgv, planPassVerb, renderScope, resultText } from "./ledger.mjs";
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
  const { parseLenses, passState, resolveLadder } = await import(pathToFileURL(join(src, "core", "passes.ts")).href);
  const { makeHostServices } = await import(pathToFileURL(join(src, "extensions", "lib", "host.ts")).href);

  const services = makeHostServices();
  const workspace = await Workspace.open(join(ENG, name), name, services);

  /**
   * The pass a child is working in, read off the disk rather than inherited.
   *
   * A subagent is a separate process with no session state, and the adversarial
   * lens is exactly the work ADR-013 and ADR-014 tell you to delegate — so
   * without this the rows a child writes carry no pass stamp and the per-pass
   * delta undercounts precisely the work that was handed out. The ladder comes
   * from the same scope the parent read; the count comes from the manifest,
   * which is where it lives because a pass outlives a session.
   */
  const scope = loadScope(process.cwd()) ?? (await workspace.readScope().catch(() => undefined));
  const ladder = resolveLadder(scope?.passes, parseLenses(process.env.PIRED_PASSES));
  const pass = ladder ? passState(ladder, await workspace.currentPass()) : undefined;

  /**
   * Opening a pass from outside the TUI.
   *
   * `/pass` is a command handler, so until this existed the pass count could only
   * advance in an interactive session: a headless run could set the ladder with
   * PIRED_PASSES and then sat on pass 1 forever. That is the gap PIRED_SCRIBE was
   * added for one feature earlier — an opt-in mechanism with no headless switch
   * gets measured in its switched-off state — and it is the same gap for anyone
   * driving pired from CI or from the compounding experiment.
   *
   * The report itself is `recall pass`, deliberately: one renderer, so the CLI
   * and the TUI cannot describe the same ladder differently.
   */
  if (plan.verb === "pass") {
    let opening;
    try {
      opening = planPassVerb(plan.args.arg);
    } catch (err) {
      process.stderr.write(`pired-ledger: ${err.message}\n`);
      process.exit(2);
    }
    if (opening.open && !ladder) {
      process.stderr.write(
        "pired-ledger: this engagement runs a single pass, so there is nothing to open.\n" +
        "Give it a ladder in scope.json (\"passes\": { \"enabled\": true }) or with PIRED_PASSES.\n",
      );
      process.exit(2);
    }
    if (opening.open) await workspace.openPass();
    // Re-read after the bump rather than reusing the state resolved above:
    // reporting the pass we were on before opening one is the kind of off-by-one
    // nobody notices until a delta is wrong.
    const opened = ladder ? passState(ladder, await workspace.currentPass()) : undefined;
    const recall = createCoreTools({ workspace, pass: () => opened }).find((t) => t.name === "recall");
    const view = await recall.execute({ query: "pass" }, { cwd: process.cwd(), services });
    process.stdout.write(plan.json ? `${JSON.stringify(view, null, 2)}\n` : `${resultText(view)}\n`);
    process.exit(0);
  }

  const tools = createCoreTools({ workspace, pass: () => pass });
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
