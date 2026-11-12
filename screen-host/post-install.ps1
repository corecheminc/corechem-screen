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

# 0. lock the folder down BEFORE trusting anything in it (security review 2026-11-12): ProgramData lets any user
#    create files and folders, and SYSTEM runs update-screen.ps1 from here. Owner Administrators, SYSTEM +
#    Administrators full control, Users read/execute only, every child reset to inherit that. Nothing that runs as
#    the signed-in user writes here (pause flag, app log, token live in %LOCALAPPDATA%), so read is enough.
$icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
try {
  $owner = (Get-Acl $Root).GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($owner -notin 'S-1-5-18', 'S-1-5-32-544') { L "folder was owned by $owner - taking it over" }
  & $icacls $Root /setowner '*S-1-5-32-544' /T /C /Q | Out-Null
  & $icacls $Root /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' /C /Q | Out-Null
  & $icacls (Join-Path $Root '*') /reset /T /C /Q | Out-Null
  Remove-Item (Join-Path $Root 'CoreChemScreen-Setup.exe') -Force -ErrorAction SilentlyContinue   # setup-era download spot
  $w = (Get-Acl $Root).Access | Where-Object {
    $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin 'S-1-5-18', 'S-1-5-32-544' -and
    ($_.FileSystemRights -band ([Security.AccessControl.FileSystemRights]'Write, Delete, ChangePermissions, TakeOwnership'))
  }
  if ($w) { L 'folder still writable by others after lock-down - not touching the updater or its task'; exit 0 }
  L 'folder locked down (SYSTEM + Administrators write, Users read)'
} catch { L "folder lock-down failed: $($_.Exception.Message) - not touching the updater or its task"; exit 0 }

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
