<#
.SYNOPSIS
  Stop the Finance Agent background scheduler: the FinanceAgentJobs task AND
  the npm/node process tree it launched.

.DESCRIPTION
  Stop-ScheduledTask alone terminates only the task's direct child (the
  hidden wscript launcher) — on current Windows builds the cmd/npm/node
  chain underneath is NOT in the task's job object and keeps running as an
  orphan (observed live, roadmap #51). This script stops the task, then
  kills the scheduler process named in data/jobs.lock; its npm/cmd parents
  unwind on their own once the child exits.
#>

$ErrorActionPreference = "Stop"

$TaskName = "FinanceAgentJobs"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$LockFile = Join-Path $ProjectRoot "data\jobs.lock"

try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}

if (Test-Path $LockFile) {
    $lockPid = (Get-Content $LockFile -Raw).Trim()
    if ($lockPid -match '^\d+$') {
        # Pid-reuse guard: only kill it if it really is a node process.
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$lockPid" -ErrorAction SilentlyContinue
        if ($proc -and $proc.Name -eq "node.exe") {
            # /T takes the subtree; the npm/cmd ancestors exit once the child dies.
            taskkill /PID $lockPid /T /F 2>$null | Out-Null
            Write-Host "Stopped scheduler process $lockPid (and its subtree)."
        } elseif ($proc) {
            Write-Host "Lock pid $lockPid is not node.exe (pid reuse?) — not killing it." -ForegroundColor Yellow
        } else {
            Write-Host "Lock pid $lockPid is not running — nothing to kill."
        }
    }
    Remove-Item $LockFile -Force -ErrorAction SilentlyContinue
} else {
    Write-Host "No data\jobs.lock — scheduler wasn't running (or was stopped cleanly)."
}

Write-Host "Task '$TaskName' stopped. It starts again at next logon; start it now with:" -ForegroundColor Green
Write-Host "  Start-ScheduledTask -TaskName $TaskName"
