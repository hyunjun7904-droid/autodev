@echo off
REM AutoDev Dashboard-only launcher (dashboard auto-start task).
REM
REM This file starts ONLY the read-only operations dashboard server. It never
REM starts the AutoDev continuous-development main loop (start-autodev.ps1) -
REM that stays a separate, explicitly user-triggered process.
REM
REM Uses the official dashboard command: npm run build, then node dist/dashboard.js.
REM Calls npm.cmd explicitly to avoid PowerShell execution-policy issues when this
REM is invoked from Task Scheduler or a plain cmd context.
REM
REM Duplicate-run / port-conflict handling lives in dist/dashboard.js itself
REM (already-running -> exit 0 quietly; port used by something else -> clear
REM non-zero exit and an error message; never silently picks a different port).
REM This file does not duplicate that logic - it only reports the exit code.

setlocal

cd /d "C:\dev\auto dev"
if errorlevel 1 (
    echo [start-dashboard] Failed to switch to repo path: C:\dev\auto dev
    exit /b 1
)

call npm.cmd run build
if errorlevel 1 (
    echo [start-dashboard] Build failed ^(npm run build^) - dashboard not started.
    exit /b 1
)

node dist\dashboard.js
set DASHBOARD_EXIT_CODE=%errorlevel%
if %DASHBOARD_EXIT_CODE% neq 0 (
    echo [start-dashboard] Dashboard server exited with an error ^(exit code %DASHBOARD_EXIT_CODE%^).
)
exit /b %DASHBOARD_EXIT_CODE%
