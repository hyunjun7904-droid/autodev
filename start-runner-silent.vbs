' Launches start-runner.cmd with no visible console window, for a given project adapter path.
' Mirrors start-dashboard-silent.vbs's WScript.Shell.Run detached pattern so the runner
' supervisor (and the AutoDev continuous runner it spawns) survives independently of whatever
' launched this script (a terminal, an IDE, a Claude Code tool-tracked background shell, etc.)
' - see src/runner-supervisor.ts header for the production incident this fixes. The supervisor
' itself spawns the actual runner via child_process.spawn with shell:false and real argv (no
' shell string assembly) - this launcher only needs to get itself started detached, it does not
' need to pass AUTODEV_CONTINUOUS_RUN or any other env var through nested shell quoting.
'
' Usage: wscript.exe start-runner-silent.vbs "<path to project's .autodev\manifest.json>"
' (the argument is optional if AUTODEV_PROJECT_ADAPTER is already set in the environment this
' is launched from - see runner-supervisor.ts resolveAdapterPath()).
'
' Output is appended to logs\runner-startup.log (logs\ is already gitignored, same directory
' AutoDev's own runtime logs already use) so a one-shot launch failure (missing build, bad
' adapter path, etc.) can still be diagnosed even though the window itself is hidden.
' Steady-state supervisor/runner events go to logs\runner-supervisor.log instead - this file
' only wraps the initial launch.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
logDir = "C:\dev\auto dev\logs"
If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir)

' Chr(34) (a literal ") is used instead of VBScript's "" escaping here - with an
' extra adapterArg segment in the mix (start-dashboard-silent.vbs has none), hand-
' balancing "" escapes across three quoted segments (exe path/adapter path/log path)
' plus the required outer-wrap-the-whole-/c-argument trick (§ empirically confirmed
' against start-dashboard-silent.vbs, which DOES have that outer wrap and works) is
' exactly the kind of nested-quoting mistake this launcher exists to avoid. Chr(34)
' concatenation makes each quote character explicit and unambiguous instead.
q = Chr(34)

adapterArg = ""
If WScript.Arguments.Count > 0 Then adapterArg = " " & q & WScript.Arguments(0) & q

innerCmd = q & "C:\dev\auto dev\start-runner.cmd" & q & adapterArg & " >> " & q & "C:\dev\auto dev\logs\runner-startup.log" & q & " 2>&1"
cmdLine = "cmd /c " & q & innerCmd & q
shell.Run cmdLine, 0, False
