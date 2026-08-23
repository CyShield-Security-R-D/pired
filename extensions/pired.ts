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
	};

	pi.on("session_start", async (_event, ctx) => {
		const flag = pi.getFlag("pired-profile");
		profile = typeof flag === "string" && (PIRED_PROFILES as readonly string[]).includes(flag) ? (flag as PiredProfile) : "review";
		scope = loadScope(ctx.cwd, profile, ctx.isProjectTrusted());
		gate = createScopeGate(scope);

		const dir = scope.workspace ? expandHome(scope.workspace) : join(homedir(), ".pired", "engagements", scope.engagement);
		workspace = await Workspace.open(dir, scope.engagement, services);
		await seedChecklist(workspace, pickTargetType(profile, scope));

		for (const tool of createCoreTools({ workspace })) pi.registerTool(toPiTool(tool, () => services));
		pi.setActiveTools([...new Set([...pi.getActiveTools(), "record", "recall"])]);

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
		systemPrompt: `${event.systemPrompt}\n\n${buildSystemPrompt({ profile, scope })}`,
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
