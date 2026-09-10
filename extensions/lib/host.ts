/**
 * Node-backed implementations of core's host ports, for the pi extension.
 *
 * Also used by `bin/pired-ledger.mjs`, which wires the same ports for a process
 * that never loaded the extension — a subagent child — so a child's `record`
 * writes through exactly the code the parent's does.
 */

import { randomBytes } from "node:crypto";
import { appendFile, chmod, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { Clock, FileStat, Fs, HostServices, Ids } from "../../core/ports.ts";

function hasCode(err: unknown, code: string): boolean {
	return typeof err === "object" && err !== null && (err as { code?: string }).code === code;
}

export class NodeFs implements Fs {
	async readFile(path: string): Promise<string> {
		return readFile(path, "utf8");
	}
	async readFileIfExists(path: string): Promise<string | undefined> {
		try {
			return await readFile(path, "utf8");
		} catch (err) {
			if (hasCode(err, "ENOENT")) return undefined;
			throw err;
		}
	}
	async writeFile(path: string, data: string, opts?: { mode?: number }): Promise<void> {
		await writeFile(path, data, opts?.mode !== undefined ? { mode: opts.mode } : undefined);
	}
	async appendFile(path: string, data: string): Promise<void> {
		await appendFile(path, data);
	}
	async mkdirp(path: string): Promise<void> {
		await mkdir(path, { recursive: true });
	}
	async readdir(path: string): Promise<string[]> {
		return readdir(path);
	}
	async rename(from: string, to: string): Promise<void> {
		await rename(from, to);
	}
	async remove(path: string): Promise<void> {
		await rm(path, { force: true, recursive: true });
	}
	async chmod(path: string, mode: number): Promise<void> {
		await chmod(path, mode);
	}
	async stat(path: string): Promise<FileStat | undefined> {
		try {
			const s = await stat(path);
			return { mtimeMs: s.mtimeMs, size: s.size };
		} catch (err) {
			if (hasCode(err, "ENOENT")) return undefined;
			throw err;
		}
	}
	async tryCreateExclusive(path: string): Promise<boolean> {
		try {
			const handle = await open(path, "wx");
			await handle.close();
			return true;
		} catch (err) {
			if (hasCode(err, "EEXIST")) return false;
			throw err;
		}
	}
}

export class SystemClock implements Clock {
	now(): number {
		return Date.now();
	}
	nowIso(): string {
		return new Date().toISOString();
	}
	sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}

export class RandomIds implements Ids {
	newId(): string {
		return randomBytes(3).toString("hex");
	}
}

export function makeHostServices(overrides?: Partial<HostServices>): HostServices {
	return { fs: new NodeFs(), clock: new SystemClock(), ids: new RandomIds(), ...overrides };
}
