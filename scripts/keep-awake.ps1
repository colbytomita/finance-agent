<#
.SYNOPSIS
  Hold this machine awake through the US market session so the Finance Agent
  job runner actually refreshes during market hours.

.DESCRIPTION
  FinanceAgentJobs (the runner) is only SUSPENDED while the laptop sleeps, not
  killed -- so a machine asleep during market hours means no refreshes, no
  catalyst scan, and no watchdog (observed Fri 2026-07-17: the whole session
  missed). The FinanceAgentWake scheduled task uses a -WakeToRun trigger to
  wake the machine pre-market; THIS script then asserts ES_SYSTEM_REQUIRED to
  keep it awake until just after the close, then releases (normal power policy
  resumes -- the display may still sleep, and the runner resumes naturally
  because the system stays awake).

  The window is computed in US Eastern and converted to local time, so it is
  correct across DST -- the HST market window shifts an hour between EDT and
  EST. Weekends are skipped (US market holidays are not -- a wasted hold on a
  holiday is harmless).

  CAVEATS (documented, not bugs):
   - The trigger's -WakeToRun needs "Allow wake timers" enabled in the active
     power plan (and it does not fire from hibernate/S4 on some hardware).
   - ES_SYSTEM_REQUIRED does NOT override a lid-close that forces sleep --
     leave the lid open, or set "do nothing" on lid close, for full coverage.

.PARAMETER TestOnly
  Print the computed market-close time for today and exit WITHOUT holding.
#>

param([switch]$TestOnly)

$ErrorActionPreference = "Stop"

$nowLocal = Get-Date
if ($nowLocal.DayOfWeek -eq [System.DayOfWeek]::Saturday -or
    $nowLocal.DayOfWeek -eq [System.DayOfWeek]::Sunday) {
    Write-Host "$(Get-Date -Format o) weekend -- market closed, not holding awake."
    exit 0
}

# Market close is 16:00 America/New_York. Build that wall-clock time on today's
# Eastern date, then convert Eastern -> local so the hold ends correctly under
# both EDT and EST. +5 min buffer past the close.
$etZone = [System.TimeZoneInfo]::FindSystemTimeZoneById("Eastern Standard Time")
$etNow = [System.TimeZoneInfo]::ConvertTime($nowLocal, $etZone)
$etClose = [DateTime]::SpecifyKind(
    (Get-Date -Year $etNow.Year -Month $etNow.Month -Day $etNow.Day -Hour 16 -Minute 5 -Second 0),
    [System.DateTimeKind]::Unspecified)
$closeLocal = [System.TimeZoneInfo]::ConvertTime($etClose, $etZone, [System.TimeZoneInfo]::Local)

Write-Host "$(Get-Date -Format o) local now; market closes $closeLocal local (16:05 ET)."

if ($TestOnly) {
    $span = $closeLocal - $nowLocal
    if ($span.Ticks -gt 0) {
        Write-Host ("TestOnly: would hold awake for {0:hh\:mm} (hh:mm)." -f $span)
    } else {
        Write-Host "TestOnly: already past close -- would not hold."
    }
    exit 0
}

if ($nowLocal -ge $closeLocal) {
    Write-Host "$(Get-Date -Format o) already past market close -- not holding."
    exit 0
}

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class FaPower {
  [DllImport("kernel32.dll")]
  public static extern uint SetThreadExecutionState(uint esFlags);
}
"@

# Decimal literals, NOT hex: under PowerShell 5.1 (what the task's powershell.exe
# is) 0x80000000 parses as signed int32 (-2147483648) and [uint32] then throws.
# 2147483648 exceeds int32 so PS reads it as int64 and the uint32 cast is clean.
$ES_CONTINUOUS = [uint32]2147483648      # 0x80000000
$ES_SYSTEM_REQUIRED = [uint32]1          # 0x00000001
[FaPower]::SetThreadExecutionState([uint32]($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)) | Out-Null
Write-Host "$(Get-Date -Format o) holding system awake until $closeLocal local."
try {
    while ((Get-Date) -lt $closeLocal) { Start-Sleep -Seconds 60 }
} finally {
    [FaPower]::SetThreadExecutionState($ES_CONTINUOUS) | Out-Null
    Write-Host "$(Get-Date -Format o) released -- normal power policy resumes."
}
