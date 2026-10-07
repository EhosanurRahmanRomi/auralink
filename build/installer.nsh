; Attended current-user setup only. No elevation or automatic application launch.
; In assisted and silent modes, install in the current user's chosen directory.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customInit
  StrCpy $hasPerMachineInstallation "0"
  StrCpy $hasPerUserInstallation "1"
  !insertmacro setInstallModePerUser
!macroend
