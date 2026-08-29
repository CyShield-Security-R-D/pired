/**
 * Forge — contamination-free targets, generated at evaluation time.
 *
 * Every run produces a tree that has never existed before, so contamination is
 * structurally impossible rather than merely audited. Ground truth is emitted by
 * construction, which makes the key exact and free.
 *
 * Synthetic injection has an earned bad reputation. The literature on LAVA and
 * its successors is specific about why: injected bugs cluster at shared attack
 * points, introduce control and data flow incongruent with the surrounding
 * program, leave magic values and repeated patterns visible on inspection, and
 * skew toward memory corruption while missing logic, crypto and concurrency —
 * exactly the tail a reasoning harness exists to reach. Four countermeasures are
 * built into these types rather than bolted on:
 *
 *   1. **Every template renders both a vulnerable and a safe site**, in matched
 *      shape. The decoys come from the same generator as the bugs, so "looks
 *      generated" carries no signal about vulnerability. This is the single most
 *      important fix and the one LAVA never had.
 *   2. **Templates are weighted to the tail** — authz/IDOR and business logic,
 *      not just the injection classes that are easy to synthesize.
 *   3. **No markers.** Nothing in a rendered file says where the sink is; sink
 *      locations are recovered afterwards by searching the finished text, so a
 *      generated comment can never leak the answer.
 *   4. **The artifact audit can reject a build** (see `audit.ts`).
 */

import type { Severity } from "../../core/ontology.ts";

export type Stack = "python-flask" | "node-express";

/** Weighted to the logic/authz tail, per the stratification design. */
export type VulnClass = "sqli" | "cmdi" | "idor" | "xss" | "pathtrav" | "logic";

export const VULN_CLASSES: VulnClass[] = ["sqli", "cmdi", "idor", "xss", "pathtrav", "logic"];

export interface Route {
	method: "GET" | "POST" | "PUT" | "DELETE";
	path: string;
	/** Handler symbol name. */
	handler: string;
	/** The user-controlled parameter this route reads. */
	param: string;
	/** A JSON-only route cannot render HTML, so xss is `n/a` there — real
	 *  applicability, not an annotation convenience. */
	jsonOnly: boolean;
}

export interface RenderCtx {
	route: Route;
	/** Helper hops between source and sink: 0 inline, 1 same-file, 2 cross-file. */
	taintDepth: number;
	rng: () => number;
}

export interface SiteRender {
	/** Statements placed in the handler body. */
	body: string;
	/** Module-level helpers this site needs. */
	helpers?: string;
	/** An additional module, for cross-file taint. */
	extraFile?: { path: string; content: string };
	/**
	 * A distinctive substring of the rendered sink. Used *after* rendering to
	 * recover the sink's line number — never emitted into the file.
	 */
	sinkMarker: string;
}

export interface VulnTemplate {
	class: VulnClass;
	stack: Stack;
	/** Pattern-family label, surfaced as a stratum in the key. */
	idiom: string;
	severity: Severity;
	vulnerable(ctx: RenderCtx): SiteRender;
	/** The matched safe rendering — same shape, same naming, no bug. */
	safe(ctx: RenderCtx): SiteRender;
	/** Why the safe rendering is genuinely clear. Becomes the key cell's `why`. */
	safeReason: string;
}

export interface ForgeSpec {
	seed: number;
	stack: Stack;
	/** Number of routes in the generated app. */
	routes: number;
	/** Share of applicable (route, class) cells that carry a real bug. */
	vulnRate: number;
	/** Upper bound on source-to-sink helper hops. */
	maxTaintDepth: number;
	/** Ordinary handlers with no sink. Defaults to `routes` — real apps are mostly boring. */
	fillerRoutes?: number;
}

export interface SiteRecord {
	route: Route;
	class: VulnClass;
	idiom: string;
	vulnerable: boolean;
	taintDepth: number;
	file: string;
	sinkMarker: string;
	severity: Severity;
	safeReason: string;
}
