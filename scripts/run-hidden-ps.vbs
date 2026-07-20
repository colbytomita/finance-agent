' Hidden-window PowerShell launcher for Finance Agent scheduled tasks.
' Mirrors run-hidden.vbs (which launches npm scripts) but runs a .ps1 file, so
' a task action never flashes a console window. Used by FinanceAgentWake.
'
' Usage: wscript.exe run-hidden-ps.vbs <ps1RelativeToRoot> <logFileRelativeToRoot>
'   e.g. wscript.exe run-hidden-ps.vbs scripts\keep-awake.ps1 data\logs\wake.log
Option Explicit
Dim shell, fso, root, psRel, logRel, psFile, logFile
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
If WScript.Arguments.Count < 2 Then
  WScript.Echo "usage: run-hidden-ps.vbs <ps1RelativeToRoot> <logFileRelativeToRoot>"
  WScript.Quit 2
End If
psRel = WScript.Arguments(0)
logRel = WScript.Arguments(1)
' Project root = parent of this script's folder (scripts\..).
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
shell.CurrentDirectory = root
psFile = root & "\" & psRel
logFile = root & "\" & logRel
If Not fso.FolderExists(fso.GetParentFolderName(logFile)) Then
  fso.CreateFolder (fso.GetParentFolderName(logFile))
End If
' Wrap in `cmd /c` so the shell interprets the >> redirection (shell.Run
' launches the program directly and would otherwise pass >> as arguments).
' 0 = hidden window, True = wait for exit (keeps the task "Running" for the
' whole hold, so Stop-ScheduledTask can end it).
WScript.Quit shell.Run("cmd /c powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & psFile & """ >> """ & logFile & """ 2>&1", 0, True)
