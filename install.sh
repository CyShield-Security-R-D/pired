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
#   NPM_PREFIX     npm --prefix to install into  (default npm's own global root)
#   PIRED_SKIP_PI  set to 1 to not install pi

set -eu

RED='\033[38;5;203m'; DIM='\033[2m'; BOLD='\033[1m'; OFF='\033[0m'
if [ ! -t 1 ]; then RED=''; DIM=''; BOLD=''; OFF=''; fi

say()  { printf '%b\n' "$*"; }
step() { printf '%b\n' "${RED}::${OFF} $*"; }
die()  { printf '%b\n' "${RED}pired:${OFF} $*" >&2; exit 1; }

say ""
say "  ${RED}${BOLD}pi(red)${OFF} ${DIM}— engagement harness for security consultants${OFF}"
say ""

# --- prerequisites ----------------------------------------------------------
# node 22.19 is pi's floor and pired's: the extension is TypeScript that pi
# type-strips at load, which needs a runtime that can do it.
command -v node >/dev/null 2>&1 || die "node not found. Install Node.js >= 22.19 and re-run."
command -v npm  >/dev/null 2>&1 || die "npm not found. Install Node.js >= 22.19 and re-run."

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
NODE_MINOR=$(node -p 'process.versions.node.split(".")[1]')
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 19 ]; }; then
	die "node $(node -v) is too old. pired needs >= 22.19."
fi

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
NPM_ARGS="--global --ignore-scripts"
[ -n "${NPM_PREFIX:-}" ] && NPM_ARGS="$NPM_ARGS --prefix $NPM_PREFIX"

# --- pi ---------------------------------------------------------------------
if [ "${PIRED_SKIP_PI:-0}" != "1" ] && ! command -v pi >/dev/null 2>&1; then
	step "installing pi"
	# shellcheck disable=SC2086
	npm install $NPM_ARGS @earendil-works/pi-coding-agent >/dev/null || die "could not install pi"
fi

# --- pired ------------------------------------------------------------------
step "installing pired ${DIM}(${SOURCE})${OFF}"
# shellcheck disable=SC2086
if ! npm install $NPM_ARGS "$SOURCE" >/dev/null 2>&1; then
	printf '%b\n' "${RED}pired:${OFF} could not install from $SOURCE" >&2
	case "$SOURCE" in
		github:*)
			# A private repo 404s for an unauthenticated fetch, which npm reports as
			# a missing package. Name the likely cause rather than the symptom.
			say "  ${DIM}If the repository is private, clone it and run the installer from there:${OFF}"
			say "    git clone git@github.com:mamgad/pired.git && cd pired && ./install.sh"
			;;
	esac
	exit 1
fi

# --- register the extension with pi ----------------------------------------
# Installing the binary gives you `pired`; this is what makes a bare `pi` load
# the security layer too. Non-fatal: the launcher passes -e explicitly, so
# pired still works completely if this step cannot find pi.
if command -v pi >/dev/null 2>&1; then
	NPM_ROOT=$(npm root --global ${NPM_PREFIX:+--prefix "$NPM_PREFIX"} 2>/dev/null || true)
	if [ -n "$NPM_ROOT" ] && [ -d "$NPM_ROOT/pired" ]; then
		step "registering the extension with pi"
		pi install "$NPM_ROOT/pired" >/dev/null 2>&1 ||
			say "  ${DIM}skipped — run: pi install $NPM_ROOT/pired${OFF}"
	fi
fi

# --- report -----------------------------------------------------------------
say ""
# `npm bin -g` was removed in npm 9, so derive the directory from the prefix.
BIN_DIR="$(npm prefix --global ${NPM_PREFIX:+--prefix "$NPM_PREFIX"} 2>/dev/null)/bin"
if [ -x "$BIN_DIR/pired" ] && [ "$(command -v pired 2>/dev/null || true)" = "$BIN_DIR/pired" ]; then
	say "  ${BOLD}installed${OFF} ${DIM}$BIN_DIR/pired${OFF}"
elif [ -x "$BIN_DIR/pired" ]; then
	# The usual cause is an npm prefix whose bin/ is not on PATH. Say so: an
	# install that works but cannot be typed looks identical to a failed one.
	say "  ${BOLD}installed${OFF} ${DIM}$BIN_DIR/pired${OFF}"
	say "  ${DIM}not on your PATH — add it:${OFF} export PATH=\"$BIN_DIR:\$PATH\""
else
	die "npm reported success but $BIN_DIR/pired is missing."
fi
say ""
say "  ${DIM}next${OFF}"
say "    pired                    ${DIM}review the current directory${OFF}"
say "    pired --profile pentest  ${DIM}blackbox testing (needs an authorized scope)${OFF}"
say "    /panel                   ${DIM}the engagement panel · alt+p toggles it${OFF}"
say ""
say "  ${DIM}docs: https://github.com/mamgad/pired/tree/main/docs${OFF}"
say ""
