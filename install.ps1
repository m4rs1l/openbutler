[CmdletBinding()]
param(
  [string]$Version = '',
  [string]$Binary = '',
  [switch]$NoModifyPath,
  [switch]$Daemon,
  [switch]$Client,
  [switch]$Web,
  [string]$InstallDir = (Join-Path $HOME '.openbutler'),
  [string]$Repo = $env:OPENBUTLER_GITHUB_REPO
)

$ErrorActionPreference = 'Stop'
$App = 'openbutler'
if ([string]::IsNullOrWhiteSpace($Repo)) { $Repo = 'zxsmind/openbutler' }
if ($Daemon -and $Client) { throw 'Error: -Daemon and -Client cannot be combined.' }
if (-not $Daemon -and -not $Client) {
  if ($Web) { throw 'Error: -Web needs -Daemon or -Client.' }
  throw 'Error: choose what to install: pass -Daemon (background host) or -Client (client-only machine), each with -Web to also install the browser UI overlay.'
}
if ($Web -and -not [string]::IsNullOrWhiteSpace($Binary)) { throw 'Error: -Binary cannot be combined with -Web.' }
$Flavor = if ($Daemon) { 'daemon' } else { 'client' }
$Config = if ($Web) { "$Flavor+web" } else { $Flavor }
$BinDir = Join-Path $InstallDir 'bin'
$Launcher = Join-Path $BinDir "$App.cmd"
$FlavorFile = Join-Path $InstallDir '.openbutler-flavor'

# One cumulative bar across download, extract, and install, drawn by hand so it
# matches the shell installer and does not depend on the host's own progress UI.
$script:BarActive = -not [Console]::IsOutputRedirected
$script:Orange = ''
$script:Reset = ''
if ($script:BarActive) {
  $esc = [char]27
  # Windows Terminal and MSYS/Git Bash already interpret ANSI; a legacy console needs it enabled.
  $vt = ($env:OS -ne 'Windows_NT') -or [bool]$env:WT_SESSION -or [bool]$env:TERM
  if (-not $vt) {
    try {
      if (-not ('OpenButler.ConsoleVt' -as [type])) {
        Add-Type -Namespace OpenButler -Name ConsoleVt -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr GetStdHandle(int nStdHandle);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetConsoleMode(IntPtr hConsoleHandle, out uint lpMode);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleMode(IntPtr hConsoleHandle, uint dwMode);
'@ -ErrorAction Stop
      }
      $handle = [OpenButler.ConsoleVt]::GetStdHandle(-11)
      [uint32]$mode = 0
      if ([OpenButler.ConsoleVt]::GetConsoleMode($handle, [ref]$mode)) {
        [void][OpenButler.ConsoleVt]::SetConsoleMode($handle, $mode -bor 4)
        $vt = $true
      }
    } catch { $vt = $false }
  }
  if ($vt -and [string]::IsNullOrEmpty($env:NO_COLOR)) {
    $script:Orange = "${esc}[38;5;214m"
    $script:Reset = "${esc}[0m"
  }
}

function Show-Bar {
  param([long]$Done, [long]$Total, [string]$Label)
  if (-not $script:BarActive) { return }
  $width = 50
  if ($Total -le 0) {
    $bar = [string]::new('-', $width)
    $line = '[' + $bar + '] ' + $Label.PadRight(11)
  } else {
    $percent = [Math]::Min(100, [int]($Done * 100 / $Total))
    $filled = [int]($percent * $width / 100)
    $bar = [string]::new('=', $filled) + [string]::new('-', $width - $filled)
    $line = '[' + $bar + '] ' + ('{0,3}' -f $percent) + '% ' + $Label.PadRight(11)
  }
  Write-Host ("`r" + $script:Orange + $line + $script:Reset) -NoNewline
}

function Get-RemoteMeta {
  param([string]$Url)
  try {
    $text = (Invoke-WebRequest -Uri "$Url.meta" -UseBasicParsing -ErrorAction Stop).Content
    $data = ConvertFrom-StringData (($text -join "`n") -replace "`r", '')
    $archiveBytes = [long]0
    $payloadBytes = [long]0
    if ("$($data['archive_bytes'])" -match '^\d+$') { $archiveBytes = [long]$data['archive_bytes'] }
    if ("$($data['payload_bytes'])" -match '^\d+$') { $payloadBytes = [long]$data['payload_bytes'] }
    if ($archiveBytes -le 0 -or $payloadBytes -le 0) { return $null }
    return @{ D = $archiveBytes; U = $payloadBytes }
  } catch { return $null }
}

function Extract-WithProgress {
  param([string]$Archive, [string]$Destination, [long]$Total, [long]$Base)
  # The web overlay ships as tar.gz on every platform; the base zip still
  # takes the ZipFile path below.
  if ($Archive -like "*.tar.gz") {
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    tar -xzf $Archive -C $Destination
    return
  }
  Add-Type -AssemblyName System.IO.Compression | Out-Null
  Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
  $zip = $null
  try {
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
  } catch {
    Expand-Archive -LiteralPath $Archive -DestinationPath $Destination -Force
    return
  }
  try {
    $entries = @($zip.Entries | Where-Object { $_.Name -ne '' })
    $sum = [long]($entries | Measure-Object -Property Length -Sum).Sum
    if ($sum -le 0) {
      $zip.Dispose()
      $zip = $null
      Expand-Archive -LiteralPath $Archive -DestinationPath $Destination -Force
      return
    }
    $denominator = $Total
    $offset = $Base
    if ($denominator -le 0) { $denominator = $sum; $offset = [long]0 }
    $done = [long]0
    $lastPercent = -1
    foreach ($entry in $entries) {
      $dest = Join-Path $Destination $entry.FullName
      $destDir = Split-Path -Parent $dest
      if (-not (Test-Path -LiteralPath $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $dest, $true)
      $done += $entry.Length
      $percent = [Math]::Min(100, [int](($offset + $done) * 100 / $denominator))
      if ($percent -ne $lastPercent) {
        Show-Bar ($offset + $done) $denominator 'Extracting'
        $lastPercent = $percent
      }
    }
    Show-Bar ($offset + $done) $denominator 'Extracting'
  } finally {
    if ($zip -ne $null) { $zip.Dispose() }
  }
}

function Installed-Version {
  if (-not (Test-Path -LiteralPath $Launcher)) { return '' }
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & $Launcher --version 2>$null
    if ($output -is [array]) { $output = $output -join "`n" }
    return ([string]$output).Trim()
  } catch { return '' } finally { $ErrorActionPreference = $previous }
}

$LeaveAlone = 'Leaving the running host alone: it was started by another installation.'

# The daemon endpoint is keyed by the data directory, so `daemon status` from
# ANY install on this machine resolves the same process: an install into
# another directory used to stop the running host and then restart only its own
# tree, replacing files under a different install (2026-11-15 incident). The
# JSON verdict answers whether that host runs from THIS install directory;
# only then may this script stop it. An answer outside the JSON contract is a
# CLI older than --json and keeps the textual probe, which may stop only the
# historical default directory.
function Test-RunningHost {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if (-not (Test-Path -LiteralPath $Launcher)) { return $false }
    $raw = (& $Launcher daemon status --json 2>$null | Out-String)
    $report = $null
    if (-not [string]::IsNullOrWhiteSpace($raw)) {
      try { $report = $raw | ConvertFrom-Json } catch { $report = $null }
    }
    if ($null -ne $report -and $report.PSObject.Properties.Name -contains 'running') {
      if (-not $report.running) { return $false }
      if (-not $report.ours) {
        Write-Host $LeaveAlone
        return $false
      }
      return $true
    }
    $legacy = (& $Launcher daemon status 2>$null | Out-String)
    if ($legacy -notmatch 'Background host running') { return $false }
    if ($InstallDir -ne (Join-Path $HOME '.openbutler')) {
      Write-Host $LeaveAlone
      return $false
    }
    return $true
  } catch { return $false } finally { $ErrorActionPreference = $previous }
}

# The running host holds node.exe open, so it must stop before the files under
# the install directory are replaced; restarting only after the copy is too late.
function Stop-RunningHost {
  if (-not (Test-RunningHost)) { return $false }
  Write-Host 'Stopping the background host so its files can be replaced.'
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Launcher daemon stop 2>$null | Out-Null } catch {} finally { $ErrorActionPreference = $previous }
  return $true
}

function Start-RunningHost {
  Write-Host 'Starting the background host on the new version.'
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Launcher daemon start 2>$null | Out-Null } catch {} finally { $ErrorActionPreference = $previous }
}

# A just-exited host, antivirus, or a slow handle release can briefly keep a
# file locked; retry the copy instead of failing the whole install.
function Copy-WithRetry {
  param([scriptblock]$Action)
  $attempt = 0
  while ($true) {
    try { & $Action; return } catch {
      $attempt++
      if ($attempt -ge 12) { throw }
      Start-Sleep -Milliseconds 500
    }
  }
}

function Download-WithProgress {
  param([string]$Url, [string]$OutFile, [long]$Total, [long]$Base)
  if ($Total -le 0) {
    try {
      $head = Invoke-WebRequest -Method Head -Uri $Url -UseBasicParsing -ErrorAction Stop
      $lengthHeader = @($head.Headers['Content-Length'])[0]
      if ("$lengthHeader" -match '^\d+$') { $Total = [long]$lengthHeader }
    } catch { $Total = [long]0 }
  }
  if ($Total -le 0) {
    Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
    return
  }
  Add-Type -AssemblyName System.Net.Http | Out-Null
  $handler = New-Object Net.Http.HttpClientHandler
  $client = New-Object Net.Http.HttpClient($handler)
  try {
    $response = $client.GetAsync($Url, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    if (-not $response.IsSuccessStatusCode) { throw "Download failed (HTTP $([int]$response.StatusCode)): $Url" }
    $contentLength = $response.Content.Headers.ContentLength
    if ($Total -le 0 -and $contentLength -gt 0) { $Total = [long]$contentLength }
    $source = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    try {
      $target = [IO.File]::OpenWrite($OutFile)
      try {
        $buffer = New-Object byte[] 81920
        $read = [long]0
        $lastPercent = -1
        while (($count = $source.Read($buffer, 0, $buffer.Length)) -gt 0) {
          $target.Write($buffer, 0, $count)
          $read += $count
          $percent = [Math]::Min(100, [int](($Base + $read) * 100 / $Total))
          if ($percent -ne $lastPercent) {
            Show-Bar ($Base + $read) $Total 'Downloading'
            $lastPercent = $percent
          }
        }
        Show-Bar ($Base + $read) $Total 'Downloading'
      } finally { $target.Close() }
    } finally { $source.Close() }
  } finally {
    $client.Dispose()
    $handler.Dispose()
  }
}

if ([string]::IsNullOrWhiteSpace($Binary)) {
  $arch = switch ($env:PROCESSOR_ARCHITECTURE) {
    'AMD64' { 'x64' }
    'ARM64' { 'arm64' }
    default { throw "Unsupported CPU: $($env:PROCESSOR_ARCHITECTURE)" }
  }
  $target = "windows-$arch"
  if ([string]::IsNullOrWhiteSpace($Version)) {
    $latest = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest"
    $specific = ([string]$latest.tag_name).TrimStart('v')
    if ([string]::IsNullOrWhiteSpace($specific)) { throw 'Could not determine the latest release version.' }
  } else {
    $specific = $Version.TrimStart('v')
    try {
      Invoke-WebRequest -Uri "https://github.com/$Repo/releases/tag/v$specific" -Method Head -UseBasicParsing | Out-Null
    } catch {
      throw "Release v$specific not found. Available releases: https://github.com/$Repo/releases"
    }
  }
  $fileName = "$App-daemon-$specific-$target.zip"
  $webFileName = "$App-web-$specific.tar.gz"
  if ([string]::IsNullOrWhiteSpace($Version)) {
    $url = "https://github.com/$Repo/releases/latest/download/$fileName"
    $webUrl = "https://github.com/$Repo/releases/latest/download/$webFileName"
  } else {
    $url = "https://github.com/$Repo/releases/download/v$specific/$fileName"
    $webUrl = "https://github.com/$Repo/releases/download/v$specific/$webFileName"
    if ($Web) {
      try { Invoke-WebRequest -Uri $webUrl -Method Head -UseBasicParsing | Out-Null }
      catch { throw "Release v$specific does not carry $webFileName. Available releases: https://github.com/$Repo/releases" }
    }
  }
} else {
  if (-not (Test-Path -LiteralPath $Binary)) { throw "Binary archive not found at $Binary" }
  $specific = 'local'
}

$current = Installed-Version
$installedConfig = if (Test-Path -LiteralPath $FlavorFile) { ((Get-Content -LiteralPath $FlavorFile -Raw -ErrorAction SilentlyContinue) -replace '\s', '') } else { '' }
if ($current -ne '' -and $current -eq $specific -and $installedConfig -eq $Config) {
  Write-Host "openbutler $current is already installed at $InstallDir."
  return
}
# An installed base at the same version with only the overlay missing fetches
# the overlay alone; the exact match above already covered the full repeat.
$skipBase = $Web -and $current -ne '' -and $current -eq $specific -and $installedConfig -eq $Flavor

$isUpdate = $false
if ([string]::IsNullOrWhiteSpace($Binary) -and $current -ne '' -and $current -ne $specific) {
  $isUpdate = $true
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("openbutler_install_" + [IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $tmp | Out-Null
$hostWasRunning = $false
$hostRestored = $false
try {
  if ($script:BarActive) { try { [Console]::CursorVisible = $false } catch {} }
  if ([string]::IsNullOrWhiteSpace($Binary)) {
    if ($isUpdate) { Write-Host "Updating openbutler $current -> $specific ($target)" }
    else { Write-Host "Downloading openbutler $specific ($target)" }
    $jobs = @()
    if (-not $skipBase) { $jobs += @{ File = $fileName; Url = $url } }
    else { Write-Host 'Base already installed at this version; fetching only the web overlay.' }
    if ($Web) { $jobs += @{ File = $webFileName; Url = $webUrl } }
    # One bar spans every archive: measure all metas first, then download all
    # and extract all into one tree for the single merge copy below. A missing
    # meta drops every job to the plain, unmeasured path - the archives must
    # not mix measured and blind progress.
    $measured = $true
    foreach ($job in $jobs) {
      $job.Meta = Get-RemoteMeta $job.Url
      if ($job.Meta -eq $null) { $measured = $false }
    }
    $BarTotal = [long]0
    if ($measured) { foreach ($job in $jobs) { $BarTotal += $job.Meta.D + $job.Meta.U + $job.Meta.U } }
    $downloadDone = [long]0
    foreach ($job in $jobs) {
      $out = Join-Path $tmp $job.File
      if ($measured) {
        Download-WithProgress -Url $job.Url -OutFile $out -Total $BarTotal -Base $downloadDone
        $downloadDone += $job.Meta.D
      } else {
        Download-WithProgress -Url $job.Url -OutFile $out -Total 0 -Base 0
      }
      $job.Archive = $out
    }
    $extract = Join-Path $tmp 'extract'
    New-Item -ItemType Directory -Path $extract | Out-Null
    $extractDone = [long]0
    foreach ($job in $jobs) {
      if ($measured) {
        Extract-WithProgress -Archive $job.Archive -Destination $extract -Total $BarTotal -Base ($downloadDone + $extractDone)
        $extractDone += $job.Meta.U
      } else {
        Extract-WithProgress -Archive $job.Archive -Destination $extract -Total 0 -Base 0
      }
    }
    # The copy block below keeps walking the same bar from the end of extracts.
    $baseD = $downloadDone + $extractDone
  } else {
    Write-Host "Installing openbutler from $Binary"
    $archive = Join-Path $tmp ([IO.Path]::GetFileName($Binary))
    Copy-Item -LiteralPath $Binary -Destination $archive
    $BarTotal = [long]0
    $extract = Join-Path $tmp 'extract'
    New-Item -ItemType Directory -Path $extract | Out-Null
    Extract-WithProgress -Archive $archive -Destination $extract -Total 0 -Base 0
  }
  if (-not (Test-Path -LiteralPath (Join-Path $extract $App))) { throw "Archive does not contain a '$App' directory." }
  $hostWasRunning = Stop-RunningHost
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  if ($BarTotal -gt 0) {
    $treeRoot = Join-Path $extract $App
    $baseDU = $baseD + [long](Get-ChildItem -LiteralPath $treeRoot -Recurse -File | Measure-Object -Property Length -Sum).Sum
    $copied = [long]0
    foreach ($child in Get-ChildItem -LiteralPath $treeRoot) {
      $item = Get-Item -LiteralPath $child.FullName
      if ($item -is [IO.DirectoryInfo]) {
        $childSize = [long](Get-ChildItem -LiteralPath $item.FullName -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
      } else {
        $childSize = [long]$item.Length
      }
      Copy-WithRetry { Copy-Item -LiteralPath $item.FullName -Destination $InstallDir -Recurse -Force }
      $copied += $childSize
      Show-Bar ($baseDU + $copied) $BarTotal 'Installing'
    }
  } else {
    Copy-WithRetry { Copy-Item -Path (Join-Path $extract "$App/*") -Destination $InstallDir -Recurse -Force }
  }
  if ($BarTotal -gt 0) { Show-Bar $BarTotal $BarTotal 'Done' }
  if ($script:BarActive) { Write-Host '' }
  New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
  $launcherBody = "@echo off`r`nrem Generated by the openbutler installer. Uses the bundled Node.js runtime.`r`n`"$InstallDir\node\bin\node.exe`" `"$InstallDir\app\dist\cli.js`" %*`r`n"
  [IO.File]::WriteAllText($Launcher, $launcherBody, [Text.Encoding]::ASCII)
} catch {
  if ($hostWasRunning -and -not $hostRestored) {
    Write-Host 'The install failed after the host was stopped; starting it again.'
    try { Start-RunningHost } catch {}
    $hostRestored = $true
  }
  throw
} finally {
  if ($script:BarActive) { try { [Console]::CursorVisible = $true } catch {} }
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

if ($hostWasRunning) { Start-RunningHost; $hostRestored = $true }

$installed = Installed-Version
if ([string]::IsNullOrWhiteSpace($installed)) { throw 'Installation finished but `openbutler --version` does not run.' }
[IO.File]::WriteAllText($FlavorFile, $Config)
if ($isUpdate) { Write-Host "Updated openbutler $current -> $installed." }
else { Write-Host "Installed openbutler $installed to $InstallDir." }
if ($Config -eq 'daemon') {
  Write-Host "Next: choose a model with openbutler setup then start the host with openbutler daemon start (add --listen <addr:port> for remote clients) and pair them with openbutler pair"
} elseif ($Config -eq 'daemon+web') {
  Write-Host "Next: choose a model with openbutler setup then start host and UI together with openbutler daemon start --web (add --listen <addr:port> for CLI clients and --hostname <address> for phones and browsers)"
  Write-Host 'Pair a CLI or desktop against this host with openbutler pair'
} elseif ($Config -eq 'client') {
  Write-Host 'Next: pair a backend with openbutler connect <host:port> --code <code>'
} else {
  Write-Host 'Next: pair a backend with openbutler connect <host:port> --code <code> then open the UI with openbutler web --backend <name>'
}

if ($NoModifyPath) {
  Write-Host "Skipped PATH setup. Add $BinDir to PATH manually."
  return
}

$existing = [Environment]::GetEnvironmentVariable('Path', 'User')
$parts = @($existing -split ';' | Where-Object { $_ -and $_ -ne $BinDir })
[Environment]::SetEnvironmentVariable('Path', (@($BinDir) + $parts) -join ';', 'User')
Write-Host "Added $BinDir to the user PATH. Restart your terminal, then try: openbutler --version"
