' Hidden-window npm launcher for Finance Agent scheduled tasks (roadmap #51).
' The task action used to be a bare `cmd.exe /c npm run jobs`, which opens a
' console window at every logon — closing that window killed the runner
' (observed: exit 0xC000013A 13s after logon, dead all day). wscript runs the
' same command with window style 0 (hidden) and waits, so the task shows
' "Running" and Stop-ScheduledTask terminates the whole tree.
'
' Usage: wscript.exe run-hidden.vbs <npmScript> <logFileRelativeToRoot>
'   e.g. wscript.exe run-hidden.vbs jobs data\logs\jobs.log
Option Explicit
Dim shell, fso, root, npmScript, logRel, logFile
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
If WScript.Arguments.Count < 2 Then
  WScript.Echo "usage: run-hidden.vbs <npmScript> <logFileRelativeToRoot>"
  WScript.Quit 2
End If
npmScript = WScript.Arguments(0)
logRel = WScript.Arguments(1)
' Project root = parent of this script's folder (scripts\..).
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
shell.CurrentDirectory = root
logFile = root & "\" & logRel
If Not fso.FolderExists(fso.GetParentFolderName(logFile)) Then
  fso.CreateFolder (fso.GetParentFolderName(logFile))
End If
' 0 = hidden window, True = wait for exit (keeps the task "Running").
WScript.Quit shell.Run("cmd /c npm run " & npmScript & " >> """ & logFile & """ 2>&1", 0, True)
