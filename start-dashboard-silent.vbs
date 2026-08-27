' Launches start-dashboard.cmd with no visible console window.
' Used only by the Windows Startup-folder shortcut (per-user, no admin rights
' required) so the dashboard supervisor starts quietly at logon instead of
' flashing/leaving open a cmd.exe window. This file does not start AutoDev's
' continuous-development main loop - only the read-only dashboard (via its
' Supervisor, dist\dashboard-supervisor.js) via start-dashboard.cmd. The
' Supervisor itself then keeps the dashboard alive independently of AutoDev's
' own process lifecycle (auto-restart on crash/kill, bounded backoff, no
' silent port change) - see .claude/CLAUDE.md / src/dashboard-supervisor.ts.
'
' Output is appended to logs\dashboard-startup.log (logs\ is already
' gitignored, same directory AutoDev's own runtime logs already use) so a
' one-shot launch failure (missing build, port conflict, etc.) can still be
' diagnosed even though the window itself is hidden. Steady-state supervisor/
' dashboard events (spawn/exit/restart/health) go to logs\dashboard-supervisor.log
' and logs\dashboard.log instead - this file only wraps the initial launch.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
logDir = "C:\dev\auto dev\logs"
If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir)
cmdLine = "cmd /c """"C:\dev\auto dev\start-dashboard.cmd"" >> ""C:\dev\auto dev\logs\dashboard-startup.log"" 2>&1"""
shell.Run cmdLine, 0, False
