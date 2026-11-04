; N7M per-user portable launcher: only executable code is cached here.
; Encrypted account data stays in the application's established userData folder.
!include "common.nsh"
!include "extractAppPackage.nsh"
!include "WinMessages.nsh"
!include "FileFunc.nsh"

; Do not scan the entire embedded EXE before startup feedback. First extraction
; uses NSIS's decompressor; completed cache generations are never overwritten.
CRCCheck off
WindowIcon on
AutoCloseWindow true
RequestExecutionLevel user
Caption "${PRODUCT_NAME} 正在启动…"
SubCaption 3 " "
SubCaption 4 " "
DetailsButtonText "启动详情"
CompletedText "启动完成"
InstProgressFlags smooth
Page instfiles

Var N7MCacheRoot
Var N7MResolvedLocalAppData
Var N7MBuildHash
Var N7MBuildBase
Var N7MCacheDirectory
Var N7MActivePointer
Var N7MMarker
Var N7MMutex
Var N7MOwnsMutex
Var N7MStartingFile
Var N7MStartingHwnd
Var N7MStartingPid
Var N7MStartingActualPid
Var N7MStartingWindowValid
Var N7MStartingAttempts
Var N7MCacheReady
Var N7MChildHandle
Var N7MChildResult
Var N7MParameters
Var N7MGenerationName
Var N7MGenerationCounter
Var N7MPid
Var N7MTick

!macro N7MCheckRequiredRuntime FAILURE_LABEL
  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 ${FAILURE_LABEL}
  IfFileExists "$INSTDIR\resources\app.asar" 0 ${FAILURE_LABEL}
  IfFileExists "$INSTDIR\icudtl.dat" 0 ${FAILURE_LABEL}
  IfFileExists "$INSTDIR\resources.pak" 0 ${FAILURE_LABEL}
  IfFileExists "$INSTDIR\snapshot_blob.bin" 0 ${FAILURE_LABEL}
  IfFileExists "$INSTDIR\v8_context_snapshot.bin" 0 ${FAILURE_LABEL}
  IfFileExists "$INSTDIR\ffmpeg.dll" 0 ${FAILURE_LABEL}
  IfFileExists "$INSTDIR\chrome_100_percent.pak" 0 ${FAILURE_LABEL}
  IfFileExists "$INSTDIR\chrome_200_percent.pak" 0 ${FAILURE_LABEL}
  IfFileExists "$INSTDIR\locales\en-US.pak" 0 ${FAILURE_LABEL}
!macroend

Function N7MReleaseMutex
  ${If} $N7MMutex != 0
    ${If} $N7MOwnsMutex == 1
      ; Only the mutex owner may remove this build's exact startup-window record.
      ; A duplicate launcher must leave the current owner's record intact.
      Delete "$N7MStartingFile"
      StrCpy $N7MOwnsMutex 0
    ${EndIf}
    System::Call 'kernel32::ReleaseMutex(p $N7MMutex)'
    System::Call 'kernel32::CloseHandle(p $N7MMutex)'
    StrCpy $N7MMutex 0
  ${EndIf}
FunctionEnd

Function N7MFocusStartingWindow
  StrCpy $N7MStartingAttempts 0
  N7MReadStartingWindow:
    StrCpy $N7MStartingHwnd ""
    StrCpy $N7MStartingPid ""
    ReadINIStr $N7MStartingHwnd "$N7MStartingFile" "startup" "hwnd"
    ReadINIStr $N7MStartingPid "$N7MStartingFile" "startup" "pid"
    ${If} $N7MStartingHwnd != ""
    ${AndIf} $N7MStartingPid != ""
      System::Call 'user32::IsWindow(p $N7MStartingHwnd) i.r0'
      StrCpy $N7MStartingWindowValid $0
      ${If} $N7MStartingWindowValid != 0
        System::Call 'user32::GetWindowThreadProcessId(p $N7MStartingHwnd, *i .r0) i.r1'
        StrCpy $N7MStartingActualPid $0
        ${If} $N7MStartingActualPid == $N7MStartingPid
          ; The owner's GUI thread may be busy extracting: post restoration
          ; asynchronously instead of blocking or guessing a title-matched HWND.
          System::Call 'user32::ShowWindowAsync(p $N7MStartingHwnd, i 9)'
          System::Call 'user32::SetForegroundWindow(p $N7MStartingHwnd)'
          Return
        ${EndIf}
      ${EndIf}
    ${EndIf}
    ; The second click can precede creation of the first native dialog. Wait a
    ; short bounded interval for its exact handle/PID to be published.
    IntOp $N7MStartingAttempts $N7MStartingAttempts + 1
    ${If} $N7MStartingAttempts < 40
      Sleep 25
      Goto N7MReadStartingWindow
    ${EndIf}
    FindWindow $N7MStartingHwnd "#32770" "${PRODUCT_NAME} 正在启动…"
    ${If} $N7MStartingHwnd == 0
      FindWindow $N7MStartingHwnd "#32770" "${PRODUCT_NAME} 正在启动… "
    ${EndIf}
    ${If} $N7MStartingHwnd != 0
      System::Call 'user32::ShowWindowAsync(p $N7MStartingHwnd, i 9)'
      System::Call 'user32::SetForegroundWindow(p $N7MStartingHwnd)'
    ${EndIf}
FunctionEnd

Function .onInit
  SetShellVarContext current
  !insertmacro check64BitAndSetRegView
  StrCpy $N7MMutex 0
  StrCpy $N7MOwnsMutex 0
  StrCpy $N7MCacheReady 0
  !ifdef N7M_BUILD_HASH
    StrCpy $N7MBuildHash "${N7M_BUILD_HASH}" 24
  !else
    !error "N7M portable launcher requires a build identity"
  !endif
  StrCpy $N7MBuildBase "${VERSION}-$N7MBuildHash"

  ; Resolve the already-existing shell folder first. GetFullPathName may return
  ; an empty string for a nonexistent directory: never append a cache child to it.
  StrCmp $LOCALAPPDATA "" N7MInvalidCacheRoot
  GetFullPathName $0 "$LOCALAPPDATA"
  StrCmp $0 "" N7MInvalidCacheRoot
  StrCpy $N7MResolvedLocalAppData $0
  StrLen $1 $0
  IntCmp $1 3 N7MInvalidCacheRoot N7MInvalidCacheRoot +1
  StrCpy $N7MCacheRoot "$N7MResolvedLocalAppData\N7M\RuntimeCache"
  ClearErrors
  CreateDirectory "$N7MCacheRoot"
  IfErrors N7MInvalidCacheRoot
  GetFullPathName $N7MCacheRoot "$N7MCacheRoot"
  StrCmp $N7MCacheRoot "" N7MInvalidCacheRoot
  ${GetParent} "$N7MCacheRoot" $1
  ${GetParent} "$1" $2
  StrCmp $2 $N7MResolvedLocalAppData 0 N7MInvalidCacheRoot
  StrCpy $N7MActivePointer "$N7MCacheRoot\$N7MBuildBase.active"
  StrCpy $N7MStartingFile "$N7MCacheRoot\$N7MBuildBase.starting"

  ; Serialize cache inspection/preparation for this build. After the handoff,
  ; later clicks reach Electron's existing single-instance activation path.
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Local\N7M.Portable.${APP_GUID}.$N7MBuildHash") p.r0'
  StrCpy $N7MMutex $0
  ${If} $N7MMutex == 0
    Goto N7MInvalidCacheRoot
  ${EndIf}
  System::Call 'kernel32::WaitForSingleObject(p $N7MMutex, i 0) i.r0'
  ${If} $0 == 258
    Call N7MFocusStartingWindow
    System::Call 'kernel32::CloseHandle(p $N7MMutex)'
    StrCpy $N7MMutex 0
    SetErrorLevel 0
    Quit
  ${ElseIf} $0 != 0
  ${AndIf} $0 != 128
    System::Call 'kernel32::CloseHandle(p $N7MMutex)'
    StrCpy $N7MMutex 0
    Goto N7MInvalidCacheRoot
  ${EndIf}
  StrCpy $N7MOwnsMutex 1

  ; Only use a pointer to a direct child inside this resolved cache root, with a
  ; completed marker for this exact payload and launcher implementation.
  IfFileExists "$N7MActivePointer" 0 N7MCacheChecked
  ClearErrors
  FileOpen $0 "$N7MActivePointer" r
  IfErrors N7MCacheChecked
  FileRead $0 $N7MGenerationName
  FileClose $0
  StrLen $0 "$N7MBuildBase.run-"
  StrCpy $1 $N7MGenerationName $0
  StrCmp $1 "$N7MBuildBase.run-" 0 N7MCacheChecked
  GetFullPathName $N7MCacheDirectory "$N7MCacheRoot\$N7MGenerationName"
  StrCmp $N7MCacheDirectory "" N7MCacheChecked
  ${GetParent} "$N7MCacheDirectory" $1
  StrCmp $1 $N7MCacheRoot 0 N7MCacheChecked
  StrCpy $INSTDIR $N7MCacheDirectory
  StrCpy $N7MMarker "$INSTDIR\n7m-runtime-complete.txt"
  IfFileExists "$N7MMarker" 0 N7MCacheChecked
  ClearErrors
  FileOpen $0 "$N7MMarker" r
  IfErrors N7MCacheChecked
  FileRead $0 $1
  FileClose $0
  StrCmp $1 "${N7M_BUILD_HASH}" 0 N7MCacheChecked
  !insertmacro N7MCheckRequiredRuntime N7MCacheChecked
  StrCpy $N7MCacheReady 1
  SetSilent silent
  N7MCacheChecked:
  Return

  N7MInvalidCacheRoot:
    Call N7MReleaseMutex
    MessageBox MB_OK|MB_ICONEXCLAMATION "启动缓存目录不可用。请重试或使用 ZIP 解压版。"
    SetErrorLevel 1
    Quit
FunctionEnd

Function .onGUIInit
  ${If} $N7MOwnsMutex == 1
    StrCpy $N7MStartingHwnd $HWNDPARENT
    System::Call 'kernel32::GetCurrentProcessId() i.r0'
    StrCpy $N7MStartingPid $0
    WriteINIStr "$N7MStartingFile" "startup" "hwnd" "$N7MStartingHwnd"
    WriteINIStr "$N7MStartingFile" "startup" "pid" "$N7MStartingPid"
    System::Call 'kernel32::WritePrivateProfileStringW(p 0, p 0, p 0, w "$N7MStartingFile")'
  ${EndIf}
  BringToFront
FunctionEnd

Function .onInstFailed
  Call N7MReleaseMutex
FunctionEnd

Function .onGUIEnd
  Call N7MReleaseMutex
FunctionEnd

Section
  ${If} $N7MCacheReady != 1
    DetailPrint "正在准备首次启动，下次打开将直接使用本机缓存…"
    SetDetailsPrint none
    ; Every extraction uses a fresh immutable generation. A damaged marker or
    ; interrupted extraction can never cause a running EXE to be overwritten.
    System::Call 'kernel32::GetCurrentProcessId() i.r0'
    StrCpy $N7MPid $0
    System::Call 'kernel32::GetTickCount() i.r0'
    StrCpy $N7MTick $0
    StrCpy $N7MGenerationCounter 0
    N7MChooseGeneration:
      StrCpy $N7MGenerationName "$N7MBuildBase.run-$N7MPid-$N7MTick-$N7MGenerationCounter"
      StrCpy $N7MCacheDirectory "$N7MCacheRoot\$N7MGenerationName"
      IfFileExists "$N7MCacheDirectory\*.*" 0 N7MGenerationChosen
      IntOp $N7MGenerationCounter $N7MGenerationCounter + 1
      Goto N7MChooseGeneration
    N7MGenerationChosen:
    ClearErrors
    CreateDirectory "$N7MCacheDirectory"
    IfErrors N7MExtractionFailed
    GetFullPathName $N7MCacheDirectory "$N7MCacheDirectory"
    StrCmp $N7MCacheDirectory "" N7MExtractionFailed
    ${GetParent} "$N7MCacheDirectory" $0
    StrCmp $0 $N7MCacheRoot 0 N7MExtractionFailed
    StrCpy $INSTDIR $N7MCacheDirectory
    StrCpy $N7MMarker "$INSTDIR\n7m-runtime-complete.txt"
    SetOutPath "$INSTDIR"
    ClearErrors
    !ifdef APP_DIR_64
      File /r "${APP_DIR_64}\*.*"
    !else
      !insertmacro extractEmbeddedAppPackage
    !endif
    IfErrors N7MExtractionFailed
    !insertmacro N7MCheckRequiredRuntime N7MExtractionFailed
    ClearErrors
    FileOpen $0 "$N7MMarker" w
    IfErrors N7MExtractionFailed
    FileWrite $0 "${N7M_BUILD_HASH}"
    FileClose $0
    IfErrors N7MExtractionFailed

    ; Commit the generation only after extraction and validation. We replace a
    ; tiny pointer file, never any completed runtime directory or user data.
    ClearErrors
    FileOpen $0 "$N7MActivePointer.tmp-$N7MPid" w
    IfErrors N7MExtractionFailed
    FileWrite $0 "$N7MGenerationName"
    FileClose $0
    IfErrors N7MExtractionFailed
    IfFileExists "$N7MActivePointer" 0 N7MCommitPointer
      Delete "$N7MActivePointer"
      IfErrors N7MExtractionFailed
    N7MCommitPointer:
    Rename "$N7MActivePointer.tmp-$N7MPid" "$N7MActivePointer"
    IfErrors N7MExtractionFailed
  ${EndIf}

  System::Call 'kernel32::SetEnvironmentVariable(w "PORTABLE_EXECUTABLE_DIR", w "$EXEDIR")'
  System::Call 'kernel32::SetEnvironmentVariable(w "PORTABLE_EXECUTABLE_FILE", w "$EXEPATH")'
  System::Call 'kernel32::SetEnvironmentVariable(w "PORTABLE_EXECUTABLE_APP_FILENAME", w "${APP_FILENAME}")'
  System::Call 'kernel32::SetEnvironmentVariable(w "N7M_PORTABLE_CACHE", w "$INSTDIR")'
  ${StdUtils.GetAllParameters} $N7MParameters 0
  SetOutPath "$INSTDIR"
  ${StdUtils.ExecShellWaitEx} $N7MChildResult $N7MChildHandle "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "open" "$N7MParameters"
  ${If} $N7MChildResult != "ok"
    Call N7MReleaseMutex
    MessageBox MB_OK|MB_ICONEXCLAMATION "程序启动失败，请重试。"
    SetErrorLevel 1
    Quit
  ${EndIf}
  Call N7MReleaseMutex
  HideWindow
  ${StdUtils.WaitForProcEx} $0 $N7MChildHandle
  SetErrorLevel $0
  Goto N7MFinished

  N7MExtractionFailed:
    Call N7MReleaseMutex
    MessageBox MB_OK|MB_ICONEXCLAMATION "首次启动准备失败，未修改已有运行文件。请重试或使用 ZIP 解压版。"
    SetErrorLevel 1
  N7MFinished:
SectionEnd
