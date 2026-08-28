/**
 * pired — the security harness as a pi extension. Reuses the harness-agnostic
 * `core/` and bridges it onto pi's ExtensionAPI, so pired inherits pi's whole
 * frontend (TUI, /model switching, /login, themes, sessions, autocomplete, MCP)
 * and only adds the security layer: engagement workspace, scope gate, the
 * security-operator prompt, the record/recall tools, on-demand methodology
 * skills, and a seeded vuln-class checklist that drives the coverage matrix.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { exportFindingsMarkdown } from "../core/export.ts";
import type { Checklist, EngagementScope, Severity, TargetType } from "../core/ontology.ts";
import type { Gate } from "../core/ports.ts";
import { buildSystemPrompt, PIRED_PROFILES, type PiredProfile } from "../core/prompts.ts";
import { createScopeGate } from "../core/scope.ts";
import { renderCoveragePanel, type Tone } from "../core/coverage-panel.ts";
import { computeCoverageView, computeEngagementStats, coveragePercent, type EngagementStats } from "../core/stats.ts";
import { layoutStatusLine, type Segment } from "../core/statusline.ts";
import { createCoreTools } from "../core/tools.ts";
import { Workspace } from "../core/workspace.ts";
import { makeHostServices } from "./lib/host.ts";
import { registerPiredProviders } from "./lib/providers.ts";
import { toPiTool } from "./lib/tools.ts";

/** Package root (this file lives in extensions/). Bundled skills + checklists sit beside it. */
const PIRED_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIR = join(PIRED_ROOT, "skills");
const CHECKLISTS_DIR = join(PIRED_ROOT, "checklists");

// Brand and spinner are drawn through the active theme rather than hardcoded
// truecolor: that way they degrade correctly on 256-color terminals and stay
// legible under whatever theme the operator picks. The two-tone wordmark still
// reads as "pi" + "red" because `accent` is the theme's signal color.
//
// The name IS "pi + red" — the status line renders it as the brand mark, so
// there is no separate banner widget: brand + live stats share one line.
const wordmark = (theme: Theme): string => theme.bold(theme.fg("dim", "pi")) + theme.bold(theme.fg("accent", "red"));

// Animated "working" spinner — a smooth braille cycle. Frames are rendered
// verbatim by pi, so each is colored at setup; intervalMs paces the animation.
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;
const spinnerFrames = (theme: Theme): string[] => SPINNER_FRAMES.map((f) => theme.fg("accent", f));

/**
 * Drop order for the status line as the terminal narrows: `/help` goes first,
 * engagement identity last. Anything without a priority (the wordmark) is
 * mandatory and always survives.
 */
const PRIORITY = {
	help: 1,
	branch: 2,
	/** Only the unarmed ("review") scope label is droppable; an armed gate is mandatory. */
	scope: 3,
	model: 4,
	coverage: 5,
	context: 6,
	findings: 7,
	blockers: 8,
	engagement: 9,
};

/** Coverage-panel tones mapped onto the active theme. */
const TONE_COLOR: Record<Tone, ThemeColor> = {
	clear: "success",
	vulnerable: "error",
	testing: "warning",
	blocked: "muted",
	"not-tested": "dim",
	"n/a": "dim",
	title: "accent",
	label: "text",
	muted: "dim",
};

/** Severity initial + the theme color that carries its weight. */
const SEVERITY_INK: Array<[Severity, string, ThemeColor]> = [
	["critical", "C", "error"],
	["high", "H", "warning"],
	["medium", "M", "text"],
	["low", "L", "dim"],
	["info", "I", "dim"],
];

function defaultScope(profile: PiredProfile, engagement: string): EngagementScope {
	const review = profile === "review";
	return { v: 1, engagement, authorized: review, mode: review ? "off" : "enforce", targets: {} };
}

function expandHome(p: string): string {
	return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

function loadScope(cwd: string, profile: PiredProfile, trusted: boolean): EngagementScope {
	if (trusted) {
		for (const rel of ["pired.scope.json", ".pired/scope.json"]) {
			const p = join(cwd, rel);
			if (!existsSync(p)) continue;
			try {
				const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<EngagementScope>;
				return { v: 1, engagement: basename(cwd) || "engagement", authorized: false, mode: "enforce", targets: {}, ...parsed };
			} catch {
				// fall through to default on malformed config
			}
		}
	}
	return defaultScope(profile, basename(cwd) || "engagement");
}

/**
 * Which built-in checklist seeds the coverage matrix. Review is always code
 * review; otherwise infer from the scope's target shape (hostnames/urls -> web,
 * bare ip/cidr blocks -> network), defaulting to web — the broadest surface.
 * The operator can drop their own checklist.json to override any of this.
 */
function pickTargetType(profile: PiredProfile, scope: EngagementScope): TargetType {
	if (profile === "review") return "code-review";
	const t = scope.targets ?? {};
	const hasWebish = (t.domains?.length ?? 0) > 0 || (t.urls?.length ?? 0) > 0;
	const hasNetish = (t.ips?.length ?? 0) > 0 || (t.cidrs?.length ?? 0) > 0;
	if (hasNetish && !hasWebish) return "network";
	return "web";
}

/** Seed checklist.json from the bundled template for this target type, if the engagement has none yet. */
async function seedChecklist(workspace: Workspace, targetType: TargetType): Promise<void> {
	if (await workspace.readChecklist()) return; // never clobber an existing/edited checklist
	const templatePath = join(CHECKLISTS_DIR, `${targetType}.json`);
	if (!existsSync(templatePath)) return;
	try {
		const checklist = JSON.parse(readFileSync(templatePath, "utf8")) as Checklist;
		if (checklist && Array.isArray(checklist.classes)) await workspace.writeChecklist(checklist);
	} catch {
		// a malformed template is non-fatal: coverage simply stays uncomputed
	}
}

export default function piredExtension(pi: ExtensionAPI): void {
	const services = makeHostServices();
	let profile: PiredProfile = "review";
	let scope: EngagementScope = defaultScope("review", "engagement");
	let gate: Gate = createScopeGate(scope);
	let workspace: Workspace | undefined;
	let checklistClasses: string[] = [];

	pi.registerFlag("pired-profile", { description: "pired profile: review | recon | pentest", type: "string", default: "review" });
	registerPiredProviders(pi);

	// Contribute pired's bundled methodology skills to pi's resource loader. pi
	// discovers each skills/<name>/SKILL.md, advertises them in the system prompt
	// (progressive disclosure), and exposes /skill:<name> — the on-demand
	// methodology layer the small always-on prompt deliberately points to.
	pi.on("resources_discover", () => ({
		skillPaths: existsSync(SKILLS_DIR) ? [SKILLS_DIR] : [],
	}));

	// Live engagement stats, refreshed each turn. Kept structured rather than
	// parsed back out of the status string, so the footer can color each part.
	let stats: EngagementStats | undefined;

	const refreshStatus = async (ctx: ExtensionContext): Promise<void> => {
		if (!workspace) return;
		stats = await computeEngagementStats(workspace);
		const parts = [`⦿ ${scope.engagement}`, `findings ${stats.findingsTotal}`];
		if (stats.coveragePct !== undefined) parts.push(`cov ${stats.coveragePct}%`);
		if (stats.blockers > 0) parts.push(`blockers ${stats.blockers}`);
		// Still published through setStatus: it is what pi's own footer renders in
		// non-TUI modes and when our custom footer is not installed.
		ctx.ui.setStatus("pired", parts.join(" · "));
	};

	/**
	 * The fx-style status line: pired wordmark + live engagement state on the
	 * left, context/model/branch on the right, in one elegant line.
	 *
	 * pi's TUI contract is that render() must return lines no wider than `width`,
	 * so the composition is delegated to `layoutStatusLine`, which sheds
	 * segments by priority and hard-truncates. Width is measured with pi-tui's
	 * ANSI- and wide-character-aware `visibleWidth` — a naive `.length` counts
	 * escape codes and mis-measures CJK/emoji, which is what corrupts a footer.
	 */
	const makeFooter =
		(ctx: ExtensionContext) =>
		(tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			let cache: { key: string; lines: string[] } | undefined;

			return {
				dispose: unsub,
				invalidate(): void {
					cache = undefined; // theme changed: cached lines hold stale color codes
					try {
						// pi calls invalidate() on theme change, so this is also where the
						// spinner gets re-inked - otherwise it keeps the old theme's accent.
						ctx.ui.setWorkingIndicator?.({ frames: spinnerFrames(ctx.ui.theme), intervalMs: SPINNER_INTERVAL_MS });
					} catch {}
				},
				render(width: number): string[] {
					try {
						const branch = footerData.getGitBranch();
						const model = ctx.model?.id;
						const pct = ctx.getContextUsage()?.percent ?? undefined;
						// Replacing pi's footer must not swallow other extensions'
						// statuses — carry them on a second line, as pi's own does.
						const foreign = [...footerData.getExtensionStatuses()]
							.filter(([k]) => k !== "pired")
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => text.replace(/[\r\n\t]+/g, " ").trim())
							.filter(Boolean)
							.join("  ");

						// render() runs every frame (the spinner ticks at 80ms), so skip
						// the work whenever nothing observable has changed.
						const key = [width, theme.name, branch, model, pct, foreign, scope.engagement,
							stats?.findingsTotal, stats?.coveragePct, stats?.blockers,
							profile, scope.mode, scope.authorized,
							...SEVERITY_INK.map(([sev]) => stats?.findings[sev])].join("\u0000");
						if (cache?.key === key) return cache.lines;

						const dim = (text: string): string => theme.fg("dim", text);
						const left: Segment[] = [{ text: wordmark(theme) }];
						left.push({
							text: `${theme.fg("accent", "⦿")} ${theme.fg("text", scope.engagement)}`,
							priority: PRIORITY.engagement,
						});
						if (stats) {
							const st = stats; // local binding: the closure variable will not narrow
							// The count an operator actually needs is "anything critical?",
							// not "how many rows exist" — so lead with the severity spread
							// and keep the bare total as the compact fallback.
							const graded = SEVERITY_INK.filter(([sev]) => st.findings[sev] > 0)
								.map(([sev, initial, color]) => theme.fg(color, `${initial}${st.findings[sev]}`))
								.join(" ");
							left.push({
								text: graded || dim("⚑ 0"),
								compact: dim(`⚑${st.findingsTotal}`),
								priority: PRIORITY.findings,
							});
							if (st.coveragePct !== undefined) {
								left.push({ text: dim(`cov ${st.coveragePct}%`), priority: PRIORITY.coverage });
							}
							if (st.blockers > 0) {
								left.push({ text: theme.fg("warning", `blockers ${st.blockers}`), priority: PRIORITY.blockers });
							}
						}

						// Whether the scope gate is live is the one piece of state that
						// separates this from a coding agent: in an enforcing profile you
						// are a command away from a real client system. Armed states are
						// mandatory segments — they shrink, but they never get shed.
						if (scope.mode === "off") {
							left.push({ text: dim(profile), priority: PRIORITY.scope });
						} else if (scope.mode === "enforce" && !scope.authorized) {
							left.push({ text: theme.fg("error", `⛨ ${profile}·unauthorized`), compact: theme.fg("error", "⛨!") });
						} else {
							const color = scope.mode === "warn" ? "warning" : "accent";
							const label = scope.mode === "warn" ? "warn" : "enforce";
							left.push({
								text: theme.fg(color, `⛨ ${profile}·${label}`),
								compact: theme.fg(color, `⛨${label.slice(0, 3).toUpperCase()}`),
							});
						}

						const right: Segment[] = [];
						if (pct !== undefined) {
							// Same thresholds as pi's built-in footer, so the warning that a
							// long engagement is filling the context window reads identically.
							const color = pct > 90 ? "error" : pct > 70 ? "warning" : "dim";
							right.push({ text: theme.fg(color, `ctx ${pct.toFixed(0)}%`), priority: PRIORITY.context });
						}
						if (model) right.push({ text: dim(model), priority: PRIORITY.model });
						if (branch) right.push({ text: dim(branch), priority: PRIORITY.branch });
						right.push({ text: dim("/help"), priority: PRIORITY.help });

						const lines = [
							layoutStatusLine({
								left,
								right,
								width,
								measure: visibleWidth,
								truncate: truncateToWidth,
								separator: dim(" · "),
							}),
						];
						if (foreign) lines.push(truncateToWidth(dim(foreign), width, dim("…")));
						cache = { key, lines };
						return lines;
					} catch {
						return [truncateToWidth(wordmark(theme), width)]; // never crash the frame
					}
				},
			};
		};

	// One-time fx-like UI polish. All guarded: a missing/older pi API must never
	// break pired. The `pired` launcher additionally loads the fxred theme file.
	const applyUiPolish = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") return; // terminal-only; skip in print/rpc/json (headless) modes
		try {
			ctx.ui.setTheme?.("fxred"); // no-op unless the theme was loaded (e.g. by `pired run`)
		} catch {}
		try {
			ctx.ui.setWorkingIndicator?.({ frames: spinnerFrames(ctx.ui.theme), intervalMs: SPINNER_INTERVAL_MS });
		} catch {}
		try {
			ctx.ui.setHiddenThinkingLabel?.("thinking");
		} catch {}
		try {
			ctx.ui.setTitle?.(`pired · ${scope.engagement}`);
		} catch {}
		try {
			ctx.ui.setFooter?.(makeFooter(ctx));
		} catch {}
	};

	pi.on("session_start", async (_event, ctx) => {
		const flag = pi.getFlag("pired-profile");
		profile = typeof flag === "string" && (PIRED_PROFILES as readonly string[]).includes(flag) ? (flag as PiredProfile) : "review";
		scope = loadScope(ctx.cwd, profile, ctx.isProjectTrusted());
		gate = createScopeGate(scope);

		const dir = scope.workspace ? expandHome(scope.workspace) : join(homedir(), ".pired", "engagements", scope.engagement);
		workspace = await Workspace.open(dir, scope.engagement, services);
		await seedChecklist(workspace, pickTargetType(profile, scope));
		const checklist = await workspace.readChecklist();
		checklistClasses = checklist?.classes.map((c) => c.title || c.id) ?? [];

		for (const tool of createCoreTools({ workspace })) pi.registerTool(toPiTool(tool, () => services));
		pi.setActiveTools([...new Set([...pi.getActiveTools(), "record", "recall"])]);

		applyUiPolish(ctx);
		await refreshStatus(ctx);
	});

	// Chain politely: pi hands us the fully-assembled base prompt (its own agent
	// instructions, loaded skills, project context) plus whatever earlier extensions
	// contributed, in event.systemPrompt. We APPEND pired's security-operator overlay
	// rather than replacing it, so we neither drop pi's base nor clobber other
	// extensions in the chain (BeforeAgentStartEventResult.systemPrompt is chained).
	// Skills are already advertised in the base prompt via resources_discover, so we
	// do not re-list them here — the overlay stays small for local models.
	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${buildSystemPrompt({ profile, scope, checklist: checklistClasses })}`,
	}));

	pi.on("tool_call", async (event) => {
		const decision = await gate({ name: event.toolName, args: event.input });
		if (!decision.allow) return { block: true, reason: decision.reason, terminate: decision.terminate };
		return undefined;
	});

	// Reflect a finding the moment it is recorded rather than at the end of the
	// turn: `record` is the only tool that moves these numbers, so this stays
	// cheap while making a long engagement's status line feel live.
	pi.on("tool_execution_end", async (event, ctx) => {
		if (event.toolName === "record" && !event.isError) await refreshStatus(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		await refreshStatus(ctx);
	});

	pi.registerCommand("coverage", {
		description: "Show the coverage matrix (checklist × surface) for this engagement",
		handler: async (_args, ctx) => {
			if (!workspace) {
				ctx.ui.notify("pired: no engagement workspace yet", "warning");
				return;
			}
			const view = await computeCoverageView(workspace);
			if (!view) {
				ctx.ui.notify("pired: no checklist seeded for this engagement", "warning");
				return;
			}
			// ui.custom renders a terminal component; headless modes get the summary.
			if (ctx.mode !== "tui") {
				const gaps = view.matrix.counts["not-tested"] + view.matrix.counts.blocked;
				const pct = coveragePercent(view.matrix);
				ctx.ui.notify(`pired: coverage ${pct}% · ${view.matrix.cells.length} cells · ${gaps} gaps`, "info");
				return;
			}
			await ctx.ui.custom<void>(
				(_tui, theme, _keybindings, done) => ({
					render: (width: number): string[] =>
						renderCoveragePanel({
							view,
							engagement: scope.engagement,
							width,
							ink: (tone, text) => theme.fg(TONE_COLOR[tone], text),
							measure: visibleWidth,
							truncate: truncateToWidth,
						}),
					invalidate(): void {},
					handleInput(data: string): void {
						if (data === "\x1b" || data === "q" || data === "\r" || data === "\n") done();
					},
				}),
				{ overlay: true, overlayOptions: { width: "80%", minWidth: 40, maxHeight: "80%", anchor: "center" } },
			);
		},
	});

	pi.registerCommand("findings", {
		description: "Export findings to Markdown in the engagement workspace",
		handler: async (_args, ctx) => {
			if (!workspace) {
				ctx.ui.notify("pired: no engagement workspace yet", "warning");
				return;
			}
			const findings = await workspace.read("findings");
			const loot = await workspace.read("loot");
			const markdown = exportFindingsMarkdown({ findings, loot, engagement: scope.engagement, generatedAt: services.clock.nowIso() });
			const rel = await workspace.writeArtifact("findings.md", markdown);
			ctx.ui.notify(`pired: exported ${findings.length} finding(s) -> ${rel}`, "info");
		},
	});
}
