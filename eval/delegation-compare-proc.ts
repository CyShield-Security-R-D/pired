/**
 * Reaping the processes a cell leaves running, by an env marker every
 * descendant inherits.
 *
 * pi's bash tool spawns every command detached (its own session/group) and
 * untracks it once bash exits, so a model's `python3 -m http.server 8000 &` or
 * any setsid child outlives the bash call, the cell, and the runner. The
 * comparison runner's runOwned reaps only its own process group (-child.pid), so
 * these strays survive: they keep the finished cell's Landlock domain and
 * workspace-write access, hold ports, and are reachable by the next arm of the
 * same pair (which runs the same target with localhost exempt from the proxy).
 * That contaminates the second arm's tokens and possibly its findings, and it
 * does not cancel per target because the arm order is 2:1.
 *
 * A name match (`pkill -f http.server`) is not safe here: Landlock ABI 4 (what
 * this host has, measured) has no signal scoping, so a signal from one cell can
 * reach another cell's and the operator's own same-uid processes. Instead we key
 * on a value every descendant of a cell inherits through its environment (the
 * runner passes each cell an opaque per-cell path such as PI_CODING_AGENT_DIR or
 * TMPDIR). /proc/<pid>/environ is a snapshot of the process's initial
 * environment, so a background job started inside the cell still carries it. We
 * signal only pids whose environ still holds the exact marker entry, re-checked
 * immediately before the signal, so a pid that died and was reused by an
 * unrelated (possibly operator) process is never hit.
 *
 * This is pid-based and therefore not perfectly race-free against pid reuse; a
 * pidfd or a per-cell cgroup would be. The re-check narrows the window to the
 * microseconds between confirming the marker and the kill(2), which is why the
 * marker must be an opaque value no other process shares.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface ReapResult {
	/** Every pid actually signalled (SIGTERM or SIGKILL), sorted ascending. */
	pids: number[];
	/** Signalling or scanning problems worth surfacing; an expected ESRCH is not one. */
	errors: string[];
}

const NUL = "\0";

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms).unref());

/** The numeric entries under procRoot (pid directories); everything else is ignored. */
async function pidDirs(procRoot: string): Promise<number[]> {
	let names: string[];
	try { names = await readdir(procRoot); }
	catch { return []; }
	const pids: number[] = [];
	for (const name of names) if (/^\d+$/.test(name)) pids.push(Number(name));
	return pids;
}

/**
 * Whether this exact pid's environ currently holds `entry`. environ is
 * NUL-separated with a trailing NUL, so an exact split-and-match distinguishes
 * `X=/a/b` from `X=/a/b-sibling`. A vanished pid (ENOENT/ESRCH), a zombie whose
 * memory is gone (empty environ), or another uid's process (EACCES) all read as
 * "not marked": one we could not confirm is one we must not signal.
 */
async function environHasEntry(procRoot: string, pid: number, entry: string): Promise<boolean> {
	try {
		const raw = await readFile(join(procRoot, String(pid), "environ"), "utf8");
		return raw.split(NUL).includes(entry);
	} catch {
		return false;
	}
}

/**
 * Every pid (other than this process and any in excludePids) whose environ
 * carries the exact `name=value` marker entry. Unreadable or vanished pids are
 * skipped, never guessed at.
 */
export async function findMarkedProcesses(
	marker: { name: string; value: string },
	options: { procRoot?: string; excludePids?: number[] } = {},
): Promise<number[]> {
	const procRoot = options.procRoot ?? "/proc";
	const entry = `${marker.name}=${marker.value}`;
	const excluded = new Set<number>([process.pid, ...(options.excludePids ?? [])]);
	const found: number[] = [];
	for (const pid of await pidDirs(procRoot)) {
		if (excluded.has(pid)) continue;
		if (await environHasEntry(procRoot, pid, entry)) found.push(pid);
	}
	return found.sort((a, b) => a - b);
}

/**
 * SIGTERM every marked process, wait graceMs, then SIGKILL survivors over a
 * bounded number of rounds until none carry the marker. Never signals a pid
 * without the marker: the marker is re-confirmed on each pid immediately before
 * the signal, so a reused pid is not hit. Returns every pid signalled.
 */
export async function reapMarkedProcesses(
	marker: { name: string; value: string },
	options: { procRoot?: string; excludePids?: number[]; graceMs?: number } = {},
): Promise<ReapResult> {
	const procRoot = options.procRoot ?? "/proc";
	const graceMs = options.graceMs ?? 2000;
	const entry = `${marker.name}=${marker.value}`;
	const signalled = new Set<number>();
	const errors: string[] = [];

	const signalMarked = async (signal: NodeJS.Signals): Promise<number> => {
		let count = 0;
		for (const pid of await findMarkedProcesses(marker, options)) {
			// Re-confirm on this exact pid: between the scan and here it could have
			// exited and been reused by an unmarked process, which we must not kill.
			if (!(await environHasEntry(procRoot, pid, entry))) continue;
			try {
				process.kill(pid, signal);
				signalled.add(pid);
				count += 1;
			} catch (error) {
				// ESRCH: it exited between the re-check and the signal — the intended
				// outcome, not a failure. Anything else (e.g. EPERM) is a real problem.
				const code = (error as { code?: string }).code;
				if (code !== "ESRCH") errors.push(`kill ${signal} ${pid}: ${code ?? message(error)}`);
			}
		}
		return count;
	};

	if ((await signalMarked("SIGTERM")) > 0) await delay(graceMs);

	// Bounded SIGKILL escalation: a handful of rounds is enough for the kernel to
	// tear down a normal tree; a loop with no ceiling would hang on a pid we
	// genuinely cannot kill (recorded in errors below instead).
	const maxRounds = 5;
	for (let round = 0; round < maxRounds; round += 1) {
		if ((await findMarkedProcesses(marker, options)).length === 0) break;
		await signalMarked("SIGKILL");
		await delay(Math.min(graceMs, 200));
	}

	const remaining = await findMarkedProcesses(marker, options);
	if (remaining.length > 0) errors.push(`marked processes survived reaping: ${remaining.map(String).join(", ")}`);
	return { pids: [...signalled].sort((a, b) => a - b), errors };
}
