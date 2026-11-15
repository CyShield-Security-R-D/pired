#!/bin/sh
# pired installer for macOS and Linux — from a vanilla box to a first engagement.
#
#   curl -fsSL https://raw.githubusercontent.com/CyShield-Security-R-D/pired/main/install.sh | sh
#
# Windows has its own script, because npm lays a global install out differently
# there and PATH lives in the registry:
#
#   powershell -c "irm https://raw.githubusercontent.com/CyShield-Security-R-D/pired/main/install.ps1 | iex"
#
# It surveys the box, prints exactly what it will do and where, asks once, and
# then does all of it: Node.js (when missing or too old), pi (when missing or
# older than 0.86.1), pired, and the PATH line that makes the command typeable.
#
# It does not register pired with pi. `pi` stays the pi you installed; the
# security layer arrives only when you type `pired`, which passes it to pi with
# -e for that run. See ADR-017.
#
# It does register pi-subagents, the package pired delegates through, and
# upgrades a registered npm:pi-subagents older than 0.71.0. That is a package
# the operator would otherwise install by hand, it is named in the plan, and
# PIRED_SKIP_SUBAGENTS=1 declines it. See ADR-021 and ADR-027.
#
# It registers pi-mcp-adapter the same way, after pi-subagents: the MCP proxy
# whose calls pired's scope gate checks. A registered npm:pi-mcp-adapter older
# than 2.33.0 is upgraded, because below that a call the adapter had cached as
# approved for the session never reaches the gate. PIRED_SKIP_MCP=1 declines it.
#
# Nothing runs as root. A vanilla Ubuntu has neither Node nor git, and neither
# absence is a reason to reach for sudo:
#
#   - Node comes from nodejs.org as a user-owned tarball under ~/.local/share,
#     checksum-verified, as .tar.gz so unpacking it needs no xz.
#   - A github: source is fetched over HTTPS from codeload when git is missing,
#     rather than apt-installing git in order to run one clone.
#
# An installer for a security tool that skips a checksum, or takes root it does
# not need, teaches the wrong habit on the very first command.
#
# Usage:
#   install.sh [-y|--yes] [--dry-run] [-h|--help]
#
# Environment:
#   PIRED_SOURCE          npm spec to install from   (default github:CyShield-Security-R-D/pired)
#   NPM_PREFIX            prefix to install into     (default npm's own global root;
#                         ~/.local/share/pired when this script brings its own Node,
#                         ~/.local when npm's root is not writable)
#   PIRED_SKIP_PI         1 to not install or upgrade pi
#   PIRED_SKIP_SUBAGENTS  1 to not install or upgrade pi-subagents
#   PIRED_SKIP_MCP        1 to not install or upgrade pi-mcp-adapter
#   PIRED_YES             1 to skip the confirmation prompt
#   PIRED_NO_ANIM         1 for plain line-at-a-time output

set -eu

PI_PACKAGE="@earendil-works/pi-coding-agent"
# The package pired delegates through: `spawn a subagent` is a thing the
# operator can ask for on a fresh box, rather than a README step they find out
# about after the first engagement wanted one. See ADR-021.
SUBAGENTS_PACKAGE="npm:pi-subagents"
# Floors, not preferences. pired's delegation is built on pi-subagents 0.71
# (ADR-027), and 0.86.1 is the oldest pi host that release supports — so a
# box that meets neither has pired without delegation, and says so.
PI_FLOOR=0.86.1
SUBAGENTS_FLOOR=0.71.0
# The MCP proxy. pired's scope gate hears each MCP call on the adapter's
# approval-broker event (pi-mcp-adapter:tool-approval-request), which 2.20.0
# added. Before 2.33.0 the adapter did not raise it for a call it had cached as
# approved for the session, so one session grant let every later call to that
# tool past the gate unchecked. Hence the floor.
MCP_PACKAGE="npm:pi-mcp-adapter"
MCP_FLOOR=2.33.0
NODE_LINE=22
NODE_MIN_MAJOR=22
NODE_MIN_MINOR=19
NODE_DIST="https://nodejs.org/dist/latest-v${NODE_LINE}.x"
DEFAULT_REPO="CyShield-Security-R-D/pired"

ASSUME_YES=${PIRED_YES:-0}
DRY_RUN=0

usage() {
	# Piped from curl there is no file to read the header out of, so the flags
	# are spelled out rather than sliced from the comment block above.
	# To the first blank line rather than to a fixed line number: the range 2,37
	# was already one env var short of the block it meant to print, and a header
	# that grows silently truncates the help it is the source of.
	if [ -r "${0:-}" ] && head -1 "$0" 2>/dev/null | grep -q '^#!'; then
		sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
		return 0
	fi
	cat <<'USAGE'
pired installer — installs Node.js (if needed), pi, pired and the extension.

  install.sh [-y|--yes] [--dry-run] [-h|--help]

  -y, --yes    install without the confirmation prompt
  --dry-run    print the plan and change nothing

  PIRED_SOURCE / NPM_PREFIX / PIRED_SKIP_PI / PIRED_SKIP_SUBAGENTS
  PIRED_SKIP_MCP / PIRED_YES / PIRED_NO_ANIM
  https://github.com/CyShield-Security-R-D/pired/tree/main/docs
USAGE
}

for arg in "$@"; do
	case "$arg" in
		-y|--yes) ASSUME_YES=1 ;;
		--dry-run) DRY_RUN=1 ;;
		-h|--help) usage; exit 0 ;;
		*) printf 'pired: unknown option %s (try --help)\n' "$arg" >&2; exit 2 ;;
	esac
done

# --- output -----------------------------------------------------------------
# The palette is the theme's: #ff5f5f for the accent, a soft green for the
# checkmarks. Colour is dropped the moment stdout is not a terminal, so a log
# file or a CI transcript stays readable.
if [ -t 1 ] && [ "${TERM:-}" != "dumb" ]; then
	RED='\033[38;5;203m'; GREEN='\033[38;5;108m'; DIM='\033[2m'; BOLD='\033[1m'; OFF='\033[0m'
	TTY_OUT=1
else
	RED=''; GREEN=''; DIM=''; BOLD=''; OFF=''
	TTY_OUT=0
fi

say() { printf '%b\n' "$*"; }
die() { printf '%b\n' "${RED}pired:${OFF} $*" >&2; exit 1; }

# Unicode is a question about the terminal, not about the platform: a box with
# LANG=C draws the block wordmark as a row of question marks.
UNICODE=0
case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
	*UTF-8*|*utf-8*|*UTF8*|*utf8*) UNICODE=1 ;;
esac
case "${TERM_PROGRAM:-}" in Apple_Terminal|iTerm.app|vscode|WezTerm) UNICODE=1 ;; esac

if [ "$UNICODE" = 1 ]; then TICK='✓'; CROSS='✗'; DOT='·'; PLUS='+'; ARROW='→'; UP='↑'; GE='≥'
else TICK='ok'; CROSS='!!'; DOT='-'; PLUS='+'; ARROW='->'; UP='^'; GE='>='; fi

# A fractional sleep is what makes a spinner a spinner. Every coreutils and BSD
# sleep takes one, but busybox's does not always — so ask before relying on it.
ANIMATE=0
if [ "$TTY_OUT" = 1 ] && [ "${PIRED_NO_ANIM:-0}" != 1 ] && sleep 0.05 2>/dev/null; then
	ANIMATE=1
fi

# npm's own output is captured rather than discarded. An installer that says
# only "could not install" leaves the user with nothing to act on.
#
# The template is explicit because BSD mktemp (macOS) rejects the bare form that
# GNU mktemp accepts — and a predictable /tmp name is a world-writable path this
# script then writes to.
LOG=$(mktemp "${TMPDIR:-/tmp}/pired-install.XXXXXX") || die "could not create a temporary file."
WORKDIR=""
cleanup() {
	rm -f "$LOG"
	[ -n "$WORKDIR" ] && rm -rf "$WORKDIR"
	[ "$TTY_OUT" = 1 ] && printf '\033[?25h'
	return 0
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM

spill() { sed -e 's/^/    /' "$LOG" | tail -14 >&2; }

tilde() {
	case "$1" in
		"$HOME"/*) printf '~%s' "${1#"$HOME"}" ;;
		*) printf '%s' "$1" ;;
	esac
}

on_path() {
	case ":${PATH}:" in *":$1:"*) return 0 ;; esac
	return 1
}

# --- the wordmark -----------------------------------------------------------
# The same lockup the agent opens with (core/banner.ts): PIRED in a three-row
# half-block face, split at the word so "pi" and "red" take their own tone —
# the name is literally pi + red, so the accent makes the wordmark explain
# itself. Full block capitals would be six rows and read as retro.
banner_row() {
	say "  ${BOLD}$1${OFF}${RED}${BOLD}$2${OFF}"
	[ "$ANIMATE" = 1 ] && sleep 0.06
	return 0
}

banner() {
	say ""
	if [ "$UNICODE" = 1 ]; then
		banner_row '█▀█ █' ' █▀█ █▀▀ █▀▄'
		banner_row '█▀▀ █' ' █▀▄ █▀▀ █ █'
		banner_row '▀   ▀' ' ▀ ▀ ▀▀▀ ▀▀ '
	else
		say "  ${BOLD}pi${OFF}${RED}${BOLD}red${OFF}"
	fi
	say ""
	say "  ${DIM}security assessment harness${OFF}"
	say ""
}

# --- progress ---------------------------------------------------------------
# One line per step: a spinner while it runs, a checkmark when it lands. The
# label beside the spinner is scraped out of the log as it grows, so a long npm
# install says what it is doing rather than sitting on "installing".
spinner_frame() {
	if [ "$UNICODE" = 1 ]; then
		case $(($1 % 10)) in
			0) printf '⠋' ;; 1) printf '⠙' ;; 2) printf '⠹' ;; 3) printf '⠸' ;; 4) printf '⠼' ;;
			5) printf '⠴' ;; 6) printf '⠦' ;; 7) printf '⠧' ;; 8) printf '⠇' ;; *) printf '⠏' ;;
		esac
	else
		case $(($1 % 4)) in 0) printf '-' ;; 1) printf '\\' ;; 2) printf '|' ;; *) printf '/' ;; esac
	fi
}

animate() {
	anim_title=$1; anim_labeller=$2; anim_log=$3
	anim_step=0
	anim_label=$STEP_HINT
	while :; do
		if [ $((anim_step % 5)) -eq 0 ]; then
			anim_label=$("$anim_labeller" "$anim_log" "$anim_label")
		fi
		printf '\r\033[K  %b %-11s%b' \
			"${RED}$(spinner_frame "$anim_step")${OFF}" "$anim_title" "${DIM}${anim_label}${OFF}"
		anim_step=$((anim_step + 1))
		sleep 0.08
	done
}

# What the spinner says until the log gives it something better. Set before each
# step; the labellers fall back to it rather than to an empty line.
STEP_HINT=""

# Run one step of the install with a spinner over it. $1 title, $2 the function
# that turns log lines into a short label, then the command and its arguments.
step() {
	step_title=$1; step_labeller=$2; shift 2
	: >"$LOG"

	if [ "$ANIMATE" != 1 ]; then
		# On a terminal without a usable spinner, say what started; in a log the
		# checkmark line that follows says it all and this would only be noise.
		[ "$TTY_OUT" = 1 ] && printf '  %b %s\n' "${DIM}${DOT}${OFF}" "$step_title"
		if "$@" >"$LOG" 2>&1; then return 0; fi
		return 1
	fi

	"$@" >"$LOG" 2>&1 &
	step_pid=$!
	printf '\033[?25l'
	animate "$step_title" "$step_labeller" "$LOG" &
	anim_pid=$!
	trap 'kill "$step_pid" 2>/dev/null; kill "$anim_pid" 2>/dev/null; cleanup; exit 130' INT TERM

	if wait "$step_pid"; then step_status=0; else step_status=$?; fi

	kill "$anim_pid" 2>/dev/null || true
	wait "$anim_pid" 2>/dev/null || true
	printf '\r\033[K\033[?25h'
	trap 'cleanup; exit 130' INT TERM
	return "$step_status"
}

done_line() { printf '%b\n' "  ${GREEN}${TICK}${OFF} $(printf '%-11s' "$1")${DIM}$2${OFF}"; }
skip_line() { printf '%b\n' "  ${DIM}${DOT} $(printf '%-11s' "$1")$2${OFF}"; }
warn_line() { printf '%b\n' "  ${RED}${CROSS}${OFF} $(printf '%-11s' "$1")${DIM}$2${OFF}"; }

# The labellers. Nothing here is load-bearing: a line that matches nothing just
# leaves the previous label standing.
node_label() {
	nl_label=${2:-$STEP_HINT}
	while IFS= read -r line; do
		case "$line" in
			Resolving*) nl_label="resolving the current v${NODE_LINE} release" ;;
			Downloading*) nl_label="downloading Node.js ${line#Downloading }" ;;
			Verifying*) nl_label="verifying the checksum" ;;
			Extracting*) nl_label="unpacking" ;;
			Linking*) nl_label="linking node, npm and npx" ;;
			Installed*) nl_label="installed" ;;
		esac
	done < "$1"
	printf '%s' "$nl_label"
}

npm_label() {
	nl_label=${2:-$STEP_HINT}
	nl_meta=0
	nl_tar=0
	while IFS= read -r line; do
		case "$line" in
			Fetching*) nl_label="fetching ${line#Fetching }" ;;
			Unpacking*) nl_label="unpacking the source" ;;
			npm\ http\ fetch\ GET\ *registry.npmjs.org/*.tgz*)
				nl_tar=$((nl_tar + 1)); nl_label="fetching packages (${nl_tar})" ;;
			npm\ http\ fetch\ GET\ *registry.npmjs.org/*)
				nl_meta=$((nl_meta + 1)); nl_label="resolving packages (${nl_meta})" ;;
			npm\ verbose\ title*) nl_label="resolving packages" ;;
			added\ *|changed\ *|removed\ *|up\ to\ date*) nl_label="$line" ;;
		esac
	done < "$1"
	printf '%s' "$nl_label"
}

quiet_label() { printf '%s' "${2:-$STEP_HINT}"; }

# --- download helpers -------------------------------------------------------
# curl is how most people got here, but a clone run on a box without it should
# still work, and wget is the other thing that is always there.
fetch() {
	if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
	elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
	else return 1
	fi
}

have_downloader() { command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1; }

# A checksum this script cannot compute is a checksum it must not skip. pired
# spends its working life telling people to verify what they run; an installer
# that shrugged here would be the first counterexample.
sha256_of() {
	if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
	elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
	elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | sed 's/.*= *//'
	else return 1
	fi
}

# --- versions ---------------------------------------------------------------
# 0 when version $1 is at least $2. Only the first three numbers count, so a
# pre-release reads as its release. A version that does not parse — a pi that
# would not start, a package.json with no version — is never new enough:
# "could not tell" is not a reason to leave a floor unchecked.
version_at_least() {
	awk -v have="$1" -v want="$2" 'BEGIN {
		sub(/^v/, "", have)
		if (have !~ /^[0-9]+\.[0-9]+\.[0-9]+/) exit 1
		split(have, h, /[^0-9]+/); split(want, w, /[^0-9]+/)
		for (i = 1; i <= 3; i++) {
			if (h[i] + 0 > w[i] + 0) exit 0
			if (h[i] + 0 < w[i] + 0) exit 1
		}
		exit 0
	}'
}

# What a pi says it is, or nothing. `pi --version` prints the bare version.
pi_version() {
	[ -n "$1" ] || return 0
	"$1" --version 2>/dev/null |
		sed -n 's/^[^0-9]*\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*[-+.0-9A-Za-z]*\).*/\1/p' | head -n 1
}

# The version in <dir>/package.json, or nothing. Read with node rather than
# sed: a minified manifest puts every "version" key on one line.
package_version() {
	[ -n "$1" ] && [ -f "$1/package.json" ] || return 0
	node -e 'try { const v = require(process.argv[1]).version; if (typeof v === "string") process.stdout.write(v) } catch {}' \
		"$1/package.json" 2>/dev/null || true
}

# --- layout -----------------------------------------------------------------
# When this script brings its own Node, everything it owns lives under one
# directory:
#
#   ~/.local/share/pired/bin              node, npm, npx, pi, pired  (one PATH entry)
#   ~/.local/share/pired/lib/node_modules
#   ~/.local/share/pired/node/v22.x.y
#   ~/.local/share/pired/node/current  ->  v22.x.y
#
# The npm prefix is deliberately the *parent* of the Node tree rather than the
# Node tree itself. Installing globals into node/current means installing them
# into a versioned directory behind a symlink, so the next Node upgrade relinks
# `current` and silently takes pi and pired with it.
pired_home() { printf '%s/pired' "${XDG_DATA_HOME:-$HOME/.local/share}"; }
node_home() { printf '%s/node' "$(pired_home)"; }

# pi's own installer parks a standalone Node here. If it is already on the box
# and new enough, adopt it rather than downloading a second copy of the same
# thing — the two installers should not each own a Node.
pi_node_home() { printf '%s/pi-node' "${XDG_DATA_HOME:-$HOME/.local/share}"; }

node_new_enough() {
	command -v node >/dev/null 2>&1 || return 1
	node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>$NODE_MIN_MAJOR||(a===$NODE_MIN_MAJOR&&b>=$NODE_MIN_MINOR)?0:1)" >/dev/null 2>&1
}

adopt_node() {
	for candidate in "$(node_home)/current/bin" "$(pi_node_home)/current/bin"; do
		if [ -x "$candidate/node" ]; then
			PATH="$candidate:$PATH"; export PATH
			if node_new_enough; then
				ADOPTED_NODE=$candidate
				return 0
			fi
			PATH=${PATH#"$candidate:"}; export PATH
		fi
	done
	return 1
}

writable_or_creatable() {
	_d=$1
	while [ ! -e "$_d" ]; do
		_parent=${_d%/*}
		[ -n "$_parent" ] && [ "$_parent" != "$_d" ] || return 1
		_d=$_parent
	done
	[ -d "$_d" ] && [ -w "$_d" ]
}

npm_prefix_usable() {
	writable_or_creatable "$1/lib/node_modules" && writable_or_creatable "$1/bin"
}

# --- source -----------------------------------------------------------------
# Prefer a checkout we are sitting inside: running ./install.sh from a clone
# should install *that* clone, not re-download one. When the script is piped from
# curl there is no directory to find, so it falls back to the published repo.
SELF_DIR=""
case "${0:-}" in
	*/*) SELF_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd) ;;
esac
DEFAULT_SOURCE="github:$DEFAULT_REPO"
if [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/package.json" ] &&
	grep -q '"name": *"pired"' "$SELF_DIR/package.json" 2>/dev/null; then
	DEFAULT_SOURCE="$SELF_DIR"
fi
SOURCE=${PIRED_SOURCE:-$DEFAULT_SOURCE}

# npm resolves a github: spec by shelling out to git, and a vanilla Ubuntu has no
# git. Rather than apt-installing one — sudo, for a single clone — fetch the same
# tree GitHub serves to a browser and install the unpacked directory.
NEED_TARBALL=0
case "$SOURCE" in
	github:*) command -v git >/dev/null 2>&1 || NEED_TARBALL=1 ;;
esac

# --- survey -----------------------------------------------------------------
# Checked before the banner: with stdout redirected to a file it is
# block-buffered while stderr is not, so a die() here would otherwise print
# above the header it follows.
have_downloader || die "neither curl nor wget is on this box. Install one and re-run."

banner

ADOPTED_NODE=""
NODE_STATE=missing
if node_new_enough || adopt_node; then
	NODE_STATE=present
elif command -v node >/dev/null 2>&1; then
	NODE_STATE=old
fi

DO_NODE=0
[ "$NODE_STATE" = present ] || DO_NODE=1

UNWRITABLE=""
PIRED_HOME=$(pired_home)
NODE_HOME=$(node_home)
if [ -n "${NPM_PREFIX:-}" ]; then
	npm_prefix_usable "$NPM_PREFIX" || die "cannot write to NPM_PREFIX=$NPM_PREFIX. Pick a writable directory."
	PREFIX=$NPM_PREFIX
elif [ "$DO_NODE" = 1 ]; then
	PREFIX=$PIRED_HOME
	sha256_of /dev/null >/dev/null 2>&1 ||
		die "no sha256sum, shasum or openssl here, so the Node.js download could not be verified.\n  Install Node.js >= $NODE_MIN_MAJOR.$NODE_MIN_MINOR yourself and re-run."
else
	case "$ADOPTED_NODE" in
		"$NODE_HOME"/*)
			# A Node this installer put here on an earlier run. Its layout comes
			# with it: `npm prefix --global` would answer with the *versioned*
			# directory behind node/current, which is the directory a Node upgrade
			# relinks away from — taking pi and pired with it. Re-runs have to land
			# in the same stable prefix the first run chose.
			PREFIX=$PIRED_HOME
			;;
		*)
			PREFIX=$(npm prefix --global 2>/dev/null || true)
			# `npm install --global` writes to lib/node_modules and bin. When it
			# cannot — a distro node owned by root, and a user who was promised no
			# sudo — fall back to a per-user prefix rather than failing with npm's
			# EACCES wall of text.
			if [ -z "$PREFIX" ] || ! npm_prefix_usable "$PREFIX"; then
				UNWRITABLE="${PREFIX:-the npm global prefix}"
				PREFIX="$HOME/.local"
			fi
			;;
	esac
fi
BIN_DIR="$PREFIX/bin"

# Whether this install owns its whole tree decides how it is undone: one rm -rf,
# or an npm uninstall that leaves the surrounding Node alone.
OWNS_TREE=0
[ "$PREFIX" = "$PIRED_HOME" ] && OWNS_TREE=1

command -v npm >/dev/null 2>&1 || [ "$DO_NODE" = 1 ] ||
	die "npm not found beside node $(node -v). Install npm and re-run."

# Resolved by path first: under a custom prefix, pi lands in a bin directory that
# is typically not on PATH yet, and `command -v pi` would miss the copy we are
# about to install — reinstalling it, then silently skipping the registration.
SURVEY_PI=""
if [ -x "$BIN_DIR/pi" ]; then SURVEY_PI="$BIN_DIR/pi"
elif [ "$DO_NODE" = 0 ]; then SURVEY_PI=$(command -v pi 2>/dev/null || true)
fi

# missing   no pi here; this run installs one
# present   pi at or above the floor
# old       pi below it, or one that cannot say; this run upgrades it
# held      pi below it and PIRED_SKIP_PI=1; kept, with a warning
# declined  no pi here and PIRED_SKIP_PI=1
#
# An upgrade is the same `npm install --global` a fresh install runs, into the
# same prefix, rather than `pi update pi`. pired starts the pi it finds beside
# itself first (bin/launch.mjs, findPi), so the copy in this prefix is the one
# that has to meet the floor; `pi update pi` upgrades wherever that pi came
# from — a managed install, bun, another npm prefix — which need not be here.
DO_PI=1
PI_STATE=missing
PI_VERSION=""
if [ -n "$SURVEY_PI" ]; then
	PI_VERSION=$(pi_version "$SURVEY_PI")
	if version_at_least "$PI_VERSION" "$PI_FLOOR"; then DO_PI=0; PI_STATE=present
	else PI_STATE=old
	fi
fi
if [ "${PIRED_SKIP_PI:-0}" = 1 ]; then
	DO_PI=0
	case "$PI_STATE" in missing) PI_STATE=declined ;; old) PI_STATE=held ;; esac
fi

# --- pi packages ------------------------------------------------------------
# Two third-party packages are registered with pi: pi-subagents and
# pi-mcp-adapter. Everything that decides or reports on one is written once
# below, and told which by the key its plan row is labelled with. What differs
# between them is in package_facts and nowhere else.
#
# What the shared code knows about each package. Sets
#   PKG_PACKAGE    the spec this script installs
#   PKG_NAME       the bare name, which a fork shares
#   PKG_FLOOR      the oldest version pired's use of it is built on
#   PKG_SKIP       the opt-out
#   PKG_ROW        what the plan says it is, when it is missing
#   PKG_NEEDS      what the floor is for, as the start of a sentence
#   PKG_FORK       what a fork may lack
#   PKG_HELD       why a pi kept below PI_FLOOR gets none of it
#   PKG_HELD_KEPT  the same, for one already registered
package_facts() {
	case "$1" in
		subagents)
			PKG_PACKAGE=$SUBAGENTS_PACKAGE; PKG_NAME=pi-subagents; PKG_FLOOR=$SUBAGENTS_FLOOR
			PKG_SKIP=PIRED_SKIP_SUBAGENTS
			PKG_ROW="delegation, loads in every pi"
			PKG_NEEDS="pired's delegation needs"
			PKG_FORK="pired's delegation needs pi-subagents $GE $SUBAGENTS_FLOOR features, which a fork may not have"
			PKG_HELD="pi-subagents $SUBAGENTS_FLOOR needs pi $GE $PI_FLOOR"
			PKG_HELD_KEPT="$SUBAGENTS_FLOOR needs pi $GE $PI_FLOOR" ;;
		mcp)
			PKG_PACKAGE=$MCP_PACKAGE; PKG_NAME=pi-mcp-adapter; PKG_FLOOR=$MCP_FLOOR
			PKG_SKIP=PIRED_SKIP_MCP
			PKG_ROW="MCP servers through one proxy tool, loads in every pi"
			PKG_NEEDS="pired's MCP scope check needs"
			PKG_FORK="pired's MCP scope check relies on the adapter's approval-broker event, which a fork may not have"
			PKG_HELD="pired registers it only on pi $GE $PI_FLOOR"
			PKG_HELD_KEPT="pired updates it only on pi $GE $PI_FLOOR" ;;
	esac
}

# Asked of the pi that is already here, if one is. On a box where this run is
# bringing pi too there is nothing to ask, and the answer is the one the plan
# would give anyway: install it.
#
# The match is any package by that name, not the one spec this script
# installs. The pi-subagents ecosystem is mostly forks — @gotgenes, @nklisch,
# @tintinweb — and an operator who chose one did not ask for a second
# implementation of the same tool registered underneath it, or for this script
# to decide what version of theirs is new enough.
#
# `pi list` prints each source with its installed path on the line below, so
# this reads entries rather than grepping lines: a grep for `pi-subagents` also
# matched that path, and counted a pinned npm:pi-subagents@0.66.0 as registered
# by the name of its directory rather than by its source. $1 is the pi to ask,
# $2 the bare name. Sets
#   PKG_KIND     canonical  npm:<name>, which `pi update` moves
#                pinned     npm:<name>@<version>, which it does not
#                fork       any other package by that name
#                (empty)    nothing registered
#   PKG_SOURCE   the source as pi recorded it
#   PKG_VERSION  the version in the package.json under that path
ESC=$(printf '\033')
package_survey() {
	PKG_KIND=""; PKG_SOURCE=""; PKG_VERSION=""
	[ -n "$1" ] || return 0
	_entry=$("$1" list 2>/dev/null | sed "s/${ESC}\[[0-9;]*m//g" | awk -v want="$2" '
		function classify(s,   name, ver, at, slash, last) {
			if (s ~ /^npm:/) {
				name = substr(s, 5); ver = ""
				# An @ past the first character starts the version.
				at = index(substr(name, 2), "@")
				if (at > 0) { ver = substr(name, at + 2); name = substr(name, 1, at) }
				if (name == want) return (ver == "" || ver == "latest") ? "canonical" : "pinned"
				# @scope/<name>, compared as text: a name is not a pattern.
				slash = index(name, "/")
				return (substr(name, 1, 1) == "@" && slash > 2 && substr(name, slash + 1) == want) ? "fork" : ""
			}
			# git:host/owner/<name>@ref, a URL, a local checkout.
			last = s
			sub(/\/+$/, "", last); sub(/.*[\/:]/, "", last); sub(/@[^@]*$/, "", last); sub(/\.git$/, "", last)
			return (last == want) ? "fork" : ""
		}
		function keep() {
			if (kind != "" && kind != "fork" && best == "") best = kind "\n" src "\n" path
			if (kind == "fork" && other == "") other = kind "\n" src "\n" path
			kind = ""
		}
		/^  [^ ]/ { keep(); src = $1; path = ""; kind = classify(src); next }
		/^    [^ ]/ { if (kind != "" && path == "") { path = $0; sub(/^ +/, "", path); sub(/ +$/, "", path) } next }
		{ keep() }
		END { keep(); if (best != "") print best; else if (other != "") print other }
	') || _entry=""
	[ -n "$_entry" ] || return 0
	PKG_KIND=$(printf '%s\n' "$_entry" | sed -n 1p)
	PKG_SOURCE=$(printf '%s\n' "$_entry" | sed -n 2p)
	PKG_VERSION=$(package_version "$(printf '%s\n' "$_entry" | sed -n 3p)")
}

# The survey as a state the plan and the run act on. $1 is the key, $2 the pi
# to ask. Sets PKG_STATE, beside what package_survey sets:
#   missing  nothing registered
#   present  npm:<name> at or above the floor, pinned or not
#   old      npm:<name> below it, or with no version on disk to read
#   pinned   npm:<name>@<version> below it: `pi update` does not move a
#            pin, and replacing the operator's pin is not this script's call
#   fork     another package by that name
package_state() {
	package_facts "$1"
	package_survey "$2" "$PKG_NAME"
	case "$PKG_KIND" in
		"") PKG_STATE=missing ;;
		fork) PKG_STATE=fork ;;
		*)
			if version_at_least "$PKG_VERSION" "$PKG_FLOOR"; then PKG_STATE=present
			elif [ "$PKG_KIND" = pinned ]; then PKG_STATE=pinned
			else PKG_STATE=old
			fi ;;
	esac
}

# What the plan does with the package. $1 is the key, $2 its opt-out's value.
# Sets PKG_DO to 1 when the run installs or updates it, and PKG_STATE to one of
# package_state's, or
#   held      missing or old, on a pi this run leaves below PI_FLOOR
#   declined  the opt-out is set
#   nopi      no pi to register it with, and none coming
package_plan() {
	PKG_DO=0; PKG_KIND=""; PKG_SOURCE=""; PKG_VERSION=""
	if [ "$2" = 1 ]; then
		PKG_STATE=declined
	elif [ "$DO_PI" = 0 ] && [ -z "$SURVEY_PI" ]; then
		# No pi to register it with, and none coming. A "+" row here would be
		# promising something this run cannot do.
		PKG_STATE=nopi
	else
		package_state "$1" "$SURVEY_PI"
		case "$PKG_STATE" in
			missing|old)
				# pi-subagents 0.71's changelog names 0.86.1 its oldest supported
				# pi, and a pi kept below that by PIRED_SKIP_PI=1 is one this run
				# will not lift. Installing the latest onto it would be installing a
				# package onto a host it has said it does not support.
				#
				# pi-mcp-adapter's own peer range reaches lower, and it is held on
				# the same floor anyway. It opens a route to MCP servers that
				# pired's scope gate has to see, and a pi below the one pired is
				# supported on is not a host this run adds that route to.
				if [ "$PI_STATE" = held ]; then PKG_STATE=held; else PKG_DO=1; fi ;;
		esac
	fi
}

# Each package's _WAS is the version that was there before this run, for the
# plan, the undo line and the report. The plan's order is the run's order.
package_plan subagents "${PIRED_SKIP_SUBAGENTS:-0}"
DO_SUBAGENTS=$PKG_DO; SUBAGENTS_STATE=$PKG_STATE
SUBAGENTS_KIND=$PKG_KIND; SUBAGENTS_SOURCE=$PKG_SOURCE; SUBAGENTS_WAS=$PKG_VERSION

package_plan mcp "${PIRED_SKIP_MCP:-0}"
DO_MCP=$PKG_DO; MCP_STATE=$PKG_STATE
MCP_KIND=$PKG_KIND; MCP_SOURCE=$PKG_SOURCE; MCP_WAS=$PKG_VERSION

REINSTALL=0
if [ -x "$BIN_DIR/pired" ]; then REINSTALL=1; fi

# --- the plan ---------------------------------------------------------------
# Everything the script is about to do, named and located, before it does any of
# it. A one-line curl into a shell earns its trust exactly here.
shell_rc() {
	case "$(basename "${SHELL:-sh}")" in
		fish) printf '%s/.config/fish/config.fish' "$HOME" ;;
		zsh) printf '%s/.zshrc' "${ZDOTDIR:-$HOME}" ;;
		bash) if [ -f "$HOME/.bashrc" ]; then printf '%s/.bashrc' "$HOME"; else printf '%s/.profile' "$HOME"; fi ;;
		*) printf '%s/.profile' "$HOME" ;;
	esac
}

# $HOME rather than the expanded path: the line outlives a renamed home
# directory, and it is shorter to read in the plan and in the rc file.
path_line() {
	case "$BIN_DIR" in
		"$HOME"/*) _expr="\$HOME${BIN_DIR#"$HOME"}" ;;
		*) _expr=$BIN_DIR ;;
	esac
	case "$(basename "${SHELL:-sh}")" in
		fish) printf 'fish_add_path "%s"' "$_expr" ;;
		*) printf 'export PATH="%s:$PATH"' "$_expr" ;;
	esac
}

RC_FILE=$(shell_rc)
PATH_LINE=$(path_line)

# In the rc but not in this shell is its own answer: nothing to write, and the
# reason the command is not typeable yet is that the file has not been sourced.
PATH_STATE=missing
if on_path "$BIN_DIR"; then
	PATH_STATE=live
elif [ -f "$RC_FILE" ] && grep -Fxq "$PATH_LINE" "$RC_FILE" 2>/dev/null; then
	PATH_STATE=written
fi

# The trailing space is not decoration: a where-path longer than the column
# would otherwise run straight into the note with nothing between them.
plan_row() { printf '    %b %-11s%-29s %b\n' "$1" "$2" "$3" "${DIM}$4${OFF}"; }
PLUS_MARK="${RED}${PLUS}${OFF}"
UP_MARK="${RED}${UP}${OFF}"
KEEP_MARK="${DIM}${DOT}${OFF}"

say "  ${BOLD}This will install${OFF}"
say ""

case "$NODE_STATE" in
	present)
		if [ -n "$ADOPTED_NODE" ]; then
			plan_row "$KEEP_MARK" "node" "$(tilde "${ADOPTED_NODE%/current/bin}")" "$(node -v) — already here"
		else
			plan_row "$KEEP_MARK" "node" "$(tilde "$(command -v node)")" "$(node -v) — already good"
		fi ;;
	old)
		plan_row "$PLUS_MARK" "node" "$(tilde "$NODE_HOME")" "$(node -v) is below $NODE_MIN_MAJOR.$NODE_MIN_MINOR — a private copy, no sudo" ;;
	missing)
		plan_row "$PLUS_MARK" "node" "$(tilde "$NODE_HOME")" "v${NODE_LINE} from nodejs.org, checksum-verified" ;;
esac

case "$PI_STATE" in
	missing) plan_row "$PLUS_MARK" "pi" "$(tilde "$BIN_DIR")" "$PI_PACKAGE" ;;
	old) plan_row "$UP_MARK" "pi" "$(tilde "$BIN_DIR")" "${PI_VERSION:-version unknown} $ARROW latest  (pired needs $GE $PI_FLOOR)" ;;
	present) plan_row "$KEEP_MARK" "pi" "$(tilde "$(dirname "$SURVEY_PI")")" "$PI_VERSION — already installed" ;;
	held) plan_row "$KEEP_MARK" "pi" "$(tilde "$(dirname "$SURVEY_PI")")" "${PI_VERSION:-version unknown} kept — PIRED_SKIP_PI=1; delegation needs $GE $PI_FLOOR" ;;
	*) plan_row "$KEEP_MARK" "pi" "" "skipped — PIRED_SKIP_PI=1" ;;
esac

if [ "$NEED_TARBALL" = 1 ]; then
	PIRED_NOTE="from $SOURCE over HTTPS — no git here"
elif [ "$REINSTALL" = 1 ]; then
	PIRED_NOTE="reinstall from $SOURCE"
else
	PIRED_NOTE="from $SOURCE"
fi
plan_row "$PLUS_MARK" "pired" "$(tilde "$BIN_DIR")" "$PIRED_NOTE"

# The only rows that write outside this script's own prefix, so they say where —
# ~/.pi is pi's directory, and a plan that hid that would be hiding the lines
# someone might object to. $1 is the key, then the package's state, the
# version it had, its source and its kind, as package_plan left them.
package_row() {
	package_facts "$1"
	case "$2" in
		missing) plan_row "$PLUS_MARK" "$1" "$(tilde "$HOME/.pi")" "$PKG_PACKAGE — $PKG_ROW" ;;
		old) plan_row "$UP_MARK" "$1" "$(tilde "$HOME/.pi")" "${3:-version unknown} $ARROW latest  (pired needs $GE $PKG_FLOOR)" ;;
		present) plan_row "$KEEP_MARK" "$1" "$(tilde "$HOME/.pi")" "$3 — already registered with pi" ;;
		pinned) plan_row "$KEEP_MARK" "$1" "$(tilde "$HOME/.pi")" "$4 — pinned, left alone" ;;
		fork) plan_row "$KEEP_MARK" "$1" "$(tilde "$HOME/.pi")" "$4 — already registered with pi, left alone" ;;
		held)
			if [ -n "$5" ]; then
				plan_row "$KEEP_MARK" "$1" "$(tilde "$HOME/.pi")" "${3:-version unknown} kept — $PKG_HELD_KEPT"
			else
				plan_row "$KEEP_MARK" "$1" "" "skipped — $PKG_HELD"
			fi ;;
		declined) plan_row "$KEEP_MARK" "$1" "" "skipped — $PKG_SKIP=1" ;;
		nopi) plan_row "$KEEP_MARK" "$1" "" "skipped — no pi to register it with" ;;
	esac
}
package_row subagents "$SUBAGENTS_STATE" "$SUBAGENTS_WAS" "$SUBAGENTS_SOURCE" "$SUBAGENTS_KIND"
package_row mcp "$MCP_STATE" "$MCP_WAS" "$MCP_SOURCE" "$MCP_KIND"

case "$PATH_STATE" in
	live) plan_row "$KEEP_MARK" "PATH" "$(tilde "$BIN_DIR")" "already on your PATH" ;;
	written) plan_row "$KEEP_MARK" "PATH" "$(tilde "$RC_FILE")" "already there — new shells have it" ;;
	*) plan_row "$PLUS_MARK" "PATH" "$(tilde "$RC_FILE")" "$PATH_LINE" ;;
esac

say ""
say "  ${DIM}Nothing runs as root. No daemon, no service, no shell hooks.${OFF}"
[ -n "$UNWRITABLE" ] && say "  ${DIM}$UNWRITABLE is not writable, so this installs under $(tilde "$PREFIX").${OFF}"
if [ "$NODE_STATE" = old ]; then
	say "  ${DIM}The PATH line puts pired's Node.js ahead of $(command -v node) in new shells.${OFF}"
fi
if [ "$PI_STATE" = old ] && [ "$SURVEY_PI" != "$BIN_DIR/pi" ]; then
	say "  ${DIM}The pi at $(tilde "$SURVEY_PI") stays as it is; pired runs the new one in $(tilde "$BIN_DIR").${OFF}"
fi
package_note() {
	package_facts "$1"
	case "$2" in
		pinned) say "  ${DIM}$PKG_NEEDS $PKG_NAME $GE $PKG_FLOOR. To lift the pin: pi install $PKG_PACKAGE${OFF}" ;;
		fork) say "  ${DIM}$PKG_FORK.${OFF}" ;;
	esac
	return 0
}
package_note subagents "$SUBAGENTS_STATE"
package_note mcp "$MCP_STATE"

# Whether the survey saw what pi already records. With no pi to ask — none on
# the box, or one on PATH that a run bringing its own Node does not count — the
# plan says "install". But an `npm rm -g` of pi leaves pi's agent directory
# behind, and the step, asking the pi this run installs, can find the
# operator's npm:pi-subagents there and upgrade it — under a plan whose undo
# said `pi remove`, which would take the operator's package away. Only a
# settings file there can record one, so without it the plan is certain.
PI_AGENT_DIR=${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}
case "$PI_AGENT_DIR" in
	"~") PI_AGENT_DIR=$HOME ;;
	"~"/*) PI_AGENT_DIR="$HOME/${PI_AGENT_DIR#"~/"}" ;;
esac
package_unasked() {
	[ "$1" = 1 ] && [ "$2" = missing ] && [ -z "$SURVEY_PI" ] && [ -f "$PI_AGENT_DIR/settings.json" ]
}
SUBAGENTS_UNASKED=0
if package_unasked "$DO_SUBAGENTS" "$SUBAGENTS_STATE"; then SUBAGENTS_UNASKED=1; fi
MCP_UNASKED=0
if package_unasked "$DO_MCP" "$MCP_STATE"; then MCP_UNASKED=1; fi
if [ "$SUBAGENTS_UNASKED" = 1 ] || [ "$MCP_UNASKED" = 1 ]; then
	say "  ${DIM}Only the pi this run installs can say what $(tilde "$PI_AGENT_DIR") already records: the${OFF}"
	if [ "$SUBAGENTS_UNASKED" = 1 ] && [ "$MCP_UNASKED" = 1 ]; then
		say "  ${DIM}subagents and mcp steps ask it, and upgrade or keep a package they find there.${OFF}"
	elif [ "$SUBAGENTS_UNASKED" = 1 ]; then
		say "  ${DIM}subagents step asks it, and upgrades or keeps a pi-subagents it finds there.${OFF}"
	else
		say "  ${DIM}mcp step asks it, and upgrades or keeps a pi-mcp-adapter it finds there.${OFF}"
	fi
fi

# `pi install` of an exact version replaces the entry it matches by name, so
# going back from an upgrade leaves npm:<name>@<old> where npm:<name> was: a
# pin, which `pi update` never moves and the next run of this script leaves
# alone. The undo says so where it is given, after a `#` so that pasting the
# line runs only the command. It is always last on its line. $1 is the
# package, $2 the version to go back to.
undo_upgrade() {
	printf 'pi install %s@%s  # pins it; pi install %s unpins' "$1" "$2" "$1"
}

# What undoes this run's change to one package, or nothing when it makes none.
# $1 is the key, then whether the plan could not ask, whether the run acts,
# the state, and the version it had.
package_undo() {
	package_facts "$1"
	if [ "$2" = 1 ]; then
		printf 'pi remove %s  # only if the step installs it' "$PKG_PACKAGE"
	elif [ "$3" = 1 ] && [ "$4" = missing ]; then
		printf 'pi remove %s' "$PKG_PACKAGE"
	elif [ "$3" = 1 ] && [ -n "$5" ]; then
		undo_upgrade "$PKG_PACKAGE" "$5"
	fi
	return 0
}

# The undo names only what this run changes, each where this run changed it.
#
# pi is in it only when this run put pi in the prefix. A pi that already met
# the floor, one PIRED_SKIP_PI=1 kept, and one an upgrade stepped in front of
# from outside the prefix all belong to the operator, and `npm rm -g` of the
# package name removed theirs. An upgrade in place is undone by going back to
# the version it replaced; one whose version could not be read has nothing to
# go back to, and is left out rather than removed.
#
# Every npm command carries the prefix, as the retry does: under NPM_PREFIX or
# the ~/.local fallback a bare `npm rm -g` runs against npm's own prefix, which
# is usually where the operator's own pi lives.
UNDO_PREFIX="--prefix $(tilde "$PREFIX")"
UNDO_PI_RM=""
UNDO_PI_BACK=""
case "$PI_STATE" in
	missing) UNDO_PI_RM=" $PI_PACKAGE" ;;
	old)
		if [ "$SURVEY_PI" != "$BIN_DIR/pi" ]; then
			UNDO_PI_RM=" $PI_PACKAGE"
		elif [ -n "$PI_VERSION" ]; then
			UNDO_PI_BACK=" · npm install -g $UNDO_PREFIX $PI_PACKAGE@$PI_VERSION"
		fi ;;
esac
UNDO_SUBAGENTS=$(package_undo subagents "$SUBAGENTS_UNASKED" "$DO_SUBAGENTS" "$SUBAGENTS_STATE" "$SUBAGENTS_WAS")
UNDO_MCP=$(package_undo mcp "$MCP_UNASKED" "$DO_MCP" "$MCP_STATE" "$MCP_WAS")

# A package's undo ends its line. Either note after it is a `#` comment, and a
# second package's undo pasted on the same line would be part of the comment,
# silently not run. The first rides the Undo line; the next takes its own line
# beneath, where pasting it runs it.
UNDO_TAIL=""
UNDO_NEXT=""
if [ -n "$UNDO_SUBAGENTS" ]; then
	UNDO_TAIL=" · $UNDO_SUBAGENTS"
	UNDO_NEXT=$UNDO_MCP
elif [ -n "$UNDO_MCP" ]; then
	UNDO_TAIL=" · $UNDO_MCP"
fi
if [ "$OWNS_TREE" = 1 ]; then
	say "  ${DIM}Undo: rm -rf $(tilde "$PIRED_HOME") ~/.pired${UNDO_TAIL}${OFF}"
else
	say "  ${DIM}Undo: npm rm -g $UNDO_PREFIX pired${UNDO_PI_RM} · rm -rf ~/.pired${UNDO_PI_BACK}${UNDO_TAIL}${OFF}"
fi
if [ -n "$UNDO_NEXT" ]; then say "        ${DIM}$UNDO_NEXT${OFF}"; fi
say ""

if [ "$DRY_RUN" = 1 ]; then
	say "  ${DIM}--dry-run: nothing was changed.${OFF}"
	say ""
	exit 0
fi

# --- approval ---------------------------------------------------------------
# Under `curl … | sh` the script itself is stdin, so a plain read would swallow
# the rest of this file. The controlling terminal is a separate open.
#
# This is the only question the installer asks. Everything above is in the plan
# the answer covers — a second prompt later for the PATH line would be asking
# twice for one decision.
if [ "$ASSUME_YES" != 1 ]; then
	if ( : <>/dev/tty ) 2>/dev/null; then
		exec 3<>/dev/tty
		printf '%b' "  ${BOLD}Proceed?${OFF} ${DIM}[Y/n]${OFF} " >&3
		IFS= read -r answer <&3 || answer=""
		exec 3>&-
		case "$answer" in
			n|N|no|NO|No)
				say ""
				say "  ${DIM}Nothing was changed.${OFF}"
				say ""
				exit 0
				;;
		esac
		say ""
	else
		# No terminal to ask at — a CI job, a provisioning script. The plan was
		# still printed, which is the part that matters in a log.
		say "  ${DIM}No terminal to ask at — continuing. Pass --dry-run to only look.${OFF}"
		say ""
	fi
fi

# --- node -------------------------------------------------------------------
node_platform() {
	case "$(uname -s)" in
		Darwin) printf 'darwin' ;;
		Linux) printf 'linux' ;;
		*) return 1 ;;
	esac
}

node_arch() {
	case "$(uname -m)" in
		x86_64|amd64) printf 'x64' ;;
		arm64|aarch64) printf 'arm64' ;;
		armv7l) printf 'armv7l' ;;
		ppc64le) printf 'ppc64le' ;;
		s390x) printf 's390x' ;;
		*) return 1 ;;
	esac
}

install_node() {
	np=$(node_platform) || { printf 'Unsupported operating system: %s\n' "$(uname -s)"; return 1; }
	na=$(node_arch) || { printf 'Unsupported CPU architecture: %s\n' "$(uname -m)"; return 1; }

	base=$(node_home)
	tmp="$base/.download.$$"
	rm -rf "$tmp"
	mkdir -p "$tmp"

	printf 'Resolving\n'
	fetch "$NODE_DIST/SHASUMS256.txt" "$tmp/SHASUMS256.txt" || { printf 'Could not reach %s\n' "$NODE_DIST"; return 1; }

	# .tar.gz rather than the smaller .tar.xz on purpose: every box that can run
	# this script can already gunzip, while xz is a package a minimal Ubuntu does
	# not carry — and installing it would mean the sudo this script promised not
	# to ask for.
	file=$(awk -v s="-$np-$na.tar.gz" 'index($2,"node-v")==1 && substr($2,length($2)-length(s)+1)==s {print $2; exit}' "$tmp/SHASUMS256.txt")
	[ -n "$file" ] || { printf 'No Node.js %s build for %s-%s\n' "$NODE_LINE" "$np" "$na"; return 1; }
	want=$(awk -v f="$file" '$2==f {print $1; exit}' "$tmp/SHASUMS256.txt")
	version=${file#node-}; version=${version%%-*}

	printf 'Downloading %s\n' "$version"
	fetch "$NODE_DIST/$file" "$tmp/$file" || { printf 'Could not download %s\n' "$file"; return 1; }

	printf 'Verifying\n'
	got=$(sha256_of "$tmp/$file") || { printf 'No SHA-256 tool available\n'; return 1; }
	if [ "$got" != "$want" ]; then
		printf 'Checksum mismatch for %s\n  expected %s\n  got      %s\n' "$file" "$want" "$got"
		rm -rf "$tmp"
		return 1
	fi

	printf 'Extracting\n'
	target="$base/$version"
	rm -rf "$target"
	mkdir -p "$target"
	tar -xzf "$tmp/$file" -C "$target" --strip-components=1 || return 1
	rm -rf "$tmp"

	# A symlink, so an upgrade is one relink and the old tree can be deleted
	# without the PATH line ever changing.
	rm -f "$base/current"
	ln -s "$target" "$base/current"

	# node, npm and npx are linked into the same bin directory the packages
	# install into, so one PATH entry covers the runtime and the commands.
	printf 'Linking\n'
	mkdir -p "$BIN_DIR"
	for tool in node npm npx; do
		[ -e "$base/current/bin/$tool" ] || continue
		rm -f "$BIN_DIR/$tool"
		ln -s "$base/current/bin/$tool" "$BIN_DIR/$tool"
	done
	printf 'Installed %s\n' "$version"
}

if [ "$DO_NODE" = 1 ]; then
	STEP_HINT="reaching nodejs.org"
	if step "node" node_label install_node; then
		PATH="$BIN_DIR:$PATH"; export PATH
		hash -r 2>/dev/null || true
		done_line "node" "$(node -v)  $(tilde "$NODE_HOME")"
	else
		spill
		die "could not install Node.js. Install Node.js >= $NODE_MIN_MAJOR.$NODE_MIN_MINOR yourself and re-run."
	fi
elif [ -n "$ADOPTED_NODE" ]; then
	done_line "node" "$(node -v)  $(tilde "${ADOPTED_NODE%/current/bin}") — already here"
else
	done_line "node" "$(node -v)  $(tilde "$(command -v node)")"
fi

# --- where npm writes -------------------------------------------------------
# The prefix travels as an environment variable, not as a --prefix argument: the
# argument list was word-split, so a prefix containing a space installed
# somewhere else entirely without saying so.
export npm_config_prefix="$PREFIX"
mkdir -p "$PREFIX/lib/node_modules" "$BIN_DIR" 2>/dev/null || true

# npm 11.6 added a release-age gate against publish-and-typosquat attacks. pi
# ships an npm-shrinkwrap, so its transitive tree is pinned regardless of the
# gate, and upstream's own installer waives it for that reason — without the
# waiver a pi release younger than the default window refuses to install.
NPM_AGE_FLAG=""
if [ "$(npm -v 2>/dev/null | cut -d. -f1)" -ge 11 ] 2>/dev/null; then
	NPM_AGE_FLAG="--min-release-age=0"
fi

npm_global() {
	# shellcheck disable=SC2086 # the flag slot is deliberately word-split
	npm install --global --ignore-scripts --loglevel http $1 "$2"
}

# --- pi ---------------------------------------------------------------------
resolve_pi() {
	if [ -x "$BIN_DIR/pi" ]; then PI="$BIN_DIR/pi"; else PI=$(command -v pi 2>/dev/null || true); fi
}
PI=""
resolve_pi

# Spelled with the prefix: under NPM_PREFIX or the ~/.local fallback, a bare
# `npm install -g` lands somewhere pired does not look.
PI_RETRY="npm install -g --prefix $(tilde "$PREFIX") $PI_PACKAGE"

if [ "$DO_PI" = 1 ]; then
	STEP_HINT="resolving packages"
	if step "pi" npm_label npm_global "$NPM_AGE_FLAG" "$PI_PACKAGE"; then
		resolve_pi
		PI_NOW=$(pi_version "$PI")
		if [ "$PI_STATE" = missing ]; then
			done_line "pi" "${PI_NOW:-installed}  $(tilde "$BIN_DIR")"
		elif version_at_least "$PI_NOW" "$PI_FLOOR"; then
			done_line "pi" "${PI_VERSION:-version unknown} $ARROW $PI_NOW  $(tilde "$BIN_DIR")"
		else
			# Asked rather than assumed: npm's exit code says npm finished, not that
			# the pi pired will start is now one it can delegate from.
			warn_line "pi" "still ${PI_NOW:-version unknown} — pired needs $GE $PI_FLOOR"
			say "    ${DIM}retry: $PI_RETRY${OFF}"
		fi
	elif [ "$PI_STATE" = old ]; then
		# The pi already here is left as it was. The floor is delegation's, so a
		# failed upgrade is a warning with the retry, as the subagents step's
		# failure is — and whether pired itself loads on that pi is the verify
		# step's question, which it asks below and dies on.
		spill
		warn_line "pi" "could not upgrade ${PI_VERSION:-pi} — pired's delegation needs $GE $PI_FLOOR"
		say "    ${DIM}retry: $PI_RETRY${OFF}"
		resolve_pi
	else
		spill
		die "could not install pi."
	fi
elif [ "$PI_STATE" = held ] && [ -n "$PI" ]; then
	warn_line "pi" "${PI_VERSION:-version unknown} kept (PIRED_SKIP_PI=1) — pired's delegation needs pi $GE $PI_FLOOR"
	say "    ${DIM}upgrade: $PI_RETRY${OFF}"
elif [ -n "$PI" ]; then
	done_line "pi" "$("$PI" --version 2>/dev/null || echo present)  $(tilde "$PI")"
else
	skip_line "pi" "skipped — pired drives pi, so put one on PATH before running it"
fi

# --- pired ------------------------------------------------------------------
if [ "$NEED_TARBALL" = 1 ]; then
	# Created out here rather than inside the step, which runs in a subshell whose
	# variables the exit trap would never see.
	WORKDIR=$(mktemp -d "${TMPDIR:-/tmp}/pired-src.XXXXXX") || die "could not create a temporary directory."
fi

install_pired() {
	src=$SOURCE
	if [ "$NEED_TARBALL" = 1 ]; then
		spec=${SOURCE#github:}
		# HEAD, not `main`: codeload resolves it to whatever the repository calls
		# its default branch, so a fork living on `master` is not a 404 blamed on
		# the wrong cause.
		ref=HEAD
		case "$spec" in *\#*) ref=${spec#*\#}; spec=${spec%%\#*} ;; esac
		printf 'Fetching %s@%s\n' "$spec" "$ref"
		fetch "https://codeload.github.com/$spec/tar.gz/$ref" "$WORKDIR/src.tar.gz" || {
			printf 'Could not fetch https://codeload.github.com/%s/tar.gz/%s\n' "$spec" "$ref"
			printf 'Check the network or proxy, and that the repository and %s exist.\n' "$ref"
			return 1
		}
		printf 'Unpacking\n'
		mkdir -p "$WORKDIR/src"
		tar -xzf "$WORKDIR/src.tar.gz" -C "$WORKDIR/src" --strip-components=1 || return 1
		src="$WORKDIR/src"
	fi
	# Installing a local directory the plain way makes the global package a
	# SYMLINK back into it, so moving or deleting the clone silently breaks the
	# install. --install-links copies the files in, and honours package.json
	# "files".
	links=""
	[ -d "$src" ] && links="--install-links"
	npm_global "$links" "$src"
}

STEP_HINT="installing the security layer"
if step "pired" npm_label install_pired; then
	# Checked here rather than at the end: a checkmark printed before anyone has
	# looked for the binary is a claim, not a result.
	[ -x "$BIN_DIR/pired" ] || die "npm reported success but $BIN_DIR/pired is missing."
	done_line "pired" "$(tilde "$BIN_DIR/pired")"
else
	spill
	case "$SOURCE" in
		github:*)
			# npm reports a failed fetch as a missing package and codeload as a
			# missing ref, whether the network, a proxy or the ref is at fault.
			# Installing from a clone takes the fetch out of the picture.
			say ""
			say "  ${DIM}If the fetch failed, check the network or proxy, or clone the repository${OFF}"
			say "  ${DIM}and run the installer from the checkout:${OFF}"
			say "    git clone https://github.com/${DEFAULT_REPO}.git && cd pired && ./install.sh"
			;;
	esac
	die "could not install from $SOURCE"
fi

# --- pired is not registered ------------------------------------------------
# There is deliberately no `pi install` for *pired* here. Registering it would
# put pired's extensions AND themes/ on pi's global resource path, so a bare
# `pi` would start with the security layer and — because pi persists a theme set
# through its extension API — would rewrite `theme` in ~/.pi/agent/settings.json
# on first run. `pi` stays the pi you installed. `pired` passes -e for its own
# run and changes nothing on disk. See ADR-017.

# --- pi packages ------------------------------------------------------------
# pired ships no sub-agent machinery and no MCP client, and depends on neither.
# These are the packages it cooperates with when they are there:
# extensions/lib/providers.ts mirrors its providers to pi-subagents' children,
# and the scope gate checks each call pi-mcp-adapter makes. Installed after
# pired and never before it, pi-subagents first, so the order of the plan is
# the order of the run.
#
# Non-fatal, and deliberately so: a third-party package that fails to resolve is
# not a reason to fail an install of pired, which works without it. The warning
# carries the one command that retries it.
install_subagents() { "$PI" install "$SUBAGENTS_PACKAGE"; }
install_mcp() { "$PI" install "$MCP_PACKAGE"; }
# `pi update <source>` updates that one package and leaves pi and every other
# package where they are (`pi update --help`, 0.85 and 0.87 alike).
update_subagents() { "$PI" update "$SUBAGENTS_PACKAGE"; }
update_mcp() { "$PI" update "$MCP_PACKAGE"; }

# The line for a package this run leaves as it found it. $1 is the key, then
# the state, the source and the version.
package_kept() {
	package_facts "$1"
	case "$2" in
		present) done_line "$1" "already registered with pi${4:+, $4}" ;;
		pinned)
			# A warning, not a skip. A pin reaches this state only below the floor,
			# where pired goes without what the floor is for, and the pin need not
			# be one the operator chose: taking the undo of an earlier upgrade
			# leaves one.
			warn_line "$1" "$3 — pinned, left alone"
			say "    ${DIM}$PKG_NEEDS $GE $PKG_FLOOR; to lift the pin: pi install $PKG_PACKAGE${OFF}" ;;
		fork)
			skip_line "$1" "$3 — already registered with pi, left alone"
			say "    ${DIM}$PKG_FORK${OFF}" ;;
		held) skip_line "$1" "held back — $PKG_HELD" ;;
	esac
	return 0
}

# One package's step. $1 is the key, $2 the state the plan printed.
package_step() {
	package_facts "$1"
	resolve_pi
	if [ -z "$PI" ]; then
		# Only reachable when the pi step was skipped between the plan and here.
		skip_line "$1" "skipped — no pi to register it with"
		return 0
	fi
	if ! version_at_least "$(pi_version "$PI")" "$PI_FLOOR"; then
		# The pi upgrade failed or did not take, and the pi step already said so.
		package_kept "$1" held
		return 0
	fi
	# Asked again rather than trusted from the survey, which may have had no pi
	# to put the question to — a box with a ~/.pi but no pi on it, which is
	# what `npm rm -g` then reinstalling leaves behind — or an older one.
	package_state "$1" "$PI"
	case "$PKG_STATE" in
		missing|old) ;;
		*) package_kept "$1" "$PKG_STATE" "$PKG_SOURCE" "$PKG_VERSION"; return 0 ;;
	esac
	# The plan offered `pi remove` for a package this step now finds already
	# there, so the undo it printed is wrong for what happens next.
	PKG_FOUND=0
	if [ "$2" = missing ] && [ "$PKG_STATE" = old ]; then PKG_FOUND=1; fi
	if [ "$PKG_STATE" = old ]; then
		PKG_WAS=$PKG_VERSION
		PKG_RETRY="pi update $PKG_PACKAGE"
		STEP_HINT="updating $PKG_PACKAGE"
		PKG_ACTION="update_$1"
	else
		PKG_WAS=""
		PKG_RETRY="pi install $PKG_PACKAGE"
		STEP_HINT="resolving $PKG_PACKAGE"
		PKG_ACTION="install_$1"
	fi
	step "$1" npm_label "$PKG_ACTION" || spill
	# Neither exit code is the answer. `pi install` can exit 0 and record
	# nothing — the registration ADR-017 removed was guarded against that, and
	# the guard is the part worth keeping — and `pi update` can exit 0 and move
	# nothing: with PI_OFFLINE=1 in the environment, pi 0.87.1 prints "Updated
	# npm:pi-subagents" and leaves 0.66.0 on disk. What pi lists, and what the
	# package.json under it says, are the answer.
	package_state "$1" "$PI"
	case "$PKG_STATE" in
		present)
			done_line "$1" "$PKG_PACKAGE ${PKG_WAS:+$PKG_WAS $ARROW }$PKG_VERSION  $(tilde "$HOME/.pi/agent")"
			if [ "$PKG_FOUND" = 1 ] && [ -n "$PKG_WAS" ]; then
				say "    ${DIM}already registered at $PKG_WAS, so updated rather than installed${OFF}"
				say "    ${DIM}undo: $(undo_upgrade "$PKG_PACKAGE" "$PKG_WAS")${OFF}"
			elif [ "$PKG_FOUND" = 1 ]; then
				say "    ${DIM}already registered, with no version to read, so updated rather than installed:${OFF}"
				say "    ${DIM}the plan's pi remove would take away a package that was here before this run${OFF}"
			fi ;;
		old)
			warn_line "$1" "$PKG_PACKAGE is ${PKG_VERSION:-unreadable} — $PKG_NEEDS $GE $PKG_FLOOR"
			say "    ${DIM}retry: pi update $PKG_PACKAGE${OFF}" ;;
		pinned|fork) package_kept "$1" "$PKG_STATE" "$PKG_SOURCE" "$PKG_VERSION" ;;
		*)
			warn_line "$1" "could not install $PKG_PACKAGE — pired works without it"
			say "    ${DIM}retry: $PKG_RETRY${OFF}" ;;
	esac
	return 0
}

if [ "$DO_SUBAGENTS" = 1 ]; then
	package_step subagents "$SUBAGENTS_STATE"
else
	package_kept subagents "$SUBAGENTS_STATE" "$SUBAGENTS_SOURCE" "$SUBAGENTS_WAS"
fi
if [ "$DO_MCP" = 1 ]; then
	package_step mcp "$MCP_STATE"
else
	package_kept mcp "$MCP_STATE" "$MCP_SOURCE" "$MCP_WAS"
fi

# --- PATH -------------------------------------------------------------------
# An install that works but cannot be typed looks identical to a failed one, so
# the line goes in rather than being printed for the user to paste. It was in
# the plan they approved, and it is one appended line under its own comment.
case "$PATH_STATE" in
	live) done_line "PATH" "$(tilde "$BIN_DIR") is already on it" ;;
	written) done_line "PATH" "already in $(tilde "$RC_FILE")" ;;
	*)
		if mkdir -p "$(dirname "$RC_FILE")" 2>/dev/null &&
			printf '\n# pired\n%s\n' "$PATH_LINE" >> "$RC_FILE" 2>/dev/null; then
			done_line "PATH" "added to $(tilde "$RC_FILE") — new shells pick it up"
		else
			warn_line "PATH" "could not write $(tilde "$RC_FILE") — run: $PATH_LINE"
		fi
		;;
esac

# --- verify -----------------------------------------------------------------
# pired's own --help exits before loading pi. Forward --help to pi instead and
# require the flag registered by the extension: pi can print help and exit 0
# even when an extension failed to load. No model or network access is needed.
if [ -n "$PI" ]; then
	STEP_HINT="loading pired in pi"
	if PI_OFFLINE=1 step "verify" quiet_label "$BIN_DIR/pired" -- --help &&
		grep -Eq '^[[:space:]]*--pired-profile([[:space:]]|$)' "$LOG"; then
		done_line "verify" "pi loaded the pired extension"
	else
		spill
		die "pired installed but pi could not load its extension (--pired-profile was not registered)."
	fi
fi

# --- report -----------------------------------------------------------------
say ""
say "  ${BOLD}Ready.${OFF} ${DIM}$(tilde "$BIN_DIR/pired")${OFF}"
say ""
if ! on_path "$BIN_DIR"; then
	say "  ${DIM}This shell does not have it yet — open a new one, or run:${OFF}"
	say "    $PATH_LINE"
	say ""
fi
# `/provider` comes first because nothing else here works without it. A box
# that has just been installed has no model at all, and what pi says about
# that points at its own documentation rather than at the model already
# running on this machine.
say "  ${DIM}next${OFF}"
say "    pired                    ${DIM}review the current directory${OFF}"
say "    /provider                ${DIM}add the model you are already running ${ARROW} do this first${OFF}"
say "    pired --profile pentest  ${DIM}blackbox testing (needs an authorized scope)${OFF}"
say "    /panel                   ${DIM}the engagement panel ${ARROW} alt+p toggles it${OFF}"
say ""
say "  ${DIM}docs: https://github.com/${DEFAULT_REPO}/tree/main/docs${OFF}"
say ""
