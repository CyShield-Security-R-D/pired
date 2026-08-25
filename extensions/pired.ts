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
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { exportFindingsMarkdown } from "../core/export.ts";
import type { Checklist, EngagementScope, TargetType } from "../core/ontology.ts";
import type { Gate } from "../core/ports.ts";
import { buildSystemPrompt, PIRED_PROFILES, type PiredProfile } from "../core/prompts.ts";
import { createScopeGate } from "../core/scope.ts";
import { computeEngagementStats } from "../core/stats.ts";
import { createCoreTools } from "../core/tools.ts";
import { Workspace } from "../core/workspace.ts";
import { makeHostServices } from "./lib/host.ts";
import { registerPiredProviders } from "./lib/providers.ts";
import { toPiTool } from "./lib/tools.ts";

/** Package root (this file lives in extensions/). Bundled skills + checklists sit beside it. */
const PIRED_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIR = join(PIRED_ROOT, "skills");
const CHECKLISTS_DIR = join(PIRED_ROOT, "checklists");

// --- sleek banner widget (pi's setWidget renders a persistent panel above the
// editor — unlike a printed banner it is not scrolled away or cleared). -------
const C = { red: "\x1b[1;38;5;203m", dim: "\x1b[2m", bold: "\x1b[1m", rst: "\x1b[0m" };

interface BannerData {
	engagement: string;
	profile: PiredProfile;
	targetType: string;
	classes: number;
	coveragePct?: number;
	findings: number;
	blockers: number;
}

function bannerLines(d: BannerData): string[] {
	const cov = d.coveragePct !== undefined ? `${d.coveragePct}%` : "n/a";
	const kv = (k: string, v: string | number) => `${C.dim}${k}${C.rst} ${v}`;
	return [
		`${C.red}╭─╴ p i r e d ╶─╮${C.rst}   ${C.dim}security operator · ${d.targetType}${C.rst}`,
		`  ${kv("engagement", d.engagement)}   ${kv("profile", d.profile)}   ${kv("checklist", `${d.classes} classes`)}`,
		`  ${kv("tools", "record · recall")}   ${kv("coverage", cov)}   ${kv("findings", d.findings)}${d.blockers > 0 ? `   ${kv("blockers", d.blockers)}` : ""}`,
	];
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

	pi.registerFlag("pired-profile", { description: "pired profile: pentest | recon | review", type: "string", default: "review" });
	registerPiredProviders(pi);

	// Contribute pired's bundled methodology skills to pi's resource loader. pi
	// discovers each skills/<name>/SKILL.md, advertises them in the system prompt
	// (progressive disclosure), and exposes /skill:<name> — the on-demand
	// methodology layer the small always-on prompt deliberately points to.
	pi.on("resources_discover", () => ({
		skillPaths: existsSync(SKILLS_DIR) ? [SKILLS_DIR] : [],
	}));

	const refreshStatus = async (ctx: ExtensionContext): Promise<void> => {
		if (!workspace) return;
		const s = await computeEngagementStats(workspace);
		const parts = [`⌖ ${scope.engagement}`, `findings ${s.findingsTotal}`];
		if (s.coveragePct !== undefined) parts.push(`cov ${s.coveragePct}%`);
		if (s.blockers > 0) parts.push(`blockers ${s.blockers}`);
		ctx.ui.setStatus("pired", parts.join(" · "));
		// Live sleek banner above the editor (persistent; not scrolled/cleared away).
		// TUI-only: terminal widgets must never run in print/rpc/json mode (they can
		// block a headless run — e.g. the `-p` benchmark path).
		if (ctx.mode !== "tui") return;
		try {
			ctx.ui.setWidget?.(
				"pired",
				bannerLines({
					engagement: scope.engagement,
					profile,
					targetType: pickTargetType(profile, scope),
					classes: checklistClasses.length,
					coveragePct: s.coveragePct,
					findings: s.findingsTotal,
					blockers: s.blockers,
				}),
			);
		} catch {
			// setWidget is best-effort UI polish; never let it break the session.
		}
	};

	// One-time fx-like UI polish. All guarded: a missing/older pi API must never
	// break pired. The `pired` launcher additionally loads the fxred theme file.
	const applyUiPolish = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") return; // terminal-only; skip in print/rpc/json (headless) modes
		try {
			ctx.ui.setTheme?.("fxred"); // no-op unless the theme was loaded (e.g. by `pired run`)
		} catch {}
		try {
			ctx.ui.setWorkingIndicator?.({ frames: [`${C.red}●${C.rst}`] });
		} catch {}
		try {
			ctx.ui.setHiddenThinkingLabel?.("thinking");
		} catch {}
		// fx-style footer: a single minimal line — red ▌ bar + live engagement
		// status on the left, model · branch · /help dim on the right.
		try {
			const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
			ctx.ui.setFooter?.((_tui, theme, footerData) => ({
				// render runs every frame; it must NEVER throw or the footer breaks.
				render(width: number): string[] {
					try {
						const status = footerData.getExtensionStatuses().get("pired") ?? scope.engagement;
						const branch = footerData.getGitBranch();
						const model = (ctx.model as { id?: string } | undefined)?.id;
						const sep = theme.fg("dim", " · ");
						const left = theme.fg("accent", "▌ ") + theme.fg("text", status);
						const right = [model, branch, "/help"].filter(Boolean).map((p) => theme.fg("dim", String(p))).join(sep);
						const gap = Math.max(1, width - strip(left).length - strip(right).length);
						return [left + " ".repeat(gap) + right];
					} catch {
						return [theme.fg("dim", " pired")]; // safe fallback — never crash the footer
					}
				},
				invalidate() {},
			}));
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

	pi.on("turn_end", async (_event, ctx) => {
		await refreshStatus(ctx);
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
