# Runs elevated at the end of every CoreChem Screen install (build/installer.nsh -> customInstall), whether the
# install came from the PC's update task (SYSTEM) or from the Hub's setup script (admin). It keeps the PC side of the
# screen current WITHOUT anyone visiting the TV (Evan, 2026-11-12: "I can't afford to go to each screen and run the
# installer each time"): the updater script and its scheduled task come from the release, not from the setup run.
# Only acts on PCs set up as a CoreChem screen (C:\ProgramData\CoreChemScreen\config.json). Never fails the install.
$ErrorActionPreference = 'Continue'
$Root = Join-Path $env:ProgramData 'CoreChemScreen'
$logFile = Join-Path $Root 'update.log'
function L($m) { try { Add-Content $logFile ("{0} post-install: {1}" -f (Get-Date -Format s), $m) } catch { } }
if (-not (Test-Path (Join-Path $Root 'config.json'))) { exit 0 }

# 1. the updater script from this release
$updater = Join-Path $Root 'update-screen.ps1'
try {
  Copy-Item (Join-Path $PSScriptRoot 'update-screen.ps1') $updater -Force -ErrorAction Stop
  L 'updater script refreshed from this release'
} catch { L "updater script NOT refreshed: $($_.Exception.Message)" }

# 2. its task: create it when missing (a PC set up before the task existed), fix the time limit otherwise.
#    A task that is running right now is this install's own caller - leave its definition for the next install.
$TaskName = 'CoreChem Screen update'
try {
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $t) {
    $a = New-ScheduledTaskAction -Execute 'powershell.exe' `
      -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$updater`""
    $tr = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(3) -RepetitionInterval (New-TimeSpan -Minutes 15)
    $p = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
      -ExecutionTimeLimit (New-TimeSpan -Minutes 60) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $TaskName -Action $a -Trigger $tr -Principal $p -Settings $s -Force | Out-Null
    L "task '$TaskName' was missing - created (every 15 min)"
  } elseif ($t.State -ne 'Running' -and $t.Settings.ExecutionTimeLimit -ne 'PT1H') {
    $t.Settings.ExecutionTimeLimit = 'PT1H'
    Set-ScheduledTask -InputObject $t | Out-Null
    L "task '$TaskName' time limit set to 60 min"
  }
} catch { L "task check failed: $($_.Exception.Message)" }
exit 0
