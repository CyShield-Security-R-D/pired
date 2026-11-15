#!/usr/bin/env pwsh
# pired installer for Windows - the launcher and the pi extension.
#
#   powershell -c "irm https://raw.githubusercontent.com/CyShield-Security-R-D/pired/main/install.ps1 | iex"
#
# macOS and Linux have their own script. npm lays a global install out
# differently here (shims sit in the prefix itself, not in prefix/bin) and PATH
# is a registry value rather than a line in a dotfile, so the two do not merge
# into one script worth reading:
#
#   curl -fsSL https://raw.githubusercontent.com/CyShield-Security-R-D/pired/main/install.sh | sh
#
# It surveys the box, prints exactly what it will do and where, asks once, and
# then does all of it: Node.js (when missing or too old), pi (when missing or
# older than 0.86.1), pired, and the user PATH entries that make the command
# typeable.
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
# Nothing needs administrator. The MSI from nodejs.org does, so this does not
# use it:
#
#   - Node comes from nodejs.org as a per-user .zip under %LOCALAPPDATA%,
#     checksum-verified, unpacked in-process and pointed at by a directory
#     junction, none of which needs elevation.
#   - PATH is a HKCU registry value, which is the user's own to write.
#
# An installer for a security tool that skips a checksum, or takes rights it
# does not need, teaches the wrong habit on the very first command.
#
# Environment:
#   PIRED_SOURCE   npm spec to install from      (default github:CyShield-Security-R-D/pired)
#   NPM_PREFIX     prefix to install into        (default npm's own global
#                  prefix, %LOCALAPPDATA%\pired when this script brings its own
#                  Node, or %APPDATA%\npm when npm's prefix is not writable)
#   PIRED_SKIP_PI  set to 1 to not install or upgrade pi
#   PIRED_SKIP_SUBAGENTS
#                  set to 1 to not install or upgrade pi-subagents
#   PIRED_SKIP_MCP set to 1 to not install or upgrade pi-mcp-adapter
#   PIRED_YES      set to 1 to skip the confirmation prompt
#   PIRED_DRY_RUN  set to 1 to print the plan and stop
#
# Flags are environment variables rather than a param() block on purpose: the
# documented install path pipes this file into iex, which has no way to pass
# arguments to it.
#
# Deliberately ASCII-only: Windows PowerShell 5.1 reads a BOM-less script as
# ANSI, and a stray em dash would arrive as mojibake on a default install.

$ErrorActionPreference = "Stop"

$PiredDefaultSource = "github:CyShield-Security-R-D/pired"
$PiPackage = "@earendil-works/pi-coding-agent"
# The package pired delegates through: `spawn a subagent` is a thing the
# operator can ask for on a fresh box, rather than a README step they find out
# about after the first engagement wanted one. See ADR-021.
$SubagentsPackage = "npm:pi-subagents"
# Floors, not preferences. pired's delegation is built on pi-subagents 0.71
# (ADR-027), and 0.86.1 is the oldest pi host that release supports - so a
# box that meets neither has pired without delegation, and says so.
$PiFloor = [version]"0.86.1"
$SubagentsFloor = [version]"0.71.0"
# The MCP proxy. pired's scope gate hears each MCP call on the adapter's
# approval-broker event (pi-mcp-adapter:tool-approval-request), which 2.20.0
# added. Before 2.33.0 the adapter did not raise it for a call it had cached as
# approved for the session, so one session grant let every later call to that
# tool past the gate unchecked. Hence the floor.
$McpPackage = "npm:pi-mcp-adapter"
$McpFloor = [version]"2.33.0"
$NodeLine = 22
$NodeMinimum = [version]"22.19.0"
$NodeDist = "https://nodejs.org/dist/latest-v$NodeLine.x"
$Escape = [char]27

$AssumeYes = ($env:PIRED_YES -eq "1")
$DryRun = ($env:PIRED_DRY_RUN -eq "1")

# --- output -----------------------------------------------------------------
# Windows consoles only interpret ANSI once virtual-terminal processing is on,
# and the oldest ones cannot turn it on at all. Ask once, and fall back to plain
# text rather than printing escape sequences at somebody.
function Enable-VirtualTerminal {
	if ($null -ne $script:PiredVirtualTerminal) { return $script:PiredVirtualTerminal }
	$script:PiredVirtualTerminal = $false

	if ([Console]::IsOutputRedirected -or $env:TERM -eq "dumb") { return $script:PiredVirtualTerminal }

	try {
		if (-not ("Pired.ConsoleMode" -as [type])) {
			Add-Type -Namespace Pired -Name ConsoleMode -MemberDefinition @"
[DllImport("kernel32.dll", SetLastError = true)]
public static extern System.IntPtr GetStdHandle(int nStdHandle);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool GetConsoleMode(System.IntPtr hConsoleHandle, out uint lpMode);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool SetConsoleMode(System.IntPtr hConsoleHandle, uint dwMode);
"@
		}

		$standardOutput = -11
		$enableVirtualTerminalProcessing = 0x0004
		$handle = [Pired.ConsoleMode]::GetStdHandle($standardOutput)
		$mode = [uint32]0
		$script:PiredVirtualTerminal =
			[Pired.ConsoleMode]::GetConsoleMode($handle, [ref]$mode) -and
			[Pired.ConsoleMode]::SetConsoleMode($handle, ($mode -bor $enableVirtualTerminalProcessing))
	} catch {
		$script:PiredVirtualTerminal = $false
	}

	return $script:PiredVirtualTerminal
}

function Initialize-Palette {
	if (Enable-VirtualTerminal) {
		$script:Red = "$Escape[38;5;203m"
		$script:Dim = "$Escape[2m"
		$script:Bold = "$Escape[1m"
		$script:Off = "$Escape[0m"
	} else {
		$script:Red = ""
		$script:Dim = ""
		$script:Bold = ""
		$script:Off = ""
	}
}

function Write-Say {
	param([string]$Text = "")
	Write-Host $Text
}

function Write-Step {
	param([string]$Text)
	Write-Host "$($script:Red)::$($script:Off) $Text"
}

function Write-Note {
	param([string]$Text)
	Write-Host "  $($script:Dim)$Text$($script:Off)"
}

function Stop-Pired {
	param([string]$Text)
	[Console]::Error.WriteLine("$($script:Red)pired:$($script:Off) $Text")
	exit 1
}

# --- running other programs --------------------------------------------------
# npm's own output is captured rather than discarded. An installer that says
# only "could not install" leaves the user with nothing to act on.
function Show-Log {
	if (-not (Test-Path -LiteralPath $script:LogPath -PathType Leaf)) { return }
	foreach ($line in @(Get-Content -LiteralPath $script:LogPath -Tail 12)) {
		[Console]::Error.WriteLine("    $line")
	}
}

# Native programs write progress to stderr, and with $ErrorActionPreference set
# to Stop a single redirected stderr line becomes a terminating error. The exit
# code is the truth here, so the preference is relaxed for the call itself.
function Invoke-Logged {
	param([string]$Command, [string[]]$Arguments)

	$previous = $ErrorActionPreference
	$ErrorActionPreference = "Continue"
	try {
		& $Command @Arguments 2>&1 | Out-File -FilePath $script:LogPath -Encoding utf8
		return ($LASTEXITCODE -eq 0)
	} catch {
		"$_" | Out-File -FilePath $script:LogPath -Encoding utf8
		return $false
	} finally {
		$ErrorActionPreference = $previous
	}
}

function Invoke-NpmLogged {
	param([string[]]$Arguments)
	return (Invoke-Logged -Command $script:Npm -Arguments $Arguments)
}

function Get-NpmValue {
	param([string[]]$Arguments)

	$previous = $ErrorActionPreference
	$ErrorActionPreference = "Continue"
	try {
		$output = & $script:Npm @Arguments 2>$null
		if ($LASTEXITCODE -ne 0 -or -not $output) { return "" }
		return ([string](@($output)[0])).Trim()
	} catch {
		return ""
	} finally {
		$ErrorActionPreference = $previous
	}
}

# --- paths -------------------------------------------------------------------
# Windows paths compare case-insensitively, a trailing separator means nothing,
# and the two separators are interchangeable - npm reports forward slashes for
# the same directory Get-Command reports with backslashes. Raw string equality
# on any of the three would report a correct install as misplaced.
function Get-ComparablePath {
	param([string]$Path)
	if (-not $Path) { return "" }
	return $Path.Replace([char]47, [char]92).TrimEnd([char]92).ToLowerInvariant()
}

# The source may be an npm spec such as github:CyShield-Security-R-D/pired, and "github:" looks
# enough like a PowerShell drive that Test-Path throws instead of answering.
function Test-Directory {
	param([string]$Path)
	try { return (Test-Path -LiteralPath $Path -PathType Container) } catch { return $false }
}

function Test-Writable {
	param([string]$Path)

	$probeDirectory = $Path
	while (-not (Test-Directory $probeDirectory)) {
		$parent = Split-Path -Path $probeDirectory -Parent
		if (-not $parent -or $parent -eq $probeDirectory) { return $false }
		$probeDirectory = $parent
	}

	$probe = Join-Path $probeDirectory ".pired-write-test-$PID"
	try {
		New-Item -ItemType File -Path $probe -Force | Out-Null
		Remove-Item -LiteralPath $probe -Force
		return $true
	} catch {
		return $false
	}
}

# `npm install --global` writes the package under <prefix>\node_modules and the
# command shims straight into <prefix>. There is no bin\ directory here.
function Test-PrefixWritable {
	param([string]$Prefix)
	if (-not $Prefix) { return $false }
	return ((Test-Writable (Join-Path $Prefix "node_modules")) -and (Test-Writable $Prefix))
}

# Shorten a home-relative path for the plan, the way ~ does on the other script.
function Get-Tilde {
	param([string]$Path)
	if (-not $Path -or -not $env:USERPROFILE) { return $Path }
	$home_ = $env:USERPROFILE.TrimEnd([char]92)
	if ((Get-ComparablePath $Path) -eq (Get-ComparablePath $home_)) { return "~" }
	if ($Path.StartsWith($home_ + [string][char]92, [System.StringComparison]::OrdinalIgnoreCase)) {
		return "~" + $Path.Substring($home_.Length)
	}
	return $Path
}

# --- layout ------------------------------------------------------------------
# When this script brings its own Node, everything it owns lives under one
# directory that can be deleted in a single step:
#
#   %LOCALAPPDATA%\pired                    pired.cmd, pired-state.cmd, pi.cmd
#   %LOCALAPPDATA%\pired\node_modules
#   %LOCALAPPDATA%\pired\node\v22.x.y
#   %LOCALAPPDATA%\pired\node\current  ->   v22.x.y   (a junction)
#
# The npm prefix is deliberately the *parent* of the Node tree rather than the
# Node tree itself. Installing globals into node\current means installing them
# into a versioned directory behind a junction, so the next Node upgrade
# repoints the junction and takes pi and pired with it.
#
# Unlike the Unix layout there is no bin\ to collapse node and the shims into:
# the Windows build puts node.exe and npm.cmd at the root of the extracted zip.
# That is two PATH entries rather than one, which is the honest cost of not
# having symlinks a plain user is allowed to create.
function Get-PiredHome {
	$root = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE "AppData\Local" }
	return (Join-Path $root "pired")
}

function Get-NodeHome { return (Join-Path (Get-PiredHome) "node") }

function Get-NodeCurrent { return (Join-Path (Get-NodeHome) "current") }

# pi's own installer parks a standalone Node here - %LOCALAPPDATA%\pi-node, the
# Windows counterpart of the ~/.local/share/pi-node the other script adopts. If
# it is already on the box and new enough, adopt it rather than downloading a
# second copy of the same thing: the two installers should not each own a Node.
#
# It puts node.exe straight into current\ rather than behind a versioned
# directory, so the candidate to test is the same shape as ours.
function Get-PiNodeHome {
	$root = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE "AppData\Local" }
	return (Join-Path $root "pi-node")
}

# --- prerequisites -----------------------------------------------------------
# Checked before the banner, so a failure is not printed underneath a header
# promising an install that never started.
#
# node 22.19 is pi's floor and pired's: the extension is TypeScript that pi
# type-strips at load, which needs a runtime that can do it.
function Resolve-Npm {
	# npm.cmd, not npm: PowerShell prefers the npm.ps1 shim, which a Restricted
	# or AllSigned execution policy refuses to run.
	foreach ($name in @("npm.cmd", "npm")) {
		$command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
		if ($command -and $command.Source) { return $command.Source }
	}
	return ""
}

# Ask a specific node.exe what it is. Returns $null rather than throwing: every
# caller here is deciding between candidates, and "cannot answer" is one of the
# answers, not a failure.
function Get-NodeVersion {
	param([string]$Command = "node")

	$previous = $ErrorActionPreference
	$ErrorActionPreference = "Continue"
	try {
		$reported = ([string](@(& $Command --version 2>$null)[0])).Trim()
	} catch {
		return $null
	} finally {
		$ErrorActionPreference = $previous
	}

	$parsed = [regex]::Match($reported, '^v?(\d+)\.(\d+)\.(\d+)')
	if (-not $parsed.Success) { return $null }
	return [version]("{0}.{1}.{2}" -f $parsed.Groups[1].Value, $parsed.Groups[2].Value, $parsed.Groups[3].Value)
}

# Only the tree this script owns, never pi's: the prefix decision below turns on
# it, and a Node we cannot upgrade must not drag the prefix with it.
function Test-UnderNodeHome {
	param([string]$Path)
	if (-not $Path) { return $false }
	$root = (Get-ComparablePath (Get-NodeHome))
	$candidate = Get-ComparablePath $Path
	return ($candidate -eq $root -or $candidate.StartsWith($root + [string][char]92))
}

# A Node this installer put here on an earlier run, or one pi's installer left
# behind. Adopting either keeps a re-run from downloading a second copy of the
# same thing, and keeps the prefix stable across runs.
#
# Ours is tried first: when both exist, the tree this script owns is the one it
# can upgrade and delete.
function Find-AdoptedNode {
	foreach ($candidate in @((Get-NodeCurrent), (Join-Path (Get-PiNodeHome) "current"))) {
		$exe = Join-Path $candidate "node.exe"
		if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { continue }

		$version = Get-NodeVersion $exe
		if (-not $version -or $version -lt $NodeMinimum) { continue }

		# In-process, so npm - and everything this script drives through it -
		# resolves the adopted copy rather than whatever else is on PATH. pi's
		# installer does put its own copy on the user PATH, but that only reaches
		# shells started afterwards, and this may be one that started before.
		$env:PATH = "$candidate;$env:PATH"
		return $candidate
	}
	return ""
}

# present  - something on PATH, or a copy we placed, is new enough
# old      - node is here but below the floor; a private copy shadows it
# missing  - no node at all
function Resolve-NodeState {
	$onPath = Get-Command node -ErrorAction SilentlyContinue
	if ($onPath) {
		$version = Get-NodeVersion "node"
		if ($version -and $version -ge $NodeMinimum) {
			# A previous run may have put our own copy on PATH. Say so, or the
			# prefix below would be taken from `npm prefix --global` - which
			# under a private Node answers with the versioned directory the next
			# upgrade repoints away from.
			$directory = Split-Path -Path $onPath.Source -Parent
			$ours = if (Test-UnderNodeHome $directory) { $directory } else { "" }
			return @{ State = "present"; Adopted = $ours; Version = $version }
		}
	}

	$adopted = Find-AdoptedNode
	if ($adopted) {
		return @{ State = "present"; Adopted = $adopted; Version = (Get-NodeVersion (Join-Path $adopted "node.exe")) }
	}

	if ($onPath) {
		# Report the version even when it is unparseable, so the plan can say
		# which node it is about to step in front of.
		return @{ State = "old"; Adopted = ""; Version = (Get-NodeVersion "node") }
	}

	return @{ State = "missing"; Adopted = ""; Version = $null }
}

# --- node --------------------------------------------------------------------
# Windows PowerShell 5.1 defaults to whatever SecurityProtocol the .NET Framework
# was configured with, which on an un-patched box is still TLS 1.0. nodejs.org
# refuses that, and the failure surfaces as an unhelpful "underlying connection
# was closed" rather than a protocol error.
function Enable-ModernTls {
	try {
		[Net.ServicePointManager]::SecurityProtocol =
			[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
	} catch {
		# .NET too old to name Tls12. The download will fail with its own message.
	}
}

# The PROCESSOR_ARCHITECTURE of a 32-bit PowerShell on 64-bit Windows is x86;
# PROCESSOR_ARCHITEW6432 is what the machine actually is. Prefer the latter, or
# a WOW64 shell would install a 32-bit Node onto an x64 box.
function Get-NodeArch {
	$architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
	switch ("$architecture".ToUpperInvariant()) {
		"AMD64" { return "x64" }
		"ARM64" { return "arm64" }
		"X86"   { return "x86" }
		default { return "" }
	}
}

function Get-Download {
	param([string]$Uri, [string]$OutFile)

	# Invoke-WebRequest renders a progress bar per chunk on PowerShell 5.1, which
	# costs far more wall-clock than the transfer does. Silence it for the call.
	$previousProgress = $ProgressPreference
	$previous = $ErrorActionPreference
	$ProgressPreference = "SilentlyContinue"
	$ErrorActionPreference = "Stop"
	try {
		Invoke-WebRequest -Uri $Uri -OutFile $OutFile -UseBasicParsing
		return $true
	} catch {
		"$_" | Out-File -FilePath $script:LogPath -Encoding utf8
		return $false
	} finally {
		$ProgressPreference = $previousProgress
		$ErrorActionPreference = $previous
	}
}

# Expand-Archive shells through the same COM path Explorer uses and is slow
# enough on a 60MB zip to look hung. ZipFile is in the framework on every
# Windows this script supports; keep Expand-Archive as the fallback.
function Expand-Zip {
	param([string]$Path, [string]$Destination)

	try {
		Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop
		[System.IO.Compression.ZipFile]::ExtractToDirectory($Path, $Destination)
		return $true
	} catch {
		try {
			Expand-Archive -LiteralPath $Path -DestinationPath $Destination -Force
			return $true
		} catch {
			"$_" | Out-File -FilePath $script:LogPath -Encoding utf8
			return $false
		}
	}
}

# A junction, not a symlink: creating a symlink needs administrator or Developer
# Mode, a directory junction needs neither. Both give the same property, which
# is that an upgrade is one repoint and the PATH entry never changes.
function Set-Junction {
	param([string]$Link, [string]$Target)

	if (Test-Path -LiteralPath $Link) {
		# Remove-Item on a junction deletes the junction, not the target - but
		# only with -Force, and only when it is not handed -Recurse, which would
		# follow it into the real directory on older PowerShell.
		try { [System.IO.Directory]::Delete($Link, $false) } catch { Remove-Item -LiteralPath $Link -Force -Recurse }
	}
	New-Item -ItemType Junction -Path $Link -Target $Target | Out-Null
}

function Install-Node {
	$arch = Get-NodeArch
	if (-not $arch) {
		Write-Note "unsupported CPU architecture: $env:PROCESSOR_ARCHITECTURE"
		return $false
	}

	Enable-ModernTls
	$base = Get-NodeHome
	$temp = Join-Path $base (".download." + [guid]::NewGuid().ToString("N"))
	New-Item -ItemType Directory -Force -Path $temp | Out-Null

	try {
		$sums = Join-Path $temp "SHASUMS256.txt"
		Write-Note "resolving the current v$NodeLine release"
		if (-not (Get-Download -Uri "$NodeDist/SHASUMS256.txt" -OutFile $sums)) {
			Write-Note "could not reach $NodeDist"
			return $false
		}

		# The manifest lists every build for the release. Pick the Windows zip
		# for this architecture and take its checksum from the same line, so the
		# hash can never be read from a different row than the file.
		$suffix = "-win-$arch.zip"
		$entry = Get-Content -LiteralPath $sums |
			Where-Object { $_ -match '^\s*([0-9a-fA-F]{64})\s+(node-v\S+' + [regex]::Escape($suffix) + ')\s*$' } |
			Select-Object -First 1
		if (-not $entry) {
			Write-Note "no Node.js $NodeLine build for win-$arch"
			return $false
		}

		$parsed = [regex]::Match($entry, '^\s*([0-9a-fA-F]{64})\s+(\S+)\s*$')
		$want = $parsed.Groups[1].Value
		$file = $parsed.Groups[2].Value
		$version = ($file -replace '^node-', '') -replace '-win-.*$', ''

		Write-Note "downloading Node.js $version"
		$archive = Join-Path $temp $file
		if (-not (Get-Download -Uri "$NodeDist/$file" -OutFile $archive)) {
			Write-Note "could not download $file"
			return $false
		}

		# A checksum this script can always compute is a checksum it must never
		# skip. pired spends its working life telling people to verify what they
		# run; an installer that shrugged here would be the first counterexample.
		Write-Note "verifying the checksum"
		$got = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
		if ($got -ne $want.ToUpperInvariant()) {
			Write-Note "checksum mismatch for $file"
			Write-Note "  expected $($want.ToUpperInvariant())"
			Write-Note "  got      $got"
			return $false
		}

		Write-Note "unpacking"
		$unpack = Join-Path $temp "unpacked"
		if (-not (Expand-Zip -Path $archive -Destination $unpack)) {
			Write-Note "could not unpack $file"
			return $false
		}

		# The zip carries one top-level node-vX.Y.Z-win-<arch> directory. Lift its
		# contents out, the way tar --strip-components=1 does on the other script.
		$inner = @(Get-ChildItem -LiteralPath $unpack -Directory) | Select-Object -First 1
		if (-not $inner) {
			Write-Note "$file did not contain the directory it was supposed to"
			return $false
		}

		$target = Join-Path $base $version
		if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
		Move-Item -LiteralPath $inner.FullName -Destination $target

		Set-Junction -Link (Get-NodeCurrent) -Target $target
		Write-Note "installed $version"
		return $true
	} catch {
		"$_" | Out-File -FilePath $script:LogPath -Encoding utf8
		Write-Note "$_"
		return $false
	} finally {
		Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
	}
}

# --- source ------------------------------------------------------------------
# Prefer a checkout we are sitting inside: running .\install.ps1 from a clone
# should install *that* clone, not re-download one. Piped through iex there is
# no script directory to find, so it falls back to the published repo.
function Get-Source {
	if ($env:PIRED_SOURCE) { return $env:PIRED_SOURCE }

	if ($PSScriptRoot) {
		$manifest = Join-Path $PSScriptRoot "package.json"
		if (Test-Path -LiteralPath $manifest -PathType Leaf) {
			if ((Get-Content -LiteralPath $manifest -Raw) -match '"name"\s*:\s*"pired"') {
				return $PSScriptRoot
			}
		}
	}

	return $PiredDefaultSource
}

# --- where to install --------------------------------------------------------
# The prefix travels as an environment variable rather than a --prefix argument,
# so every npm call in this script - install, prefix, root - agrees on it
# without the flag having to be threaded through each one.
function Select-Prefix {
	param([switch]$DoNode, [string]$Adopted)

	if ($env:NPM_PREFIX) {
		if (-not (Test-PrefixWritable $env:NPM_PREFIX)) {
			Stop-Pired "cannot write to NPM_PREFIX=$($env:NPM_PREFIX). Pick a writable directory."
		}
		$env:npm_config_prefix = $env:NPM_PREFIX
		return $env:NPM_PREFIX
	}

	# Bringing our own Node, or re-running on top of one we brought: either way
	# the prefix is the stable parent directory, never npm's own answer. Under a
	# private Node, `npm prefix --global` reports the *versioned* directory
	# behind node\current - the one the next upgrade repoints away from, taking
	# pi and pired with it.
	if ($DoNode -or (Test-UnderNodeHome $Adopted)) {
		$piredHome = Get-PiredHome
		try {
			New-Item -ItemType Directory -Force -Path $piredHome | Out-Null
			New-Item -ItemType Directory -Force -Path (Join-Path $piredHome "node_modules") | Out-Null
		} catch {
			Stop-Pired "cannot create $piredHome."
		}
		$env:npm_config_prefix = $piredHome
		return $piredHome
	}

	$prefix = Get-NpmValue @("prefix", "--global")
	if (Test-PrefixWritable $prefix) { return $prefix }

	# A machine-wide node - one under Program Files, or installed by another
	# account - leaves a prefix this user cannot write to. Fall back to npm's own
	# per-user location, which the Node.js installer already puts on PATH,
	# rather than failing with npm's EACCES wall of text.
	$unwritable = if ($prefix) { $prefix } else { "npm's global prefix" }
	if (-not $env:APPDATA) {
		Stop-Pired "$unwritable is not writable, and APPDATA is not set to fall back to."
	}

	$fallback = Join-Path $env:APPDATA "npm"
	try {
		New-Item -ItemType Directory -Force -Path $fallback | Out-Null
		New-Item -ItemType Directory -Force -Path (Join-Path $fallback "node_modules") | Out-Null
	} catch {
		Stop-Pired "$unwritable is not writable, and neither is $fallback."
	}

	$env:npm_config_prefix = $fallback
	$prefix = Get-NpmValue @("prefix", "--global")
	if (-not (Test-PrefixWritable $prefix)) {
		Stop-Pired "$unwritable is not writable, and neither is $fallback."
	}

	# Recorded rather than printed: the survey runs before the banner, and this
	# belongs in the plan with everything else the run decided.
	$script:UnwritableNote = "$unwritable is not writable, so this installs into $prefix instead."
	return $prefix
}

# --- pi ----------------------------------------------------------------------
# Resolved by path first: under a fallback prefix, pi lands in a directory that
# is typically not on PATH yet, and Get-Command would miss the copy we just
# installed - reinstalling it, then silently skipping the registration below.
function Resolve-Pi {
	param([string]$Prefix, [switch]$PathFallback)

	foreach ($name in @("pi.cmd", "pi.exe")) {
		$candidate = Join-Path $Prefix $name
		if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
	}

	# Only when this run is keeping the Node already on the box. When it is
	# bringing its own, a pi on PATH belongs to the runtime we are about to step
	# in front of - counting it would leave the new Node without a pi at all.
	if (-not $PathFallback) { return "" }

	$command = Get-Command pi -ErrorAction SilentlyContinue | Select-Object -First 1
	if ($command -and $command.Source) { return $command.Source }
	return ""
}

# --- versions ----------------------------------------------------------------
# The first three numbers in the text, so "0.87.1" and "0.86.1-beta.2" both read
# as their release. Anything else is $null, which no floor accepts: "could not
# tell" is not a reason to leave a floor unchecked.
function ConvertTo-Version {
	param([string]$Text)
	$parsed = [regex]::Match("$Text", '(\d+)\.(\d+)\.(\d+)')
	if (-not $parsed.Success) { return $null }
	return [version]("{0}.{1}.{2}" -f $parsed.Groups[1].Value, $parsed.Groups[2].Value, $parsed.Groups[3].Value)
}

function Format-Version {
	param($Version)
	if ($Version) { return "$Version" }
	return "version unknown"
}

# What a pi says it is, or $null. `pi --version` prints the bare version.
function Get-PiVersion {
	param([string]$Pi)
	if (-not $Pi) { return $null }

	$previous = $ErrorActionPreference
	$ErrorActionPreference = "Continue"
	try {
		$reported = [string](@(& $Pi --version 2>$null)[0])
	} catch {
		return $null
	} finally {
		$ErrorActionPreference = $previous
	}
	return (ConvertTo-Version $reported)
}

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
# from, which need not be here.
function Get-PiState {
	param([string]$Pi)

	$skip = ($env:PIRED_SKIP_PI -eq "1")
	if (-not $Pi) {
		$state = if ($skip) { "declined" } else { "missing" }
		return @{ State = $state; Version = $null }
	}

	$version = Get-PiVersion $Pi
	if ($version -and $version -ge $PiFloor) { return @{ State = "present"; Version = $version } }
	$state = if ($skip) { "held" } else { "old" }
	return @{ State = $state; Version = $version }
}

# --- pi packages -------------------------------------------------------------
# Two third-party packages are registered with pi: pi-subagents and
# pi-mcp-adapter. Everything that decides or reports on one is written once
# below and handed the package's facts; what differs between the two lives in
# Get-PackageFacts and nowhere else.
function Get-PackageFacts {
	param([string]$Key)

	switch ($Key) {
		"subagents" {
			return @{
				Key = "subagents"; Package = $SubagentsPackage; Name = "pi-subagents"; Floor = $SubagentsFloor
				Skip = "PIRED_SKIP_SUBAGENTS"
				Row = "delegation, loads in every pi"
				Needs = "pired's delegation needs"
				Fork = "pired's delegation needs pi-subagents >= $SubagentsFloor features, which a fork may not have"
				Held = "pi-subagents $SubagentsFloor needs pi >= $PiFloor"
				HeldKept = "$SubagentsFloor needs pi >= $PiFloor"
				Install = @("install", $SubagentsPackage)
				# `pi update <source>` updates that one package and leaves pi and
				# every other package where they are (`pi update --help`).
				Update = @("update", $SubagentsPackage)
			}
		}
		"mcp" {
			return @{
				Key = "mcp"; Package = $McpPackage; Name = "pi-mcp-adapter"; Floor = $McpFloor
				Skip = "PIRED_SKIP_MCP"
				Row = "MCP servers through one proxy tool, loads in every pi"
				Needs = "pired's MCP scope check needs"
				Fork = "pired's MCP scope check relies on the adapter's approval-broker event, which a fork may not have"
				Held = "pired registers it only on pi >= $PiFloor"
				HeldKept = "pired updates it only on pi >= $PiFloor"
				Install = @("install", $McpPackage)
				Update = @("update", $McpPackage)
			}
		}
	}
	throw "no such package: $Key"
}

# The match is any package by that name, not the one spec this script
# installs. The pi-subagents ecosystem is mostly forks - @gotgenes, @nklisch,
# @tintinweb - and an operator who chose one did not ask for a second
# implementation of the same tool registered underneath it, or for this script
# to decide what version of theirs is new enough.
#
# canonical  npm:<name>, which `pi update` moves
# pinned     npm:<name>@<version>, which it does not
# fork       any other package by that name - a scope, a git remote, a checkout
function Get-PackageKind {
	param([string]$Source, [string]$Name)

	if ($Source -match '^npm:(@[^/@]+/)?([^@]+)(@(.*))?$') {
		$scope = $Matches[1]
		$found = $Matches[2]
		$version = $Matches[4]
		if ($found -ne $Name) { return "" }
		if ($scope) { return "fork" }
		if ((-not $version) -or $version -eq "latest") { return "canonical" }
		return "pinned"
	}

	$last = $Source.TrimEnd([char]47, [char]92)
	$last = @($last -split '[/\\:]')[-1]
	$last = ($last -replace '@[^@]*$', '') -replace '\.git$', ''
	if ($last -eq $Name) { return "fork" }
	return ""
}

# Node writes UTF-8 whatever the console is set to, and PowerShell decodes a
# native program's output with [Console]::OutputEncoding - the OEM code page on
# a default Windows install. The path `pi list` prints sits under the user's
# profile, so one non-ASCII letter in the user name turns it into a path that
# does not exist: Test-Path finds no package.json there, the version reads as
# unknown, and every run - a fresh install of the current release included -
# warns that delegation needs a newer one and runs `pi update` again.
#
# Set for the one call and put back, since on Windows it is the console's
# code page and outlives this script. Returns what to put back, or $null when
# there is no console to set it on (the ISE, a redirected host), in which case
# the output is read as it was before.
function Set-Utf8Output {
	try {
		$previous = [Console]::OutputEncoding
		[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
		return $previous
	} catch {
		return $null
	}
}

function Restore-Output {
	param($Encoding)
	if ($null -eq $Encoding) { return }
	try { [Console]::OutputEncoding = $Encoding } catch { }
}

# `pi list` prints each source with its installed path on the line below, so
# this reads entries rather than matching lines: a match on `pi-subagents` also
# hit that path, and counted a pinned npm:pi-subagents@0.66.0 as registered by
# the name of its directory rather than by its source. npm:<name> is preferred
# over a fork registered beside it, since it is the one this can move.
function Get-PackageEntry {
	param([string]$Pi, [string]$Name)
	if (-not $Pi) { return $null }

	$previous = $ErrorActionPreference
	$ErrorActionPreference = "Continue"
	$encoding = Set-Utf8Output
	try {
		$output = & $Pi "list" 2>$null
	} catch {
		return $null
	} finally {
		Restore-Output $encoding
		$ErrorActionPreference = $previous
	}

	$best = $null
	$other = $null
	$current = $null
	foreach ($raw in @($output)) {
		$line = "$raw" -replace "$([char]27)\[[0-9;]*m", ""
		if ($line -match '^  (\S+)') {
			$source = $Matches[1]
			$current = $null
			$kind = Get-PackageKind $source $Name
			if (-not $kind) { continue }
			$current = @{ Kind = $kind; Source = $source; Path = "" }
			if ($kind -eq "fork") {
				if (-not $other) { $other = $current }
			} elseif (-not $best) {
				$best = $current
			}
		} elseif ($line -match '^    (\S.*?)\s*$') {
			if ($current -and -not $current.Path) { $current.Path = $Matches[1] }
		} else {
			$current = $null
		}
	}

	if ($best) { return $best }
	return $other
}

function Test-SubagentsRegistered {
	param([string]$Pi)
	return ($null -ne (Get-PackageEntry $Pi "pi-subagents"))
}

function Test-McpRegistered {
	param([string]$Pi)
	return ($null -ne (Get-PackageEntry $Pi "pi-mcp-adapter"))
}

# The version in <path>\package.json, or $null.
function Get-PackageVersion {
	param([string]$Path)
	if (-not $Path) { return $null }

	try {
		$manifest = Join-Path $Path "package.json"
		if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { return $null }
		$parsed = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
		return (ConvertTo-Version ([string]$parsed.version))
	} catch {
		return $null
	}
}

# Asked of the pi that is already here, if one is. On a box where this run is
# bringing pi too there is nothing to ask, and the answer is the one the plan
# would give anyway: install it.
#
#   missing   nothing registered
#   present   npm:<name> at or above the floor, pinned or not
#   old       npm:<name> below it, or with no version on disk to read
#   pinned    npm:<name>@<version> below it: `pi update` does not move a
#             pin, and replacing the operator's pin is not this script's call
#   fork      another package by that name
#   held      missing or old, on a pi this run leaves below its own floor
#   declined  the package's opt-out is set to 1
#   nopi      no pi to register it with, and none coming
#
# A function rather than lines inside the survey because this is the half of
# the feature that decides, and install.ps1 cannot be run on the machines its
# tests run on - so what decides has to be callable on its own.
function Get-PackageState {
	param([hashtable]$Facts, [string]$Pi, [bool]$DoPi, [bool]$PiReady = $true)

	$result = @{ State = ""; Kind = ""; Source = ""; Version = $null }
	if ([Environment]::GetEnvironmentVariable($Facts.Skip) -eq "1") { $result.State = "declined"; return $result }
	# No pi to register it with, and none coming. A "+" row here would be
	# promising something this run cannot do.
	if ((-not $DoPi) -and (-not $Pi)) { $result.State = "nopi"; return $result }

	$entry = Get-PackageEntry $Pi $Facts.Name
	if (-not $entry) {
		$result.State = "missing"
	} else {
		$result.Kind = $entry.Kind
		$result.Source = $entry.Source
		$result.Version = Get-PackageVersion $entry.Path
		if ($entry.Kind -eq "fork") {
			$result.State = "fork"
		} elseif ($result.Version -and $result.Version -ge $Facts.Floor) {
			$result.State = "present"
		} elseif ($entry.Kind -eq "pinned") {
			$result.State = "pinned"
		} else {
			$result.State = "old"
		}
	}

	# pi-subagents 0.71's changelog names 0.86.1 its oldest supported pi, and a
	# pi kept below that by PIRED_SKIP_PI=1 is one this run will not lift.
	# Installing the latest onto it would be installing a package onto a host it
	# has said it does not support.
	#
	# pi-mcp-adapter's own peer range reaches lower, and it is held on the same
	# floor anyway. It opens a route to MCP servers that pired's scope gate has
	# to see, and a pi below the one pired is supported on is not a host this
	# run adds that route to.
	if ((-not $PiReady) -and ($result.State -in @("missing", "old"))) { $result.State = "held" }
	return $result
}

function Get-SubagentsState {
	param([string]$Pi, [bool]$DoPi, [bool]$PiReady = $true)
	return (Get-PackageState -Facts (Get-PackageFacts "subagents") -Pi $Pi -DoPi $DoPi -PiReady $PiReady)
}

function Get-McpState {
	param([string]$Pi, [bool]$DoPi, [bool]$PiReady = $true)
	return (Get-PackageState -Facts (Get-PackageFacts "mcp") -Pi $Pi -DoPi $DoPi -PiReady $PiReady)
}

# Where pi keeps its settings: PI_CODING_AGENT_DIR, or .pi\agent under the
# profile. Joined a part at a time so the same path comes out on the Linux
# PowerShell the tests load this file into.
function Get-PiAgentDir {
	$dir = $env:PI_CODING_AGENT_DIR
	if ($dir) {
		if ($dir -match '^~([\\/]|$)' -and $env:USERPROFILE) { return $env:USERPROFILE + $dir.Substring(1) }
		return $dir
	}
	if (-not $env:USERPROFILE) { return "" }
	return (Join-Path (Join-Path $env:USERPROFILE ".pi") "agent")
}

# Whether the plan's "missing" is a guess. With no pi to ask - none on the box,
# or one on PATH that a run bringing its own Node does not count - the survey
# says "missing". But `npm rm -g` of pi leaves pi's agent directory behind, and
# the step, asking the pi this run installs, can find the operator's
# npm:pi-subagents there and upgrade it - under a plan whose undo said
# `pi remove`, which would take the operator's package away. Only a settings
# file there can record one, so without it the plan is certain. The same holds
# for either package.
function Test-PackageUnasked {
	param([string]$Pi, [string]$State)
	if ($Pi -or $State -ne "missing") { return $false }
	$agentDir = Get-PiAgentDir
	if (-not $agentDir) { return $false }
	try { return (Test-Path -LiteralPath (Join-Path $agentDir "settings.json") -PathType Leaf) } catch { return $false }
}

# `pi install` of an exact version replaces the entry it matches by name, so
# going back from an upgrade leaves npm:<name>@<old> where npm:<name> was: a
# pin, which `pi update` never moves and the next run of this script leaves
# alone. The undo says so where it is given, after a `#` so that pasting it
# runs only the command. It is always last on its line.
function Format-PackageUndo {
	param([string]$Package, $Version)
	return "pi install $($Package)@$Version  # pins it; pi install $Package unpins"
}

# What undoes this run's change to one package, or "" when it makes none.
function Get-PackageUndo {
	param([string]$Package, [string]$State, $Version, [bool]$Unasked)
	if ($Unasked) { return "pi remove $Package  # only if the step installs it" }
	if ($State -eq "missing") { return "pi remove $Package" }
	if ($State -eq "old" -and $Version) { return (Format-PackageUndo $Package $Version) }
	return ""
}

# The undo line, a function for the reason Get-SubagentsState is one: it is a
# decision, and this file cannot be run where its tests run. Spelled for
# PowerShell, which is the shell this script was started from, and naming only
# what this run changes, each where this run changed it.
#
# pi is in it only when this run put pi in the prefix. A pi that already met
# the floor, one PIRED_SKIP_PI=1 kept, and one an upgrade stepped in front of
# from outside the prefix all belong to the operator, and `npm rm -g` of the
# package name removed theirs. An upgrade in place is undone by going back to
# the version it replaced; one whose version could not be read has nothing to
# go back to, and is left out rather than removed.
#
# Every npm command carries the prefix, as the retry does: under NPM_PREFIX or
# the %APPDATA%\npm fallback a bare `npm rm -g` runs against npm's own prefix,
# which is usually where the operator's own pi lives.
function Get-UndoText {
	param(
		[string]$Prefix,
		[bool]$OwnsTree,
		[string]$PiState,
		$PiVersion,
		[bool]$PiInPrefix,
		[string]$SubagentsState,
		$SubagentsVersion,
		[bool]$SubagentsUnasked,
		[string]$McpState = "",
		$McpVersion = $null,
		[bool]$McpUnasked = $false
	)

	$undoPrefix = "--prefix `"$Prefix`""
	$undoPiRemove = ""
	$undoPiBack = ""
	if ($PiState -eq "missing" -or ($PiState -eq "old" -and -not $PiInPrefix)) {
		$undoPiRemove = " $PiPackage"
	} elseif ($PiState -eq "old" -and $PiVersion) {
		$undoPiBack = "; npm install -g $undoPrefix $($PiPackage)@$PiVersion"
	}

	# A package's undo ends its line. Either note after it is a `#` comment, and
	# a second package's undo pasted on the same line would be part of the
	# comment, silently not run. The first rides the Undo line; the next takes
	# its own line beneath, where pasting it runs it.
	$subagentsUndo = Get-PackageUndo $SubagentsPackage $SubagentsState $SubagentsVersion $SubagentsUnasked
	$mcpUndo = Get-PackageUndo $McpPackage $McpState $McpVersion $McpUnasked
	$tail = ""
	$next = ""
	if ($subagentsUndo) {
		$tail = "; $subagentsUndo"
		$next = $mcpUndo
	} elseif ($mcpUndo) {
		$tail = "; $mcpUndo"
	}

	if ($OwnsTree) {
		$text = "Undo: Remove-Item -Recurse -Force $(Get-Tilde (Get-PiredHome)), ~\.pired$tail"
	} else {
		$text = "Undo: npm rm -g $undoPrefix pired$undoPiRemove; Remove-Item -Recurse -Force ~\.pired$undoPiBack$tail"
	}
	if ($next) { $text += "$([char]10)        $next" }
	return $text
}

# npm writes both a .cmd and a .ps1 shim, and PowerShell resolves the .ps1
# first. Under a Restricted or AllSigned execution policy that shim refuses to
# run, so `pired` fails even though the pired.cmd beside it is perfectly
# allowed. Drop the blocked shim rather than weaken the machine's policy - and
# only for the commands this run installed, never for someone else's package.
function Remove-BlockedShims {
	param([string]$Prefix, [string[]]$Names)

	$policy = Get-ExecutionPolicy
	if ($policy -notin @("Restricted", "AllSigned")) { return }

	foreach ($name in $Names) {
		$cmdShim = Join-Path $Prefix "$name.cmd"
		$powerShellShim = Join-Path $Prefix "$name.ps1"
		if (-not (Test-Path -LiteralPath $cmdShim -PathType Leaf)) { continue }
		if (-not (Test-Path -LiteralPath $powerShellShim -PathType Leaf)) { continue }

		try {
			Remove-Item -LiteralPath $powerShellShim -Force
			Write-Note "removed $name.ps1 so $name runs under the $policy execution policy"
		} catch {
			Write-Note "could not remove $powerShellShim - $name may be blocked by the $policy execution policy"
		}
	}
}

# --- bash --------------------------------------------------------------------
# pired's whole method is driving the tools already on the box - nmap, ffuf,
# curl, semgrep - and pi runs them through bash. Windows ships none, so an
# install that ignores this is an install that cannot run a single command.
function Get-PiShellPath {
	if (-not $env:USERPROFILE) { return "" }

	$settings = Join-Path (Join-Path $env:USERPROFILE ".pi\agent") "settings.json"
	if (-not (Test-Path -LiteralPath $settings -PathType Leaf)) { return "" }

	try {
		$parsed = Get-Content -LiteralPath $settings -Raw | ConvertFrom-Json
	} catch {
		return ""
	}
	if ($parsed -and ($parsed.PSObject.Properties.Name -contains "shellPath")) {
		return [string]$parsed.shellPath
	}
	return ""
}

function Find-Bash {
	$configured = Get-PiShellPath
	if ($configured -and (Test-Path -LiteralPath $configured -PathType Leaf)) { return $configured }

	$candidates = @()
	if ($env:ProgramFiles) { $candidates += (Join-Path (Join-Path $env:ProgramFiles "Git") "bin\bash.exe") }
	if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path (Join-Path ${env:ProgramFiles(x86)} "Git") "bin\bash.exe") }
	if ($env:LOCALAPPDATA) { $candidates += (Join-Path (Join-Path $env:LOCALAPPDATA "Programs\Git") "bin\bash.exe") }
	if ($env:USERPROFILE) { $candidates += (Join-Path (Join-Path $env:USERPROFILE ".pi\agent\win-git-bash") "bin\bash.exe") }

	foreach ($candidate in $candidates) {
		if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
	}

	# System32\bash.exe is the WSL launcher, not a bash: it would run every tool
	# against a different filesystem than the one holding the engagement. Better
	# to report no bash than to point pi at that.
	$system32 = if ($env:SystemRoot) { Get-ComparablePath (Join-Path $env:SystemRoot "System32") } else { "" }
	$command = Get-Command bash.exe -ErrorAction SilentlyContinue | Select-Object -First 1
	if ($command -and $command.Source -and
		(Get-ComparablePath (Split-Path -Path $command.Source -Parent)) -ne $system32) {
		return $command.Source
	}

	return ""
}

# --- PATH --------------------------------------------------------------------
# PATH here is a registry value, not a line in a dotfile. Read it raw so that
# entries stored as %USERPROFILE%\... are not expanded and frozen on the way
# back out, which would quietly rewrite variables this installer does not own.
function Get-UserEnv {
	param([string]$Key)

	$environment = (Get-Item -Path "HKCU:").OpenSubKey("Environment")
	if (-not $environment) { return $null }
	return $environment.GetValue($Key, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
}

# Tell Explorer and every terminal started from now on that the environment
# changed. Without the broadcast a PATH edit waits for the next sign-out.
function Publish-EnvChange {
	try {
		if (-not ("Pired.Broadcast" -as [type])) {
			Add-Type -Namespace Pired -Name Broadcast -MemberDefinition @"
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern System.IntPtr SendMessageTimeout(
    System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam,
    uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);
"@
		}

		$broadcast = [System.IntPtr]0xffff
		$settingChange = 0x1a
		$result = [System.UIntPtr]::Zero
		[Pired.Broadcast]::SendMessageTimeout($broadcast, $settingChange, [System.UIntPtr]::Zero, "Environment", 2, 5000, [ref]$result) | Out-Null
	} catch {
		# A refused broadcast costs one shell restart, not the install.
	}
}

function Set-UserEnv {
	param([string]$Key, [string]$Value)

	$environment = (Get-Item -Path "HKCU:").OpenSubKey("Environment", $true)
	# Preserve the kind: a PATH holding %APPDATA% must stay an ExpandString, or
	# every entry in it stops resolving.
	$kind = if ($Value.Contains("%")) {
		[Microsoft.Win32.RegistryValueKind]::ExpandString
	} elseif ($environment.GetValue($Key)) {
		$environment.GetValueKind($Key)
	} else {
		[Microsoft.Win32.RegistryValueKind]::String
	}

	$environment.SetValue($Key, $Value, $kind)
	Publish-EnvChange
}

function Add-UserPathEntry {
	param([string]$Directory)

	$comparable = Get-ComparablePath $Directory
	$existing = @((Get-UserEnv -Key "Path") -split ";" |
		Where-Object { $_ -and ((Get-ComparablePath $_) -ne $comparable) })
	Set-UserEnv -Key "Path" -Value ((@($Directory) + $existing) -join ";")

	# Also update this process, so the summary below can honestly say the
	# command is reachable rather than promising it after a restart.
	$inProcess = @($env:PATH -split ";" | Where-Object { $_ -and ((Get-ComparablePath $_) -ne $comparable) })
	$env:PATH = ((@($Directory) + $inProcess) -join ";")
}

# live    - already in this process, so the command is typeable now
# written - in the registry but not in this shell; a new terminal has it
# missing - not there at all
function Get-PathState {
	param([string]$Directory)

	$comparable = Get-ComparablePath $Directory
	foreach ($entry in ($env:PATH -split ";")) {
		if ($entry -and (Get-ComparablePath $entry) -eq $comparable) { return "live" }
	}

	# Compared raw *and* expanded: an entry stored as %LOCALAPPDATA%\pired is the
	# same directory as the expanded path, and writing it twice is still a bug.
	$userPath = [string](Get-UserEnv -Key "Path")
	foreach ($entry in ($userPath -split ";")) {
		if (-not $entry) { continue }
		if ((Get-ComparablePath $entry) -eq $comparable) { return "written" }
		if ((Get-ComparablePath ([System.Environment]::ExpandEnvironmentVariables($entry))) -eq $comparable) { return "written" }
	}

	return "missing"
}

# --- the plan ----------------------------------------------------------------
# Everything the script is about to do, named and located, before it does any of
# it. A one-line irm into iex earns its trust exactly here.
#
# The trailing space is not decoration: a where-path longer than the column
# would otherwise run straight into the note with nothing between them.
function Write-PlanRow {
	param([string]$Mark, [string]$What, [string]$Where, [string]$Note)
	$markup = if ($Mark -eq "+" -or $Mark -eq "^") { "$($script:Red)$Mark$($script:Off)" } else { "$($script:Dim).$($script:Off)" }
	Write-Host ("    {0} {1}{2} {3}" -f $markup, $What.PadRight(11), $Where.PadRight(31), "$($script:Dim)$Note$($script:Off)")
}

# The only rows that write outside this script's own prefix, so they say
# where - ~\.pi is pi's directory, and a plan that hid that would be hiding the
# lines someone might object to.
function Write-PackageRow {
	param([hashtable]$Facts, [hashtable]$State, [string]$PiHome)

	$key = $Facts.Key
	$where = Get-Tilde $PiHome
	$was = Format-Version $State.Version
	switch ($State.State) {
		"missing" { Write-PlanRow "+" $key $where "$($Facts.Package) - $($Facts.Row)" }
		"old" { Write-PlanRow "^" $key $where "$was -> latest  (pired needs >= $($Facts.Floor))" }
		"present" { Write-PlanRow "." $key $where "$was - already registered with pi" }
		"pinned" { Write-PlanRow "." $key $where "$($State.Source) - pinned, left alone" }
		"fork" { Write-PlanRow "." $key $where "$($State.Source) - already registered with pi, left alone" }
		"held" {
			if ($State.Kind) {
				Write-PlanRow "." $key $where "$was kept - $($Facts.HeldKept)"
			} else {
				Write-PlanRow "." $key "" "skipped - $($Facts.Held)"
			}
		}
		"declined" { Write-PlanRow "." $key "" "skipped - $($Facts.Skip)=1" }
		"nopi" { Write-PlanRow "." $key "" "skipped - no pi to register it with" }
	}
}

function Write-PackageNote {
	param([hashtable]$Facts, [string]$State)
	switch ($State) {
		"pinned" { Write-Note "$($Facts.Needs) $($Facts.Name) >= $($Facts.Floor). To lift the pin: pi install $($Facts.Package)" }
		"fork" { Write-Note "$($Facts.Fork)." }
	}
}

# This is the only question the installer asks. Everything above it is in the
# plan the answer covers - a second prompt later for the PATH entries would be
# asking twice for one decision.
function Confirm-Plan {
	if ($script:AssumeYes) { return $true }

	# No console to ask at - a CI job, a provisioning script. The plan was still
	# printed, which is the part that matters in a log.
	if ([Console]::IsInputRedirected) {
		Write-Note "no console to ask at - continuing. Set PIRED_DRY_RUN=1 to only look."
		Write-Say
		return $true
	}

	$answer = Read-Host "  Proceed? [Y/n]"
	if ($answer -and $answer -notmatch "^(y|yes)$") {
		Write-Say
		Write-Note "Nothing was changed."
		Write-Say
		return $false
	}
	Write-Say
	return $true
}

# --- pi packages, the step ---------------------------------------------------
# pired ships no sub-agent machinery and no MCP client, and depends on neither.
# These are the packages it cooperates with when they are there: pi-subagents
# runs its delegation, and the scope gate checks each call pi-mcp-adapter
# makes. Installed after pired and never before it, pi-subagents first, so the
# order of the plan is the order of the run.
#
# Non-fatal, and deliberately so: a third-party package that fails to resolve is
# not a reason to fail an install of pired, which works without it. The warning
# carries the one command that retries it.
function Invoke-PackageStep {
	param([hashtable]$Facts, [hashtable]$Planned, [string]$Pi)

	$key = $Facts.Key
	$package = $Facts.Package
	if (-not $Pi) {
		# Only reachable when the pi step was skipped between the plan and here.
		Write-Note "$key skipped - no pi to register it with"
		return
	}
	$piNow = Get-PiVersion $Pi
	if (-not ($piNow -and $piNow -ge $PiFloor)) {
		# The pi upgrade failed or did not take, and the pi step already said so.
		Write-Note "$key held back - $($Facts.Held)"
		return
	}

	# Asked again rather than trusted from the survey, which may have had no pi
	# to put the question to - a box with a ~\.pi but no pi on it, which is what
	# `npm rm -g` then reinstalling leaves behind - or an older one.
	$now = Get-PackageState -Facts $Facts -Pi $Pi -DoPi $false
	if ($now.State -in @("pinned", "fork")) {
		Write-Note "$($now.Source) is registered - left alone"
		return
	}
	if ($now.State -notin @("missing", "old")) { return }

	if ($now.State -eq "old") {
		Write-Step "updating $package $(Format-Version $now.Version) -> latest"
		$ran = Invoke-Logged -Command $Pi -Arguments $Facts.Update
		$retry = "pi update $package"
	} else {
		Write-Step "installing $package"
		$ran = Invoke-Logged -Command $Pi -Arguments $Facts.Install
		$retry = "pi install $package"
	}
	if (-not $ran) { Show-Log }

	# Neither exit code is the answer. `pi install` can exit 0 and record
	# nothing - the registration ADR-017 removed was guarded against that, and
	# the guard is the part worth keeping - and `pi update` can exit 0 and move
	# nothing: with PI_OFFLINE=1 in the environment, pi 0.87.1 prints "Updated
	# npm:pi-subagents" and leaves 0.66.0 on disk. What pi lists, and what the
	# package.json under it says, are the answer.
	$after = Get-PackageState -Facts $Facts -Pi $Pi -DoPi $false
	switch ($after.State) {
		"present" {
			# The plan offered `pi remove` for a package this step found already
			# there, so the undo it printed is wrong for what ran.
			if ($Planned.State -eq "missing" -and $now.State -eq "old") {
				if ($now.Version) {
					Write-Note "$package was already registered at $($now.Version), so this updated it rather than installing it"
					Write-Host "    undo: $(Format-PackageUndo $package $now.Version)"
				} else {
					Write-Note "$package was already registered, with no version to read, so this updated it rather than"
					Write-Note "installing it: the plan's pi remove would take away a package that was here before this run"
				}
			}
		}
		"old" {
			Write-Note "$package is $(Format-Version $after.Version) - $($Facts.Needs) >= $($Facts.Floor)"
			Write-Host "    retry: pi update $package"
		}
		{ $_ -in @("pinned", "fork") } { Write-Note "$($after.Source) is registered - left alone" }
		default {
			Write-Note "could not install $package - pired works without it"
			Write-Host "    retry: $retry"
		}
	}
}

# Said again after the run, not only in the plan. A pin reaches this state
# only below the floor, where pired goes without what the floor is for, and the
# pin need not be one the operator chose: taking the undo of an earlier upgrade
# leaves one.
function Write-PackageKept {
	param([hashtable]$Facts, [hashtable]$State)
	if ($State.State -ne "pinned") { return }
	Write-Note "$($State.Source) is pinned below $($Facts.Floor) - left alone; $($Facts.Needs) >= $($Facts.Floor)"
	Write-Host "    to lift the pin: pi install $($Facts.Package)"
}

# --- the installer -----------------------------------------------------------
function Invoke-PiredInstaller {
	if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
		Write-Host "This installer is for Windows. On macOS and Linux, use:"
		Write-Host "  curl -fsSL https://raw.githubusercontent.com/CyShield-Security-R-D/pired/main/install.sh | sh"
		exit 1
	}

	Initialize-Palette

	$script:LogPath = Join-Path ([System.IO.Path]::GetTempPath()) ("pired-install-" + [guid]::NewGuid().ToString("N") + ".log")
	New-Item -ItemType File -Path $script:LogPath -Force | Out-Null

	try {
		# --- survey ---
		# Everything the plan needs to be truthful, decided before anything is
		# written. Nothing here changes the box.
		$node = Resolve-NodeState
		$doNode = ($node.State -ne "present")

		$source = Get-Source
		$script:UnwritableNote = ""

		if ($doNode) {
			# No usable node means no npm to ask, so the prefix is decided
			# without one and $script:Npm is resolved after the download.
			$prefix = Select-Prefix -DoNode
			$script:Npm = ""
		} else {
			$script:Npm = Resolve-Npm
			if (-not $script:Npm) {
				Stop-Pired "npm not found beside node v$($node.Version). Install npm and re-run."
			}
			$prefix = Select-Prefix -Adopted $node.Adopted
		}

		$nodeCurrent = Get-NodeCurrent
		$ownsTree = ((Get-ComparablePath $prefix) -eq (Get-ComparablePath (Get-PiredHome)))

		$pi = Resolve-Pi -Prefix $prefix -PathFallback:(-not $doNode)
		$piState = Get-PiState $pi
		$doPi = ($piState.State -in @("missing", "old"))
		$piReady = ($doPi -or $piState.State -eq "present")
		$piInPrefix = ($pi -and ((Get-ComparablePath (Split-Path -Path $pi -Parent)) -eq (Get-ComparablePath $prefix)))
		$reinstall = (Test-Path -LiteralPath (Join-Path $prefix "pired.cmd") -PathType Leaf)

		$piHome = if ($env:USERPROFILE) { Join-Path $env:USERPROFILE ".pi" } else { ".pi" }
		$subagentsFacts = Get-PackageFacts "subagents"
		$subagents = Get-PackageState -Facts $subagentsFacts -Pi $pi -DoPi $doPi -PiReady $piReady
		$doSubagents = ($subagents.State -in @("missing", "old"))
		$mcpFacts = Get-PackageFacts "mcp"
		$mcp = Get-PackageState -Facts $mcpFacts -Pi $pi -DoPi $doPi -PiReady $piReady
		$doMcp = ($mcp.State -in @("missing", "old"))

		# Two entries when this run brings its own Node: the shims live in the
		# prefix, node.exe and npm.cmd at the root of the extracted zip.
		$pathWanted = @($prefix)
		if ($doNode -or $ownsTree) { $pathWanted += $nodeCurrent }
		$pathNeeded = @($pathWanted | Where-Object { (Get-PathState $_) -eq "missing" })

		$bash = Find-Bash

		# --- the plan ---
		Write-Say
		Write-Host "  $($script:Red)$($script:Bold)pired$($script:Off) $($script:Dim)- security assessment harness$($script:Off)"
		Write-Say
		Write-Host "  $($script:Bold)This will install$($script:Off)"
		Write-Say

		switch ($node.State) {
			"present" {
				if ($node.Adopted) {
					# The home, not the current\ inside it - that is the directory
					# the user would delete, and the one an upgrade repoints.
					$home_ = Split-Path -Path $node.Adopted -Parent
					$whose = if (Test-UnderNodeHome $node.Adopted) { "already here" } else { "already here, pi's copy" }
					Write-PlanRow "." "node" (Get-Tilde $home_) "v$($node.Version) - $whose"
				} else {
					$where = (Get-Command node).Source
					Write-PlanRow "." "node" (Get-Tilde $where) "v$($node.Version) - already good"
				}
			}
			"old" {
				$was = if ($node.Version) { "v$($node.Version)" } else { "the node on your PATH" }
				Write-PlanRow "+" "node" (Get-Tilde (Get-NodeHome)) "$was is below $NodeMinimum - a private copy, no admin"
			}
			"missing" {
				Write-PlanRow "+" "node" (Get-Tilde (Get-NodeHome)) "v$NodeLine from nodejs.org, checksum-verified"
			}
		}

		$piVersionText = Format-Version $piState.Version
		switch ($piState.State) {
			"missing" { Write-PlanRow "+" "pi" (Get-Tilde $prefix) $PiPackage }
			"old" { Write-PlanRow "^" "pi" (Get-Tilde $prefix) "$piVersionText -> latest  (pired needs >= $PiFloor)" }
			"present" { Write-PlanRow "." "pi" (Get-Tilde (Split-Path -Path $pi -Parent)) "$piVersionText - already installed" }
			"held" { Write-PlanRow "." "pi" (Get-Tilde (Split-Path -Path $pi -Parent)) "$piVersionText kept - PIRED_SKIP_PI=1; delegation needs >= $PiFloor" }
			default { Write-PlanRow "." "pi" "" "skipped - PIRED_SKIP_PI=1" }
		}

		$piredNote = if ($reinstall) { "reinstall from $source" } else { "from $source" }
		Write-PlanRow "+" "pired" (Get-Tilde $prefix) $piredNote

		Write-PackageRow -Facts $subagentsFacts -State $subagents -PiHome $piHome
		Write-PackageRow -Facts $mcpFacts -State $mcp -PiHome $piHome

		if ($pathNeeded.Count -gt 0) {
			Write-PlanRow "+" "PATH" "your user environment" (($pathNeeded | ForEach-Object { Get-Tilde $_ }) -join "; ")
		} else {
			Write-PlanRow "." "PATH" "your user environment" "already there"
		}

		# Not installed, only reported: Git for Windows is a ~250MB install with
		# shell integration and file associations, which is well outside what
		# "no service, no shell hooks" can promise on the user's behalf.
		if ($bash) {
			Write-PlanRow "." "bash" (Get-Tilde $bash) "already here - pi runs tools through it"
		} else {
			Write-PlanRow "." "bash" "" "not here - see the note after the install"
		}

		Write-Say
		Write-Note "Nothing needs administrator. No daemon, no service, no shell hooks."
		if ($script:UnwritableNote) { Write-Note $script:UnwritableNote }
		if ($node.State -eq "old") {
			Write-Note "The PATH entry puts pired's Node.js ahead of $((Get-Command node).Source) in new shells."
		}
		if ($piState.State -eq "old" -and -not $piInPrefix) {
			Write-Note "The pi at $(Get-Tilde $pi) stays as it is; pired runs the new one in $(Get-Tilde $prefix)."
		}
		Write-PackageNote -Facts $subagentsFacts -State $subagents.State
		Write-PackageNote -Facts $mcpFacts -State $mcp.State

		$subagentsUnasked = Test-PackageUnasked -Pi $pi -State $subagents.State
		$mcpUnasked = Test-PackageUnasked -Pi $pi -State $mcp.State
		if ($subagentsUnasked -or $mcpUnasked) {
			Write-Note "Only the pi this run installs can say what $(Get-Tilde (Get-PiAgentDir)) already records: the"
			if ($subagentsUnasked -and $mcpUnasked) {
				Write-Note "subagents and mcp steps ask it, and upgrade or keep a package they find there."
			} elseif ($subagentsUnasked) {
				Write-Note "subagents step asks it, and upgrades or keeps a pi-subagents it finds there."
			} else {
				Write-Note "mcp step asks it, and upgrades or keeps a pi-mcp-adapter it finds there."
			}
		}
		Write-Note (Get-UndoText -Prefix $prefix -OwnsTree $ownsTree `
			-PiState $piState.State -PiVersion $piState.Version -PiInPrefix ([bool]$piInPrefix) `
			-SubagentsState $subagents.State -SubagentsVersion $subagents.Version -SubagentsUnasked $subagentsUnasked `
			-McpState $mcp.State -McpVersion $mcp.Version -McpUnasked $mcpUnasked)
		Write-Say

		if ($script:DryRun) {
			Write-Note "PIRED_DRY_RUN=1: nothing was changed."
			Write-Say
			return
		}

		if (-not (Confirm-Plan)) { return }

		# --- node ---
		if ($doNode) {
			Write-Step "installing Node.js"
			if (-not (Install-Node)) {
				Show-Log
				Stop-Pired "could not install Node.js. Install Node.js >= $NodeMinimum yourself and re-run."
			}

			# In-process, so npm and the verification step below resolve the copy
			# just installed rather than the old one this run stepped in front of.
			$env:PATH = "$nodeCurrent;$env:PATH"
			$script:Npm = Resolve-Npm
			if (-not $script:Npm) {
				Stop-Pired "installed Node.js but found no npm beside it in $nodeCurrent."
			}
		}

		# Spelled with the prefix: under NPM_PREFIX or the %APPDATA%\npm fallback,
		# a bare `npm install -g` lands somewhere pired does not look.
		$piRetry = "npm install -g --prefix `"$prefix`" $PiPackage"
		$installedPi = $false
		if ($doPi) {
			if ($piState.State -eq "old") {
				Write-Step "upgrading pi $piVersionText -> latest"
			} else {
				Write-Step "installing pi"
			}
			if (Invoke-NpmLogged @("install", "--global", "--ignore-scripts", $PiPackage)) {
				$installedPi = $true
				$pi = Resolve-Pi -Prefix $prefix -PathFallback:(-not $doNode)
				if ($piState.State -eq "old") {
					# Asked rather than assumed: npm's exit code says npm finished, not
					# that the pi pired will start is now one it can delegate from.
					$piNow = Get-PiVersion $pi
					if (-not ($piNow -and $piNow -ge $PiFloor)) {
						Write-Note "pi is still $(Format-Version $piNow) - pired needs >= $PiFloor"
						Write-Host "    retry: $piRetry"
					}
				}
			} elseif ($piState.State -eq "old") {
				# The pi already here is left as it was. The floor is delegation's,
				# so a failed upgrade is a warning with the retry, as the subagents
				# step's failure is - and whether pired itself loads on that pi is
				# the verify step's question, which it asks below and stops on.
				Show-Log
				Write-Note "could not upgrade pi $piVersionText - pired's delegation needs >= $PiFloor"
				Write-Host "    retry: $piRetry"
				$pi = Resolve-Pi -Prefix $prefix -PathFallback:(-not $doNode)
			} else {
				Show-Log
				Stop-Pired "could not install pi"
			}
		} elseif ($piState.State -eq "held") {
			Write-Note "pi $piVersionText kept (PIRED_SKIP_PI=1) - pired's delegation needs pi >= $PiFloor"
			Write-Host "    upgrade: $piRetry"
		}

		Write-Step "installing pired $($script:Dim)($source)$($script:Off)"
		# Installing a local directory the plain way makes the global package a
		# SYMLINK back into it, so moving or deleting the clone silently breaks
		# the install. --install-links copies the files in, and honours
		# package.json "files".
		$arguments = @("install", "--global", "--ignore-scripts")
		if (Test-Directory $source) { $arguments += "--install-links" }
		$arguments += $source

		if (-not (Invoke-NpmLogged $arguments)) {
			Show-Log
			if ($source -like "github:*") {
				# npm reports a failed fetch as a missing package, whether the
				# network, a proxy, a missing ref or a missing git is at fault.
				# Installing from a clone takes the fetch out of the picture.
				Write-Note "If the fetch failed, check the network or proxy, and that git is installed (winget install --id Git.Git -e). Or clone the repository and run the installer from the checkout:"
				Write-Host "    git clone https://github.com/CyShield-Security-R-D/pired.git; cd pired; .\install.ps1"
			}
			Stop-Pired "could not install from $source"
		}

		$shims = @("pired", "pired-state")
		if ($installedPi) { $shims += "pi" }
		Remove-BlockedShims -Prefix $prefix -Names $shims

		# --- pired is not registered ---
		# There is deliberately no `pi install` for *pired* here. Registering it
		# would put pired's extensions AND themes\ on pi's global resource path,
		# so a bare `pi` would start with the security layer and - because pi
		# persists a theme set through its extension API - would rewrite `theme`
		# in ~\.pi\agent\settings.json on first run. `pi` stays the pi you
		# installed. `pired` passes -e for its own run and writes nothing.
		# See ADR-017.

		# --- pi packages ---
		# pi-subagents first, then pi-mcp-adapter, as the plan listed them. See
		# Invoke-PackageStep for why each is non-fatal.
		if ($doSubagents) {
			Invoke-PackageStep -Facts $subagentsFacts -Planned $subagents -Pi $pi
		} else {
			Write-PackageKept -Facts $subagentsFacts -State $subagents
		}
		if ($doMcp) {
			Invoke-PackageStep -Facts $mcpFacts -Planned $mcp -Pi $pi
		} else {
			Write-PackageKept -Facts $mcpFacts -State $mcp
		}

		# --- PATH ---
		# Covered by the one approval above, so this writes rather than asks.
		# Non-fatal: a PATH this script could not write costs the user one
		# manual edit, and everything installed above still works when invoked
		# by full path.
		$pathFailed = @()
		foreach ($directory in $pathNeeded) {
			try {
				Add-UserPathEntry $directory
			} catch {
				$pathFailed += $directory
			}
		}

		# --- verify ---
		$piredCmd = Join-Path $prefix "pired.cmd"
		if (-not (Test-Path -LiteralPath $piredCmd -PathType Leaf)) {
			Stop-Pired "npm reported success but $piredCmd is missing."
		}

		# pired's own help does not load pi. pi's help can exit 0 even after an
		# extension fails, so require the flag that pired registers as well.
		if ($pi) {
			Write-Step "verifying"
			$previousOffline = $env:PI_OFFLINE
			try {
				$env:PI_OFFLINE = "1"
				$verified = Invoke-Logged -Command $piredCmd -Arguments @("--", "--help")
			} finally {
				$env:PI_OFFLINE = $previousOffline
			}
			if ((-not $verified) -or (-not (Select-String -LiteralPath $script:LogPath -Pattern '^\s*--pired-profile(\s|$)' -Quiet))) {
				Show-Log
				Stop-Pired "pired installed but pi could not load its extension (--pired-profile was not registered)."
			}
		}

		# --- report ---
		Write-Say
		Write-Host "  $($script:Bold)installed$($script:Off) $($script:Dim)$piredCmd$($script:Off)"

		if ($pathFailed.Count -gt 0) {
			Write-Say
			Write-Note "could not write your user PATH. Add these to it by hand:"
			foreach ($directory in $pathFailed) { Write-Host "    $directory" }
		} elseif ($pathNeeded.Count -gt 0) {
			Write-Note "PATH updated - open a new terminal for it to take effect."
		}

		if (-not (Find-Bash)) {
			Write-Say
			Write-Note "no bash found. pired drives the tools already on this box, and pi"
			Write-Note "runs them through bash - without one, no command can execute."
			Write-Host "    winget install --id Git.Git -e"
			Write-Note "or let pi's own installer set up a managed copy for you:"
			Write-Host "    irm https://pi.dev/install.ps1 | iex"
		}

		Write-Say
		Write-Note "next"
		Write-Host "    pired                    $($script:Dim)review the current directory$($script:Off)"
		Write-Host "    /provider                $($script:Dim)add the model you are already running - do this first$($script:Off)"
		Write-Host "    pired --profile pentest  $($script:Dim)blackbox testing (needs an authorized scope)$($script:Off)"
		Write-Host "    /panel                   $($script:Dim)the engagement panel - alt+p toggles it$($script:Off)"
		Write-Say
		Write-Note "docs: https://github.com/CyShield-Security-R-D/pired/tree/main/docs"
		Write-Say
	} finally {
		if (Test-Path -LiteralPath $script:LogPath) {
			Remove-Item -LiteralPath $script:LogPath -Force -ErrorAction SilentlyContinue
		}
	}
}

Invoke-PiredInstaller
