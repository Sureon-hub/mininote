@echo off
rem MiniNote: lets the app open Windows Explorer at an image ("mininote-open:" links).
rem Registers a link handler for the current user only (HKCU). Remove: run with /uninstall
set "DEST=%LOCALAPPDATA%\MiniNote"
if /i "%~1"=="/uninstall" (
  reg delete "HKCU\Software\Classes\mininote-open" /f >nul 2>&1
  echo Removed.
  pause
  exit /b
)
if not exist "%DEST%" mkdir "%DEST%"
copy /y "%~dp0tools\open-folder.ps1" "%DEST%\open-folder.ps1" >nul
reg add "HKCU\Software\Classes\mininote-open" /ve /d "URL:MiniNote open folder" /f >nul
reg add "HKCU\Software\Classes\mininote-open" /v "URL Protocol" /d "" /f >nul
reg add "HKCU\Software\Classes\mininote-open\shell\open\command" /ve /d "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"%DEST%\open-folder.ps1\" \"%%1\"" /f >nul
echo Done. MiniNote can now open folders in Explorer.
echo (The browser will ask once whether to open these links - allow it.)
pause
