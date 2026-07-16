<#
.SYNOPSIS
  Remove the Finance Agent watchdog Scheduled Task registered by
  scripts/install-watchdog-task.ps1.
#>

$ErrorActionPreference = "Stop"

$TaskName = "FinanceAgentWatchdog"

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $existing) {
    Write-Host "Task '$TaskName' is not registered — nothing to remove."
    return
}

try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false

Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
