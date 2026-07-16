<#
.SYNOPSIS
  Register a Windows Scheduled Task that keeps the Finance Agent background
  scheduler (`npm run jobs`) running across logons and restarts it on failure.

.DESCRIPTION
  `npm run jobs` normally lives and dies with a terminal window, so a reboot
  silently stops the market refreshes, catalyst scans, and daily maintenance
  until you notice the header job-health badge go red. This registers a
  per-user task that starts the scheduler at logon, keeps it running with no
  time limit, restarts it if it crashes, and appends its output to
  data/logs/jobs.log.

  Opt-in: nothing installs this for you — you run it yourself. Remove it any
  time with scripts/uninstall-jobs-task.ps1.

.NOTES
  Runs as the current user (no admin needed for a per-user logon task). If
  registration is blocked by policy, re-run from an elevated PowerShell.
#>

param(
    # Start the task immediately after registering it.
    [switch]$StartNow
)

$ErrorActionPreference = "Stop"

$TaskName = "FinanceAgentJobs"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$LogDir = Join-Path $ProjectRoot "data\logs"
$LogFile = Join-Path $LogDir "jobs.log"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# Launch through the hidden-window VBS wrapper (roadmap #51): a bare cmd.exe
# action opens a console window at every logon, and closing that window kills
# the runner. wscript runs it hidden and waits, so the task shows "Running".
# Output still lands in jobs.log. NOTE: Stop-ScheduledTask kills only the
# launcher and orphans the npm/node tree (observed live) — stop with
# scripts/stop-jobs-task.ps1, which also kills the process in data/jobs.lock.
$vbs = Join-Path $PSScriptRoot "run-hidden.vbs"
$action = New-ScheduledTaskAction -Execute "wscript.exe" `
    -Argument "`"$vbs`" jobs data\logs\jobs.log" -WorkingDirectory $ProjectRoot

# Fire at logon; keep running with no execution time limit (the scheduler loops
# forever); restart up to 3 times, a minute apart, if the process exits with an
# error; and don't refuse to start on battery.
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

try {
    # -Force makes re-running idempotent (replaces an existing registration).
    # -ErrorAction Stop: the CIM-based cmdlet can emit a NON-terminating
    # "Access is denied" that slips past $ErrorActionPreference and the catch,
    # making the script report success after a failed registration.
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal `
        -Description "Finance Agent background scheduler (npm run jobs). Logs to data/logs/jobs.log." `
        -Force -ErrorAction Stop | Out-Null
} catch {
    Write-Error "Failed to register '$TaskName': $($_.Exception.Message). Try running this from an elevated PowerShell."
    exit 1
}

# Belt and braces: confirm the task actually exists before claiming success.
if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
    Write-Error "Registration reported no error but '$TaskName' does not exist. Run this from an elevated PowerShell."
    exit 1
}

Write-Host "Registered scheduled task '$TaskName'." -ForegroundColor Green
Write-Host "  - Starts 'npm run jobs' at logon, in a hidden window (no console to close)"
Write-Host "  - Output appended to: $LogFile"
Write-Host "  - Restarts on failure; no run-time limit"
Write-Host ""
if ($StartNow) {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Started it now. Check: Get-ScheduledTask -TaskName $TaskName" -ForegroundColor Green
} else {
    Write-Host "Start it now without logging off:  Start-ScheduledTask -TaskName $TaskName"
}
Write-Host "Stop it:                           scripts\stop-jobs-task.ps1   (also kills the npm/node tree)"
Write-Host "Check status:                      Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo"
Write-Host "Remove it:                         scripts\uninstall-jobs-task.ps1"
Write-Host ""
Write-Host "Note: the scheduler holds a single-instance lock — a manual 'npm run jobs'"
Write-Host "exits immediately while the task is running (and vice versa)."
