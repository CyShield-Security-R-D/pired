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
# Installs, in order: pi (if missing), pired, and pired's extension registration
# so a plain `pi` also loads the security layer. Everything is npm-global; there
# is no elevation, no service and no state outside ~\.pi and ~\.pired.
#
# Environment:
#   PIRED_SOURCE   npm spec to install from      (default github:mamgad/pired)
#   NPM_PREFIX     prefix to install into        (default npm's own global
#                  prefix, or %APPDATA%\npm when that prefix is not writable)
#   PIRED_SKIP_PI  set to 1 to not install pi
#
# Deliberately ASCII-only: Windows PowerShell 5.1 reads a BOM-less script as
# ANSI, and a stray em dash would arrive as mojibake on a default install.

$ErrorActionPreference = "Stop"

$PiredDefaultSource = "github:mamgad/pired"
$PiPackage = "@earendil-works/pi-coding-agent"
$NodeMinimum = [version]"22.19.0"
$Escape = [char]27

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
# Windows paths compare case-insensitively and a trailing separator means
# nothing, so raw string equality would report a correct install as misplaced.
function Get-ComparablePath {
	param([string]$Path)
	if (-not $Path) { return "" }
	return $Path.TrimEnd([char]92, [char]47).ToLowerInvariant()
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

function Assert-Prerequisites {
	if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
		Stop-Pired "node not found. Install Node.js >= 22.19 and re-run."
	}

	$script:Npm = Resolve-Npm
	if (-not $script:Npm) {
		Stop-Pired "npm not found. Install Node.js >= 22.19 and re-run."
	}

	$previous = $ErrorActionPreference
	$ErrorActionPreference = "Continue"
	try {
		$reported = ([string](@(& node --version 2>$null)[0])).Trim()
	} finally {
		$ErrorActionPreference = $previous
	}

	$parsed = [regex]::Match($reported, '^v?(\d+)\.(\d+)\.(\d+)')
	if (-not $parsed.Success) {
		Stop-Pired "could not read a version out of 'node --version' (it said '$reported')."
	}

	$version = [version]("{0}.{1}.{2}" -f $parsed.Groups[1].Value, $parsed.Groups[2].Value, $parsed.Groups[3].Value)
	if ($version -lt $NodeMinimum) {
		Stop-Pired "node $reported is too old. pired needs >= 22.19."
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
	if ($env:NPM_PREFIX) { $env:npm_config_prefix = $env:NPM_PREFIX }

	$prefix = Get-NpmValue @("prefix", "--global")
	if (Test-PrefixWritable $prefix) { return $prefix }

	if ($env:NPM_PREFIX) {
		Stop-Pired "cannot write to NPM_PREFIX=$($env:NPM_PREFIX). Pick a writable directory."
	}

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

	Write-Note "$unwritable is not writable - installing into $prefix instead"
	Write-Say
	return $prefix
}

# --- pi ----------------------------------------------------------------------
# Resolved by path first: under a fallback prefix, pi lands in a directory that
# is typically not on PATH yet, and Get-Command would miss the copy we just
# installed - reinstalling it, then silently skipping the registration below.
function Resolve-Pi {
	param([string]$Prefix)

	foreach ($name in @("pi.cmd", "pi.exe")) {
		$candidate = Join-Path $Prefix $name
		if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
	}

	$command = Get-Command pi -ErrorAction SilentlyContinue | Select-Object -First 1
	if ($command -and $command.Source) { return $command.Source }
	return ""
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

function Confirm-PathEntry {
	param([string]$Directory, [string]$Active)

	# Unlike a dotfile there is nowhere to print an `export` line and be done:
	# on Windows a durable PATH means the registry, so ask for it outright.
	Write-Note "not on your PATH"
	if ($Active) { Write-Note "your shell resolves 'pired' to $Active" }

	if ([Console]::IsInputRedirected) {
		Write-Note "add it to this session with:"
		Write-Host "    " -NoNewline
		Write-Host ('$env:PATH = "' + $Directory + ';$env:PATH"')
		Write-Note "or permanently, by adding $Directory to your user PATH."
		return
	}

	$answer = Read-Host "  add $Directory to your user PATH now? [Y/n]"
	if ($answer -and $answer -notmatch "^(y|yes)$") {
		Write-Note "left alone. Add $Directory to your user PATH when you want it."
		return
	}

	try {
		Add-UserPathEntry $Directory
		Write-Note "added. Open a new terminal for it to take effect."
	} catch {
		Write-Note "could not write your user PATH: $_"
		Write-Note "add $Directory to it by hand."
	}
}

# --- the installer -----------------------------------------------------------
function Invoke-PiredInstaller {
	if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
		Write-Host "This installer is for Windows. On macOS and Linux, use:"
		Write-Host "  curl -fsSL https://raw.githubusercontent.com/mamgad/pired/main/install.sh | sh"
		exit 1
	}

	Initialize-Palette
	Assert-Prerequisites

	$script:LogPath = Join-Path ([System.IO.Path]::GetTempPath()) ("pired-install-" + [guid]::NewGuid().ToString("N") + ".log")
	New-Item -ItemType File -Path $script:LogPath -Force | Out-Null

	try {
		Write-Say
		Write-Host "  $($script:Red)$($script:Bold)pired$($script:Off) $($script:Dim)- security assessment harness$($script:Off)"
		Write-Say

		$source = Get-Source
		$prefix = Select-Prefix

		$pi = Resolve-Pi $prefix
		$installedPi = $false
		if ($env:PIRED_SKIP_PI -ne "1" -and -not $pi) {
			Write-Step "installing pi"
			if (-not (Invoke-NpmLogged @("install", "--global", "--ignore-scripts", $PiPackage))) {
				Show-Log
				Stop-Pired "could not install pi"
			}
			$installedPi = $true
			$pi = Resolve-Pi $prefix
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

		# --- register the extension with pi ---
		# Installing the package gives you `pired`; this is what makes a bare
		# `pi` load the security layer too. Non-fatal - the launcher passes -e
		# explicitly, so pired still works completely without it - but never
		# silent: an unregistered extension means a plain `pi` runs with no
		# security layer at all.
		$npmRoot = Get-NpmValue @("root", "--global")
		$piredRoot = if ($npmRoot) { Join-Path $npmRoot "pired" } else { "" }
		if ($piredRoot -and (Test-Directory $piredRoot)) {
			if ($pi) {
				Write-Step "registering the extension with pi"
				if (-not (Invoke-Logged -Command $pi -Arguments @("install", $piredRoot))) {
					Write-Note "skipped - run: pi install $piredRoot"
				} else {
					# Trust, then check: `pi install` can report success and leave pi
					# without the package, and a bare `pi` then starts perfectly well
					# with no security layer in it.
					$listed = & $pi list 2>$null | Out-String
					if ($listed -notmatch "pired") {
						Write-Note "pi did not record it - a plain 'pi' runs without the security layer."
						Write-Note "retry with: pi install $piredRoot"
					}
				}
			} else {
				Write-Note "pi not found: a plain 'pi' will not load the security layer."
				Write-Note "register it with: pi install $piredRoot"
			}
		}

		# --- verify ---
		$piredCmd = Join-Path $prefix "pired.cmd"
		if (-not (Test-Path -LiteralPath $piredCmd -PathType Leaf)) {
			Stop-Pired "npm reported success but $piredCmd is missing."
		}

		# An install that cannot start is indistinguishable from a working one
		# until the first engagement. Find out now, while there is still
		# something to say about it.
		if ($pi) {
			Write-Step "verifying"
			if (-not (Invoke-Logged -Command $piredCmd -Arguments @("--help"))) {
				Show-Log
				Stop-Pired "pired installed but could not start."
			}
		}

		# --- report ---
		Write-Say
		Write-Host "  $($script:Bold)installed$($script:Off) $($script:Dim)$piredCmd$($script:Off)"

		$resolved = Get-Command pired -ErrorAction SilentlyContinue | Select-Object -First 1
		$resolvedDirectory = if ($resolved -and $resolved.Source) { Split-Path -Path $resolved.Source -Parent } else { "" }
		if ((Get-ComparablePath $resolvedDirectory) -ne (Get-ComparablePath $prefix)) {
			Confirm-PathEntry -Directory $prefix -Active $(if ($resolved) { $resolved.Source } else { "" })
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
