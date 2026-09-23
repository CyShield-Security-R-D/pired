/* Linux Landlock filesystem boundary for model evaluations. Fail closed.
 * Build: cc -O2 -Wall -Wextra -o /tmp/pired-fs-seal eval/corpus/fs-seal.c
 * Usage: pired-fs-seal [--read PATH|--write PATH|--lock-dir PATH]... -- CMD...
 * --lock-dir permits auth lock mkdir/rmdir, without granting file reads.
 * Network isolation is separate; the comparison runner seals HTTP egress.
 *
 * Landlock alone is not a process boundary. A sealed bash can hand a path to
 * an IPC broker whose worker is not a Landlock descendant of this process
 * (systemd --user via `systemd-run --user`, or dockerd via /var/run/docker.sock
 * with the operator in group docker), and the broker's worker reads the file
 * with no ruleset in force. On this host (Landlock ABI 4) unix-socket connect()
 * is unmediated, so a delegated `cat <answer-key>` succeeded even though the
 * direct open was denied EACCES -- i.e. the model could read the target CVE id
 * and vulnerable file:line and silently invalidate the finding measurement.
 * bwrap/user namespaces are unavailable here, so we cannot put each cell in its
 * own IPC namespace; instead a seccomp-BPF filter denies the door to those
 * brokers.
 *
 * The seccomp filter (raw BPF, no libseccomp) makes socket(AF_UNIX, ...) fail
 * with EACCES. That is the syscall both `systemd-run --user` (D-Bus over
 * /run/user/<uid>/bus) and the docker client (/var/run/docker.sock) must make
 * to reach their broker; with no AF_UNIX socket they cannot connect. The filter
 * also closes the two ways a caller could reach an AF_UNIX socket without a
 * socket() call the number check would see: io_uring (io_uring_setup/enter/
 * register return EPERM, so a task cannot have a kernel worker run
 * IORING_OP_SOCKET+IORING_OP_CONNECT to the broker -- this host is kernel 6.8
 * with io_uring enabled, and libuv falls back to epoll on the EPERM) and the x32
 * ABI (nrs with __X32_SYSCALL_BIT are dispatched under AUDIT_ARCH_X86_64 and are
 * killed, so an x32 socket() at 0x40000029 cannot slip past nr==__NR_socket).
 * The filter fails closed on an unexpected audit arch (SECCOMP_RET_KILL_PROCESS)
 * so a mismatched syscall ABI -- i386 int 0x80 arrives as AUDIT_ARCH_I386 -- is
 * rejected rather than allowed to smuggle a socket() past the number check. No
 * other syscall opens an AF_UNIX socket on x86_64/aarch64: socketpair() makes
 * connected pairs only (no external endpoint), and accept/accept4() need a
 * listening socket the sealed cell does not have.
 *
 * What the filter deliberately keeps working, because the runner and its probe
 * depend on it: socketpair() is a distinct syscall and stays allowed (libuv's
 * IPC/signal plumbing uses it); AF_INET/AF_INET6 sockets stay allowed so DNS
 * and provider TLS still work (the runner steers egress with proxy env, not by
 * blocking sockets); AF_NETLINK stays allowed because glibc getaddrinfo opens a
 * NETLINK_ROUTE socket to enumerate interfaces and denying it breaks DNS.
 *
 * What this does NOT close, and what a newer kernel would: a TCP connection to a
 * localhost broker that happens to listen on AF_INET (none of systemd/docker do
 * by default here) is still reachable; signals are not scoped (Landlock ABI 4
 * has no LANDLOCK_ACCESS_NET or signal scoping, so `kill` from a sealed cell can
 * still reach same-uid processes) -- Landlock ABI 6's network rules would scope
 * connect() to TCP ports rather than relying on this coarse AF_UNIX block. The
 * filter is a coarse, fail-closed lid over the broker-escape door, not a full
 * IPC namespace.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

/* Older kernel headers predate the process-wide kill action; the runtime kernel
 * here (6.8) honours it, and the constant is a plain bit pattern. */
#ifndef SECCOMP_RET_KILL_PROCESS
#define SECCOMP_RET_KILL_PROCESS 0x80000000U
#endif

/* x32 syscalls set this bit and are dispatched under AUDIT_ARCH_X86_64 (there is
 * no separate audit arch for x32), so an x32 socket() arrives as nr 0x40000029,
 * never matching __NR_socket (41) while the kernel still runs socket(). The
 * filter rejects the whole high-numbered range rather than trust the number
 * check alone. Defined by <asm/unistd.h> on x86_64; provide it elsewhere so the
 * one guard compiles on every supported arch (no legitimate syscall number on
 * x86_64 or aarch64 reaches 0x40000000). */
#ifndef __X32_SYSCALL_BIT
#define __X32_SYSCALL_BIT 0x40000000U
#endif

/* io_uring lets a task ask a kernel worker to run IORING_OP_SOCKET +
 * IORING_OP_CONNECT, which creates and connects an AF_UNIX socket without ever
 * issuing the socket() syscall -- so the AF_UNIX rule below never sees it and a
 * sealed cell could still reach a broker's unix socket (docker.sock, the user
 * D-Bus). io_uring_setup/enter/register are denied with EPERM so that door is
 * shut. EPERM (not kill) is deliberate: node 22 / libuv 1.51 probe io_uring at
 * startup and fall back to epoll + the thread pool on any error, so the cell
 * keeps working; a kill would take node down on the probe. The nrs are identical
 * on x86_64 and aarch64 (asm-generic table); fall back if headers predate them. */
#ifndef __NR_io_uring_setup
#define __NR_io_uring_setup 425
#endif
#ifndef __NR_io_uring_enter
#define __NR_io_uring_enter 426
#endif
#ifndef __NR_io_uring_register
#define __NR_io_uring_register 427
#endif

/* The filter is validated only for the architectures the eval host runs on. A
 * different build arch would need its own audit-arch constant and syscall ABI
 * review, so refuse to compile rather than ship a filter that silently matches
 * the wrong syscall numbers. */
#if defined(__x86_64__)
#define SEAL_AUDIT_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define SEAL_AUDIT_ARCH AUDIT_ARCH_AARCH64
#else
#error "fs-seal seccomp filter: unsupported build architecture"
#endif

/* args[] in seccomp_data is __u64; on the little-endian arches above the low 32
 * bits (where the int socket domain lives) sit at the field's base offset. */
#define SEAL_ARG_LO(n) (offsetof(struct seccomp_data, args[n]))

static void fail(const char *what) { perror(what); exit(125); }

/* Close every way a sealed command could reach a broker daemon's unix socket
 * (systemd --user over the user D-Bus, dockerd over docker.sock) and thereby
 * read files this process itself cannot:
 *   1. an unexpected audit arch (i386 int 0x80 arrives as AUDIT_ARCH_I386, not
 *      AUDIT_ARCH_X86_64) kills the process -- fail closed, so a 32-bit ABI
 *      cannot present socket() under different numbering;
 *   2. any nr with __X32_SYSCALL_BIT set is killed, so an x32 socket()
 *      (0x40000029) cannot slip past the nr==__NR_socket test and still run;
 *   3. io_uring_setup/enter/register return EPERM, so a task cannot ask a kernel
 *      worker to run IORING_OP_SOCKET(AF_UNIX)+IORING_OP_CONNECT and open the
 *      broker socket without ever calling socket() (libuv falls back to epoll);
 *   4. socket(AF_UNIX, ...) returns EACCES, the direct path both brokers need.
 * socketpair() (a distinct syscall) makes only connected pairs, and accept/
 * accept4() need a listening socket the cell does not have, so neither reaches a
 * broker; both stay allowed. Everything else is allowed -- AF_INET/AF_INET6 and
 * AF_NETLINK sockets, so DNS and provider TLS keep working. */
static void install_socket_filter(void) {
	struct sock_filter filter[] = {
		/* [0-2] arch guard: kill on any ABI but the one this build validated. */
		BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
		BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SEAL_AUDIT_ARCH, 1, 0),
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
		BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
		/* [4-5] x32 guard: high-bit nrs share this audit arch; kill them. */
		BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, __X32_SYSCALL_BIT, 0, 1),
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
		/* [6-9] deny io_uring with EPERM (the socket-less AF_UNIX door). */
		BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_io_uring_setup, 2, 0),
		BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_io_uring_enter, 1, 0),
		BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_io_uring_register, 0, 1),
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA)),
		/* [10-14] deny socket(AF_UNIX) with EACCES; allow all other domains. */
		BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socket, 0, 3),
		BPF_STMT(BPF_LD | BPF_W | BPF_ABS, SEAL_ARG_LO(0)),
		BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_UNIX, 0, 1),
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EACCES & SECCOMP_RET_DATA)),
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
	};
	struct sock_fprog prog = { .len = sizeof(filter) / sizeof(filter[0]), .filter = filter };
	/* NO_NEW_PRIVS is already set by the caller, which SECCOMP_SET_MODE_FILTER
	 * requires for an unprivileged process. */
	if (syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, 0, &prog)) fail("fs-seal seccomp filter");
}

int main(int argc, char **argv) {
    int abi = syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
    if (abi < 3) {
        fprintf(stderr, "fs-seal: Landlock ABI >=3 required (found %d)\n", abi);
        return 125;
    }
    const __u64 read = LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR;
    const __u64 write = LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_REMOVE_DIR |
        LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR |
        LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO |
        LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_MAKE_SYM | LANDLOCK_ACCESS_FS_REFER |
        LANDLOCK_ACCESS_FS_TRUNCATE;
    struct landlock_ruleset_attr rules = { .handled_access_fs = read | write };
    int fd = syscall(SYS_landlock_create_ruleset, &rules, sizeof(rules), 0);
    if (fd < 0) fail("fs-seal create ruleset");
    int i;
    for (i = 1; i < argc && strcmp(argv[i], "--"); i += 2) {
        if (i + 1 >= argc) { fprintf(stderr, "fs-seal: missing path\n"); return 125; }
        __u64 access;
        if (!strcmp(argv[i], "--read")) access = read;
        else if (!strcmp(argv[i], "--write")) access = read | write;
        else if (!strcmp(argv[i], "--lock-dir")) access = LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_REMOVE_DIR;
        else { fprintf(stderr, "fs-seal: unknown option %s\n", argv[i]); return 125; }
        int path = open(argv[i + 1], O_PATH | O_CLOEXEC);
        if (path < 0) fail(argv[i + 1]);
        struct stat st;
        if (fstat(path, &st)) fail("fs-seal stat");
        if (!S_ISDIR(st.st_mode)) access &= LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE |
            LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_TRUNCATE;
        struct landlock_path_beneath_attr rule = { .allowed_access = access, .parent_fd = path };
        if (syscall(SYS_landlock_add_rule, fd, LANDLOCK_RULE_PATH_BENEATH, &rule, 0)) fail("fs-seal add rule");
        close(path);
    }
    if (i + 1 >= argc) { fprintf(stderr, "fs-seal: missing command after --\n"); return 125; }
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) fail("fs-seal no-new-privileges");
    /* Close the broker-escape door before the filesystem ruleset; both need
     * NO_NEW_PRIVS and both persist across execvp. */
    install_socket_filter();
    if (syscall(SYS_landlock_restrict_self, fd, 0)) fail("fs-seal restrict");
    close(fd);
    execvp(argv[i + 1], &argv[i + 1]);
    fail("fs-seal exec");
}
