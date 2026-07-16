<#
.SYNOPSIS
  Register a Windows Scheduled Task that checks the Finance Agent job runner's
  heartbeat every 30 minutes and sends a notification when it is down.

.DESCRIPTION
  Every in-app liveness surface (header badge, /status, alert pushes) is served
  by the processes that are dead exactly when you need the warning. This task
  runs `npm run watchdog` from outside the app: if the scheduler heartbeat is
  >10 minutes old it pushes a desktop toast (and ntfy, if a topic is configured
  in Settings), throttled to one alert per outage with a 6h repeat.

  Opt-in: nothing installs this for you — you run it yourself. Remove it any
  time with scripts/uninstall-watchdog-task.ps1.
#>

$ErrorActionPreference = "Stop"

$TaskName = "FinanceAgentWatchdog"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
New-Item -ItemType Directory -Force -Path (Join-Path $ProjectRoot "data\logs") | Out-Null

$vbs = Join-Path $PSScriptRoot "run-hidden.vbs"
$action = New-ScheduledTaskAction -Execute "wscript.exe" `
    -Argument "`"$vbs`" watchdog data\logs\watchdog.log" -WorkingDirectory $ProjectRoot

# Every 30 minutes, indefinitely, starting a minute from now. No
# -RepetitionDuration: omitting it means "repeat indefinitely" — passing
# [TimeSpan]::MaxValue renders as P99999999DT..., which Task Scheduler
# rejects as out of range on current Windows builds.
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 30)
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal `
        -Description "Finance Agent dead-runner watchdog (npm run watchdog every 30 min). Logs to data/logs/watchdog.log." `
        -Force -ErrorAction Stop | Out-Null
} catch {
    Write-Error "Failed to register '$TaskName': $($_.Exception.Message). Try running this from an elevated PowerShell."
    exit 1
}
if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
    Write-Error "Registration reported no error but '$TaskName' does not exist. Run this from an elevated PowerShell."
    exit 1
}

Write-Host "Registered scheduled task '$TaskName'." -ForegroundColor Green
Write-Host "  - Checks the runner heartbeat every 30 minutes (hidden window)"
Write-Host "  - Desktop toast works out of the box; add an ntfy topic in Settings for phone push"
Write-Host "  - Remove it: scripts\uninstall-watchdog-task.ps1"
