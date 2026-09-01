/**
 * Engagement workspace: the disk-backed, append-only store engine (FORMAT.md).
 *
 * Disk is the source of truth. Ledgers are append-only JSONL; "updates" are new
 * records with the same id (last write wins on read); a `deleted: true` record
 * tombstones an id. Single-object files (manifest/scope/checklist) are written
 * atomically via temp-file + rename. Writers serialize through an advisory
 * lockfile so concurrent appends (subagents, the `pired answer` subcommand) can't
 * interleave.
 *
 * All I/O goes through the injected `Fs`/`Clock` ports — no node builtins here.
 */

import type { Checklist, EngagementScope, StoreName, StoreRecordMap, WorkspaceManifest } from "./ontology.ts";
import { FORMAT_VERSION, MODEL_SECTIONS } from "./ontology.ts";
import type { Clock, Fs } from "./ports.ts";

/** Posix-style path join for the workspace's own paths. */
function joinPath(dir: string, ...parts: string[]): string {
	let out = dir.replace(/\/+$/, "");
	for (const part of parts) out += `/${part.replace(/^\/+/, "").replace(/\/+$/, "")}`;
	return out;
}

/**
 * `model.md` to its sections, keyed by lowercased heading.
 *
 * Tolerant on the way in: the file is hand-editable and a person who opens it
 * to correct a sentence should not be able to break it. Anything before the
 * first heading is dropped (it is the title), and an unknown heading is kept so
 * an engagement can carry a section this ontology never anticipated.
 */
function parseModel(raw: string | undefined): Map<string, string> {
	const out = new Map<string, string>();
	if (!raw) return out;
	let current: string | undefined;
	let body: string[] = [];
	const flush = (): void => {
		if (current !== undefined) {
			const text = body.join("\n").trim();
			if (text.length > 0) out.set(current, text);
		}
	};
	for (const line of raw.split("\n")) {
		const heading = /^##\s+(.+?)\s*$/.exec(line);
		if (heading?.[1]) {
			flush();
			current = heading[1].toLowerCase();
			body = [];
			continue;
		}
		if (current !== undefined) body.push(line);
	}
	flush();
	return out;
}

/** Sections back to Markdown, in canonical order so the bytes are stable. */
function renderModel(sections: Map<string, string>): string {
	const known = MODEL_SECTIONS.filter((s) => sections.has(s));
	const extra = [...sections.keys()].filter((k) => !(MODEL_SECTIONS as readonly string[]).includes(k)).sort();
	const blocks = [...known, ...extra].map((name) => `## ${name}\n${sections.get(name) ?? ""}`);
	return `# Target model\n\n${blocks.join("\n\n")}\n`;
}

export interface WorkspaceServices {
	fs: Fs;
	clock: Clock;
}

export interface WorkspaceOptions {
	/** Give up acquiring a writer lock after this long. */
	lockTimeoutMs?: number;
	/** Treat an existing lock older than this as stale and steal it. */
	lockStaleMs?: number;
	/** Delay between lock attempts. */
	lockRetryMs?: number;
}

const DEFAULT_OPTIONS: Required<WorkspaceOptions> = {
	lockTimeoutMs: 5000,
	lockStaleMs: 30_000,
	lockRetryMs: 50,
};

export class Workspace {
	readonly dir: string;
	private fs: Fs;
	private clock: Clock;
	private opts: Required<WorkspaceOptions>;

	constructor(dir: string, services: WorkspaceServices, opts?: WorkspaceOptions) {
		this.dir = dir;
		this.fs = services.fs;
		this.clock = services.clock;
		this.opts = { ...DEFAULT_OPTIONS, ...opts };
	}

	/** Open (creating if needed) an engagement workspace. */
	static async open(
		dir: string,
		engagement: string,
		services: WorkspaceServices,
		opts?: WorkspaceOptions,
	): Promise<Workspace> {
		const ws = new Workspace(dir, services, opts);
		await ws.ensure(engagement);
		return ws;
	}

	storePath(store: StoreName): string {
		return joinPath(this.dir, `${store}.jsonl`);
	}

	private file(name: string): string {
		return joinPath(this.dir, name);
	}

	async ensure(engagement: string): Promise<void> {
		await this.fs.mkdirp(this.dir);
		await this.fs.mkdirp(joinPath(this.dir, "evidence"));
		await this.fs.mkdirp(joinPath(this.dir, "artifacts"));
		const manifestPath = this.file("manifest.json");
		if ((await this.fs.readFileIfExists(manifestPath)) === undefined) {
			const manifest: WorkspaceManifest = {
				formatVersion: FORMAT_VERSION,
				engagement,
				createdAt: this.clock.nowIso(),
				stores: {},
			};
			await this.writeJsonAtomic(manifestPath, manifest);
		}
	}

	// --- Ledgers -------------------------------------------------------------

	async append<S extends StoreName>(store: S, record: StoreRecordMap[S]): Promise<void> {
		const path = this.storePath(store);
		await this.withLock(path, async () => {
			await this.writeLines(store, path, [record]);
		});
	}

	/**
	 * Append what the current contents of the store say should be appended.
	 *
	 * Deduplication is a read-then-write, and `record` runs concurrently with
	 * subagents and the `pired answer` subcommand: reading outside the lock lets
	 * two writers both decide an element is new and both create it, which is the
	 * duplicate this exists to prevent. So the decision is made inside the same
	 * lock that guards the append, against the ledger as it stands at that
	 * instant. `plan` returning nothing writes nothing — a repeat that says
	 * nothing new should not cost a line.
	 */
	async upsert<S extends StoreName>(
		store: S,
		plan: (current: StoreRecordMap[S][]) => StoreRecordMap[S][] | undefined,
	): Promise<void> {
		const path = this.storePath(store);
		await this.withLock(path, async () => {
			const records = plan(this.parseStore<S>(await this.fs.readFileIfExists(path)));
			if (records && records.length > 0) await this.writeLines(store, path, records);
		});
	}

	async read<S extends StoreName>(store: S): Promise<StoreRecordMap[S][]> {
		return this.parseStore<S>(await this.fs.readFileIfExists(this.storePath(store)));
	}

	/** Must be called with the store's writer lock held. */
	private async writeLines<S extends StoreName>(store: S, path: string, records: StoreRecordMap[S][]): Promise<void> {
		// Loot is sensitive: guarantee 0o600 BEFORE any plaintext reaches disk.
		// A brand-new ledger is created with the mode; a pre-existing one (perhaps
		// world-readable — an older version, a stray umask) is tightened first, so
		// a secret is never appended to a file that is still permissive.
		if (store === "loot") {
			if ((await this.fs.stat(path)) === undefined) {
				await this.fs.writeFile(path, "", { mode: 0o600 });
			} else {
				await this.fs.chmod(path, 0o600);
			}
		}
		await this.fs.appendFile(path, records.map((r) => `${JSON.stringify(r)}\n`).join(""));
	}

	/** JSONL to live records: last write wins per id, tombstones removed. */
	private parseStore<S extends StoreName>(raw: string | undefined): StoreRecordMap[S][] {
		if (!raw) return [];
		const byId = new Map<string, StoreRecordMap[S]>();
		for (const rawLine of raw.split("\n")) {
			const line = rawLine.trim();
			if (!line) continue;
			let rec: unknown;
			try {
				rec = JSON.parse(line);
			} catch {
				continue;
			}
			if (!rec || typeof rec !== "object") continue;
			const id = (rec as { id?: unknown }).id;
			if (typeof id !== "string") continue;
			byId.set(id, rec as StoreRecordMap[S]);
		}
		const out: StoreRecordMap[S][] = [];
		for (const rec of byId.values()) {
			if ((rec as { deleted?: unknown }).deleted === true) continue;
			out.push(rec);
		}
		return out;
	}

	// --- Single-object files -------------------------------------------------

	async readManifest(): Promise<WorkspaceManifest | undefined> {
		return this.readJson<WorkspaceManifest>(this.file("manifest.json"));
	}

	async writeScope(scope: EngagementScope): Promise<void> {
		await this.writeJsonAtomic(this.file("scope.json"), scope);
	}

	async readScope(): Promise<EngagementScope | undefined> {
		return this.readJson<EngagementScope>(this.file("scope.json"));
	}

	async writeChecklist(checklist: Checklist): Promise<void> {
		await this.writeJsonAtomic(this.file("checklist.json"), checklist);
	}

	async readChecklist(): Promise<Checklist | undefined> {
		return this.readJson<Checklist>(this.file("checklist.json"));
	}

	// --- Target model --------------------------------------------------------

	/**
	 * Replace one section of the target model.
	 *
	 * REPLACE, not append — and that is the whole difference from `appendNote`.
	 * A note is an observation, true when it was written and true forever; an
	 * understanding of the target is a draft that gets corrected. Appending
	 * revisions leaves a stack of contradicting versions with the current one
	 * buried at the bottom, which is worse than having none: the agent reads the
	 * pile and reasons from whichever paragraph it happened to weigh.
	 *
	 * Sections are rendered in `MODEL_SECTIONS` order, never in write order.
	 * This document is injected into the system prompt, so a stable byte layout
	 * is not cosmetic — reordering it on every write would move the prefix and
	 * invalidate the cache behind it (the lesson `reviewEviction` in
	 * core/extract.ts already paid for once).
	 */
	async writeModelSection(section: string, body: string): Promise<void> {
		const path = this.file("model.md");
		await this.withLock(path, async () => {
			const sections = parseModel(await this.fs.readFileIfExists(path));
			sections.set(section.trim().toLowerCase(), body.trim());
			await this.writeTextAtomic(path, renderModel(sections));
		});
	}

	/** The target model as written, or "" when the engagement has none yet. */
	async readModel(): Promise<string> {
		return (await this.fs.readFileIfExists(this.file("model.md"))) ?? "";
	}

	/** The target model by section, for callers that render their own view of it. */
	async readModelSections(): Promise<Map<string, string>> {
		return parseModel(await this.fs.readFileIfExists(this.file("model.md")));
	}

	// --- Notes / evidence / artifacts ---------------------------------------

	async appendNote(text: string): Promise<void> {
		const path = this.file("notes.md");
		const block = `## ${this.clock.nowIso()}\n${text}\n\n`;
		await this.withLock(path, async () => {
			await this.fs.appendFile(path, block);
		});
	}

	async readNotes(): Promise<string> {
		return (await this.fs.readFileIfExists(this.file("notes.md"))) ?? "";
	}

	/** Write raw evidence; returns the workspace-relative path to reference from records. */
	async writeEvidence(name: string, data: string): Promise<string> {
		return this.writeUnder("evidence", name, data);
	}

	/** Write an artifact; returns the workspace-relative path to reference from records. */
	async writeArtifact(name: string, data: string): Promise<string> {
		return this.writeUnder("artifacts", name, data);
	}

	/**
	 * Read back a workspace-relative path a record claims (e.g. a finding's
	 * `evidence`). Record content is agent-authored and therefore untrusted, so
	 * anything that could escape the workspace — an absolute path, a `..`
	 * segment, a backslash — is refused rather than resolved. Returns undefined
	 * when the path is missing or refused, so an audit sees "does not resolve"
	 * either way.
	 */
	async readRelative(relPath: string): Promise<string | undefined> {
		if (relPath.startsWith("/") || relPath.includes("\\")) return undefined;
		if (relPath.split("/").some((seg) => seg === "..")) return undefined;
		return this.fs.readFileIfExists(joinPath(this.dir, relPath));
	}

	private async writeUnder(dir: string, name: string, data: string): Promise<string> {
		const safe = name.replace(/[/\\]/g, "_");
		await this.fs.writeFile(joinPath(this.dir, dir, safe), data);
		return `${dir}/${safe}`;
	}

	// --- Internals -----------------------------------------------------------

	private async readJson<T>(path: string): Promise<T | undefined> {
		const raw = await this.fs.readFileIfExists(path);
		if (raw === undefined) return undefined;
		return JSON.parse(raw) as T;
	}

	private async writeJsonAtomic(path: string, value: unknown): Promise<void> {
		await this.writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
	}

	private async writeTextAtomic(path: string, body: string): Promise<void> {
		const tmp = `${path}.tmp.${this.clock.now()}`;
		await this.fs.writeFile(tmp, body);
		await this.fs.rename(tmp, path);
	}

	private async withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
		const lockPath = `${path}.lock`;
		const deadline = this.clock.now() + this.opts.lockTimeoutMs;
		for (;;) {
			if (await this.fs.tryCreateExclusive(lockPath)) break;
			const st = await this.fs.stat(lockPath);
			if (st && this.clock.now() - st.mtimeMs > this.opts.lockStaleMs) {
				await this.fs.remove(lockPath);
				continue;
			}
			if (this.clock.now() >= deadline) {
				throw new Error(`pired: timed out acquiring lock on ${path}`);
			}
			await this.clock.sleep(this.opts.lockRetryMs);
		}
		try {
			return await fn();
		} finally {
			await this.fs.remove(lockPath);
		}
	}
}
