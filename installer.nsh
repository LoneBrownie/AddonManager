; Custom NSIS installer script to preserve addon data during updates
; This script supports silent updates via autoUpdater.quitAndInstall()

; Backup addon data before installation
!macro preInit
  ; Check if this is an update (app is already installed)
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "UninstallString"
  ${If} $0 != ""
    ; App is already installed, backup addon data
    ${If} ${FileExists} "$APPDATA\brownies-addon-manager\addons.json"
      CreateDirectory "$TEMP\brownies-addon-manager-backup"
      CopyFiles "$APPDATA\brownies-addon-manager\addons.json" "$TEMP\brownies-addon-manager-backup\addons.json"
    ${EndIf}
    ${If} ${FileExists} "$APPDATA\brownies-addon-manager\settings.json"
      CreateDirectory "$TEMP\brownies-addon-manager-backup"
      CopyFiles "$APPDATA\brownies-addon-manager\settings.json" "$TEMP\brownies-addon-manager-backup\settings.json"
    ${EndIf}
  ${EndIf}
!macroend

; Restore addon data after installation
!macro customInstall
  ; Restore backed up data if it exists
  ${If} ${FileExists} "$TEMP\brownies-addon-manager-backup\addons.json"
    CreateDirectory "$APPDATA\brownies-addon-manager"
    CopyFiles "$TEMP\brownies-addon-manager-backup\addons.json" "$APPDATA\brownies-addon-manager\addons.json"
  ${EndIf}
  ${If} ${FileExists} "$TEMP\brownies-addon-manager-backup\settings.json"
    CreateDirectory "$APPDATA\brownies-addon-manager"
    CopyFiles "$TEMP\brownies-addon-manager-backup\settings.json" "$APPDATA\brownies-addon-manager\settings.json"
  ${EndIf}
  
  ; Clean up temporary backup
  ${If} ${FileExists} "$TEMP\brownies-addon-manager-backup"
    RMDir /r "$TEMP\brownies-addon-manager-backup"
  ${EndIf}
!macroend

; Don't remove user data on uninstall unless explicitly requested
!macro customUnInstall
  ; Only remove user data if it's a complete uninstall (not an update)
  ; The installer will handle this automatically with deleteAppDataOnUninstall: false
!macroend
