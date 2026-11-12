# CoreChem screen updater - run by the task "CoreChem Screen update" as SYSTEM every 15 minutes.
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$logFile = Join-Path $Root 'update.log'
function L($m) { Add-Content $logFile ("{0} {1}" -f (Get-Date -Format s), $m) }
$flag = Join-Path $Root 'updating'
try {
  $cfg = Get-Content (Join-Path $Root 'config.json') -Raw | ConvertFrom-Json
  if (-not $cfg.app) { exit 0 }
  $exe = Join-Path $env:ProgramFiles 'CoreChem Screen\CoreChem Screen.exe'
  $have = $null
  try { $have = [version](Get-Item $exe -ErrorAction Stop).VersionInfo.ProductVersion.Split('-')[0] } catch { }
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $y = (Invoke-WebRequest 'https://github.com/corecheminc/corechem-screen/releases/latest/download/latest.yml' -UseBasicParsing -TimeoutSec 30).Content
  if ($y -notmatch '(?m)^version:\s*([0-9][0-9.]*)') { exit 0 }
  $want = [version]$Matches[1]
  if ($have -and $want -le $have) { exit 0 }
  $busy = Get-ChildItem 'C:\Users\*\AppData\Local\CoreChemScreen\busy' -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-10) }
  if ($busy) { L "update $want is waiting: a share or meeting is live"; exit 0 }
  L "updating $have -> $want"
  Set-Content $flag (Get-Date -Format s)
  $inst = Join-Path $Root 'CoreChemScreen-Setup.exe'
  Invoke-WebRequest 'https://github.com/corecheminc/corechem-screen/releases/latest/download/CoreChemScreen-Setup.exe' -OutFile $inst -UseBasicParsing
  Get-CimInstance Win32_Process -Filter "Name='CoreChem Screen.exe'" -ErrorAction SilentlyContinue |
    ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate -ErrorAction SilentlyContinue | Out-Null }
  $p = Start-Process $inst -ArgumentList '/S' -Wait -PassThru
  $now = try { (Get-Item $exe).VersionInfo.ProductVersion } catch { '?' }
  L "installer exit $($p.ExitCode); installed version now $now"
  Remove-Item $inst -Force -ErrorAction SilentlyContinue
} catch { L "error: $($_.Exception.Message)" }
finally { Remove-Item $flag -Force -ErrorAction SilentlyContinue }
