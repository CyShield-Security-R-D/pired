#!/bin/sh
# pired installer for macOS and Linux — from a vanilla box to a first engagement.
#
#   curl -fsSL https://raw.githubusercontent.com/mamgad/pired/main/install.sh | sh
#
# Windows has its own script, because npm lays a global install out differently
# there and PATH lives in the registry:
#
#   powershell -c "irm https://raw.githubusercontent.com/mamgad/pired/main/install.ps1 | iex"
#
# It surveys the box, prints exactly what it will do and where, asks once, and
# then does all of it: Node.js (when missing or too old), pi, pired, and the
# PATH line that makes the command typeable.
#
# It does not register pired with pi. `pi` stays the pi you installed; the
# security layer arrives only when you type `pired`, which passes it to pi with
# -e for that run. See ADR-017.
#
# It does register pi-subagents, the delegation extension pired cooperates with.
# That is a package the operator would otherwise install by hand, it is named in
# the plan, and PIRED_SKIP_SUBAGENTS=1 declines it. See ADR-021.
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
#   PIRED_SOURCE          npm spec to install from   (default github:mamgad/pired)
#   NPM_PREFIX            prefix to install into     (default npm's own global root;
#                         ~/.local/share/pired when this script brings its own Node,
#                         ~/.local when npm's root is not writable)
#   PIRED_SKIP_PI         1 to not install pi
#   PIRED_SKIP_SUBAGENTS  1 to not install pi-subagents
#   PIRED_YES             1 to skip the confirmation prompt
#   PIRED_NO_ANIM         1 for plain line-at-a-time output

set -eu

PI_PACKAGE="@earendil-works/pi-coding-agent"
# The delegation extension pired cooperates with: `spawn a subagent` is a thing
# the operator can ask for on a fresh box, rather than a README step they find
# out about after the first engagement wanted one. See ADR-021.
SUBAGENTS_PACKAGE="npm:pi-subagents"
NODE_LINE=22
NODE_MIN_MAJOR=22
NODE_MIN_MINOR=19
NODE_DIST="https://nodejs.org/dist/latest-v${NODE_LINE}.x"
DEFAULT_REPO="mamgad/pired"

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
  PIRED_YES / PIRED_NO_ANIM
  https://github.com/mamgad/pired/tree/main/docs
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

if [ "$UNICODE" = 1 ]; then TICK='✓'; CROSS='✗'; DOT='·'; PLUS='+'; ARROW='→'
else TICK='ok'; CROSS='!!'; DOT='-'; PLUS='+'; ARROW='->'; fi

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
DO_PI=1
PI_STATE=missing
if [ -x "$BIN_DIR/pi" ] || { [ "$DO_NODE" = 0 ] && command -v pi >/dev/null 2>&1; }; then
	DO_PI=0; PI_STATE=present
fi
if [ "${PIRED_SKIP_PI:-0}" = 1 ]; then DO_PI=0; fi

# --- subagents --------------------------------------------------------------
# Asked of the pi that is already here, if one is. On a box where this run is
# bringing pi too there is nothing to ask, and the answer is the one the plan
# would give anyway: install it.
#
# The match is any package whose name ends in `pi-subagents`, not the one spec
# this script installs. The ecosystem is mostly forks — @gotgenes, @nklisch,
# @tintinweb — and an operator who chose one did not ask for a second
# implementation of the same tool registered underneath it.
subagents_registered() {
	[ -n "$1" ] || return 1
	"$1" list 2>/dev/null | grep -Eq '(^|[:/[:space:]])(@[^[:space:]/]+/)?pi-subagents([[:space:]]|$)'
}

SURVEY_PI=""
if [ -x "$BIN_DIR/pi" ]; then SURVEY_PI="$BIN_DIR/pi"
elif [ "$DO_NODE" = 0 ]; then SURVEY_PI=$(command -v pi 2>/dev/null || true)
fi

DO_SUBAGENTS=1
SUBAGENTS_STATE=missing
if [ "${PIRED_SKIP_SUBAGENTS:-0}" = 1 ]; then
	DO_SUBAGENTS=0; SUBAGENTS_STATE=declined
elif [ "$DO_PI" = 0 ] && [ -z "$SURVEY_PI" ]; then
	# No pi to register it with, and none coming. Saying "+ subagents" here would
	# be promising something this run cannot do.
	DO_SUBAGENTS=0; SUBAGENTS_STATE=nopi
elif subagents_registered "$SURVEY_PI"; then
	DO_SUBAGENTS=0; SUBAGENTS_STATE=present
fi

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

if [ "$DO_PI" = 1 ]; then
	plan_row "$PLUS_MARK" "pi" "$(tilde "$BIN_DIR")" "$PI_PACKAGE"
elif [ "$PI_STATE" = present ]; then
	plan_row "$KEEP_MARK" "pi" "$(tilde "$BIN_DIR")" "already installed"
else
	plan_row "$KEEP_MARK" "pi" "" "skipped — PIRED_SKIP_PI=1"
fi

if [ "$NEED_TARBALL" = 1 ]; then
	PIRED_NOTE="from $SOURCE over HTTPS — no git here"
elif [ "$REINSTALL" = 1 ]; then
	PIRED_NOTE="reinstall from $SOURCE"
else
	PIRED_NOTE="from $SOURCE"
fi
plan_row "$PLUS_MARK" "pired" "$(tilde "$BIN_DIR")" "$PIRED_NOTE"

# The only row that writes outside this script's own prefix, so it says where —
# ~/.pi is pi's directory, and a plan that hid that would be hiding the one line
# someone might object to.
case "$SUBAGENTS_STATE" in
	missing) plan_row "$PLUS_MARK" "subagents" "$(tilde "$HOME/.pi")" "$SUBAGENTS_PACKAGE — delegation, loads in every pi" ;;
	present) plan_row "$KEEP_MARK" "subagents" "$(tilde "$HOME/.pi")" "already registered with pi" ;;
	declined) plan_row "$KEEP_MARK" "subagents" "" "skipped — PIRED_SKIP_SUBAGENTS=1" ;;
	nopi) plan_row "$KEEP_MARK" "subagents" "" "skipped — no pi to register it with" ;;
esac

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
UNDO_SUBAGENTS=""
[ "$DO_SUBAGENTS" = 1 ] && UNDO_SUBAGENTS=" · pi remove $SUBAGENTS_PACKAGE"
if [ "$OWNS_TREE" = 1 ]; then
	say "  ${DIM}Undo: rm -rf $(tilde "$PIRED_HOME") ~/.pired${UNDO_SUBAGENTS}${OFF}"
else
	say "  ${DIM}Undo: npm rm -g pired $PI_PACKAGE · rm -rf ~/.pired${UNDO_SUBAGENTS}${OFF}"
fi
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

if [ "$DO_PI" = 1 ]; then
	STEP_HINT="resolving packages"
	if step "pi" npm_label npm_global "$NPM_AGE_FLAG" "$PI_PACKAGE"; then
		resolve_pi
		done_line "pi" "$("$PI" --version 2>/dev/null || echo installed)  $(tilde "$BIN_DIR")"
	else
		spill
		die "could not install pi."
	fi
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
			printf 'The repository is private, does not exist, or has no %s.\n' "$ref"
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
			# A private repo 404s for an unauthenticated fetch, which npm reports as
			# a missing package and codeload as a missing ref. Name the likely cause
			# rather than the symptom.
			say ""
			say "  ${DIM}A private repository cannot be fetched anonymously. Clone it over your${OFF}"
			say "  ${DIM}SSH key and run the installer from the checkout:${OFF}"
			say "    git clone git@github.com:${DEFAULT_REPO}.git && cd pired && ./install.sh"
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

# --- subagents --------------------------------------------------------------
# pired ships no sub-agent machinery and depends on none; this is the package it
# cooperates with when it is there (extensions/lib/providers.ts mirrors its
# providers to the children). Installed after pired and never before it, so the
# order of the plan is the order of the run.
#
# Non-fatal, and deliberately so: a third-party package that fails to resolve is
# not a reason to fail an install of pired, which works without it. The warning
# carries the one command that retries it.
install_subagents() { "$PI" install "$SUBAGENTS_PACKAGE"; }

if [ "$DO_SUBAGENTS" = 1 ]; then
	resolve_pi
	if [ -z "$PI" ]; then
		# Only reachable when the pi step was skipped between the plan and here.
		skip_line "subagents" "skipped — no pi to register it with"
	elif subagents_registered "$PI"; then
		# The survey had no pi to put the question to — a box with a ~/.pi but no
		# pi on it, which is what `npm rm -g` then reinstalling leaves behind. Ask
		# now rather than install a package over itself.
		done_line "subagents" "already registered with pi"
	else
		STEP_HINT="resolving $SUBAGENTS_PACKAGE"
		# `pi install` exiting 0 is not the same as pi having recorded the package:
		# the registration ADR-017 removed was guarded this way for that reason, and
		# the guard is the part that was worth keeping.
		if step "subagents" npm_label install_subagents && subagents_registered "$PI"; then
			done_line "subagents" "$SUBAGENTS_PACKAGE  $(tilde "$HOME/.pi/agent")"
		else
			warn_line "subagents" "could not install $SUBAGENTS_PACKAGE — pired works without it"
			say "    ${DIM}retry: pi install $SUBAGENTS_PACKAGE${OFF}"
		fi
	fi
elif [ "$SUBAGENTS_STATE" = present ]; then
	done_line "subagents" "already registered with pi"
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
