#!/bin/sh
# pired installer — one command for the launcher and the pi extension.
#
#   curl -fsSL https://raw.githubusercontent.com/mamgad/pired/main/install.sh | sh
#
# Installs, in order: pi (if missing), pired, and pired's extension registration
# so a plain `pi` also loads the security layer. Everything is npm-global; there
# is no sudo, no daemon and no state outside ~/.pi and ~/.pired.
#
# Environment:
#   PIRED_SOURCE   npm spec to install from      (default github:mamgad/pired)
#   NPM_PREFIX     prefix to install into        (default npm's own global root,
#                  or ~/.local when that root is not writable)
#   PIRED_SKIP_PI  set to 1 to not install pi

set -eu

RED='\033[38;5;203m'; DIM='\033[2m'; BOLD='\033[1m'; OFF='\033[0m'
if [ ! -t 1 ]; then RED=''; DIM=''; BOLD=''; OFF=''; fi

say()  { printf '%b\n' "$*"; }
step() { printf '%b\n' "${RED}::${OFF} $*"; }
die()  { printf '%b\n' "${RED}pired:${OFF} $*" >&2; exit 1; }

# npm's own output is captured rather than discarded. An installer that says
# only "could not install" leaves the user with nothing to act on.
LOG=$(mktemp 2>/dev/null || echo "/tmp/pired-install.$$.log")
trap 'rm -f "$LOG"' EXIT
spill() { sed -e 's/^/    /' "$LOG" | tail -12 >&2; }

npm_install() {
	# shellcheck disable=SC2086 # $1 may be an empty flag slot
	npm install --global --ignore-scripts $1 "$2" >"$LOG" 2>&1
}

# --- prerequisites ----------------------------------------------------------
# Checked before the banner: on a pipe, stdout is block-buffered while stderr is
# not, so a die() here would otherwise print above the header it follows.
#
# node 22.19 is pi's floor and pired's: the extension is TypeScript that pi
# type-strips at load, which needs a runtime that can do it.
command -v node >/dev/null 2>&1 || die "node not found. Install Node.js >= 22.19 and re-run."
command -v npm  >/dev/null 2>&1 || die "npm not found. Install Node.js >= 22.19 and re-run."

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
NODE_MINOR=$(node -p 'process.versions.node.split(".")[1]')
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 19 ]; }; then
	die "node $(node -v) is too old. pired needs >= 22.19."
fi

say ""
say "  ${RED}${BOLD}pi(red)${OFF} ${DIM}— engagement harness for security consultants${OFF}"
say ""

# --- source -----------------------------------------------------------------
# Prefer a checkout we are sitting inside: running ./install.sh from a clone
# should install *that* clone, not re-download one. When the script is piped from
# curl there is no directory to find, so it falls back to the published repo.
SELF_DIR=""
case "${0:-}" in
	*/*) SELF_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd) ;;
esac
DEFAULT_SOURCE="github:mamgad/pired"
if [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/package.json" ] &&
	grep -q '"name": *"pired"' "$SELF_DIR/package.json" 2>/dev/null; then
	DEFAULT_SOURCE="$SELF_DIR"
fi

SOURCE=${PIRED_SOURCE:-$DEFAULT_SOURCE}

# --- where to install -------------------------------------------------------
# The prefix travels as an environment variable, not as a --prefix argument: the
# argument list was word-split, so a prefix containing a space installed
# somewhere else entirely without saying so.
[ -n "${NPM_PREFIX:-}" ] && export npm_config_prefix="$NPM_PREFIX"

# `npm install --global` writes to both of these. When it cannot — a distro node
# owned by root, and a user who was promised no sudo — fall back to a per-user
# prefix rather than failing with npm's EACCES wall of text.
writable() {
	_d=$1
	while [ ! -d "$_d" ] && [ "$_d" != "/" ] && [ -n "$_d" ]; do _d=$(dirname "$_d"); done
	[ -w "$_d" ]
}
prefix_writable() {
	_p=$(npm prefix --global 2>/dev/null) || return 1
	[ -n "$_p" ] || return 1
	writable "$_p/lib/node_modules" && writable "$_p/bin"
}

if ! prefix_writable; then
	[ -z "${NPM_PREFIX:-}" ] || die "cannot write to NPM_PREFIX=$NPM_PREFIX. Pick a writable directory."
	UNWRITABLE=$(npm prefix --global 2>/dev/null || echo "npm's global prefix")
	NPM_PREFIX="$HOME/.local"
	mkdir -p "$NPM_PREFIX/bin" "$NPM_PREFIX/lib/node_modules" ||
		die "$UNWRITABLE is not writable, and neither is $NPM_PREFIX."
	export npm_config_prefix="$NPM_PREFIX"
	say "  ${DIM}$UNWRITABLE is not writable — installing into $NPM_PREFIX instead${OFF}"
	say ""
fi

# `npm bin -g` was removed in npm 9, so derive the directory from the prefix.
BIN_DIR="$(npm prefix --global 2>/dev/null)/bin"

# --- pi ---------------------------------------------------------------------
# Resolved by path first: under a custom prefix, pi lands in a bin directory that
# is typically not on PATH yet, and `command -v pi` would miss the copy we just
# installed — reinstalling it, then silently skipping the registration below.
PI=""
resolve_pi() {
	if [ -x "$BIN_DIR/pi" ]; then PI="$BIN_DIR/pi"; else PI=$(command -v pi 2>/dev/null || true); fi
}

resolve_pi
if [ "${PIRED_SKIP_PI:-0}" != "1" ] && [ -z "$PI" ]; then
	step "installing pi"
	npm_install "" @earendil-works/pi-coding-agent || { spill; die "could not install pi"; }
	resolve_pi
fi

# --- pired ------------------------------------------------------------------
step "installing pired ${DIM}(${SOURCE})${OFF}"
# Installing a local directory the plain way makes the global package a SYMLINK
# back into it, so moving or deleting the clone silently breaks the install.
# --install-links copies the files in, and honours package.json "files".
LINKS=""
[ -d "$SOURCE" ] && LINKS="--install-links"
if ! npm_install "$LINKS" "$SOURCE"; then
	spill
	case "$SOURCE" in
		github:*)
			# A private repo 404s for an unauthenticated fetch, which npm reports as
			# a missing package. Name the likely cause rather than the symptom.
			say "  ${DIM}If the repository is private, clone it and run the installer from there:${OFF}"
			say "    git clone git@github.com:mamgad/pired.git && cd pired && ./install.sh"
			;;
	esac
	die "could not install from $SOURCE"
fi

# --- register the extension with pi ----------------------------------------
# Installing the binary gives you `pired`; this is what makes a bare `pi` load
# the security layer too. Non-fatal — the launcher passes -e explicitly, so
# pired still works completely without it — but never silent: an unregistered
# extension means a plain `pi` runs with no security layer at all.
NPM_ROOT=$(npm root --global 2>/dev/null || true)
if [ -n "$NPM_ROOT" ] && [ -d "$NPM_ROOT/pired" ]; then
	if [ -n "$PI" ]; then
		step "registering the extension with pi"
		"$PI" install "$NPM_ROOT/pired" >"$LOG" 2>&1 ||
			say "  ${DIM}skipped — run: pi install $NPM_ROOT/pired${OFF}"
	else
		say "  ${DIM}pi not found: a plain 'pi' will not load the security layer.${OFF}"
		say "  ${DIM}register it with: pi install $NPM_ROOT/pired${OFF}"
	fi
fi

# --- verify -----------------------------------------------------------------
[ -x "$BIN_DIR/pired" ] || die "npm reported success but $BIN_DIR/pired is missing."

# An install that cannot start is indistinguishable from a working one until the
# first engagement. Find out now, while there is still something to say about it.
if [ -n "$PI" ]; then
	step "verifying"
	"$BIN_DIR/pired" --help >"$LOG" 2>&1 || { spill; die "pired installed but could not start."; }
fi

# --- report -----------------------------------------------------------------
say ""
say "  ${BOLD}installed${OFF} ${DIM}$BIN_DIR/pired${OFF}"
if [ "$(command -v pired 2>/dev/null || true)" != "$BIN_DIR/pired" ]; then
	# The usual cause is an npm prefix whose bin/ is not on PATH. Say so: an
	# install that works but cannot be typed looks identical to a failed one.
	say "  ${DIM}not on your PATH — add it:${OFF} export PATH=\"$BIN_DIR:\$PATH\""
fi
say ""
say "  ${DIM}next${OFF}"
say "    pired                    ${DIM}review the current directory${OFF}"
say "    pired --profile pentest  ${DIM}blackbox testing (needs an authorized scope)${OFF}"
say "    /panel                   ${DIM}the engagement panel · alt+p toggles it${OFF}"
say ""
say "  ${DIM}docs: https://github.com/mamgad/pired/tree/main/docs${OFF}"
say ""
