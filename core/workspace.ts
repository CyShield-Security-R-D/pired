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
import { FORMAT_VERSION } from "./ontology.ts";
import type { Clock, Fs } from "./ports.ts";

/** Posix-style path join for the workspace's own paths. */
function joinPath(dir: string, ...parts: string[]): string {
	let out = dir.replace(/\/+$/, "");
	for (const part of parts) out += `/${part.replace(/^\/+/, "").replace(/\/+$/, "")}`;
	return out;
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
		const line = `${JSON.stringify(record)}\n`;
		await this.withLock(path, async () => {
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
			await this.fs.appendFile(path, line);
		});
	}

	async read<S extends StoreName>(store: S): Promise<StoreRecordMap[S][]> {
		const raw = await this.fs.readFileIfExists(this.storePath(store));
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
		const tmp = `${path}.tmp.${this.clock.now()}`;
		await this.fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
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
