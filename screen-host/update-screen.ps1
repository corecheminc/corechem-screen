# CoreChem screen updater - run by the task "CoreChem Screen update" as SYSTEM every 15 minutes.
# CANONICAL COPY: this file ships inside every CoreChem Screen release (resources\screen-host) and each install copies
# it to C:\ProgramData\CoreChemScreen\update-screen.ps1 (post-install.ps1), so fixing the updater = releasing the app;
# nobody has to visit a TV. The Hub's setup script writes a first copy when a PC is set up.
# Log: update.log next to this file; the app forwards new lines to the Hub (Screens -> Control -> Log, "updater:").
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$logFile = Join-Path $Root 'update.log'
function L($m) { try { Add-Content $logFile ("{0} {1}" -f (Get-Date -Format s), $m) } catch { } }
$flag = Join-Path $Root 'updating'
$ProgressPreference = 'SilentlyContinue'   # Windows PowerShell 5.1's progress bar makes downloads 10x+ slower
$Latest = 'https://github.com/corecheminc/corechem-screen/releases/latest/download/'
try {
  # keep update.log small (it is read by the app and shipped to the Hub)
  try { if ((Get-Item $logFile -ErrorAction Stop).Length -gt 512KB) { Move-Item $logFile "$logFile.1" -Force } } catch { }
  $cfg = Get-Content (Join-Path $Root 'config.json') -Raw | ConvertFrom-Json
  if (-not $cfg.app) { exit 0 }
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $r = Invoke-WebRequest ($Latest + 'latest.yml') -UseBasicParsing -TimeoutSec 30
  # GitHub serves release assets as application/octet-stream, and Windows PowerShell 5.1 then returns .Content as
  # BYTES - the setup-era updater matched "version:" against bytes, never matched, and exited silently every 15 min
  # on every TV (found 2026-11-12: no TV had ever updated itself). Always decode.
  $y = $r.Content
  if ($y -is [byte[]]) { $y = [Text.Encoding]::UTF8.GetString($y) }

  # The PC clock. The Downstairs Conference Room PC ran 15 h fast (2026-11-11), so its 03:30 nightly restart came
  # at lunchtime. GitHub's Date header is a good enough clock: correct anything more than 2 minutes off.
  try {
    $now = [DateTime]::Parse($r.Headers['Date']).ToUniversalTime()
    $off = ((Get-Date).ToUniversalTime() - $now).TotalSeconds
    if ([Math]::Abs($off) -gt 120) {
      Set-Date -Date $now.ToLocalTime() | Out-Null
      L ("clock was {0:N0} s off - set from GitHub's time" -f $off)
    }
  } catch { L "clock check failed: $($_.Exception.Message)" }

  if ($y -notmatch '(?m)^version:\s*([0-9][0-9.]*)') { exit 0 }
  $want = [version]$Matches[1]
  $exe = Join-Path $env:ProgramFiles 'CoreChem Screen\CoreChem Screen.exe'
  $have = $null
  try { $have = [version](Get-Item $exe -ErrorAction Stop).VersionInfo.ProductVersion.Split('-')[0] } catch { }
  if ($have -and $want -le $have) { exit 0 }
  $busy = Get-ChildItem 'C:\Users\*\AppData\Local\CoreChemScreen\busy' -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-10) }
  if ($busy) { L "update $want is waiting: a share or meeting is live"; exit 0 }
  # size of CoreChemScreen-Setup.exe as latest.yml lists it (0 = unknown: no check)
  $size = if ($y -match '(?s)url:\s*CoreChemScreen-Setup\.exe\s+(?:sha512:\s*\S+\s+)?size:\s*(\d+)') { [int64]$Matches[1] } else { 0 }
  L "updating $have -> $want"
  Set-Content $flag (Get-Date -Format s)
  $inst = Join-Path $Root 'CoreChemScreen-Setup.exe'
  Remove-Item $inst -Force -ErrorAction SilentlyContinue
  $t0 = Get-Date
  (New-Object Net.WebClient).DownloadFile($Latest + 'CoreChemScreen-Setup.exe', $inst)
  $got = (Get-Item $inst).Length
  L ("downloaded {0:N1} MB in {1:N0} s" -f ($got / 1MB), ((Get-Date) - $t0).TotalSeconds)
  if ($size -and $got -ne $size) { throw "download is $got bytes, latest.yml says $size - not installing" }
  Get-CimInstance Win32_Process -Filter "Name='CoreChem Screen.exe'" -ErrorAction SilentlyContinue |
    ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate -ErrorAction SilentlyContinue | Out-Null }
  $p = Start-Process $inst -ArgumentList '/S' -Wait -PassThru
  $now = try { (Get-Item $exe).VersionInfo.ProductVersion } catch { '?' }
  L "installer exit $($p.ExitCode); installed version now $now"
  Remove-Item $inst -Force -ErrorAction SilentlyContinue
} catch { L "error: $($_.Exception.Message)" }
finally { Remove-Item $flag -Force -ErrorAction SilentlyContinue }
