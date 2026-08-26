; qingbird-md — Windows NSIS installer
; Registers .md/.markdown file association, desktop + start-menu shortcuts,
; supports overwrite-upgrade while preserving the user-data dir (%APPDATA%).
Unicode true
Name "青鸟Markdown阅读器"
!define VERSION "0.1.0"
!define APP_NAME "青鸟Markdown阅读器"
!define EXE "qingbird-md.exe"

RequestExecutionLevel admin
InstallDir "$PROGRAMFILES\青鸟Markdown阅读器"
InstallDirRegKey HKLM "Software\qingbird-md" "InstallDir"
SetCompressor lzma
OutFile "..\release\qingbird-md-setup-${VERSION}.exe"

Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Function .onInit
  ; Close a running instance so the exe can be overwritten.
  ExecWait 'taskkill /IM qingbird-md.exe /F'
FunctionEnd

Section
  SetOutPath "$INSTDIR"
  File "..\target\release\${EXE}"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Shortcuts
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortCut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${EXE}"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${EXE}"

  ; File association (HKCR)
  WriteRegStr HKLM "Software\Classes\.md" "" "qingbird.md"
  WriteRegStr HKLM "Software\Classes\.markdown" "" "qingbird.md"
  WriteRegStr HKLM "Software\Classes\qingbird.md" "" "Markdown 文档"
  WriteRegStr HKLM "Software\Classes\qingbird.md\DefaultIcon" "" "$INSTDIR\${EXE},0"
  WriteRegStr HKLM "Software\Classes\qingbird.md\shell\open\command" "" '"$INSTDIR\${EXE}" "%1"'

  ; Add/Remove Programs entry
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\qingbird-md" "DisplayName" "${APP_NAME}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\qingbird-md" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\qingbird-md" "Publisher" "木言小布"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\qingbird-md" "UninstallString" '"$INSTDIR\uninstall.exe"'
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"
  DeleteRegKey HKLM "Software\Classes\.md"
  DeleteRegKey HKLM "Software\Classes\.markdown"
  DeleteRegKey HKLM "Software\Classes\qingbird.md"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\qingbird-md"
  Delete "$INSTDIR\${EXE}"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
