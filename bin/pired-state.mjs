#!/usr/bin/env node
/**
 * Print the engagement panel for an external view.
 *
 *   pired-state.mjs                      # render the panel, once
 *   pired-state.mjs --json               # machine-readable state
 *   pired-state.mjs --mode findings      # pick a view
 *   pired-state.mjs --watch              # redraw every few seconds
 *   pired-state.mjs --engagement acme    # a specific engagement
 *
 * pi's extension API offers a header and a footer, not a side rail, so a genuine
 * side panel has to live outside the TUI — in a tmux pane, a second terminal, a
 * status bar. That only works if pired will tell something else what it knows,
 * which is what this does. Earlier in development the side panel scraped the
 * .jsonl ledgers directly; reading pired's own derivation instead means the
 * panel and the TUI can never disagree.
 */
import { copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENG = join(homedir(), ".pired", "engagements");

/**
 * Node refuses to strip types for any file under node_modules, so a globally
 * installed pired cannot import core/*.ts where it sits. Mirror the sources
 * this needs to a cache outside node_modules and import from there: the same
 * files, one source of truth, and still no build step. It resolves standalone
 * because everything these modules import is either relative or a node builtin.
 *
 * From a checkout there is nothing to stage, so this is a no-op.
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
    // Copy on any difference, so an upgraded package refreshes the cache.
    if (!b || b.mtimeMs < a.mtimeMs || b.size !== a.size) await copyFile(src, dst);
  }
}

async function sourceRoot() {
  if (!ROOT.includes(`${sep}node_modules${sep}`)) return ROOT;
  const stage = join(homedir(), ".pired", "cache", "src");
  for (const dir of SRC_DIRS) await mirrorTs(join(ROOT, dir), join(stage, dir));
  return stage;
}

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  const v = process.argv[i + 1];
  return i >= 0 && v && !v.startsWith("--") ? v : d;
};
const has = (n) => process.argv.includes(`--${n}`);

async function newestEngagement() {
  const dirs = await readdir(ENG).catch(() => []);
  let best, bestT = -1;
  for (const d of dirs) {
    const t = await stat(join(ENG, d)).then((s) => s.mtimeMs).catch(() => -1);
    if (t > bestT) { bestT = t; best = d; }
  }
  return best;
}

async function main() {
  const name = arg("engagement") ?? (await newestEngagement());
  if (!name || !existsSync(join(ENG, name))) {
    process.stderr.write("no engagement found\n");
    process.exit(2);
  }
  const dir = join(ENG, name);

  // Import core through the same type-stripping path the extension uses, so the
  // panel here is rendered by exactly the code the TUI renders.
  const src = await sourceRoot();
  const load = (rel) => import(pathToFileURL(join(src, rel)).href);
  const { Workspace } = await load("core/workspace.ts");
  const { makeHostServices } = await load("extensions/lib/host.ts");
  const { computeEngagementStats, computeCoverageView } = await load("core/stats.ts");
  const { renderPanel } = await load("core/panel.ts");

  const ws = new Workspace(dir, makeHostServices());
  const stats = await computeEngagementStats(ws);
  const view = await computeCoverageView(ws);
  const inv = await ws.read("inventory");
  const hyp = await ws.read("hypotheses");
  const fnd = await ws.read("findings");
  const blk = (await ws.read("blockers")).filter((b) => b.status === "open");
  const checklist = await ws.readChecklist();
  const scope = await ws.readScope();
  const evidence = await readdir(join(dir, "evidence")).then((x) => x.length).catch(() => 0);

  const tally = (xs) => xs.reduce((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
  const TYPE = { "code-review": "review · source audit", web: "pentest · web application", api: "pentest · API", network: "pentest · network" };

  const data = {
    engagement: name,
    engagementType: checklist ? (TYPE[checklist.targetType] ?? checklist.targetType) : undefined,
    scope: scope ? { mode: scope.mode, authorized: scope.authorized === true, targets: scope.targets ?? {} } : undefined,
    coveragePct: stats.coveragePct,
    cells: view?.matrix.applicable,
    settled: view ? view.matrix.counts.clear + view.matrix.counts.vulnerable : undefined,
    gaps: view ? view.matrix.counts["not-tested"] + view.matrix.counts.blocked : undefined,
    surface: tally(inv.map((r) => r.kind)),
    hypotheses: tally(hyp.map((h) => h.outcome)),
    findings: stats.findings,
    recentFindings: fnd.slice(-6).reverse().map((f) => ({ severity: f.severity, title: f.title })),
    openBlockers: blk.map((b) => ({ question: b.question, priority: b.priority })),
    evidence,
  };

  if (has("json")) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }

  const C = { title: "\x1b[1m", body: "", label: "\x1b[2m", muted: "\x1b[2m", accent: "\x1b[36m", good: "\x1b[32m", warn: "\x1b[33m", bad: "\x1b[31m" };
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const width = Number(arg("width", process.env.COLUMNS || "44"));
  const lines = renderPanel({
    mode: arg("mode", "state"),
    data,
    width,
    maxLines: Number(arg("lines", "24")),
    ink: (tone, text) => `${C[tone] ?? ""}${text}\x1b[0m`,
    measure: (s) => strip(s).length,
    // The ellipsis is the difference between "this line was cut" and "the title
    // ends mid-word", which reads as corrupted data rather than as a narrow pane.
    truncate: (s, w) => (strip(s).length <= w ? s : `${strip(s).slice(0, Math.max(0, w - 1))}…`),
    frame: !has("no-frame"),
  });
  process.stdout.write(`${lines.join("\n")}\n`);
}

if (has("watch")) {
  const every = Number(arg("every", "5")) * 1000;
  for (;;) {
    process.stdout.write("\x1b[2J\x1b[H");
    await main().catch((e) => process.stderr.write(`${e.message}\n`));
    await new Promise((r) => setTimeout(r, every));
  }
} else {
  await main();
}
