<#
.SYNOPSIS
  Installs (or updates) the "AutoDev Dashboard Supervisor Watchdog" Scheduled Task and
  disables the old Startup-folder shortcut, so the Dashboard survives its own Supervisor
  dying, not just the Dashboard child process.

.BACKGROUND
  Prior structure (confirmed by direct observation, 2026-09-03):
    Startup folder -> "AutoDev Dashboard.lnk" -> wscript.exe start-dashboard-silent.vbs
    -> shell.Run(start-dashboard.cmd, 0, False)  [ASYNC, fire-and-forget]
    -> start-dashboard.cmd -> node dist/dashboard-supervisor.js -> node dist/dashboard.js

  dashboard-supervisor.js already restarts dashboard.js (the child) if it dies -
  src/dashboard-supervisor.ts's runSupervisorLoop(). But nothing restarts
  dashboard-supervisor.js itself if IT dies, because shell.Run's third argument (False)
  means the VBScript does not wait for or track start-dashboard.cmd - it launches it and
  exits immediately, so there is no process Windows can watch for a restart. This was
  confirmed as the actual failure mode: dashboard-supervisor.lock had a stale PID (owner
  process gone) with no LISTEN on 4590 and no Scheduled Task recovering it.

.WHAT THIS SCRIPT DOES
  1. Disables (renames, does not delete) the Startup-folder "AutoDev Dashboard.lnk" so it
     can no longer double-launch a second Supervisor alongside the Scheduled Task.
  2. Registers/updates a Scheduled Task that runs `cmd.exe /c start-dashboard.cmd` directly
     (NOT the async VBS) as its action, so Task Scheduler tracks that process end-to-end and
     can apply its own RestartOnFailure policy when the Supervisor (and therefore the
     cmd.exe action process, since start-dashboard.cmd runs node in the foreground and
     forwards its exit code) terminates for any reason.

  This does not touch dashboard-supervisor.ts's existing child-restart logic, the Runner
  Supervisor / JARVIS Scheduled Task, or Revenue OS's running processes/state/locks.

.USAGE
  Run once, interactively, as the same Windows user who is meant to run the dashboard
  (no admin rights required - mirrors the existing "AutoDev Runner Supervisor Watchdog"
  task's non-elevated principal):
    powershell -NoProfile -ExecutionPolicy Bypass -File "C:\dev\auto dev\install-dashboard-watchdog-task.ps1"
#>

param(
  [string]$RepoRoot = "C:\dev\auto dev",
  [string]$TaskName = "AutoDev Dashboard Supervisor Watchdog"
)

$ErrorActionPreference = "Stop"

$cmdPath = Join-Path $RepoRoot "start-dashboard.cmd"
if (-not (Test-Path $cmdPath)) {
  throw "start-dashboard.cmd not found at $cmdPath - aborting, nothing changed."
}

# --- Step 1: disable the old Startup-folder shortcut (rename, keep as backup) ---------------
$startupDir = [Environment]::GetFolderPath("Startup")
$oldLnk = Join-Path $startupDir "AutoDev Dashboard.lnk"
$disabledLnk = Join-Path $startupDir "AutoDev Dashboard.lnk.disabled-by-scheduled-task"
if (Test-Path $oldLnk) {
  if (Test-Path $disabledLnk) { Remove-Item $disabledLnk -Force }
  Rename-Item -Path $oldLnk -NewName (Split-Path $disabledLnk -Leaf)
  Write-Output "[install] Disabled Startup shortcut: $oldLnk -> $disabledLnk"
} elseif (Test-Path $disabledLnk) {
  Write-Output "[install] Startup shortcut already disabled: $disabledLnk"
} else {
  Write-Output "[install] No Startup shortcut found at $oldLnk (nothing to disable)."
}

# --- Step 2: register/update the Scheduled Task ----------------------------------------------
# Action runs cmd.exe /c directly (not the async VBS) so Task Scheduler tracks the real
# process tree: cmd.exe waits synchronously on `node dist\dashboard-supervisor.js`
# (start-dashboard.cmd line: `node dist\dashboard-supervisor.js` with no `start`/`call /b`),
# so the task's action process stays "Running" for exactly as long as the Supervisor is alive,
# and its LastTaskResult reflects the Supervisor's real exit code.
$action = New-ScheduledTaskAction `
  -Execute "cmd.exe" `
  -Argument ('/c "{0}"' -f $cmdPath) `
  -WorkingDirectory $RepoRoot

# Two triggers:
#   1. AtLogOn - starts the Dashboard when the user logs in (the explicit requirement).
#   2. A "Once" trigger with an indefinite repetition every 2 minutes, starting immediately -
#      this is the trigger that actually recovers a dead Supervisor. Empirically confirmed
#      during this Task's own verification (2026-09-03): with only an AtLogOn trigger, killing
#      the Supervisor process left <RestartOnFailure><Count>3</Count><Interval>PT1M</Interval>
#      never firing a restart after 3+ minutes (no new SUPERVISOR_STARTED log entry, no
#      cmd.exe/node.exe action process, Task state stuck at "Ready", LastTaskResult -1) - a
#      documented real-world limitation of RestartOnFailure combined with a logon-only trigger.
#      A periodic trigger sidesteps that: at every 2-minute tick, Task Scheduler checks whether
#      an instance is already running (MultipleInstancesPolicy=IgnoreNew below); if the
#      Supervisor is alive, this is a no-op; if it died, this starts a fresh one. This is a
#      built-in Task Scheduler feature (declarative trigger repetition), not a custom restart
#      loop script.
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$watchdogTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 2) -RepetitionDuration (New-TimeSpan -Days 3650)
$trigger = @($logonTrigger, $watchdogTrigger)

# MultipleInstances IgnoreNew: if a still-running instance exists, a logon trigger, the periodic
# watchdog trigger, or a manual Run must not start a second one - defense in depth on top of
# dashboard-supervisor.ts's own atomic lock file, not a replacement for it. This is also what
# makes the periodic trigger above safe as a watchdog: it is a no-op whenever the Supervisor is
# already alive.
# ExecutionTimeLimit = Zero: unbounded. Task Scheduler's default is 3 days (PT72H), which would
# silently kill a long-lived dashboard Supervisor.
# RestartCount/RestartInterval: kept as a secondary, defense-in-depth recovery path (bounded:
# 3 attempts, 1 minute apart, when the task's last result is non-success) for whatever
# scenarios it does cover - but per the note above, it is NOT the primary recovery mechanism;
# the periodic watchdog trigger is.
$settings = New-ScheduledTaskSettingsSet `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries

# Interactive/Limited principal (no admin) - same shape as the existing (unrelated, untouched)
# "AutoDev Runner Supervisor Watchdog" task's principal.
$principal = New-ScheduledTaskPrincipal `
  -UserId $env:USERNAME `
  -LogonType Interactive `
  -RunLevel Limited

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Output "[install] Removed pre-existing task '$TaskName' before re-registering."
}

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description "Runs AutoDev's read-only operations Dashboard (start-dashboard.cmd -> dashboard-supervisor.js -> dashboard.js) at logon, tracking the process directly so Task Scheduler can recover it if the Supervisor itself dies (not just the Dashboard child, which dashboard-supervisor.ts already restarts). Isolated from Revenue OS / JARVIS / the Runner Supervisor Watchdog task." `
  | Out-Null

Write-Output "[install] Registered Scheduled Task '$TaskName'."
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State | Format-Table -AutoSize
