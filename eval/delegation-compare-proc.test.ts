import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findMarkedProcesses, reapMarkedProcesses } from "./delegation-compare-proc.ts";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// A unique marker per spawned process, so no other process on the host — least
// of all the operator's — can match it and be signalled by mistake.
const uniqueMarker = (tag: string) => ({ name: "PIRED_REAP_MARKER", value: `${tag}-${process.pid}-${Date.now()}` });

describe.skipIf(process.platform !== "linux")("reaping a cell's stray processes by env marker", () => {
	const strays: number[] = [];
	afterEach(() => {
		// Kill any test process still alive if an assertion failed before reaping.
		for (const pid of strays.splice(0)) { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }
	});

	it("reaps a detached shell and its backgrounded child that carry the marker", async () => {
		const marker = uniqueMarker("tree");
		// A detached session with a backgrounded job: exactly pi's `cmd &` shape,
		// which today survives its bash call and the cell. The env marker is
		// inherited by the shell and every sleep it starts.
		const shell = spawn("bash", ["-c", "sleep 300 & sleep 300"], {
			detached: true, stdio: "ignore", env: { ...process.env, [marker.name]: marker.value },
		});
		shell.unref();
		if (shell.pid) strays.push(shell.pid);

		// Wait for both the backgrounded and foreground sleeps to be visible.
		let marked: number[] = [];
		for (let i = 0; i < 100 && marked.length < 2; i += 1) { marked = await findMarkedProcesses(marker); await delay(20); }
		expect(marked.length).toBeGreaterThanOrEqual(2);

		const result = await reapMarkedProcesses(marker, { graceMs: 300 });
		expect(result.errors).toEqual([]);
		expect(result.pids.length).toBeGreaterThanOrEqual(2);
		expect(await findMarkedProcesses(marker)).toEqual([]);
	});

	it("leaves an unmarked process running and reports signalling nothing", async () => {
		const bystander = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
		bystander.unref();
		if (bystander.pid) strays.push(bystander.pid);
		await delay(50);

		// The marker matches nothing; a name-based reaper would still hit the
		// sleep, but this one signals only exact-marker carriers.
		const result = await reapMarkedProcesses(uniqueMarker("nomatch"), { graceMs: 100 });
		expect(result).toEqual({ pids: [], errors: [] });
		expect(() => process.kill(bystander.pid as number, 0)).not.toThrow();
	});

	it("parses a NUL-separated environ, matches the exact entry, and skips vanished or unreadable pids", async () => {
		const root = await mkdtemp(join(tmpdir(), "pired-reap-proc-"));
		try {
			const marker = { name: "PIRED_CELL", value: "/cells/abc/agent" };
			const entry = `${marker.name}=${marker.value}`;
			// 100 carries the marker among other variables.
			await mkdir(join(root, "100"));
			await writeFile(join(root, "100", "environ"), `PATH=/usr/bin\0${entry}\0HOME=/root\0`);
			// 200 is a near-miss value: an exact-entry match must not treat the cell
			// path as a prefix of a sibling cell's path.
			await mkdir(join(root, "200"));
			await writeFile(join(root, "200", "environ"), `${marker.name}=/cells/abc/agent-sibling\0`);
			// 400 vanished between readdir and read: it has no environ file.
			await mkdir(join(root, "400"));
			// A non-numeric entry is not a pid, even though it carries the marker.
			await mkdir(join(root, "kthreadd"));
			await writeFile(join(root, "kthreadd", "environ"), `${entry}\0`);

			expect(await findMarkedProcesses(marker, { procRoot: root })).toEqual([100]);
			expect(await findMarkedProcesses(marker, { procRoot: root, excludePids: [100] })).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
