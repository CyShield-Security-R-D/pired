import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
let root = "";
let seal = "";
let allowed: string[] = [];
let unsupported = "";

// A minimal io_uring probe compiled per test run. io_uring_setup returning EPERM
// under the seal is sufficient evidence that the ring is unavailable, so a model
// cannot use IORING_OP_SOCKET(AF_UNIX)+IORING_OP_CONNECT to reach a broker socket
// without ever calling socket() (the path the socket()-only seccomp rule missed).
const iouProbeC = `#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>
#ifndef __NR_io_uring_setup
#define __NR_io_uring_setup 425
#endif
int main(void) {
	unsigned char params[256];
	memset(params, 0, sizeof(params));
	long r = syscall(__NR_io_uring_setup, 1, params);
	if (r >= 0) { printf("allowed"); return 2; }
	printf(errno == EPERM ? "eperm" : "errno=%d", errno);
	return errno == EPERM ? 0 : 3;
}
`;
// The runner itself fails closed on unsupported hosts. The integration test
// needs Linux Landlock and a compiler, which are available on the eval host.
describe.skipIf(process.platform !== "linux")("evaluation filesystem boundary", () => {
	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "pired-landlock-test-"));
		seal = join(root, "seal");
		try { await run("cc", ["-O2", "-Wall", "-Wextra", "-o", seal, new URL("./fs-seal.c", import.meta.url).pathname]); }
		catch (error) {
			if ((error as { code?: string }).code !== "ENOENT") throw error;
			unsupported = "C compiler unavailable; the live runner still refuses unsealed runs";
			return;
		}
		await mkdir(join(root, "work"));
		await mkdir(join(root, "auth"));
		await writeFile(join(root, "answer-key.txt"), "hidden answer");
		await writeFile(join(root, "auth/auth.json"), "{}");
		await writeFile(join(root, "auth/history.txt"), "hidden history");
		await symlink(join(root, "answer-key.txt"), join(root, "work/escape"));
		allowed = ["/usr", "/bin", "/lib", "/lib64", "/etc", resolve(dirname(process.execPath), "..")].flatMap((p) => ["--read", p]);
		allowed.push("--write", join(root, "work"), "--write", join(root, "auth/auth.json"), "--lock-dir", join(root, "auth"));
		try { await run(seal, [...allowed, "--", "/usr/bin/true"]); }
		catch (error) {
			if (!(error as { stderr?: string }).stderr?.includes("Landlock ABI >=3 required")) throw error;
			unsupported = "Landlock ABI >=3 unavailable; the live runner still refuses unsealed runs";
		}
	});
	afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

	it("denies answer keys, history, symlink escapes and outside writes in descendants", async (ctx) => {
		if (unsupported) return ctx.skip(unsupported);
		const script = `const fs = require('fs'), cp = require('child_process');
const root = process.argv[1];
for (const file of ['answer-key.txt', 'auth/history.txt', 'work/escape']) {
  try { fs.readFileSync(root + '/' + file); throw new Error('unexpected read'); }
  catch (e) { if (e.code !== 'EACCES') throw e; }
}
try { fs.writeFileSync(root + '/outside.txt', 'bad'); throw new Error('unexpected write'); }
catch (e) { if (e.code !== 'EACCES') throw e; }
const child = cp.spawnSync('/bin/cat', [root + '/answer-key.txt']);
if (child.status === 0) throw new Error('descendant escaped');
fs.writeFileSync(root + '/work/output.txt', 'allowed');
console.log('sealed');`;
		const result = await run(seal, [...allowed, "--", process.execPath, "-e", script, root]);
		expect(result.stdout.trim()).toBe("sealed");
		expect(await readFile(join(root, "work/output.txt"), "utf8")).toBe("allowed");
	});

	it("permits exact credential refresh and lock operations without granting sibling reads", async (ctx) => {
		if (unsupported) return ctx.skip(unsupported);
		const script = `const fs = require('fs'), root = process.argv[1];
fs.readFileSync(root + '/auth/auth.json');
fs.mkdirSync(root + '/auth/auth.json.lock');
fs.writeFileSync(root + '/auth/auth.json', '{"refreshed":true}');
fs.rmdirSync(root + '/auth/auth.json.lock');
try { fs.readFileSync(root + '/auth/history.txt'); throw new Error('history leaked'); }
catch(e) { if(e.code !== 'EACCES') throw e; }`;
		await run(seal, [...allowed, "--", process.execPath, "-e", script, root]);
		expect(JSON.parse(await readFile(join(root, "auth/auth.json"), "utf8"))).toEqual({ refreshed: true });
	});

	it("refuses unknown options and missing allowlist paths before running the command", async (ctx) => {
		if (unsupported) return ctx.skip(unsupported);
		await expect(run(seal, ["--bad", root, "--", process.execPath, "--version"])).rejects.toMatchObject({ code: 125 });
		await expect(run(seal, ["--read", join(root, "absent"), "--", process.execPath, "--version"])).rejects.toMatchObject({ code: 125 });
	});

	it("denies unix-socket connect so a sealed command cannot reach an IPC broker's answer keys", async (ctx) => {
		if (unsupported) return ctx.skip(unsupported);
		// Landlock does not mediate connect(); a sealed cat delegated through
		// systemd --user or dockerd read answer keys this process could not open.
		// The seccomp filter blocks socket(AF_UNIX) so the broker door never opens.
		// The socket sits in a writable (Landlock-allowed) dir, so only seccomp,
		// not a path denial, can be what fails the connect.
		const sockPath = join(root, "work/broker.sock");
		const broker: Server = createServer((c) => c.end("answer-key: CVE-0000-0000 at app/x.php:16"));
		await new Promise<void>((res, rej) => { broker.once("error", rej); broker.listen(sockPath, res); });
		try {
			const script = `const net = require('net');
const c = net.connect(process.argv[1]);
c.on('error', (e) => { console.log('denied:' + e.code); process.exit(0); });
c.on('data', (d) => { console.log('LEAKED:' + d); process.exit(0); });`;
			const result = await run(seal, [...allowed, "--", process.execPath, "-e", script, sockPath]);
			expect(result.stdout.trim()).toBe("denied:EACCES");
		} finally {
			await new Promise<void>((res) => broker.close(() => res()));
		}
	});

	it("denies io_uring so a kernel worker cannot open an AF_UNIX broker socket the socket() rule never sees", async (ctx) => {
		if (unsupported) return ctx.skip(unsupported);
		// io_uring runs IORING_OP_SOCKET(AF_UNIX)+IORING_OP_CONNECT inside a kernel
		// worker, so it opens and connects a unix socket without the socket() syscall
		// the AF_UNIX seccomp rule matches -- a delegated `cat <answer-key>` over
		// docker.sock/the user bus this way was invisible to the socket()-only lid.
		// The filter denies io_uring_setup/enter/register with EPERM; libuv then
		// falls back to epoll (verified by the AF_INET/stdio test below still passing).
		const probeSrc = join(root, "iou-probe.c");
		const probeBin = join(root, "work", "iou-probe"); // work is --write => readable+executable under Landlock
		await writeFile(probeSrc, iouProbeC);
		await run("cc", ["-O2", "-o", probeBin, probeSrc]);
		// Confirm the host allows io_uring at all, so the sealed EPERM is the filter's
		// doing and not an io_uring-disabled kernel (rc 2 / "allowed" when unsealed).
		let bare = "";
		try { bare = (await run(probeBin)).stdout; }
		catch (error) { bare = (error as { stdout?: string }).stdout ?? ""; }
		if (bare.trim() !== "allowed") return ctx.skip("io_uring unavailable unsealed; the seal's EPERM would be indistinguishable");
		const sealed = await run(seal, [...allowed, "--", probeBin]);
		expect(sealed.stdout.trim()).toBe("eperm");
	});

	it("still permits piped child_process stdio and AF_INET sockets the runner depends on", async (ctx) => {
		if (unsupported) return ctx.skip(unsupported);
		// socketpair() (a distinct syscall) backs libuv's piped stdio, and DNS +
		// provider TLS need AF_INET; blocking AF_UNIX and io_uring must leave both
		// intact -- node boots here only because libuv falls back off the denied ring.
		const tcp: Server = createServer((c) => c.end("tcp-ok"));
		const port = await new Promise<number>((res, rej) => {
			tcp.once("error", rej);
			tcp.listen(0, "127.0.0.1", () => res((tcp.address() as { port: number }).port));
		});
		try {
			const script = `const cp = require('child_process'), net = require('net');
const piped = cp.spawnSync('/bin/echo', ['piped-ok'], { stdio: ['pipe', 'pipe', 'pipe'] });
if (piped.status !== 0 || piped.stdout.toString().trim() !== 'piped-ok') throw new Error('piped stdio broke');
const c = net.connect(Number(process.argv[1]), '127.0.0.1');
c.on('error', (e) => { throw new Error('AF_INET blocked: ' + e.code); });
c.on('data', (d) => { console.log('inet:' + d + ' piped:' + piped.stdout.toString().trim()); c.end(); process.exit(0); });`;
			const result = await run(seal, [...allowed, "--", process.execPath, "-e", script, String(port)]);
			expect(result.stdout.trim()).toBe("inet:tcp-ok piped:piped-ok");
		} finally {
			await new Promise<void>((res) => tcp.close(() => res()));
		}
	});
});
