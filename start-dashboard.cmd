@echo off
REM AutoDev Dashboard-only launcher (dashboard auto-start task).
REM
REM This file starts ONLY the read-only operations dashboard, via its Supervisor. It never
REM starts the AutoDev continuous-development main loop (start-autodev.ps1) - that stays a
REM separate, explicitly user-triggered process.
REM
REM Dashboard server outage forensics/recovery/hardening - this launcher no longer runs
REM "npm run build" on every start. Verified by direct reproduction: two concurrent "tsc"
REM processes writing the same dist/ directory (this launcher's own build vs. AutoDev's own
REM build, running at the same time) reliably produce TS5033 write failures - this launcher's
REM "rebuild on every login/reboot" behavior was one side of that race. Now it only checks that
REM dist\dashboard-supervisor.js already exists, and if not, fails with a clear message asking
REM for a manual "npm run build" once - it never silently skips a failed build or attempts one
REM itself here (simplest, most stable structure).
REM
REM Calls node.exe directly (not npm.cmd) to avoid PowerShell execution-policy issues when
REM this is invoked from Task Scheduler/Startup or a plain cmd context, and to avoid any npm
REM wrapper spawning behavior that could keep an extra shell alive.
REM
REM Duplicate-run / port-conflict handling lives in dist/dashboard.js and
REM dist/dashboard-supervisor.js themselves (already-running -> no duplicate spawn; port used
REM by something else -> never silently picks a different port; a second Supervisor exits
REM quietly via its own lock file). This file does not duplicate that logic - it only reports
REM the exit code.
REM
REM Crash/kill auto-recovery, bounded restart backoff, and structured logging
REM (logs\dashboard-supervisor.log, logs\dashboard.log) live in dist/dashboard-supervisor.js -
REM this .cmd is a single-shot launch of that supervisor, which itself stays running and keeps
REM the dashboard alive independently of AutoDev's own process lifecycle.
REM
REM NOTE: keep this file plain ASCII. A previous revision added non-ASCII (Korean) comment
REM text here and cmd.exe's console-codepage handling of that text corrupted the REM lines
REM into stray "not recognized as an internal or external command" errors - reproduced and
REM confirmed directly. English-only comments avoid that class of bug entirely.

setlocal

cd /d "C:\dev\auto dev"
if errorlevel 1 (
    echo [start-dashboard] Failed to switch to repo path: C:\dev\auto dev
    exit /b 1
)

if not exist "dist\dashboard-supervisor.js" (
    echo [start-dashboard] dist\dashboard-supervisor.js not found - run "npm run build" manually once first.
    echo [start-dashboard] This launcher does not auto-build, to avoid a concurrent-tsc-write race with AutoDev's own build.
    exit /b 1
)

node dist\dashboard-supervisor.js
set DASHBOARD_EXIT_CODE=%errorlevel%
if %DASHBOARD_EXIT_CODE% neq 0 (
    echo [start-dashboard] Dashboard supervisor exited with an error ^(exit code %DASHBOARD_EXIT_CODE%^).
)
exit /b %DASHBOARD_EXIT_CODE%
