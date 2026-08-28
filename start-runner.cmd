@echo off
REM AutoDev Continuous Runner launcher (project-agnostic) - see src/runner-supervisor.ts.
REM
REM Starts the runner-supervisor for a project adapter given as %1 (or AUTODEV_PROJECT_ADAPTER
REM env var if %1 is omitted). The supervisor spawns "node dist/run.js --continuous --project
REM <adapter>" directly via child_process.spawn with shell:false (no shell string assembly -
REM see runner-supervisor.ts header for the production bug class this avoids) and keeps it
REM alive with bounded backoff if it exits unexpectedly.
REM
REM This file does not build - run "npm run build" manually once first (same rationale as
REM start-dashboard.cmd - avoid concurrent tsc writes racing with AutoDev's own build).
REM
REM NOTE: keep this file plain ASCII (see start-dashboard.cmd for the reproduced cmd.exe
REM codepage corruption this avoids).

setlocal

cd /d "C:\dev\auto dev"
if errorlevel 1 (
    echo [start-runner] Failed to switch to repo path: C:\dev\auto dev
    exit /b 1
)

if not exist "dist\runner-supervisor.js" (
    echo [start-runner] dist\runner-supervisor.js not found - run "npm run build" manually once first.
    exit /b 1
)

if "%~1"=="" (
    node dist\runner-supervisor.js
) else (
    node dist\runner-supervisor.js --project "%~1"
)
set RUNNER_EXIT_CODE=%errorlevel%
if %RUNNER_EXIT_CODE% neq 0 (
    echo [start-runner] Runner supervisor exited with an error ^(exit code %RUNNER_EXIT_CODE%^).
)
exit /b %RUNNER_EXIT_CODE%
