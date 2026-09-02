/**
 * pired — the security harness as a pi extension. Reuses the harness-agnostic
 * `core/` and bridges it onto pi's ExtensionAPI, so pired inherits pi's whole
 * frontend (TUI, /model switching, /login, themes, sessions, autocomplete, MCP)
 * and only adds the security layer: engagement workspace, scope gate, the
 * security-operator prompt, the record/recall tools, on-demand methodology
 * skills, and a seeded vuln-class checklist that drives the coverage matrix.
 */

import { createHash } from "node:crypto";
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
	buildBrowserModel, detailRowCount, elementLabel, initialState, reduceBrowser, renderBrowser, type BrowserKey, type BrowserModel, type BrowserState, type BrowserTone, type BrowserView,
} from "../core/browser.ts";
import { type BannerTone, renderBanner } from "../core/banner.ts";
import { exportFindingsMarkdown, notReportReady } from "../core/export.ts";
import { bannerColumns, BROWSER_CHROME, OVERLAY, OVERLAY_HEIGHT_SHARE, railColumns } from "../core/layout.ts";
import type { BlockerRecord, Checklist, EngagementScope, Severity, TargetType } from "../core/ontology.ts";
import type { Gate, ToolContext, ToolDefinition } from "../core/ports.ts";
import { buildSystemPrompt, PIRED_PROFILES, type PiredProfile } from "../core/prompts.ts";
import { createScopeGate } from "../core/scope.ts";
import { renderCoveragePanel, type Tone } from "../core/coverage-panel.ts";
import { complete } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage, Message, UserMessage } from "@earendil-works/pi-ai/compat";
import { describePlan, type Ledgers, planCompaction } from "../core/dedupe.ts";
import { applyPlan, extractionSystemPrompt, extractionUserMessage, needsRetry, parseExtraction, planExtraction, retryNudge, reviewEviction, reviewWindow, rollCallClasses, shouldExtract } from "../core/extract.ts";
import { dismissHint, PANEL_MODES, renderFindingDetail, renderPanel, scrollFramed, type PanelData, type PanelMode, type PanelTone } from "../core/panel.ts";
import { coverageBrief, renderCoverageBrief } from "../core/coverage.ts";
import { computeCoverageView, computeEngagementStats, coveragePercent, type CoverageView, type EngagementStats } from "../core/stats.ts";
import { layoutStatusLine, scribeStatus, type ScribeState, type Segment } from "../core/statusline.ts";
import { createCoreTools } from "../core/tools.ts";
import { Workspace } from "../core/workspace.ts";
import { execFile } from "node:child_process";
import { makeHostServices } from "./lib/host.ts";
import { apiKeyForProvider, registerPiredProviders } from "./lib/providers.ts";
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
	/** A mode, so it yields to the engagement's own numbers before they yield to it. */
	scribe: 5,
	coverage: 6,
	context: 7,
	findings: 8,
	blockers: 9,
	engagement: 10,
};

/** Coverage-panel tones mapped onto the active theme. */
const BANNER_TONE_COLOR: Record<BannerTone, ThemeColor> = {
	// "pi" recedes and "red" carries the accent: the name is the two words, and
	// the wordmark should explain itself without a caption.
	pi: "dim", red: "accent", label: "text", muted: "dim", accent: "accent", rule: "dim",
};

const BROWSER_TONE_COLOR: Record<BrowserTone, ThemeColor> = {
	clear: "success", vulnerable: "error", testing: "warning", blocked: "muted",
	"not-tested": "dim", "n/a": "dim", title: "accent", label: "text", muted: "dim", body: "text",
	// The cursor row's FOREGROUND fallback, used only when no highlight painter is
	// supplied; the real cursor is a background (see RenderOptions.highlight).
	selected: "accent",
	accent: "accent",
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
	body: "text",
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

/**
 * What to say about findings that would ship with a section missing.
 *
 * One clause, appended to a line that is already being printed: pi's status
 * line replaces the previous one in place, so a second notification would erase
 * the first rather than sit under it.
 */
export function describeUnready(count: number): string {
	return count > 0
		? ` · ${count} need${count === 1 ? "s" : ""} impact + remediation — /skill:ops-technical-writer`
		: "";
}

async function countUnready(ws: Workspace): Promise<string> {
	try {
		return describeUnready(notReportReady(await ws.read("findings")).length);
	} catch {
		// The ledger is unreadable for the moment; the pass itself still reports.
		return "";
	}
}

export default function piredExtension(pi: ExtensionAPI): void {
	const services = makeHostServices();
	let profile: PiredProfile = "review";
	let scope: EngagementScope = defaultScope("review", "engagement");
	let gate: Gate = createScopeGate(scope);
	let workspace: Workspace | undefined;
	let checklistClasses: string[] = [];
	/**
	 * The target model, held in memory rather than read per agent start.
	 *
	 * `before_agent_start` is synchronous and fires on every turn, so the disk
	 * read has to happen somewhere else: at session start, and again whenever the
	 * agent rewrites a section. Both are covered below, and both are the only
	 * ways the file changes during a run.
	 */
	let targetModel = "";

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

	/**
	 * Below this many characters a turn is an exchange, not a review, and running
	 * a second model call over "ok, done" wastes a minute of a consultant's time.
	 */
	const EXTRACT_MIN_REVIEW = 1200;
	let recordTool: ToolDefinition | undefined;
	/**
	 * The engagement's review so far, not just the last turn's.
	 *
	 * An engagement is many turns, and the analysis is spread across them: take
	 * nine ended on a short endpoint listing, so extraction was handed that and
	 * correctly answered "the review only lists endpoints; it does not examine
	 * this class" for all nineteen — a right answer to the wrong question, while
	 * 242 hypotheses' worth of analysis sat in earlier turns it never saw.
	 *
	 * Bounded, because a long engagement would otherwise grow without limit;
	 * reviewEviction() drops whole turns off the front, keeping the tail, which is
	 * where the conclusions live.
	 */
	const reviewTurns: string[] = [];
	/**
	 * What eviction has already thrown away, so the extractor's header can say so.
	 *
	 * There used to be a second, looser cap here (160k) on top of the 40k the
	 * extractor was actually handed, so 120k of buffer was retained and then
	 * discarded before every call. One threshold now, and it means one thing: the
	 * buffer IS the window, bounded by REVIEW_BUDGET at a turn boundary.
	 */
	let reviewDropped = { turns: 0, chars: 0 };
	const reviewSoFar = (): string => reviewWindow(reviewTurns, reviewDropped);
	/** Reviews already extracted, so a quiet turn does not duplicate a previous pass. */
	const extractedAlready = new Set<string>();
	/** Review length when a pass last ran, and how many since wrote nothing. */
	let lastExtractLength = 0;
	let barrenExtractions = 0;
	/** New review a pass needs before it is worth making again. */
	const EXTRACT_GROWTH = 2000;
	/**
	 * Whether the scribe runs on its own.
	 *
	 * OFF by default, which is a reversal, and the reason is where it used to run.
	 * `turn_end` in pi is not the end of the operator's request — it is one
	 * assistant message plus its tool batch, emitted inside the agent's own loop
	 * and awaited by it (`agent-loop.js`: `await emit({ type: "turn_end" })`). A
	 * review that reads thirty files ends thirty turns, and the gate below clears
	 * on 2,000 characters of new prose, which a single turn of visible thinking
	 * passes. So the agent stopped, mid-loop, for a whole second model call, again
	 * and again, on a local server that answers one request at a time. That is not
	 * a background pass; it is the harness taking the machine away from the work.
	 *
	 * Now: opt-in with `/scribe on`, started only once the agent has settled,
	 * never awaited, and abandoned the moment the operator types. What is left in
	 * the hot path is appending a string to an array.
	 *
	 * Session-scoped, like the rest of this state: a new session starts it off.
	 */
	let scribeAuto = false;
	/**
	 * The pass in flight, so a second cannot start and the first can be dropped.
	 *
	 * Held until the promise settles rather than cleared on abort: aborting stops
	 * the model call, but the rows that call already earned are still being
	 * written, and a second pass starting on top of them is how one turn's
	 * analysis gets recorded twice.
	 */
	let scribeRun: { abort: AbortController; done: Promise<void> } | undefined;
	/** Offered once a session: a buffer worth a pass, with nobody running one. */
	let scribeOffered = false;
	/**
	 * A pass the operator asked for, which is not held in `scribeRun` because
	 * nothing may cancel it — but which the status line must still show as work in
	 * progress. `/scribe` on a session with the scribe off would otherwise render
	 * "off" for the whole minute it spends running.
	 */
	let scribeByHand = false;
	/** The one place the three states are decided, so every surface agrees. */
	const scribeState = (): ScribeState => (scribeRun || scribeByHand ? "running" : scribeAuto ? "on" : "off");

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
		title: "text", body: "text", label: "dim", muted: "dim", accent: "accent",
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
	let railHandle: { hide(): void; setHidden(h: boolean): void; focus?(): void; unfocus?(o?: unknown): void } | undefined;
	/**
	 * Maximised: a wider, taller, scrollable rail — still a side panel, not a
	 * takeover.
	 *
	 * The half-screen rail drops whole sections to fit, which is right for a
	 * glance and wrong for reading: twelve findings truncated to three is a
	 * summary of a summary. Maximising renders everything and scrolls it.
	 *
	 * Capturing follows the mode. The rail must never take the keyboard from the
	 * operator, but a scrollable view has to receive arrow keys, so it captures
	 * only while maximised and hands the keyboard back on restore.
	 */
	/**
	 * Named once because two places need the same key: pi routes shortcuts through
	 * the *editor*, so while the maximised rail holds the keyboard alt+m never
	 * reaches the handler that would restore it. The rail has to answer for the
	 * key itself, and a second literal here is a toggle that only goes one way.
	 */
	const MAXIMIZE_KEY = Key.alt("m");
	let railMax = false;
	let railScroll = 0;
	let railSel = 0;
	/** Reading one finding rather than the list. */
	let railDetail = false;
	let railRerender: (() => void) | undefined;
	let railCtx: ExtensionContext | undefined;
	/**
	 * The TUI the rail is drawn on. Its terminal is the one to size against:
	 * process.stdout is a different thing when pired is driven through a pipe or
	 * a multiplexer, and the panel would then be laid out for the wrong screen.
	 */
	let railTui: TUI | undefined;
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
	/**
	 * The rail's height in rows, resolved from whatever railHeight() expresses.
	 *
	 * renderPanel has to be told this number. Given a larger budget it lays out
	 * more sections than the overlay can show, pi clips the overflow, and what
	 * gets clipped is the end of the panel — its closing frame and the dismiss
	 * hint. The panel's own section-dropping is the graceful path and it only
	 * runs when maxLines is honest about the space available.
	 */
	const railRows = (tui?: { terminal?: { rows: number } }): number => {
		// tui.terminal.rows over process.stdout.rows: the TUI knows the size it is
		// actually laying out for, which is not the same thing when pired is driven
		// through a pipe or a multiplexer.
		const rows = tui?.terminal?.rows ?? railTui?.terminal?.rows ?? process.stdout.rows ?? 40;
		if (railMax) return Math.max(6, Math.floor(rows * 0.9));
		const h = railHeight();
		return typeof h === "number" ? h : Math.floor((rows * Number.parseInt(h, 10)) / 100);
	};

	const bannerReserve = (): number => {
		if (String(pi.getFlag("pired-panel") ?? "on").toLowerCase() === "off") return 0;
		const rows = railTui?.terminal?.rows ?? process.stdout.rows ?? 40;
		const cap = railRows();
		// What the panel actually draws, not what it is allowed to draw. A fresh
		// engagement's panel is a third of the height a busy one needs, and
		// reserving the cap regardless is a wall of blank rows above the editor —
		// most visible on a tall screen, where the cap is half of a lot. Line count
		// does not depend on colour or truncation, so the cheapest honest answer is
		// to lay the panel out and count.
		const drawn = panelData
			? renderPanel({
				mode: panelMode, data: panelData, width: railWidth(), maxLines: cap, frame: true, hint: " ",
				ink: (_t, x) => x, measure: visibleWidth, truncate: (x) => x,
			}).length
			: cap;
		const RAIL_OFFSET_Y = 1;
		// The rail's own offset, and one row of margin. The editor lands two rows
		// clear of the rail's bottom border, which is margin enough for a layout
		// whose exact spacing belongs to pi: too small here covers the editor with
		// the panel, too large is a blank row nobody minds.
		return Math.max(0, Math.min(drawn + RAIL_OFFSET_Y, rows - 8));
	};

	/**
	 * Columns for the rail, taken from the terminal it is being drawn on.
	 *
	 * Fixed at 56 it was a sliver on a wide screen — truncating every finding
	 * title with sixty columns sitting empty beside it — and the same 56 was most
	 * of a small one. core/layout.ts holds the share and the caps; PIRED_RAIL_WIDTH
	 * still wins outright.
	 */
	const railWidth = (cols?: number): number => {
		const raw = process.env.PIRED_RAIL_WIDTH;
		const override = raw === undefined ? undefined : Number(raw);
		return railColumns(cols ?? railTui?.terminal?.columns ?? process.stdout.columns ?? 100, override);
	};

	/**
	 * The overlay's geometry, as one object pi holds a reference to.
	 *
	 * ui.custom resolves overlayOptions exactly once: the function form is called
	 * at show time and never again. pi-tui, though, re-reads the fields of the
	 * object it was handed on every frame — so getters, not a function, are what
	 * let alt+m resize a panel that is already open. Without them the maximised
	 * panel laid out a 90%-tall screen of content into an overlay still capped at
	 * 50% and 56 columns, and pi sliced off everything past the cap, including the
	 * "↓ n more" line that says there is more to see. It looked like a panel that
	 * had lost half its content rather than one that had not been resized.
	 */
	const railOverlay = {
		// Top-right, not full height. The overlay paints over the transcript rather
		// than reflowing it, so where it sits decides how much it costs you: the
		// newest output and the editor are at the bottom, which is exactly the part
		// you are reading. Anchoring to the top covers older, already-read lines.
		// offsetY leaves a row of breathing space at the very top.
		anchor: "top-right" as const,
		offsetY: 1,
		get width(): number | `${number}%` {
			return railMax ? "70%" : railWidth();
		},
		get minWidth(): number | undefined {
			return railMax ? 60 : undefined;
		},
		// Restored, maxHeight caps the rail at half the screen so a long panel
		// cannot creep down into the live region.
		get maxHeight(): number | `${number}%` {
			return railMax ? "90%" : railHeight();
		},
		// nonCapturing is load-bearing: ui.custom shows a component WITH keyboard
		// focus by default, so without it the rail silently swallows every keystroke
		// and the app looks frozen. Restored, the panel is a view, not a prompt, and
		// must never take the keyboard from the operator; maximised, it is a
		// scroller and has to receive arrow keys.
		get nonCapturing(): boolean {
			return !railMax;
		},
	};

	/**
	 * Point the keyboard at whichever thing is currently a prompt.
	 *
	 * Both directions have to be asked for explicitly. nonCapturing is only
	 * consulted when the overlay is *shown*, so a rail opened as a view and then
	 * maximised still has focus on the editor and would scroll for nobody. And an
	 * overlay that keeps focus after it stops handling keys is worse than one that
	 * never took it: it swallows every keystroke and the app looks frozen, so
	 * restoring hands the keyboard straight back.
	 */
	/**
	 * The one way in and out of maximised — and it recreates the overlay.
	 *
	 * `nonCapturing` is fixed when the overlay is created. pi re-evaluates
	 * overlayOptions for layout, so flipping it there resizes the panel but never
	 * gives it the keyboard, and `unfocus()` only releases "to the next visible
	 * capturing overlay" — a nonCapturing rail cannot take focus however it is
	 * asked. Toggling therefore tears the overlay down and opens a new one in the
	 * mode wanted, which is also why the rail must remember the context it was
	 * opened with.
	 */
	const setRailMax = async (next: boolean): Promise<void> => {
		railMax = next;
		railScroll = 0;
		railSel = 0;
		railDetail = false;
		const ctx = railCtx;
		try {
			railHandle?.hide();
		} catch {}
		railHandle = undefined;
		railDone = undefined;
		if (ctx) await openInlineRail(ctx).catch(() => {});
	};

	/**
	 * Columns the banner may use: everything left of the panel.
	 *
	 * The panel is an overlay, so pi hands the banner the full terminal width and
	 * then paints the rail on top of its right-hand end — which sliced the wordmark,
	 * the facts and the command list at the column where the rail begins. Narrowing
	 * the banner to the free columns is what puts the two side by side instead of
	 * on top of one another.
	 */
	const bannerWidth = (full: number): number => {
		if (String(pi.getFlag("pired-panel") ?? "on").toLowerCase() === "off") return full;
		return bannerColumns(full, railWidth(full));
	};

	const openInlineRail = async (ctx: ExtensionContext): Promise<void> => {
		// Remembered so a maximise toggle can rebuild the overlay: capturing is
		// fixed at creation, so the only way to change it is to open a new one.
		railCtx = ctx;
		void ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				railTui = tui;
				railDone = () => done();
				railRerender = () => tui.requestRender();
				return {
					render: (w: number): string[] => {
						if (!panelData) return [theme.fg("dim", "pired: no engagement state yet")];
						const rows = railRows(tui);
						const ink = (tone: PanelTone, text: string) => theme.fg(PANEL_TONE_COLOR[tone], text);
						const truncate = (x: string, ww: number) => truncateToWidth(x, ww, theme.fg("dim", "…"));
						const finds = panelData.recentFindings;

						// Reading one finding, in the same frame the list was in. The rail
						// stays a single surface: no second overlay, nothing to find.
						const chosen = finds[railSel];
						if (railMax && railDetail && chosen) {
							return renderFindingDetail({
								finding: chosen, engagement: scope.engagement,
								width: w, maxLines: rows, frame: true,
								hint: "esc back · ↑↓ list · q close",
								ink, measure: visibleWidth, truncate,
							});
						}

						const lines = renderPanel({
							mode: panelMode,
							data: panelData,
							width: w,
							maxLines: railMax ? 4000 : rows,
							expanded: railMax,
							selected: railMax ? railSel : undefined,
							frame: true,
							hint: railMax
								? (finds.length > 0 ? "↑↓ select · ⏎ open · esc restore" : "↑↓ scroll · esc restore")
								: dismissHint(process.platform, w),
							ink, measure: visibleWidth, truncate,
						});
						if (!railMax) return lines;
						const win = scrollFramed(lines, railScroll, rows);
						railScroll = win.scroll;
						return win.below > 0
							? [...win.lines.slice(0, -1), theme.fg("dim", truncateToWidth(`  ↓ ${win.below} more`, w))]
							: win.lines;
					},
					invalidate(): void {},
					handleInput(data: string): boolean {
						// Restored, the rail is a view and must not take the keys the
						// operator is using to talk to the agent.
						if (!railMax) return false;
						const finds = panelData?.recentFindings ?? [];
						const page = Math.max(1, railRows(tui) - 4);

						if (matchesKey(data, MAXIMIZE_KEY)) {
							void setRailMax(false);
							return true;
						}

						if (railDetail) {
							if (matchesKey(data, Key.escape) || matchesKey(data, Key.left) || data === "h") railDetail = false;
							else if (matchesKey(data, Key.up) || data === "k") { railSel = Math.max(0, railSel - 1); }
							else if (matchesKey(data, Key.down) || data === "j") { railSel = Math.min(finds.length - 1, railSel + 1); }
							else if (data === "q") void setRailMax(false);
							else return false;
							tui.requestRender();
							return true;
						}

						if (matchesKey(data, Key.up) || data === "k") {
							// With findings present the cursor moves; without them there is
							// nothing to select and the same key scrolls instead.
							if (finds.length > 0) railSel = Math.max(0, railSel - 1);
							else railScroll -= 1;
						} else if (matchesKey(data, Key.down) || data === "j") {
							if (finds.length > 0) railSel = Math.min(finds.length - 1, railSel + 1);
							else railScroll += 1;
						} else if (matchesKey(data, Key.pageUp)) railScroll -= page;
						else if (matchesKey(data, Key.pageDown)) railScroll += page;
						else if (matchesKey(data, Key.home) || data === "g") { railScroll = 0; railSel = 0; }
						else if (matchesKey(data, Key.end) || data === "G") { railScroll = 1e9; railSel = Math.max(0, finds.length - 1); }
						else if (matchesKey(data, Key.enter) || matchesKey(data, Key.right) || data === "l") {
							if (finds.length === 0) return false;
							railDetail = true;
						} else if (matchesKey(data, Key.escape) || data === "q") {
							void setRailMax(false);
							return true;
						} else return false;
						if (railScroll < 0) railScroll = 0;
						tui.requestRender();
						return true;
					},
				};
			},
			{
				overlay: true,
				// Not a function: pi calls that form once, at show time. See railOverlay.
				overlayOptions: railOverlay,
				onHandle: (h) => {
					railHandle = h;
					// Maximised, the rail is being read and needs the keyboard; restored,
					// it is a view and must never take the keys meant for the agent.
					try {
						if (railMax) h.focus?.();
						else h.unfocus?.();
					} catch {}
					// A rail opened as a view hands the keyboard straight back; one opened
					// maximised keeps it. Unconditional unfocus here is what used to make
					// alt+m-from-closed open a scroller that ignored the arrow keys.
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
		railRerender = undefined;
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
		// Cached for the same reason panelData is: a renderer runs on layout and
		// cannot await a ledger read. The welcome screen draws the matrix, so it
		// has to be here rather than fetched when /coverage is typed.
		coverageView = await computeCoverageView(workspace).catch(() => undefined);
		const parts = [`⦿ ${scope.engagement}`, `findings ${stats.findingsTotal}`];
		if (stats.coveragePct !== undefined) parts.push(`cov ${stats.coveragePct}%`);
		if (stats.blockers > 0) parts.push(`blockers ${stats.blockers}`);
		// A mode that costs a model call is a mode the operator should never have
		// to ask about, and one that is off by default is one they will otherwise
		// assume is on. Said here as well as in the footer, because this is the
		// line pi renders in print and RPC modes and whenever the custom footer
		// is not installed.
		parts.push(scribeStatus(scribeState()).text);
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
	let coverageView: CoverageView | undefined;
	const promptedBlockers = new Set<string>();
	/**
	 * Walk the open blockers and ask.
	 *
	 * `onlyNew` is what separates the two callers. The automatic pass asks once
	 * per blocker and never again — a dialog that reappears every time the agent
	 * records something is a dialog the operator learns to dismiss. `/blockers`
	 * asks about all of them: someone who typed the command is asking to be
	 * asked, including about the ones they waved away an hour ago.
	 *
	 * Returns how many were answered, so a caller can say so.
	 */
	const answerBlockers = async (ctx: ExtensionContext, onlyNew: boolean): Promise<number> => {
		if (!workspace || ctx.mode !== "tui") return 0;
		let open: BlockerRecord[];
		try {
			open = (await workspace.read("blockers")).filter((b) => b.status === "open");
		} catch {
			return 0;
		}
		let answered = 0;
		for (const b of open) {
			if (onlyNew && promptedBlockers.has(b.id)) continue;
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
				answered += 1;
				await refreshStatus(ctx);
				ctx.ui.notify(`pired: blocker answered — ${b.question.slice(0, 48)}`, "info");
			} catch {
				// A dialog that fails must never take the session with it.
			}
		}
		return answered;
	};
	const promptForNewBlockers = async (ctx: ExtensionContext): Promise<void> => {
		await answerBlockers(ctx, true);
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
		// A finding's target is an element id or a raw string; resolving the former
		// is what turns "e1a2b3" into "GET /api/v2/dags" in the detail view.
		const surfaceLabels = new Map<string, string>(
			inv.map((r) => {
				const rec = r as unknown as { id: string; path?: string; value?: string; name?: string };
				return [rec.id, rec.path ?? rec.value ?? rec.name ?? rec.id];
			}),
		);
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
			// Newest first, and enough of them that a maximised panel has something to
			// scroll. The rail still renders three; the cap is here only so a very
			// long engagement cannot make every frame quadratic.
			recentFindings: finds.slice(-200).reverse().map((f) => ({
				severity: f.severity, title: f.title, id: f.id, cwe: f.cwe, class: f.class,
				status: f.status, description: f.description, repro: f.repro,
				evidence: f.evidence,
				// Resolved through the inventory when it is an element id, kept verbatim
				// when it is a raw string. Both exist now that target is optional.
				target: typeof f.target === "string" ? (surfaceLabels.get(f.target) ?? f.target) : undefined,
			})),
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
						const fullKey = `${key}\u0000${panelOpen ? panelMode : "off"}\u0000${scribeState()}`;
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

						// The scribe writes the review into the ledger, and it is off until
						// asked — so the line says so. A background pass that costs a model
						// call must be visible while it runs, and a default that quietly
						// does nothing must be visible while it does not: an operator who
						// believes their findings are being recorded and is wrong finds out
						// at the report, which is far too late.
						const scribe = scribeStatus(scribeState());
						const scribeInk = scribeRun ? (t: string) => theme.fg("accent", t) : dim;
						left.push({ text: scribeInk(scribe.text), compact: scribeInk(scribe.compact), priority: PRIORITY.scribe });

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
								{ title: "text", body: "text", label: "dim", muted: "dim", accent: "accent", good: "success", warn: "warning", bad: "error" } as Record<PanelTone, string>
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
		// Every bash call the agent makes inherits this process's environment, so
		// exporting the workspace here is what makes `> "$PIRED_WORKSPACE/evidence/x"`
		// work in a shell whose cwd is the target. Without it the only way to write
		// evidence where the ledger looks for it is to paste an absolute path.
		process.env.PIRED_WORKSPACE = dir;
		await seedChecklist(workspace, pickTargetType(profile, scope));
		const checklist = await workspace.readChecklist();
		checklistClasses = checklist?.classes.map((c) => c.title || c.id) ?? [];
		// The whole point of the model: a session that starts cold starts knowing
		// what the last one worked out about the target.
		targetModel = await workspace.readModel();

		for (const tool of createCoreTools({ workspace })) {
			const presentation = tool.name === "record" ? { renderResult: renderRecordResult } : undefined;
			// Held so phase two can write through the same tool the model would have
			// called: same validation, same ids, same coverage effect. A second write
			// path is a second set of rules to keep in step.
			if (tool.name === "record") recordTool = tool;
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
					// Collapsed against home here rather than in the renderer: the banner
					// is a pure module and homedir() is a host call.
					cwd: ctx.cwd.startsWith(homedir()) ? `~${ctx.cwd.slice(homedir().length)}` : ctx.cwd,
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
	/** Opening tag of the injected coverage block, and the key for replacing it. */
	const BRIEF_TAG = "<pired-coverage>";

	/**
	 * Put the coverage matrix in front of the agent instead of waiting to be asked.
	 *
	 * Measured across five sessions on three corpus targets: 30 `read` calls, 20
	 * `bash`, 3 `record` — and 1 `recall`. The reviewer reasons well and simply
	 * does not consult the ledger, so a test plan it has to pull is a test plan it
	 * never reads. On one target `cmdi` stayed untested for a whole engagement
	 * beside a `/api/command` the agent had recorded itself.
	 *
	 * This is the "inform" lever, not a script: the block states what the ledger
	 * says and stops there. It ranks nothing and asks for nothing, because
	 * choosing what to test next is the reviewer's judgement and a harness that
	 * ordered the work would be writing the review.
	 *
	 * Re-derived per request and the previous copy dropped, so it cannot go stale
	 * and cannot accumulate — and because it is rebuilt from the ledger rather
	 * than remembered, it survives compaction, which is exactly where the earlier
	 * sessions lost the thread.
	 */
	pi.on("context", async (event) => {
		if (!workspace) return undefined;
		const ws = workspace;
		// Never let situational awareness break the turn it is meant to inform.
		let text = "";
		try {
			const view = await computeCoverageView(ws);
			if (view) {
				const labels = new Map<string, string>();
				for (const rec of await ws.read("inventory")) {
					const label = elementLabel(rec as Parameters<typeof elementLabel>[0]);
					if (label) labels.set(rec.id, label);
				}
				text = renderCoverageBrief(coverageBrief(view.matrix), (id) => labels.get(id));
			}
		} catch { return undefined; }

		const kept = event.messages.filter(
			(m) => !(m.role === "user" && typeof m.content === "string" && m.content.startsWith(BRIEF_TAG)),
		);
		if (text.length === 0) return { messages: kept };
		// Appending after an assistant message that still has tool calls out would
		// split a call from its result, so leave that request alone; the next one
		// carries the same block a moment later.
		const last = kept[kept.length - 1] as { role?: string; content?: unknown } | undefined;
		const pending = last?.role === "assistant" && Array.isArray(last.content)
			&& last.content.some((c) => (c as { type?: string }).type === "toolCall");
		if (pending) return { messages: kept };
		const notice = {
			role: "user" as const,
			content: `${BRIEF_TAG}\nDerived from your ledger and refreshed automatically — no tool call was made for this, and none is required. \`recall gaps\` reads the full matrix when you want the detail.\n\n${text}\n</pired-coverage>`,
			timestamp: Date.now(),
		};
		return { messages: [...kept, notice as unknown as (typeof event.messages)[number]] };
	});

	pi.on("before_agent_start", (event) => {
		// The backstop to the `input` handler: a queued follow-up, a steering
		// message or a command that starts a run never passes through `input`, and
		// every one of them means the model is wanted elsewhere.
		stopScribe();
		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildSystemPrompt({ profile, scope, checklist: checklistClasses, workspace: workspace?.dir, targetModel })}`,
		};
	});

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
	/**
	 * The turn's prose, thinking included.
	 *
	 * pired runs with visible thinking at "high", and on a review most of the
	 * analysis lands in thinking rather than in the final text — the findings list
	 * take four produced, CWEs and CVSS vectors and all, was reasoning. Extracting
	 * only the final message would hand phase two a summary of the work instead of
	 * the work.
	 */
	const assistantText = (message: unknown): string => {
		const content = (message as { content?: unknown } | undefined)?.content;
		if (!Array.isArray(content)) return "";
		const parts: string[] = [];
		for (const item of content) {
			const c = item as { type?: string; text?: string; thinking?: string };
			if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
			else if (c.type === "thinking" && typeof c.thinking === "string") parts.push(c.thinking);
		}
		return parts.join("\n\n").trim();
	};

	/**
	 * A cache identity for the extraction stream.
	 *
	 * Hashed rather than passed raw: it travels as a header value and a
	 * prompt_cache_key, and a workspace path can hold spaces or non-ASCII. Stable
	 * for the life of an engagement, which is exactly the span over which these
	 * prompts share a prefix.
	 */
	const extractionCacheKey = (dir: string): string =>
		`pired-extract-${createHash("sha256").update(dir).digest("hex").slice(0, 16)}`;

	/**
	 * Was this the operator taking the machine back, rather than a failure?
	 *
	 * Runtimes disagree about what an aborted request throws — a DOMException
	 * named "AbortError", a plain Error, or nothing at all because the provider
	 * returned an empty message instead — so the signal is the authority and the
	 * error's shape is only a fallback.
	 */
	const aborted = (err: unknown, signal?: AbortSignal): boolean => {
		if (signal?.aborted) return true;
		const name = (err as { name?: string } | undefined)?.name;
		return name === "AbortError" || name === "TimeoutError";
	};

	/** One run of the scribe: what it is allowed to ask, and how to call it off. */
	interface ScribeOptions {
		/** `manual` says what went wrong out loud; `auto` fails quietly and tries again later. */
		trigger: "auto" | "manual";
		/**
		 * Ask the checklist roll-call as well.
		 *
		 * The sweep is what settles coverage cells, and it is the expensive half:
		 * one JSON row per class, every pass, mostly "not-considered" until the
		 * review has been somewhere. So the automatic pass leaves it out and reads
		 * new prose for findings and surface, and an operator typing `/scribe`
		 * gets it — an explicit ask is exactly when a slower, complete answer is
		 * the one wanted.
		 */
		sweep: boolean;
		/** Tripped when the operator wants the machine back. */
		signal?: AbortSignal;
	}

	/**
	 * Phase two: a fresh single-turn call that converts the review into records.
	 *
	 * Deliberately NOT a tool call. The failure being worked around is that the
	 * model does not emit tool calls late in a long conversation, so asking it to
	 * emit one here would reproduce the bug. It returns JSON; the harness writes.
	 */
	const runScribe = async (ctx: ExtensionContext, review: string, opts: ScribeOptions): Promise<void> => {
		const { trigger, sweep, signal } = opts;
		if (!workspace || !recordTool) return;
		// Bound once: `workspace` is a mutable module-level binding, so the guard's
		// narrowing does not survive into the awaits below.
		const ws = workspace;
		const writeRecord = recordTool;
		const model = ctx.model;
		if (!model) {
			if (trigger === "manual") ctx.ui.notify("pired: no model available to write records with", "warning");
			return;
		}

		// A long engagement ends many turns without settling anything, and each one
		// would re-extract overlapping prose into duplicate rows. Fingerprint what
		// was extracted and skip a repeat.
		const fingerprint = `${sweep ? "sweep" : "pass"}:${review.length}:${review.slice(0, 200)}:${review.slice(-200)}`;
		if (trigger === "auto" && extractedAlready.has(fingerprint)) return;
		extractedAlready.add(fingerprint);
		// Nothing was spent yet, so a pass that stops here must leave no trace:
		// the next idle moment should be free to try the same review again.
		const forget = (): void => {
			extractedAlready.delete(fingerprint);
		};

		const checklist = await ws.readChecklist();
		const classList = checklist?.classes ?? [];
		const classes = classList.map((c) => c.id);
		// Only the classes with a cell still open. A class settled everywhere it
		// applies has no answer left to give, and asking costs a row per pass for
		// the rest of the engagement.
		const rollCall = sweep
			? rollCallClasses(classes, (await computeCoverageView(ws).catch(() => undefined))?.matrix.cells ?? [])
			: [];
		if (signal?.aborted) { forget(); return; }
		// Say which of the two questions is being asked, and how big it is. A pass
		// that takes a minute of a consultant's time should have told them what it
		// went to do — "extracting…" said neither.
		ctx.ui.notify(
			rollCall.length > 0
				? `pired: scribe — writing the review into the ledger, and asking the review about ${rollCall.length} unsettled checklist class(es)…`
				: sweep
					? "pired: scribe — writing the review into the ledger; every checklist class is already settled"
					: "pired: scribe — reading the new review for findings and surface…",
			"info",
		);

		const systemPrompt = extractionSystemPrompt(classes, { rollCall });
		// Already bounded at a turn boundary by the review window; trimming again
		// here would shave characters off the FRONT of a prefix built to stay put.
		const body = extractionUserMessage(review);
		const user = (content: string): UserMessage => ({ role: "user", content, timestamp: Date.now() });

		// Thinking is off for this call. It is a transcription, not a judgement —
		// and a reasoning budget spent deliberating is a budget not spent emitting
		// the object, which is the failure being worked around.
		const ask = async (messages: Message[]): Promise<{ text: string; message: AssistantMessage }> => {
			const answer = await complete(
				model,
				{ systemPrompt, messages },
				// A direct complete() bypasses pi's request pipeline, so what that
				// pipeline would have attached has to be supplied here: the key, and
				// the cache identity. Without a sessionId an OpenAI-compatible provider
				// sends no prompt_cache_key and no affinity headers, so a prefix built
				// to be reused is offered to whichever replica answers.
				//
				// Keyed on the engagement, not the pi session: this is one long series
				// of near-identical prompts spanning every turn of the engagement, and
				// it is deliberately a different stream from the conversation's own.
				// "long" retention because the gap between two passes is a whole agent
				// turn — file reads, scans, tool loops — which routinely outlives a
				// five-minute cache entry. The provider ignores it where unsupported.
				{
					reasoning: "off",
					apiKey: apiKeyForProvider(model.provider),
					sessionId: extractionCacheKey(ws.dir),
					cacheRetention: "long",
					// The operator typing is the one thing that outranks this pass. On a
					// server that answers one request at a time, dropping the connection
					// is also what hands the slot back to the agent they are waiting on.
					signal,
				},
			);
			// complete() does NOT throw on a failed call: it returns a message with
			// stopReason "error" and an empty content array. Treating that as a reply
			// turns "the provider rejected the request" into "no JSON object found in
			// the reply" — which is what a whole take was misdiagnosed as.
			if (answer.stopReason === "error") {
				throw new Error(answer.errorMessage ?? "model call failed with no message");
			}
			// TEXT only, never thinking. assistantText() folds thinking in — right for
			// reading a review, wrong here: reasoning about a JSON object routinely
			// contains a brace, and the parser takes the first one it sees.
			const parts = (answer as { content?: unknown }).content;
			const text = Array.isArray(parts)
				? parts
					.filter((c): c is { type: "text"; text: string } => (c as { type?: string }).type === "text")
					.map((c) => c.text)
					.join("\n")
				: "";
			if (text.trim().length === 0) {
				throw new Error(`model returned no text (stopReason: ${answer.stopReason})`);
			}
			return { text, message: answer };
		};

		let first: { text: string; message: AssistantMessage };
		try {
			first = await ask([user(body)]);
		} catch (err) {
			// An abort is not a failure. The operator sent a prompt, this pass got out
			// of the way, and the review it was reading is still buffered — so it
			// leaves no fingerprint, says nothing, and the next idle moment picks the
			// same work up. Anything else is a real failure worth a line.
			if (aborted(err, signal)) { forget(); return; }
			forget();
			if (trigger === "manual") ctx.ui.notify(`pired: scribe call failed — ${err instanceof Error ? err.message : String(err)}`, "warning");
			return;
		}
		let reply = first.text;

		let parsed = parseExtraction(reply);
		let retryError: string | undefined;
		if (needsRetry(parsed, rollCall.length > 0)) {
			// One retry, as a third message rather than a second prompt. The comment
			// here used to promise "with the reply in context so the model can see
			// what it did" while the code sent a lone user message with the nudge
			// PREPENDED — which put changed text at offset zero and threw away the
			// prefix the first call had just paid to cache. Appending the exchange
			// instead makes the promise true and leaves the body byte-identical, so
			// the retry re-reads it for free.
			// The first live attempt answered a "return JSON" instruction with prose.
			try {
				// Text only on the way back too, for the reason given above and one
				// more: a thinking block replayed into a request is at best noise and
				// at worst a signature the provider rejects. The prose is the point —
				// it is what the model produced instead of the object.
				const echoed: AssistantMessage = {
					...first.message,
					content: first.message.content.filter((c) => c.type === "text"),
				};
				const retry = await ask([user(body), echoed, user(retryNudge())]);
				const second = retry.text;
				if (second.trim().length > 0) {
					const reparsed = parseExtraction(second);
					// Only take the retry if it actually did better; a second helping of
					// prose should not overwrite a first attempt that half-worked.
					const gain = reparsed.extraction.findings.length + reparsed.extraction.classes.length;
					if (gain > 0) { reply = second; parsed = reparsed; }
				}
			} catch (err) {
				// An aborted retry is not a failed one: keep whatever the first reply
				// parsed to and write it, rather than reporting a failure the operator
				// caused by typing.
				if (!aborted(err, signal)) retryError = err instanceof Error ? err.message : String(err);
			}
		}

		// Keep the raw reply whatever happened: an extraction that produced nothing
		// is undiagnosable without seeing what the model actually said, and this is
		// the one artifact that explains it.
		try {
			await ws.writeEvidence(`scribe-${Date.now()}.txt`, reply);
		} catch { /* diagnostics must never break the run */ }

		const { extraction, errors } = parsed;
		if (retryError) errors.push(`retry failed: ${retryError}`);
		// `cwd` is not optional here. `record` resolves a finding's line by reading
		// the file it names, relative to the working directory, and without it that
		// lookup returns immediately — which is why every finding this pass wrote
		// across a whole corpus run carried a filename and no line, and every one
		// was dropped before scoring. The tool context the agent's own calls arrive
		// with has it; this synthetic one has to supply it too.
		const toolCtx: ToolContext = { cwd: ctx.cwd, services, mode: ctx.mode } as unknown as ToolContext;

		// Surface first: hypotheses and findings target elements by label, so the
		// elements have to exist before anything can point at them.
		//
		// Seeded from what is ALREADY recorded, not only from what this pass writes.
		// Phase one usually maps the surface itself — take five recorded fifty-three
		// endpoints — and a target that resolves to no element settles no cell, so
		// mapping only newly-written rows silently produced a coverage number of
		// zero beside a full ledger. The labels come from the same elementLabel()
		// the surface browser displays, so what the extractor echoes back from the
		// review matches what is stored.
		const idFor = new Map<string, string>();
		const inventory = await ws.read("inventory");
		for (const rec of inventory) {
			const label = elementLabel(rec as Parameters<typeof elementLabel>[0]);
			if (label) idFor.set(label, rec.id);
		}
		// A refutation that names no target settles the class across everything
		// recorded — what a consultant means by "we checked for SSTI and it is
		// clean", and what `record` already supports by taking lists.
		const allSurface = inventory
			.filter((r: { kind: string }) => (["endpoint", "host", "service", "param", "tech"] as string[]).includes(r.kind))
			.map((r: { id: string }) => r.id);

		// Which rows to write is decided in core, where it can be tested, and this
		// is all that is left here: hand it the ledger's state, run what comes back.
		// The decisions — which cells a verdict settles, when a class is recovered
		// from a CWE, whether a finding also implies a hypothesis, what is a
		// duplicate — used to live in a hundred lines of loop right here, where
		// nothing could reach them.
		const { records, notes } = planExtraction({
			extraction, known: new Set(idFor.keys()), allSurface, classes: classList,
		});
		errors.push(...notes);
		const applied = await applyPlan(
			records,
			async (args: Record<string, unknown>) => {
				const out = await writeRecord.execute(args, toolCtx);
				const d = (out as { details?: { ids?: string[]; created?: string[] } }).details;
				return {
					ids: Array.isArray(d?.ids) ? d.ids : [],
					created: Array.isArray(d?.created) ? d.created : [],
				};
			},
			idFor,
		);
		errors.push(...applied.errors);
		const wrote = applied.settled + applied.findings;

		await refreshStatus(ctx);
		const dropped = errors.length > 0 ? ` · ${errors.length} row(s) dropped` : "";
		const notConsidered = extraction.classes.filter((v) => v.verdict === "not-considered").length;
		const untouched = notConsidered > 0 ? ` · ${notConsidered} class(es) not considered` : "";
		// This pass reads a review buffer that only grows, so it re-offers what it
		// already extracted last turn. Those rows are folded into the ones they
		// match rather than duplicated, and saying so is the difference between a
		// quiet pass that did nothing and a quiet pass that had nothing new to do.
		const again = applied.repeats > 0 ? ` · ${applied.repeats} already recorded` : "";
		// Said here, on the line the pass already prints, because a second notify
		// would replace this one rather than follow it — and because now is when
		// the reviewer still has the context to write the two paragraphs. The
		// export says the same thing, but by then the report is being handed over.
		// Whether this pass earned another one. A pass that folded rows into what was
		// already there did read new review and find it already captured, which is a
		// result; only a pass that produced nothing at all counts as barren.
		lastExtractLength = review.length;
		if (wrote > 0 || applied.repeats > 0) barrenExtractions = 0;
		else barrenExtractions += 1;

		const unready = await countUnready(ws);
		// What a pass that did not ask the roll-call owes the operator: the reason
		// coverage did not move is that nobody asked it to, and a number that stays
		// at zero without saying why is the failure the roll-call was built for.
		const sweepHint = !sweep && classes.length > 0 ? " · `/scribe` settles the checklist" : "";
		const settled = sweep ? `, ${applied.settled} cells settled` : "";
		ctx.ui.notify(
			wrote > 0
				? `pired: scribe — ${applied.surface} surface${settled}, ${applied.findings} findings${untouched}${again}${dropped}${unready}${sweepHint}`
				: applied.repeats > 0
					? `pired: scribe — nothing new, ${applied.repeats} row(s) already recorded${untouched}${dropped}${sweepHint}`
					: `pired: scribe — nothing to write${dropped ? ` (${errors[0]})` : ""}${sweepHint}`,
			wrote > 0 || applied.repeats > 0 ? "info" : trigger === "manual" ? "warning" : "info",
		);
	};

	/**
	 * Start a pass in the background, and never more than one.
	 *
	 * Not awaited by anything: that is the entire point. The caller is an event
	 * handler the agent loop is waiting on, and a pass that ran inside it would be
	 * the stall this redesign exists to remove.
	 */
	const startScribe = (ctx: ExtensionContext, sweep: boolean): void => {
		// A run that has been called off no longer holds the slot. It may still be
		// draining — writing rows its model call already earned — but it will make
		// no further call, and making the next pass wait on that would cost the
		// engagement a whole idle window for a keystroke. Overlapping writes are
		// what `record`'s identity check is for.
		if (scribeRun && !scribeRun.abort.signal.aborted) return;
		const abort = new AbortController();
		const run = {
			abort,
			done: runScribe(ctx, reviewSoFar(), { trigger: "auto", sweep, signal: abort.signal })
				// A background pass must never take the session down with it, and it has
				// already said anything worth saying.
				.catch(() => {})
				.then(() => {
					if (scribeRun?.abort === abort) scribeRun = undefined;
				}),
		};
		scribeRun = run;
	};

	/**
	 * Drop the pass the moment the operator wants the machine back.
	 *
	 * Only the model call is abandoned. Rows from a call that already answered are
	 * written out — they are paid for, and throwing them away would lose the
	 * engagement's record to a keystroke.
	 */
	const stopScribe = (): void => {
		scribeRun?.abort.abort();
	};

	pi.on("tool_execution_end", async (event, ctx) => {
		if (event.toolName === "record" && !event.isError) {
			const details = (event.result as { details?: { kind?: unknown } } | undefined)?.details;
			// Re-read only when the model actually changed. The next turn's prompt
			// is built from this variable, so a section corrected now is in front of
			// the agent immediately rather than at the next session.
			if (details?.kind === "model" && workspace) targetModel = await workspace.readModel();
			await refreshStatus(ctx);
			await promptForNewBlockers(ctx);
		}
	});

	/**
	 * A turn is not the end of the operator's request: it is one assistant message
	 * plus its tool batch, and pi's agent loop AWAITS this handler before starting
	 * the next one. So the only work allowed here is the work a review cannot
	 * afford to lose — appending this turn's prose to the buffer. Everything that
	 * costs a model call happens once the agent has settled, below.
	 */
	pi.on("turn_end", async (event, ctx) => {
		const review = assistantText(event.message);
		if (review.length > 0) {
			reviewTurns.push(review);
			// Drop from the front, at a turn boundary, and in one chunk: the newest
			// turns carry the conclusions, and the start of the window is the one
			// place a byte may not move if the prefix cache is to hold. See
			// reviewEviction().
			const drop = reviewEviction(reviewTurns);
			if (drop > 0) {
				const gone = reviewTurns.splice(0, drop);
				reviewDropped = {
					turns: reviewDropped.turns + gone.length,
					chars: reviewDropped.chars + gone.reduce((n, t) => n + t.length, 0),
				};
			}
		}
		await refreshStatus(ctx);
	});

	/**
	 * The scribe's moment: pi has finished and will not continue on its own.
	 *
	 * Two rules make this cheap. It is not awaited — `agent_settled` handlers are,
	 * and a pass that blocked here would delay the operator's next prompt instead
	 * of the agent's next turn, which is the same bug wearing a different hat. And
	 * it is gated on new review rather than on the ledger's state: `claims === 0`
	 * and `unanswered > 0` are both permanently true in a real engagement — a
	 * class the roll-call calls "not-considered" is never settled, and an agent
	 * that records nothing itself never raises claims — so together they fired a
	 * pass every single turn. Eighteen on one target, none of which settled
	 * anything, each carrying the whole review buffer to a server that answers one
	 * call at a time.
	 *
	 * With the scribe off — the default — the same gate is what decides the offer
	 * is worth making, so an operator who never turns it on is told once that a
	 * review is sitting in a buffer, and never again.
	 */
	pi.on("agent_settled", async (_event, ctx) => {
		if (!workspace || !recordTool) return;
		if (!shouldExtract({
			reviewLength: reviewSoFar().length,
			lastLength: lastExtractLength,
			barren: barrenExtractions,
			min: EXTRACT_MIN_REVIEW,
			growth: EXTRACT_GROWTH,
		})) return;
		if (!scribeAuto) {
			if (scribeOffered) return;
			scribeOffered = true;
			ctx.ui.notify(
				`pired: ${reviewTurns.length} turn(s) of review buffered and unrecorded — \`/scribe\` writes it to the ledger, \`/scribe on\` does it after every reply`,
				"info",
			);
			return;
		}
		startScribe(ctx, false);
	});

	/**
	 * The operator typed. Whatever the scribe was doing matters less than that.
	 *
	 * On a local server answering one request at a time, dropping this call is
	 * also what hands the slot back to the agent they are now waiting on.
	 */
	pi.on("input", async () => {
		stopScribe();
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
	pi.registerShortcut(MAXIMIZE_KEY, {
		description: "maximize the engagement panel and scroll it",
		handler: async (ctx) => {
			if (ctx.mode !== "tui") return;
			if (!railHandle) {
				// Nothing to maximize yet: open it maximized rather than doing nothing.
				railMax = true;
				railScroll = 0;
				railSel = 0;
				railDetail = false;
				try {
					await openInlineRail(ctx);
				} catch {}
				return;
			}
			await setRailMax(!railMax);
		},
	});

	pi.registerShortcut("alt+p", {
		description: "pired: toggle the engagement panel",
		handler: async (ctx) => {
			await togglePanel("", ctx);
		},
	});

	pi.registerCommand("maximize", {
		description: "Maximize the engagement panel (scrollable); run again to restore",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("pired: the panel is a terminal view; nothing to maximize here", "warning");
				return;
			}
			if (!railHandle) {
				railMax = true;
				railScroll = 0;
				await openInlineRail(ctx).catch(() => {});
				return;
			}
			setRailMax(!railMax);
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
					// Dismissing ends the maximised session too: reopening should give
					// back the glance it was opened as, not a scroller nobody asked for.
					// A mode switch below deliberately keeps it, since that is the same
					// reading session with a different view in it.
					railMax = false;
					railScroll = 0;
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

	/**
	 * Rows an 80%-height overlay actually gets.
	 *
	 * tui.terminal.rows over process.stdout.rows for the reason railRows gives:
	 * under tmux or a pipe the TUI knows the size it is laying out for and the
	 * process's stdout does not. One expression, because the browser had two that
	 * disagreed — it clamped rows to 46 when rendering but not when paging, so on
	 * a taller terminal the cursor walked off the bottom of the drawn window.
	 */
	const overlayRows = (tui?: { terminal?: { rows: number } }): number => {
		const rows = tui?.terminal?.rows ?? railTui?.terminal?.rows ?? process.stdout.rows ?? 30;
		// No floor: pi slices at exactly this number, so claiming more than it will
		// show is how the closing border and the legend get cut on a short terminal.
		return Math.max(1, Math.floor(rows * OVERLAY_HEIGHT_SHARE));
	};

	pi.registerCommand("coverage", {
		description: "Browse the coverage matrix — checklist × surface, with drill-down",
		handler: async (_args, ctx) => {
			if (!workspace) {
				ctx.ui.notify("pired: no engagement workspace yet", "warning");
				return;
			}
			// Headless modes get the summary; only a TUI can browse. The matrix is read
			// here ONLY for that summary — openBrowser builds its own model, so doing
			// this unconditionally read every ledger twice per /coverage.
			if (ctx.mode !== "tui") {
				const view = await computeCoverageView(workspace);
				if (!view) {
					ctx.ui.notify("pired: no checklist seeded for this engagement", "warning");
					return;
				}
				const gaps = view.matrix.counts["not-tested"] + view.matrix.counts.blocked;
				const pct = coveragePercent(view.matrix);
				ctx.ui.notify(`pired: coverage ${pct}% · ${view.matrix.applicable} cells · ${gaps} gaps`, "info");
				return;
			}
			// The matrix used to be a static overlay whose entire input handler was
			// "close" — the one view in the tool you could not scroll, filter or open
			// anything from, while its siblings were full browsers. It is the
			// transpose of the surface view over a model that already holds it, so it
			// is a view of the browser rather than a screen of its own; that also
			// gives it the frame, the cursor and tab-cycling for free.
			//
			// renderCoveragePanel keeps its real job: the welcome box, where "fit into
			// N rows and count the rest" is the point.
			await openBrowser(ctx, "coverage");
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
	const toBrowserKey = (data: string, view?: BrowserView): BrowserKey | undefined => {
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
		if (data === "R") return "refresh";
		// Only the hypotheses list has outcome filters. Firing them view-blind set a
		// filter the current list never showed, which `switch` then carried into
		// hypotheses — you tabbed over to a pre-filtered list you never filtered.
		if (view === "hypotheses") {
			if (data === "a") return "filter:all";
			if (data === "c") return "filter:confirmed";
			if (data === "r") return "filter:refuted";
			if (data === "o") return "filter:open";
		}
		return undefined;
	};

	/** Body rows the browser gets: the overlay's height, less its chrome. */
	const browserHeight = (tui?: { terminal?: { rows: number } }): number =>
		Math.max(1, overlayRows(tui) - BROWSER_CHROME);

	/** Open the browser at `view`; shared by /surface, /hypotheses and /findings. */
	const openBrowser = async (ctx: ExtensionContext, view: "coverage" | "surface" | "hypotheses" | "findings"): Promise<void> => {
		if (!workspace) {
			ctx.ui.notify("pired: no engagement workspace yet", "warning");
			return;
		}
		// Bound once: `workspace` is a mutable module-level binding, so the guard's
		// narrowing does not survive into the closure that re-reads it.
		const ws = workspace;
		const build = async (): Promise<BrowserModel> => {
			const cov = await computeCoverageView(ws);
			return buildBrowserModel({
				engagement: scope.engagement,
				classes: cov?.classes ?? [],
				cells: cov?.matrix.cells ?? [],
				inventory: await ws.read("inventory"),
				hypotheses: await ws.read("hypotheses"),
				findings: await ws.read("findings"),
			});
		};
		// Rebuildable: the browser is open while the agent is still recording, and a
		// snapshot taken at open time quietly goes stale — a finding recorded a
		// second later simply is not in the list. `R` re-reads the ledger.
		let model = await build();

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
		// The width the last frame was drawn at. A detail view wraps to it, so its
		// scrollable length is only knowable here — handleInput is given no width.
		let lastWidth = 72;
		let reloadGen = 0;
		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => ({
				render: (width: number): string[] => {
					lastWidth = width;
					return renderBrowser({
						model, state, width,
						// Chrome is the box edges, the tally, two rules and the legend.
						height: browserHeight(tui),
						maxLines: overlayRows(tui),
						ink: (tone, text) => theme.fg(BROWSER_TONE_COLOR[tone], text),
						// Background, not foreground: theme.fg resets with \x1b[39m, so an
						// outer accent dies at the row's first inner colour and the cursor
						// row renders less coloured than its neighbours. bg resets with
						// \x1b[49m, which no foreground code emits. selectedBg was already
						// in themes/pired.json and used by nothing.
						highlight: (line) => theme.bg("selectedBg", line),
						measure: visibleWidth,
						truncate: (x, ww) => truncateToWidth(x, ww, theme.fg("dim", "…")),
					});
				},
				invalidate(): void {},
				handleInput(data: string): void {
					const key = toBrowserKey(data, state.view);
					if (!key) return;
					const height = browserHeight(tui);
					const detailRows = detailRowCount({
						model, state, width: lastWidth, height,
						ink: (_t: BrowserTone, text: string) => text,
						measure: visibleWidth,
						truncate: (x: string, ww: number) => truncateToWidth(x, ww),
					});
					if (key === "refresh") {
						// Generation guard: two fast presses otherwise resolve in arbitrary
						// order and the older read can win.
						const gen = ++reloadGen;
						void build().then((fresh) => {
							if (gen !== reloadGen) return;
							model = fresh;
							// The surface list re-sorts by progress on every build, so a kept
							// cursor lands on a different row. Clamp it back into range.
							const rows = detailRowCount({
								model, state, width: lastWidth, height: browserHeight(tui),
								ink: (_t: BrowserTone, x: string) => x, measure: visibleWidth,
								truncate: (x: string, ww: number) => truncateToWidth(x, ww),
							});
							state = { ...state, cursor: 0, scroll: 0, ...(rows === 0 ? {} : {}) };
							tui.requestRender();
						}).catch((err) => {
							// A failed reload must not look like a successful empty one.
							ctx.ui.notify(`pired: reload failed — ${err instanceof Error ? err.message : String(err)}`, "warning");
						});
						return;
					}
					const next = reduceBrowser(state, key, model, height, detailRows);
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
			{ overlay: true, overlayOptions: { ...OVERLAY.browser } },
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
		engagement: string; cwd?: string; profile: string; scope: string; model?: string;
		surface?: number; coveragePct?: number; findings?: number;
	}>("pired-welcome", (entry, _options, theme) => {
		const info = entry.data;
		if (!info) return undefined;
		return {
			render: (width: number): string[] => {
				const cols = bannerWidth(width);
				const rows = bannerReserve();
				const ink = (tone: BannerTone, text: string) => theme.fg(BANNER_TONE_COLOR[tone], text);
				const truncate = (x: string, w: number) => truncateToWidth(x, w, theme.fg("dim", "…"));
				const banner = renderBanner({ info, width: cols, ink, measure: visibleWidth, truncate });

				// The panel floats, so the editor has to clear it, so the welcome entry
				// has to be that tall. Those rows were blank; the matrix that is the
				// whole thesis of the harness — checklist × surface — is a better
				// answer to "what goes here" than nothing, and on a fresh engagement
				// it says what to do instead of showing an empty grid.
				// One row short of the reservation, which is the reservation's own
				// margin before the editor. Entry line n lands beside rail line n — the
				// rail's offset from the top of the screen is the same offset the
				// transcript starts at, so it cancels — and the two boxes therefore
				// close on the same row when the entry fills everything but that
				// margin. Twice I reasoned my way to an off-by-one here and twice a
				// screenshot settled it; near-alignment reads worse than none at all.
				const room = rows - banner.length - 1;
				// Indented and narrowed to the banner's own measure, so the box's two
				// edges are the wordmark's left margin and the rule's right end.
				const box = coverageView && room >= 7
					? renderCoveragePanel({
						view: coverageView, engagement: scope.engagement, width: cols - 2,
						frame: true, maxLines: room,
						// Here the pointer is useful: this box is a summary and /coverage
						// is where the rest of the classes are. The overlay omits it.
						moreHint: "/coverage",
						ink: (tone, text) => theme.fg(TONE_COLOR[tone], text),
						measure: visibleWidth, truncate: truncateToWidth,
					}).map((l) => `  ${l}`)
					: [];
				if (box.length === 0) {
					return renderBanner({ info, width: cols, minLines: rows, ink, measure: visibleWidth, truncate });
				}
				const out = [...banner, ...box];
				while (out.length < rows) out.push("");
				return out;
			},
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

	/**
	 * `/findings` reads them; `/report` writes the deliverable.
	 *
	 * It was the other way about: `/report` browsed while `/findings` exported, so
	 * the noun did the verb's job. Naming the writer `/export` is not available —
	 * pi already owns `/export`, `/copy` and `/share` — and `/report` is the better
	 * word anyway: in an engagement the report *is* the written artifact.
	 */
	pi.registerCommand("findings", {
		description: "Browse findings — select one to read its detail",
		handler: async (_args, ctx) => { await openBrowser(ctx, "findings"); },
	});

	/**
	 * What needs you, on demand.
	 *
	 * The blocker dialog fires when the agent parks one, and an operator who is
	 * mid-thought dismisses it — correctly, since the blocker stays open. What was
	 * missing was the way back: the panel's "needs you" section could show three
	 * open blockers with no way to answer them short of waiting for the agent to
	 * record something and re-trigger the prompt for the NEXT one. This is that
	 * way back, and it re-asks the dismissed ones too.
	 */
	pi.registerCommand("blockers", {
		description: "Answer what needs you — walk the open blockers, one dialog at a time",
		handler: async (_args, ctx) => {
			if (!workspace) {
				ctx.ui.notify("pired: no engagement workspace yet", "warning");
				return;
			}
			let open: BlockerRecord[];
			try {
				open = (await workspace.read("blockers")).filter((b) => b.status === "open");
			} catch (err) {
				ctx.ui.notify(`pired: could not read blockers — ${err instanceof Error ? err.message : String(err)}`, "warning");
				return;
			}
			if (open.length === 0) {
				ctx.ui.notify("pired: nothing needs you — no open blockers", "info");
				return;
			}
			// Outside the TUI there are no dialogs to walk, so say what is waiting
			// rather than silently doing nothing.
			if (ctx.mode !== "tui") {
				const list = open.map((b) => `· ${b.type.replace(/-/g, " ")}: ${b.question}`).join("\n");
				ctx.ui.notify(`pired: ${open.length} open blocker(s) — answering needs the terminal UI\n${list}`, "warning");
				return;
			}
			const answered = await answerBlockers(ctx, false);
			ctx.ui.notify(
				answered > 0
					? `pired: ${answered} of ${open.length} blocker(s) answered`
					: `pired: ${open.length} blocker(s) still open`,
				answered > 0 ? "info" : "warning",
			);
		},
	});

	/**
	 * `/scribe` writes the review into the ledger now; `/scribe on` lets it happen
	 * by itself.
	 *
	 * Named for the job rather than the mechanism. "Extract" described what the
	 * code does to a string; what the operator has is someone who sits through the
	 * review and takes it down — findings, surface, and what was ruled out — so
	 * that a consultant's conclusions survive the transcript. It also makes the
	 * off state sayable, which a mode nobody can name never is.
	 *
	 * One command rather than two, for the same reason `/panel` is one command:
	 * the verb and the switch are the same subject. Typed bare it SWEEPS — the
	 * roll-call included — because an explicit ask is exactly when the slower,
	 * complete answer is the one wanted.
	 */
	const scribeCommand = async (args: string, ctx: ExtensionContext): Promise<void> => {
		const arg = (args ?? "").trim().toLowerCase();
		if (arg === "off" || arg === "on") {
			scribeAuto = arg === "on";
			// Turning it off must also stop the one already running, or "off" is a
			// setting that takes effect after the thing it disables has finished.
			if (!scribeAuto) stopScribe();
			await refreshStatus(ctx);
			ctx.ui.notify(
				scribeAuto
					? "pired: scribe on — after every reply, new review is read into the ledger while you read it. `/scribe` still sweeps the checklist"
					: "pired: scribe off — `/scribe` writes the review into the ledger when you ask",
				"info",
			);
			return;
		}
		if (arg === "status") {
			ctx.ui.notify(
				`pired: scribe is ${scribeState()} · ${reviewTurns.length} turn(s) buffered, ${reviewSoFar().length} chars`,
				"info",
			);
			return;
		}
		if (reviewTurns.length === 0) {
			ctx.ui.notify("pired: nothing to write — no review in this session yet", "warning");
			return;
		}
		// The operator asked, so this one is awaited and it sweeps. An automatic
		// pass already in flight is dropped rather than raced: it is reading a
		// subset of the same buffer.
		stopScribe();
		scribeByHand = true;
		try {
			await runScribe(ctx, reviewSoFar(), { trigger: "manual", sweep: arg !== "quick" });
		} finally {
			scribeByHand = false;
		}
	};

	pi.registerCommand("scribe", {
		description: "Write the review into the ledger now, checklist included — `on` | `off` | `status` | `quick`",
		handler: scribeCommand,
	});
	// The name this had for its whole life so far. Kept because it is in the
	// docs, in the muscle memory and in at least one operator's notes, and
	// because a rename that breaks the command is a rename that gets reverted.
	pi.registerCommand("extract", {
		description: "Alias for `/scribe`.",
		handler: scribeCommand,
	});

	/**
	 * Repair a ledger that already holds duplicates.
	 *
	 * `record` stopped new ones, which does nothing for an engagement carried out
	 * before it. This is deliberately the operator's command and not a tool the
	 * agent can reach: it retires rows, and the one thing a model must not be able
	 * to do quietly is remove a finding from a client's report. It shows what it
	 * would fold and writes only when told twice.
	 */
	pi.registerCommand("dedupe", {
		description: "Find rows recorded more than once and fold them into one — `apply` to write, otherwise a preview",
		handler: async (args, ctx) => {
			if (!workspace) {
				ctx.ui.notify("pired: no engagement workspace yet", "warning");
				return;
			}
			const ws = workspace;
			const read = async (): Promise<Ledgers> => ({
				inventory: await ws.read("inventory"), hypotheses: await ws.read("hypotheses"),
				findings: await ws.read("findings"), blockers: await ws.read("blockers"), loot: await ws.read("loot"),
			});
			const plan = planCompaction(await read(), services.clock.nowIso());
			const apply = (args ?? "").trim().toLowerCase() === "apply";
			if (plan.groups.length === 0) {
				ctx.ui.notify("pired: no duplicates — every row in this workspace is already one thing", "info");
				return;
			}
			if (!apply) {
				// Shown before anything is written, and shown as a list: "12 rows will
				// be folded" is not a thing anyone can check, and this is the only
				// command in pired that retires a row someone may still want.
				const preview = describePlan(plan);
				const shown = preview.slice(0, 40);
				if (preview.length > shown.length) shown.push(`… and ${preview.length - shown.length} more line(s)`);
				const ok = await ctx.ui.confirm(
					`Fold ${plan.removed} duplicate row(s) into ${plan.groups.length}?`,
					shown.join("\n"),
				);
				if (!ok) {
					ctx.ui.notify("pired: nothing written", "info");
					return;
				}
			}
			for (const write of plan.writes) await ws.upsert(write.store, () => write.records);
			await refreshStatus(ctx);
			ctx.ui.notify(
				`pired: folded ${plan.removed} duplicate row(s) into ${plan.groups.length}` +
				(plan.retargeted > 0 ? `, moved ${plan.retargeted} reference(s)` : "") +
				" — the originals are still in the ledger",
				"info",
			);
		},
	});

	pi.registerCommand("report", {
		description: "Write findings to Markdown in the engagement workspace",
		handler: async (_args, ctx) => {
			if (!workspace) {
				ctx.ui.notify("pired: no engagement workspace yet", "warning");
				return;
			}
			const findings = await workspace.read("findings");
			// A report with no findings in it is not a report, and writing one puts
			// a file called findings.md in the engagement that says nothing —
			// indistinguishable, later, from a review that genuinely found nothing.
			// Say what is missing instead.
			if (findings.length === 0) {
				ctx.ui.notify(
					"pired: nothing to report yet — no findings recorded. The agent records them as it confirms them; `/scribe` writes up a review it has already produced.",
					"warning",
				);
				return;
			}
			const loot = await workspace.read("loot");
			const markdown = exportFindingsMarkdown({ findings, loot, engagement: scope.engagement, generatedAt: services.clock.nowIso() });
			const rel = await workspace.writeArtifact("findings.md", markdown);
			ctx.ui.notify(`pired: exported ${findings.length} finding(s) -> ${rel}${describeUnready(notReportReady(findings).length)}`, "info");
		},
	});
}
