# Runs elevated at the end of every CoreChem Screen install (build/installer.nsh -> customInstall), whether the
# install came from the PC's update task (SYSTEM) or from the Hub's setup script (admin). It keeps the PC side of the
# screen current WITHOUT anyone visiting the TV (Evan, 2026-11-12: "I can't afford to go to each screen and run the
# installer each time"): the updater script and its scheduled task come from the release, not from the setup run.
# Only acts on PCs set up as a CoreChem screen (C:\ProgramData\CoreChemScreen\config.json). Never fails the install.
$ErrorActionPreference = 'Continue'
$Root = Join-Path $env:ProgramData 'CoreChemScreen'
$logFile = Join-Path $Root 'update.log'
$rootOk = $false   # update.log is written only once the folder is known to be a real, admin-owned folder
function L($m) {
  $line = "{0} post-install: {1}" -f (Get-Date -Format s), $m
  Write-Output $line                                                  # the installer's own log (nsExec::ExecToLog)
  if ($script:rootOk) { try { Add-Content -LiteralPath $logFile $line } catch { } }
}
# 0. lock the folder down BEFORE trusting anything in it (security reviews 2026-11-12). ProgramData lets any user
#    create files, folders and links, and SYSTEM runs update-screen.ps1 from here. Result: owner Administrators,
#    SYSTEM + Administrators full control, Users read/execute only. Nothing that runs as the signed-in user writes
#    here (pause flag, app log, token live in %LOCALAPPDATA%), so read is enough. Order matters:
#    a. the folder itself must be a real folder owned by SYSTEM / Administrators - a link, or a folder some user
#       made, is refused (setup rebuilds it; this step never takes one over);
#    b. close it FIRST (no new files / links from users from here on);
#    c. remove what can't be legitimate - subfolders, links, hard links, files a user owns (a link would make the
#       ACL changes below land on its TARGET);
#    d. owner + reset on what is left, /L everywhere (act on a link, never its target).
$icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
$Admins = 'S-1-5-18', 'S-1-5-32-544'
function OwnerSid($path) { (Get-Acl -LiteralPath $path).GetOwner([Security.Principal.SecurityIdentifier]).Value }
try {
  $it = Get-Item -LiteralPath $Root -Force -ErrorAction SilentlyContinue
  if (-not $it) { exit 0 }                                               # not a CoreChem screen PC
  if ($it.Attributes -band [IO.FileAttributes]::ReparsePoint) { L 'folder is a LINK - refusing; re-run the screen setup'; exit 0 }
  $o = OwnerSid $Root
  if ($o -notin $Admins) { L "folder is owned by $o, not SYSTEM/Administrators - refusing; re-run the screen setup"; exit 0 }
  if (-not (Test-Path -LiteralPath (Join-Path $Root 'config.json'))) { exit 0 }
  & $icacls $Root /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' /L /C /Q | Out-Null
  $removed = @()
  foreach ($c in @(Get-ChildItem -LiteralPath $Root -Force)) {
    $link = [bool]($c.Attributes -band [IO.FileAttributes]::ReparsePoint)
    $why = if ($link) { 'link' } elseif ($c.PSIsContainer) { 'folder' } elseif ($c.LinkType -eq 'HardLink') { 'hard link' }
           elseif ((OwnerSid $c.FullName) -notin $Admins) { 'user-owned file' } else { '' }
    if (-not $why) { continue }
    if ($link -and $c.PSIsContainer) { [IO.Directory]::Delete($c.FullName) }          # removes the link, never its target
    elseif ($c.PSIsContainer) { & "$env:SystemRoot\System32\cmd.exe" /c rd /s /q "$($c.FullName)" | Out-Null }   # rd never follows links
    else { [IO.File]::Delete($c.FullName) }                                            # a file link / one name of a hard link
    $removed += "$why $($c.Name)"
  }
  & $icacls $Root /setowner '*S-1-5-32-544' /T /L /C /Q | Out-Null
  & $icacls (Join-Path $Root '*') /reset /T /L /C /Q | Out-Null
  $rootOk = $true                                                      # links / user files are gone: update.log is safe now
  foreach ($x in $removed) { L "removed $x (nothing like it belongs here)" }
  Remove-Item -LiteralPath (Join-Path $Root 'CoreChemScreen-Setup.exe') -Force -ErrorAction SilentlyContinue   # setup-era download spot
  $w = (Get-Acl -LiteralPath $Root).Access | Where-Object {
    $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $Admins -and
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
