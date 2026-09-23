#!/usr/bin/env pwsh
# pired installer for Windows - the launcher and the pi extension.
#
#   powershell -c "irm https://raw.githubusercontent.com/mamgad/pired/main/install.ps1 | iex"
#
# macOS and Linux have their own script. npm lays a global install out
# differently here (shims sit in the prefix itself, not in prefix/bin) and PATH
# is a registry value rather than a line in a dotfile, so the two do not merge
# into one script worth reading:
#
#   curl -fsSL https://raw.githubusercontent.com/mamgad/pired/main/install.sh | sh
#
# It surveys the box, prints exactly what it will do and where, asks once, and
# then does all of it: Node.js (when missing or too old), pi, pired, and the
# user PATH entries that make the command typeable.
#
# It does not register pired with pi. `pi` stays the pi you installed; the
# security layer arrives only when you type `pired`, which passes it to pi with
# -e for that run. See ADR-017.
#
# It does register pi-subagents, the delegation extension pired cooperates with.
# That is a package the operator would otherwise install by hand, it is named in
# the plan, and PIRED_SKIP_SUBAGENTS=1 declines it. See ADR-021.
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
#   PIRED_SOURCE   npm spec to install from      (default github:mamgad/pired)
#   NPM_PREFIX     prefix to install into        (default npm's own global
#                  prefix, %LOCALAPPDATA%\pired when this script brings its own
#                  Node, or %APPDATA%\npm when npm's prefix is not writable)
#   PIRED_SKIP_PI  set to 1 to not install pi
#   PIRED_SKIP_SUBAGENTS
#                  set to 1 to not install pi-subagents
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

$PiredDefaultSource = "github:mamgad/pired"
$PiPackage = "@earendil-works/pi-coding-agent"
# The delegation extension pired cooperates with: `spawn a subagent` is a thing
# the operator can ask for on a fresh box, rather than a README step they find
# out about after the first engagement wanted one. See ADR-021.
$SubagentsPackage = "npm:pi-subagents"
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

# The source may be an npm spec such as github:mamgad/pired, and "github:" looks
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

# --- subagents ---------------------------------------------------------------
# The match is any package whose name ends in `pi-subagents`, not the one spec
# this script installs. The ecosystem is mostly forks - @gotgenes, @nklisch,
# @tintinweb - and an operator who chose one did not ask for a second
# implementation of the same tool registered underneath it.
function Test-SubagentsRegistered {
	param([string]$Pi)
	if (-not $Pi) { return $false }

	$previous = $ErrorActionPreference
	$ErrorActionPreference = "Continue"
	try {
		$output = & $Pi "list" 2>$null
	} catch {
		return $false
	} finally {
		$ErrorActionPreference = $previous
	}

	foreach ($line in @($output)) {
		if ("$line" -match '(^|[:/\s])(@[^\s/]+/)?pi-subagents(\s|$)') { return $true }
	}
	return $false
}

# Asked of the pi that is already here, if one is. On a box where this run is
# bringing pi too there is nothing to ask, and the answer is the one the plan
# would give anyway: install it.
#
# A function rather than four lines inside the survey because this is the half of
# the feature that decides, and install.ps1 cannot be run on the machines its
# tests run on - so what decides has to be callable on its own.
function Get-SubagentsState {
	param([string]$Pi, [bool]$DoPi)

	if ($env:PIRED_SKIP_SUBAGENTS -eq "1") { return "declined" }
	# No pi to register it with, and none coming. A "+ subagents" row here would
	# be promising something this run cannot do.
	if ((-not $DoPi) -and (-not $Pi)) { return "nopi" }
	if (Test-SubagentsRegistered $Pi) { return "present" }
	return "missing"
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
	$markup = if ($Mark -eq "+") { "$($script:Red)+$($script:Off)" } else { "$($script:Dim).$($script:Off)" }
	Write-Host ("    {0} {1}{2} {3}" -f $markup, $What.PadRight(11), $Where.PadRight(31), "$($script:Dim)$Note$($script:Off)")
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

# --- the installer -----------------------------------------------------------
function Invoke-PiredInstaller {
	if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
		Write-Host "This installer is for Windows. On macOS and Linux, use:"
		Write-Host "  curl -fsSL https://raw.githubusercontent.com/mamgad/pired/main/install.sh | sh"
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
		$skipPi = ($env:PIRED_SKIP_PI -eq "1")
		$doPi = ((-not $skipPi) -and (-not $pi))
		$reinstall = (Test-Path -LiteralPath (Join-Path $prefix "pired.cmd") -PathType Leaf)

		$piHome = if ($env:USERPROFILE) { Join-Path $env:USERPROFILE ".pi" } else { ".pi" }
		$subagentsState = Get-SubagentsState -Pi $pi -DoPi $doPi
		$doSubagents = ($subagentsState -eq "missing")

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

		if ($doPi) {
			Write-PlanRow "+" "pi" (Get-Tilde $prefix) $PiPackage
		} elseif ($pi) {
			Write-PlanRow "." "pi" (Get-Tilde $prefix) "already installed"
		} else {
			Write-PlanRow "." "pi" "" "skipped - PIRED_SKIP_PI=1"
		}

		$piredNote = if ($reinstall) { "reinstall from $source" } else { "from $source" }
		Write-PlanRow "+" "pired" (Get-Tilde $prefix) $piredNote

		# The only row that writes outside this script's own prefix, so it says
		# where - ~\.pi is pi's directory, and a plan that hid that would be hiding
		# the one line someone might object to.
		switch ($subagentsState) {
			"missing" { Write-PlanRow "+" "subagents" (Get-Tilde $piHome) "$SubagentsPackage - delegation, loads in every pi" }
			"present" { Write-PlanRow "." "subagents" (Get-Tilde $piHome) "already registered with pi" }
			"declined" { Write-PlanRow "." "subagents" "" "skipped - PIRED_SKIP_SUBAGENTS=1" }
			"nopi" { Write-PlanRow "." "subagents" "" "skipped - no pi to register it with" }
		}

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
		# Spelled for PowerShell, which is the shell this script was started from.
		$undoSubagents = if ($doSubagents) { "; pi remove $SubagentsPackage" } else { "" }
		if ($ownsTree) {
			Write-Note "Undo: Remove-Item -Recurse -Force $(Get-Tilde (Get-PiredHome)), ~\.pired$undoSubagents"
		} else {
			Write-Note "Undo: npm rm -g pired $PiPackage; Remove-Item -Recurse -Force ~\.pired$undoSubagents"
		}
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

		if ($doPi) {
			Write-Step "installing pi"
			if (-not (Invoke-NpmLogged @("install", "--global", "--ignore-scripts", $PiPackage))) {
				Show-Log
				Stop-Pired "could not install pi"
			}
			$installedPi = $true
			$pi = Resolve-Pi -Prefix $prefix -PathFallback:(-not $doNode)
		} else {
			$installedPi = $false
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
				# A private repo 404s for an unauthenticated fetch, which npm
				# reports as a missing package. Name the likely cause.
				Write-Note "If the repository is private, clone it and run the installer from there:"
				Write-Host "    git clone git@github.com:mamgad/pired.git; cd pired; .\install.ps1"
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

		# --- subagents ---
		# pired ships no sub-agent machinery and depends on none; this is the
		# package it cooperates with when it is there. Installed after pired and
		# never before it, so the order of the plan is the order of the run.
		#
		# Non-fatal, and deliberately so: a third-party package that fails to
		# resolve is not a reason to fail an install of pired, which works without
		# it. The warning carries the one command that retries it.
		if ($doSubagents) {
			if (-not $pi) {
				# Only reachable when the pi step was skipped between the plan and here.
				Write-Note "subagents skipped - no pi to register it with"
			} elseif (-not (Test-SubagentsRegistered $pi)) {
				# Asked again rather than trusted from the survey, which had no pi to
				# put the question to on a box with a ~\.pi but no pi on it - what
				# `npm rm -g` then reinstalling leaves behind.
				Write-Step "installing $SubagentsPackage"
				# `pi install` exiting 0 is not the same as pi having recorded the
				# package: the registration ADR-017 removed was guarded this way for
				# that reason, and the guard is the part that was worth keeping.
				$installed = (Invoke-Logged -Command $pi -Arguments @("install", $SubagentsPackage))
				if (-not ($installed -and (Test-SubagentsRegistered $pi))) {
					Write-Note "could not install $SubagentsPackage - pired works without it"
					Write-Host "    retry: pi install $SubagentsPackage"
				}
			}
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
		Write-Note "docs: https://github.com/mamgad/pired/tree/main/docs"
		Write-Say
	} finally {
		if (Test-Path -LiteralPath $script:LogPath) {
			Remove-Item -LiteralPath $script:LogPath -Force -ErrorAction SilentlyContinue
		}
	}
}

Invoke-PiredInstaller
