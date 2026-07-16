<#
.SYNOPSIS
  Remove the Finance Agent background-scheduler Scheduled Task registered by
  scripts/install-jobs-task.ps1.

.DESCRIPTION
  Stops the task if it's running and unregisters it. The data/logs/jobs.log
  file is left in place so you keep the history; delete it yourself if you want.
#>

$ErrorActionPreference = "Stop"

$TaskName = "FinanceAgentJobs"

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $existing) {
    Write-Host "Task '$TaskName' is not registered — nothing to remove."
    return
}

# stop-jobs-task.ps1 also kills the npm/node tree — Stop-ScheduledTask alone
# orphans it (the children aren't in the task's job object; roadmap #51).
& (Join-Path $PSScriptRoot "stop-jobs-task.ps1")
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false

Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
Write-Host "(data/logs/jobs.log was left in place.)"
