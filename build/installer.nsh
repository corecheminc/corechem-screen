; CoreChem Screen installer hooks (electron-builder "nsis.include").
; After the files are in place, refresh the PC side of the screen (updater script + its task) from this release:
; screen-host\post-install.ps1. The install is per-machine, so this runs elevated (SYSTEM from the update task, or
; admin from the setup script). 64-bit PowerShell via Sysnative (the installer itself is 32-bit), else the default.
!macro customInstall
  StrCpy $0 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  IfFileExists $0 +2 0
    StrCpy $0 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"   ; full path: a bare name could resolve to a planted exe
  IfFileExists "$INSTDIR\resources\screen-host\post-install.ps1" 0 +2
    nsExec::ExecToLog '"$0" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\screen-host\post-install.ps1"'
!macroend
