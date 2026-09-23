/**
 * The bounded live handoff a worker (or a compacted parent) reads back.
 *
 * pired no longer ships its own worker — delegation goes through pi-subagents
 * (ADR-027) — but the shared ledger is still the channel between a parent and
 * the workers it delegates to, and `recall context` is how either side pulls a
 * current, bounded snapshot of it: the target model, the checklist, the recorded
 * surface and the claims against it, filtered to the IDs/paths a task named. It
 * carries no conversation transcript and no loot secrets, and it is rebuilt from
 * disk on every call so a worker sees records another one just wrote.
 *
 * Pure module: reads through the Workspace port, no direct I/O.
 */
import type { Workspace } from "./workspace.ts";

export function boundedText(text: string, limit: number, suffix = "\n[abridged; retrieve the full record with recall or read]"): string {
	return text.length <= limit ? text : text.slice(0, Math.max(0, limit - suffix.length)) + suffix.slice(0, limit);
}

/** Live lookup behind `recall query=context`, so a worker can refresh after changes. */
export async function workerContext(ws: Workspace, refs: string[] = []): Promise<string> {
	const [inventory, hypotheses, findings, blockers, model, checklist] = await Promise.all([
		ws.read("inventory"), ws.read("hypotheses"), ws.read("findings"), ws.read("blockers"), ws.readModel(), ws.readChecklist(),
	]);
	const wanted = new Set(refs);
	// Follow assigned claims to their elements; match paths exactly (with optional line).
	const path = (v: unknown) => typeof v === "string" ? v.replace(/:\d+(?::\d+)?$/, "") : "";
	const matches = (r: { id: string; target?: string; file?: string; path?: string }) =>
		wanted.has(r.id) || [r.target, r.file, r.path].some((v) => v && refs.some((ref) => path(ref) === path(v)));
	for (const r of [...hypotheses, ...findings]) if (wanted.has(r.id) && r.target) wanted.add(r.target);
	const surface = inventory.filter((r) => refs.length === 0 || matches(r));
	for (const r of surface) wanted.add(r.id);
	const selected = <T extends { id: string; target?: string }>(rows: T[]) => rows.filter((r) => refs.length === 0 || matches(r) || (r.target && wanted.has(r.target)));
	const section = (name: string, rows: unknown[], budget: number) => `${name} (${rows.length} matching):\n${boundedText(rows.map((r) => JSON.stringify(r)).join("\n") || "(none)", budget)}`;
	return [
		`Shared workspace: ${ws.dir}\nEvidence: ${ws.dir}/evidence/\nThis is a bounded snapshot. All records remain available through recall; read source/evidence by path. Never infer clearance from omitted records.`,
		`Target model:\n${boundedText(model || "(none yet)", 2000)}`,
		`Checklist IDs: ${boundedText(checklist?.classes.map((c) => `${c.id}: ${c.title}`).join("; ") || "(none)", 1800)}`,
		section("Surface", surface, 2000),
		section("Hypotheses", selected(hypotheses), 2400),
		section("Findings", selected(findings), 2400),
		section("Open blockers", blockers.filter((b) => b.status === "open"), 1200),
	].join("\n\n");
}
