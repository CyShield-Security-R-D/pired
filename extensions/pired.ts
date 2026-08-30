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
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
	ThemeColor,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, truncateToWidth, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import {
	type BrowserKey, type BrowserState, type BrowserTone, buildBrowserModel,
	initialState, reduceBrowser, renderBrowser,
} from "../core/browser.ts";
import { type BannerTone, renderBanner } from "../core/banner.ts";
import { exportFindingsMarkdown } from "../core/export.ts";
import type { BlockerRecord, Checklist, EngagementScope, Severity, TargetType } from "../core/ontology.ts";
import type { Gate } from "../core/ports.ts";
import { buildSystemPrompt, PIRED_PROFILES, type PiredProfile } from "../core/prompts.ts";
import { createScopeGate } from "../core/scope.ts";
import { renderCoveragePanel, type Tone } from "../core/coverage-panel.ts";
import { dismissHint, PANEL_MODES, renderPanel, type PanelData, type PanelMode, type PanelTone } from "../core/panel.ts";
import { computeCoverageView, computeEngagementStats, coveragePercent, type EngagementStats } from "../core/stats.ts";
import { layoutStatusLine, type Segment } from "../core/statusline.ts";
import { createCoreTools } from "../core/tools.ts";
import { Workspace } from "../core/workspace.ts";
import { execFile } from "node:child_process";
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
const BANNER_TONE_COLOR: Record<BannerTone, ThemeColor> = {
	// "pi" recedes and "red" carries the accent: the name is the two words, and
	// the wordmark should explain itself without a caption.
	pi: "dim", red: "accent", label: "text", muted: "dim", accent: "accent", rule: "dim",
};

const BROWSER_TONE_COLOR: Record<BrowserTone, ThemeColor> = {
	clear: "success", vulnerable: "error", testing: "warning", blocked: "muted",
	"not-tested": "dim", "n/a": "dim", title: "accent", label: "text", muted: "dim",
	// The cursor row. `accent` reads as selection against every shipped theme,
	// and the leading marker stays as a redundant cue where it does not.
	selected: "accent",
};

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

const SEVERITY_COLOR = Object.fromEntries(SEVERITY_INK.map(([sev, , color]) => [sev, color])) as Record<Severity, ThemeColor>;

/**
 * Render a `record` result as a security-native line. A recorded finding is the
 * engagement's actual product, so its severity should be the first thing the
 * operator sees in the transcript rather than generic tool output. Anything
 * else falls back to the tool's own summary text.
 */
function renderRecordResult(result: AgentToolResult<unknown>, _options: ToolRenderResultOptions, theme: Theme): Component {
	const summary = (): string => {
		const first = result.content?.find((c: { type: string }) => c.type === "text");
		return first && "text" in first ? String(first.text) : "";
	};
	let line: string;
	try {
		const d = (result.details ?? {}) as { kind?: string; severity?: Severity; title?: string };
		line =
			d.kind === "finding" && d.severity && d.title
				? `${theme.fg(SEVERITY_COLOR[d.severity] ?? "text", `⦿ ${d.severity.toUpperCase()}`)}  ${theme.fg("text", d.title)}`
				: theme.fg("dim", summary());
	} catch {
		line = summary(); // presentation must never break the transcript
	}
	return {
		render: (width: number): string[] => [truncateToWidth(line, width)],
		invalidate(): void {},
	};
}

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
	// The panel is the operator's view of the ledger, so it is on by default:
	// state you have to summon is state you check less often than you should.
	// `--pired-panel off` (or `pired --no-panel`) starts without it, and `/panel`
	// still toggles it either way.
	pi.registerFlag("pired-banner", {
		description: "show the welcome banner on start: on | off",
		type: "string",
		default: "on",
	});

	pi.registerFlag("pired-panel", { description: "show the engagement panel on start: on | off", type: "string", default: "on" });
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

	// The panel rides in the footer, so showing and hiding it is a boolean and a
	// re-render — no window management, no modal to dismiss. Off by default: the
	// transcript is where trust is built, and a panel nobody asked for competes
	// with it. `/panel` toggles, `/panel <mode>` switches view.
	let panelOpen = false;
	let panelMode: PanelMode = "state";
	let panelData: PanelData | undefined;

	/**
	 * When pired runs inside tmux, `/panel` opens a real full-height side rail
	 * rather than the footer strip. pi exposes only setHeader/setFooter, so a
	 * side panel cannot live inside the TUI — but the terminal multiplexer can
	 * provide one, and the rail renders the same panel from the same state via
	 * bin/pired-state.mjs. Outside tmux the footer variant is the fallback.
	 */
	/** Panel tones mapped onto the active theme's colour roles. */
	const PANEL_TONE_COLOR: Record<PanelTone, Parameters<Theme["fg"]>[0]> = {
		title: "text", label: "dim", muted: "dim", accent: "accent",
		good: "success", warn: "warning", bad: "error",
	};

	let railPane: string | undefined;
	const inTmux = (): boolean => Boolean(process.env.TMUX);

	/**
	 * The in-TUI side rail.
	 *
	 * I concluded three times that pi could not do this — first from setFooter
	 * alone, then from WidgetPlacement being aboveEditor|belowEditor. Both were
	 * true and neither was the whole API: ui.custom takes overlayOptions, and
	 * OverlayAnchor includes right-center, so an overlay can be pinned to the
	 * right edge at a fixed width for the life of the session.
	 *
	 * It floats over the transcript rather than reflowing it — pi's layout root
	 * belongs to pi — but it is a real side panel, present without a multiplexer.
	 * onHandle gives the handle used to close it again.
	 */
	let railHandle: { hide(): void; setHidden(h: boolean): void } | undefined;
	let railDone: (() => void) | undefined;

	/**
	 * Overlay heights are `number | "<n>%"`, and an env var is neither until it is
	 * checked — an unvalidated string here would be a runtime surprise in a
	 * position where a wrong value silently mis-sizes the panel.
	 */
	const railHeight = (): number | `${number}%` => {
		const raw = process.env.PIRED_RAIL_HEIGHT;
		if (!raw) return "50%";
		const pct = /^(\d{1,3})%$/.exec(raw);
		if (pct) return `${Number(pct[1])}%`;
		const rows = Number(raw);
		return Number.isFinite(rows) && rows > 0 ? rows : "50%";
	};

	/**
	 * Rows the banner should reserve so the editor clears the panel.
	 *
	 * Derived from the rail's own maxHeight and offset rather than a constant, so
	 * changing PIRED_RAIL_HEIGHT moves both together. Zero when the panel is off —
	 * there is nothing to clear — and capped so a short terminal is not filled
	 * with blank lines that push the editor off the bottom, which would be a worse
	 * bug than the overlap it fixes.
	 */
	const bannerReserve = (): number => {
		if (String(pi.getFlag("pired-panel") ?? "on").toLowerCase() === "off") return 0;
		const rows = process.stdout.rows ?? 40;
		const h = railHeight();
		const panelRows = typeof h === "number" ? h : Math.floor((rows * Number.parseInt(h, 10)) / 100);
		const RAIL_OFFSET_Y = 1;
		// Leave room for the editor box and the status line beneath it.
		return Math.max(0, Math.min(panelRows + RAIL_OFFSET_Y + 1, rows - 8));
	};

	const openInlineRail = async (ctx: ExtensionContext): Promise<void> => {
		const width = Number(process.env.PIRED_RAIL_WIDTH ?? 56);
		void ctx.ui.custom<void>(
			(_tui, theme, _keybindings, done) => {
				railDone = () => done();
				return {
					render: (w: number): string[] => {
						if (!panelData) return [theme.fg("dim", "pired: no engagement state yet")];
						return renderPanel({
							mode: panelMode,
							data: panelData,
							width: w,
							maxLines: 60,
							frame: true,
							// The panel opens over the transcript — and now does so without
							// being asked — so it owes the operator an exit that works on the
							// machine they are reading it on. See dismissHint.
							hint: dismissHint(process.platform),
							ink: (tone, text) => theme.fg(PANEL_TONE_COLOR[tone], text),
							measure: visibleWidth,
							truncate: (x, ww) => truncateToWidth(x, ww, theme.fg("dim", "…")),
						});
					},
					invalidate(): void {},
					// The rail is a view, not a prompt: it must not capture the keys
					// the operator is using to talk to the agent.
					handleInput(): boolean {
						return false;
					},
				};
			},
			{
				overlay: true,
				// Top-right, not full height. The overlay paints over the transcript
				// rather than reflowing it, so where it sits decides how much it costs
				// you: the newest output and the editor are at the bottom, which is
				// exactly the part you are reading. Anchoring to the top covers older,
				// already-read lines instead.
				//
				// maxHeight caps it at half the screen so a long panel cannot creep
				// down into the live region, and offsetY leaves a row of breathing
				// space at the very top.
				//
				// nonCapturing is load-bearing: ui.custom shows a component WITH
				// keyboard focus by default, so without it the rail silently swallows
				// every keystroke and the app looks frozen. The panel is a view, not
				// a prompt — it must never take the keyboard from the operator.
				overlayOptions: () => ({
					anchor: "top-right",
					width,
					maxHeight: railHeight(),
					offsetY: 1,
					nonCapturing: true,
				}),
				onHandle: (h) => {
					railHandle = h;
					// If the host focuses it anyway, hand the keyboard straight back.
					try {
						(h as { unfocus?: (o?: unknown) => void }).unfocus?.();
					} catch {}
				},
			},
		);
	};

	const closeInlineRail = (): void => {
		try {
			railHandle?.hide();
		} catch {}
		railDone?.();
		railHandle = undefined;
		railDone = undefined;
	};

	const tmuxCmd = (args: string[]): Promise<string> =>
		new Promise((resolve) => {
			execFile("tmux", args, { timeout: 5000 }, (err, stdout) => resolve(err ? "" : String(stdout).trim()));
		});

	const openRail = async (mode: PanelMode): Promise<boolean> => {
		const script = new URL("../bin/pired-state.mjs", import.meta.url).pathname;
		const width = Number(process.env.PIRED_RAIL_WIDTH ?? 64);
		// -d keeps focus in the TUI; -P -F prints the new pane id so it can be
		// closed again on toggle.
		const id = await tmuxCmd([
			"split-window", "-h", "-d", "-P", "-F", "#{pane_id}", "-l", String(width),
			`node --experimental-strip-types ${script} --watch --every 5 --mode ${mode} --width ${width - 2} --lines 60`,
		]);
		if (!id) return false;
		railPane = id;
		return true;
	};

	const closeRail = async (): Promise<void> => {
		if (!railPane) return;
		await tmuxCmd(["kill-pane", "-t", railPane]);
		railPane = undefined;
	};

	const refreshStatus = async (ctx: ExtensionContext): Promise<void> => {
		if (!workspace) return;
		stats = await computeEngagementStats(workspace);
		panelData = await collectPanelData(workspace, scope, stats);
		const parts = [`⦿ ${scope.engagement}`, `findings ${stats.findingsTotal}`];
		if (stats.coveragePct !== undefined) parts.push(`cov ${stats.coveragePct}%`);
		if (stats.blockers > 0) parts.push(`blockers ${stats.blockers}`);
		// Still published through setStatus: it is what pi's own footer renders in
		// non-TUI modes and when our custom footer is not installed.
		ctx.ui.setStatus("pired", parts.join(" · "));
	};

	/**
	 * Ask the operator about a blocker the moment it is recorded.
	 *
	 * The harness is built to never stall: the agent parks a blocker and routes
	 * around it. That works only if the blocker reaches a human — and until now
	 * it was a row in a ledger nobody was looking at, so "never stall" quietly
	 * became "never finish". The dialog closes that loop at the moment the agent
	 * needs the answer, which is also the moment the operator has the context.
	 *
	 * Answers are written back to the same record, so the ledger stays the single
	 * source of truth and a resumed session sees the decision.
	 */
	const promptedBlockers = new Set<string>();
	const promptForNewBlockers = async (ctx: ExtensionContext): Promise<void> => {
		if (!workspace || ctx.mode !== "tui") return;
		let open: BlockerRecord[];
		try {
			open = (await workspace.read("blockers")).filter((b) => b.status === "open");
		} catch {
			return;
		}
		for (const b of open) {
			if (promptedBlockers.has(b.id)) continue;
			promptedBlockers.add(b.id);
			const title = `pired · ${b.type.replace(/-/g, " ")}`;
			const detail = b.context ? `${b.question}\n\n${b.context}` : b.question;
			try {
				let answer: string | undefined;
				if (b.type === "approval") {
					// A yes/no gate — the destructive-action case, where the wrong
					// default is the expensive one, so nothing is pre-selected.
					answer = (await ctx.ui.confirm(title, detail)) ? "approved" : "denied";
				} else if (b.options && b.options.length > 0) {
					answer = await ctx.ui.select(title, [...b.options, "skip for now"]);
					if (answer === "skip for now") answer = undefined;
				} else {
					answer = await ctx.ui.input(title, b.type === "credential-request" ? "value (stored in the workspace)" : "answer");
				}
				if (!answer) continue; // dismissed: the blocker stays open, as it should

				await workspace.append("blockers", {
					...b,
					status: "answered",
					answer,
					answeredAt: new Date().toISOString(),
					answeredBy: "operator",
				});
				await refreshStatus(ctx);
				ctx.ui.notify(`pired: blocker answered — ${b.question.slice(0, 48)}`, "info");
			} catch {
				// A dialog that fails must never take the session with it.
			}
		}
	};

	/**
	 * Gather what the panel shows. Read from the ledger rather than threaded
	 * through the agent: the operator's view of the engagement should not depend
	 * on the agent choosing to report it.
	 */
	const collectPanelData = async (
		ws: Workspace,
		sc: EngagementScope,
		st: EngagementStats,
	): Promise<PanelData> => {
		const inv = await ws.read("inventory");
		const hyps = await ws.read("hypotheses");
		const finds = await ws.read("findings");
		const blockers = (await ws.read("blockers")).filter((b) => b.status === "open");
		const view = await computeCoverageView(ws);
		const settled = view ? view.matrix.counts.clear + view.matrix.counts.vulnerable : 0;
		const tally = <T extends string>(xs: T[]): Record<string, number> => {
			const m: Record<string, number> = {};
			for (const x of xs) m[x] = (m[x] ?? 0) + 1;
			return m;
		};
		const checklist = await ws.readChecklist();
		const TYPE: Record<string, string> = {
			"code-review": "review · source audit",
			web: "pentest · web application",
			api: "pentest · API",
			network: "pentest · network",
		};
		return {
			engagement: sc.engagement,
			engagementType: checklist ? (TYPE[checklist.targetType] ?? checklist.targetType) : undefined,
			scope: { mode: sc.mode, authorized: sc.authorized === true, targets: (sc.targets ?? {}) as Record<string, string[] | undefined> },
			coveragePct: st.coveragePct,
			cells: view?.matrix.applicable,
			settled,
			gaps: view ? view.matrix.counts["not-tested"] + view.matrix.counts.blocked : undefined,
			surface: tally(inv.map((r) => r.kind)),
			hypotheses: tally(hyps.map((h) => h.outcome)),
			findings: st.findings,
			recentFindings: finds.slice(-4).reverse().map((f) => ({ severity: f.severity, title: f.title })),
			openBlockers: blockers.map((b) => ({ question: b.question, priority: b.priority })),
			evidence: 0,
		};
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
						// Panel visibility and mode belong in the cache key: without them a
						// toggle would not repaint until something else happened to change.
						const fullKey = `${key}\u0000${panelOpen ? panelMode : "off"}`;
						if (cache?.key === fullKey) return cache.lines;

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

						const lines: string[] = [];

						// The panel sits above the status line and is strictly budgeted:
						// the footer shares the terminal with the transcript, and a panel
						// that grows without limit silently eats the conversation it is
						// meant to accompany.
						if (panelOpen && panelData) {
							const tone = (t: PanelTone): string => (
								{ title: "text", label: "dim", muted: "dim", accent: "accent", good: "success", warn: "warning", bad: "error" } as Record<PanelTone, string>
							)[t];
							lines.push(
								...renderPanel({
									mode: panelMode,
									data: panelData,
									width,
									maxLines: 8,
									ink: (t, text) => theme.fg(tone(t) as Parameters<typeof theme.fg>[0], text),
									measure: visibleWidth,
									truncate: (x, w) => truncateToWidth(x, w, dim("…")),
								}),
								dim("─".repeat(Math.max(0, Math.min(width, 40)))),
							);
						}

						lines.push(
							layoutStatusLine({
								left,
								right,
								width,
								measure: visibleWidth,
								truncate: truncateToWidth,
								separator: dim(" · "),
							}),
						);
						if (foreign) lines.push(truncateToWidth(dim(foreign), width, dim("…")));
						cache = { key: fullKey, lines };
						return lines;
					} catch {
						return [truncateToWidth(wordmark(theme), width)]; // never crash the frame
					}
				},
			};
		};

	// One-time fx-like UI polish. All guarded: a missing/older pi API must never
	// break pired. The `pired` launcher additionally loads pired's own theme file.
	const applyUiPolish = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") return; // terminal-only; skip in print/rpc/json (headless) modes
		try {
			ctx.ui.setTheme?.("pired"); // no-op unless the theme was loaded (e.g. by `pired run`)
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

		for (const tool of createCoreTools({ workspace })) {
			const presentation = tool.name === "record" ? { renderResult: renderRecordResult } : undefined;
			pi.registerTool(toPiTool(tool, () => services, presentation));
		}
		pi.setActiveTools([...new Set([...pi.getActiveTools(), "record", "recall"])]);

		applyUiPolish(ctx);
		await refreshStatus(ctx);

		// Open the panel unless asked not to. It goes up after refreshStatus so it
		// has real numbers on its first frame rather than flashing an empty shell,
		// and it is guarded like every other UI call: a host without ui.custom
		// simply starts without a panel.
		if (ctx.mode === "tui" && String(pi.getFlag("pired-panel") ?? "on").toLowerCase() !== "off") {
			try {
				await openInlineRail(ctx);
			} catch {}
		}

		// The welcome banner, as a transcript entry rather than a widget.
		//
		// There was a banner widget once and dropping it was right: it held layout
		// forever to repeat a brand the status line already carries. A custom entry
		// is written once, scrolls away like any other, and — being a CustomEntry —
		// never enters the model's context, so the greeting costs no tokens.
		//
		// Last, so the first frame a person sees already has real numbers in it.
		if (ctx.mode === "tui" && String(pi.getFlag("pired-banner") ?? "on").toLowerCase() !== "off") {
			try {
				pi.appendEntry?.("pired-welcome", {
					engagement: scope.engagement,
					profile,
					scope: scope.authorized ? (scope.mode ?? "enforce") : "not authorized",
					model: ctx.model?.id,
					surface: stats?.surface,
					coveragePct: stats?.coveragePct,
					findings: stats?.findingsTotal,
				});
			} catch {}
		}
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

	pi.on("tool_call", async (event, ctx) => {
		const decision = await gate({ name: event.toolName, args: event.input });
		if (decision.allow) return undefined;
		// The refusal reaches the model as a tool result, but the operator needs to
		// see it too: an out-of-scope call that is silently blocked is
		// indistinguishable from the agent simply choosing not to act.
		ctx.ui.notify(`⛨ blocked: ${decision.reason ?? "out of authorized scope"}`, "warning");
		return { block: true, reason: decision.reason, terminate: decision.terminate };
	});

	// Reflect a finding the moment it is recorded rather than at the end of the
	// turn: `record` is the only tool that moves these numbers, so this stays
	// cheap while making a long engagement's status line feel live.
	pi.on("tool_execution_end", async (event, ctx) => {
		if (event.toolName === "record" && !event.isError) {
			await refreshStatus(ctx);
			await promptForNewBlockers(ctx);
		}
	});

	pi.on("turn_end", async (_event, ctx) => {
		await refreshStatus(ctx);
	});

	/**
	 * Show and hide the panel. Deliberately one command with no required
	 * argument: `/panel` toggles, and that is the whole interaction. A view you
	 * have to think about is a view you stop using, and a modal you must dismiss
	 * is worse than no panel at all — which is why this lives in the footer
	 * rather than as an overlay like /coverage.
	 *
	 * `/panel <mode>` jumps straight to a view; `/panel next` cycles. Passing a
	 * mode also opens the panel, so there is no state where naming a view leaves
	 * it hidden.
	 */
	/**
	 * A keypress for the panel, because a view you have to type a command for is
	 * a view you check less often than you should. Every ctrl+letter is taken by
	 * pi or readline — ctrl+g was registered and silently skipped as a conflict —
	 * so alt+p it is, which is at least mnemonic.
	 */
	pi.registerShortcut("alt+p", {
		description: "pired: toggle the engagement panel",
		handler: async (ctx) => {
			await togglePanel("", ctx);
		},
	});

	pi.registerCommand("panel", {
		description: `Toggle the engagement panel (${PANEL_MODES.join(" | ")})`,
		handler: async (args, ctx) => await togglePanel(args ?? "", ctx),
	});

	const togglePanel = async (args: string, ctx: ExtensionContext): Promise<void> => {
		{
			const arg = (args ?? "").trim().toLowerCase();
			// Preference order: the in-TUI rail (works everywhere, no multiplexer),
			// then a tmux pane if explicitly asked for, then the footer strip.
			if (arg !== "footer" && arg !== "tmux") {
				if (railHandle && (!arg || arg === "off")) {
					closeInlineRail();
					ctx.ui.notify("pired: panel hidden", "info");
					return;
				}
				if (arg === "next") {
					panelMode = PANEL_MODES[(PANEL_MODES.indexOf(panelMode) + 1) % PANEL_MODES.length] as PanelMode;
				} else if ((PANEL_MODES as readonly string[]).includes(arg)) {
					panelMode = arg as PanelMode;
				}
				if (workspace && stats) panelData = await collectPanelData(workspace, scope, stats);
				if (railHandle) closeInlineRail();
				if (arg !== "off") {
					await openInlineRail(ctx);
					ctx.ui.notify(`pired: side panel · ${panelMode}`, "info");
				}
				return;
			}

			// `/panel tmux` puts the rail in a multiplexer pane instead — useful when
			// you want it beside the TUI rather than floating over it.
			if (arg === "tmux") {
				if (railPane) {
					await closeRail();
					ctx.ui.notify("pired: tmux panel closed", "info");
				} else if (!inTmux()) {
					ctx.ui.notify("pired: not running inside tmux", "warning");
				} else if (await openRail(panelMode)) {
					ctx.ui.notify(`pired: tmux panel · ${panelMode}`, "info");
				} else {
					ctx.ui.notify("pired: could not open a tmux pane", "warning");
				}
				return;
			}

			// `/panel footer` is the strip — kept because it survives without a
			// multiplexer and without stealing width from the transcript.
			panelOpen = !panelOpen;
			if (panelOpen && workspace && stats) {
				panelData = await collectPanelData(workspace, scope, stats);
			}
			ctx.ui.notify(panelOpen ? `pired: panel · ${panelMode}` : "pired: panel hidden", "info");
		}
	};

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
				ctx.ui.notify(`pired: coverage ${pct}% · ${view.matrix.applicable} cells · ${gaps} gaps`, "info");
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

	/**
	 * Raw terminal input to a semantic key.
	 *
	 * This mapping is the whole reason `core/browser.ts` speaks in names rather
	 * than escape sequences: recognising them needs pi-tui's matchesKey, and
	 * core/ carries no host imports. Vim keys sit alongside the arrows because a
	 * list this dense is navigated by people who never take a hand off home row.
	 */
	const toBrowserKey = (data: string): BrowserKey | undefined => {
		if (matchesKey(data, Key.up) || data === "k") return "up";
		if (matchesKey(data, Key.down) || data === "j") return "down";
		if (matchesKey(data, Key.pageUp)) return "pageUp";
		if (matchesKey(data, Key.pageDown)) return "pageDown";
		if (matchesKey(data, Key.home) || data === "g") return "top";
		if (matchesKey(data, Key.end) || data === "G") return "bottom";
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.right) || data === "l") return "in";
		// Escape is tested after every escape-prefixed sequence above: an arrow key
		// arrives as an escape sequence, so checking it first would close the
		// browser on every press of up.
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.left) || data === "h") return "out";
		if (matchesKey(data, Key.tab)) return "switch";
		if (data === "q") return "close";
		if (data === "a") return "filter:all";
		if (data === "c") return "filter:confirmed";
		if (data === "r") return "filter:refuted";
		if (data === "o") return "filter:open";
		return undefined;
	};

	/** Open the browser at `view`; shared by /surface and /hypotheses. */
	const openBrowser = async (ctx: ExtensionContext, view: "surface" | "hypotheses"): Promise<void> => {
		if (!workspace) {
			ctx.ui.notify("pired: no engagement workspace yet", "warning");
			return;
		}
		const cov = await computeCoverageView(workspace);
		const model = buildBrowserModel({
			engagement: scope.engagement,
			classes: cov?.classes ?? [],
			cells: cov?.matrix.cells ?? [],
			inventory: await workspace.read("inventory"),
			hypotheses: await workspace.read("hypotheses"),
			findings: await workspace.read("findings"),
		});

		if (ctx.mode !== "tui") {
			const c = model.counts;
			ctx.ui.notify(
				`pired: ${model.surface.length} surface element(s) · ${c.all} hypotheses ` +
				`(${c.confirmed} confirmed, ${c.refuted} refuted, ${c.open} open)`,
				"info",
			);
			return;
		}

		let state: BrowserState = initialState(view);
		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => ({
				render: (width: number): string[] => {
					// Chrome is two header lines and two footer lines; the rest is body.
					// stdout.rows is the only height signal a component gets — render()
					// is handed a width and nothing else.
					const rows = Math.max(12, Math.min(process.stdout.rows ?? 30, 46));
					return renderBrowser({
						model, state, width,
						height: Math.max(3, Math.floor(rows * 0.8) - 5),
						ink: (tone, text) => theme.fg(BROWSER_TONE_COLOR[tone], text),
						measure: visibleWidth,
						truncate: (x, ww) => truncateToWidth(x, ww, theme.fg("dim", "…")),
					});
				},
				invalidate(): void {},
				handleInput(data: string): void {
					const key = toBrowserKey(data);
					if (!key) return;
					const next = reduceBrowser(state, key, model, Math.max(3, Math.floor((process.stdout.rows ?? 30) * 0.8) - 5));
					if (next === "close") {
						done();
						return;
					}
					state = next;
					// Without this the component keeps the old frame: pi renders on
					// request, not on a timer.
					tui.requestRender();
				},
			}),
			{ overlay: true, overlayOptions: { width: "90%", minWidth: 48, maxHeight: "80%", anchor: "center" } },
		);
	};

	/**
	 * The welcome entry's renderer.
	 *
	 * A CustomEntry carries data, not lines, so the banner is laid out at render
	 * time against the terminal's real width — resize the window and it reflows
	 * rather than staying frozen at whatever the width was at session start.
	 */
	// Guarded like every other host call: registerEntryRenderer is newer than the
	// rest of the API, and a pi without it must start pired without a banner
	// rather than fail to load the extension at all.
	pi.registerEntryRenderer?.<{
		engagement: string; profile: string; scope: string; model?: string;
		surface?: number; coveragePct?: number; findings?: number;
	}>("pired-welcome", (entry, _options, theme) => {
		const info = entry.data;
		if (!info) return undefined;
		return {
			render: (width: number): string[] =>
				renderBanner({
					info, width,
					minLines: bannerReserve(),
					ink: (tone, text) => theme.fg(BANNER_TONE_COLOR[tone], text),
					measure: visibleWidth,
					truncate: (x, w) => truncateToWidth(x, w, theme.fg("dim", "…")),
				}),
			invalidate(): void {},
		};
	});

	pi.registerCommand("surface", {
		description: "Browse the recorded attack surface and its coverage",
		handler: async (_args, ctx) => { await openBrowser(ctx, "surface"); },
	});

	pi.registerCommand("hypotheses", {
		description: "Browse hypotheses — confirmed, refuted, and still open",
		handler: async (_args, ctx) => { await openBrowser(ctx, "hypotheses"); },
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
