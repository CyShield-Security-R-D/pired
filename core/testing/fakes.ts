/**
 * In-memory fake implementations of the host ports (PLAN.md §3.1).
 *
 * These let `core/` be exercised with zero real runtime. They also serve as the
 * "second adapter" that keeps the core boundary honest: if core compiles and its
 * tests pass against these fakes, core provably doesn't reach past its ports.
 */

import type {
	Clock,
	FileStat,
	Fs,
	HostServices,
	Ids,
} from "../ports.ts";

function dirnameOf(path: string): string {
	const i = path.lastIndexOf("/");
	if (i <= 0) return "/";
	return path.slice(0, i);
}

function basenameOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? path : path.slice(i + 1);
}

/** Deterministic, advanceable clock. `sleep` advances virtual time so lock loops terminate under test. */
export class FakeClock implements Clock {
	private t: number;

	constructor(startMs: number = Date.parse("2026-01-01T00:00:00.000Z")) {
		this.t = startMs;
	}

	now(): number {
		return this.t;
	}

	nowIso(): string {
		return new Date(this.t).toISOString();
	}

	async sleep(ms: number): Promise<void> {
		this.t += ms;
	}

	advance(ms: number): void {
		this.t += ms;
	}

	set(ms: number): void {
		this.t = ms;
	}
}

/** Sequential ids: id1, id2, ... */
export class FakeIds implements Ids {
	private n = 0;

	newId(): string {
		this.n += 1;
		return `id${this.n}`;
	}
}

interface FakeFile {
	data: string;
	mode?: number;
	mtimeMs: number;
}

/** In-memory filesystem. mtimes are stamped from the injected clock so staleness math matches. */
export class FakeFs implements Fs {
	private files = new Map<string, FakeFile>();
	private dirs = new Set<string>(["/"]);
	private clock: Clock;

	constructor(clock: Clock) {
		this.clock = clock;
	}

	private ensureParent(path: string): void {
		let d = dirnameOf(path);
		while (!this.dirs.has(d)) {
			this.dirs.add(d);
			if (d === "/") break;
			d = dirnameOf(d);
		}
	}

	async readFile(path: string): Promise<string> {
		const f = this.files.get(path);
		if (!f) throw new Error(`ENOENT: ${path}`);
		return f.data;
	}

	async readFileIfExists(path: string): Promise<string | undefined> {
		return this.files.get(path)?.data;
	}

	async writeFile(path: string, data: string, opts?: { mode?: number }): Promise<void> {
		this.ensureParent(path);
		const prev = this.files.get(path);
		this.files.set(path, { data, mode: opts?.mode ?? prev?.mode, mtimeMs: this.clock.now() });
	}

	async appendFile(path: string, data: string): Promise<void> {
		this.ensureParent(path);
		const prev = this.files.get(path);
		this.files.set(path, { data: (prev?.data ?? "") + data, mode: prev?.mode, mtimeMs: this.clock.now() });
	}

	async mkdirp(path: string): Promise<void> {
		let d = path;
		while (!this.dirs.has(d)) {
			this.dirs.add(d);
			if (d === "/") break;
			d = dirnameOf(d);
		}
	}

	async readdir(path: string): Promise<string[]> {
		const norm = path === "/" ? "/" : path.replace(/\/+$/, "");
		const out = new Set<string>();
		for (const key of this.files.keys()) {
			if (dirnameOf(key) === norm) out.add(basenameOf(key));
		}
		for (const dir of this.dirs) {
			if (dir !== norm && dirnameOf(dir) === norm) out.add(basenameOf(dir));
		}
		return [...out];
	}

	async rename(from: string, to: string): Promise<void> {
		const f = this.files.get(from);
		if (!f) throw new Error(`ENOENT: ${from}`);
		this.ensureParent(to);
		this.files.delete(from);
		this.files.set(to, { ...f, mtimeMs: this.clock.now() });
	}

	async remove(path: string): Promise<void> {
		this.files.delete(path);
		this.dirs.delete(path);
	}

	async chmod(path: string, mode: number): Promise<void> {
		const f = this.files.get(path);
		if (f) f.mode = mode;
	}

	async stat(path: string): Promise<FileStat | undefined> {
		const f = this.files.get(path);
		if (f) return { mtimeMs: f.mtimeMs, size: f.data.length };
		if (this.dirs.has(path)) return { mtimeMs: 0, size: 0 };
		return undefined;
	}

	async tryCreateExclusive(path: string): Promise<boolean> {
		if (this.files.has(path)) return false;
		this.ensureParent(path);
		this.files.set(path, { data: "", mtimeMs: this.clock.now() });
		return true;
	}

	// --- test helpers ---
	getMode(path: string): number | undefined {
		return this.files.get(path)?.mode;
	}

	has(path: string): boolean {
		return this.files.has(path);
	}
}

export interface FakeServices extends HostServices {
	fs: FakeFs;
	clock: FakeClock;
	ids: FakeIds;
}

export function makeFakeServices(): FakeServices {
	const clock = new FakeClock();
	const fs = new FakeFs(clock);
	return { fs, clock, ids: new FakeIds() };
}
