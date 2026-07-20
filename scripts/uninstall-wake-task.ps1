<#
.SYNOPSIS
  Remove the Finance Agent wake task registered by
  scripts/install-wake-task.ps1, and release any hold it left in place.
#>

$ErrorActionPreference = "Stop"

$TaskName = "FinanceAgentWake"

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $existing) {
    Write-Host "Task '$TaskName' is not registered -- nothing to remove."
    return
}

# Stop first so a mid-session hold ends now; the SetThreadExecutionState hold
# lives in that process, so killing it releases the keep-awake assertion.
try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false

Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
