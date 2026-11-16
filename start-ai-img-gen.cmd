@echo off
setlocal
set "ROOT=%~dp0"
set "STARTER=%ROOT%web\start-server.ps1"
set "URL=http://127.0.0.1:4577/"
if not exist "%STARTER%" (
  echo [AI IMG GEN] Web starter was not found: "%STARTER%"
  if not defined AI_IMG_GEN_NO_PAUSE pause
  exit /b 1
)
where powershell.exe >nul 2>&1
if errorlevel 1 (
  echo [AI IMG GEN] Windows PowerShell was not found.
  if not defined AI_IMG_GEN_NO_PAUSE pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%STARTER%"
if errorlevel 1 (
  echo [AI IMG GEN] Web workbench failed to start.
  if not defined AI_IMG_GEN_NO_PAUSE pause
  exit /b 1
)
if defined AI_IMG_GEN_NO_BROWSER exit /b 0
start "" "%URL%"
exit /b 0
