# The folder, locked down (security reviews 2026-11-12): ProgramData lets any user create files, folders and links,
# and the SYSTEM update task runs a script from here. Owner Administrators; SYSTEM + Administrators full control;
# Users read/execute only (nothing that runs as the signed-in user writes here - its flags and logs are in
# %LOCALAPPDATA%). A folder that is a LINK or was not made by an administrator is rebuilt (the link removed, never its
# target). An existing folder is closed FIRST, then everything that can't be legitimate goes (subfolders, links, hard
# links, user-owned files) so the owner / reset below can't land on a link's target; /L everywhere. App 0.1.8+
# installs re-check this (screen-host/post-install.ps1 in corechem-screen).
$icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
$cmdExe = Join-Path $env:SystemRoot 'System32\cmd.exe'
$AdminSids = 'S-1-5-18', 'S-1-5-32-544'
function Get-OwnerSid($p) { (Get-Acl -LiteralPath $p).GetOwner([Security.Principal.SecurityIdentifier]).Value }
$it = Get-Item -LiteralPath $Root -Force -ErrorAction SilentlyContinue
if ($it -and (($it.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ((Get-OwnerSid $Root) -notin $AdminSids))) {
  Say "  ! $Root was a link or not made by an administrator - rebuilding it." 'Yellow'
  if ($it.Attributes -band [IO.FileAttributes]::ReparsePoint) { [IO.Directory]::Delete($Root) }
  else { & $cmdExe /c rd /s /q "$Root" | Out-Null }                                      # rd never follows links
  if (Test-Path -LiteralPath $Root) { throw "could not remove $Root - remove it by hand and run this again" }
  $it = $null
}
if (-not $it) {
  $ds = New-Object Security.AccessControl.DirectorySecurity
  $ds.SetAccessRuleProtection($true, $false)
  foreach ($r in @(@('S-1-5-18', 'FullControl'), @('S-1-5-32-544', 'FullControl'), @('S-1-5-32-545', 'ReadAndExecute'))) {
    $ds.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
      (New-Object Security.Principal.SecurityIdentifier $r[0]), $r[1], 'ContainerInherit, ObjectInherit', 'None', 'Allow')))
  }
  [IO.Directory]::CreateDirectory($Root, $ds) | Out-Null                                 # locked from the first moment
  & $icacls $Root /setowner '*S-1-5-32-544' /L /C /Q | Out-Null                           # (already so for an elevated admin)
} else {
  & $icacls $Root /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' /L /C /Q | Out-Null
  foreach ($c in @(Get-ChildItem -LiteralPath $Root -Force)) {
    $link = [bool]($c.Attributes -band [IO.FileAttributes]::ReparsePoint)
    $why = if ($link) { 'link' } elseif ($c.PSIsContainer) { 'folder' } elseif ($c.LinkType -eq 'HardLink') { 'hard link' }
           elseif ((Get-OwnerSid $c.FullName) -notin $AdminSids) { 'user-owned file' } else { '' }
    if (-not $why) { continue }
    if ($link -and $c.PSIsContainer) { [IO.Directory]::Delete($c.FullName) }
    elseif ($c.PSIsContainer) { & $cmdExe /c rd /s /q "$($c.FullName)" | Out-Null }
    else { [IO.File]::Delete($c.FullName) }
    Say "  ! removed $why $($c.Name) from $Root (nothing like it belongs there)" 'Yellow'
  }
  & $icacls $Root /setowner '*S-1-5-32-544' /T /L /C /Q | Out-Null
  & $icacls (Join-Path $Root '*') /reset /T /L /C /Q | Out-Null
}
