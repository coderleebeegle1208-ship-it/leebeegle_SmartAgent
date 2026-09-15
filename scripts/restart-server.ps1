# Relaunches the leebeegle_SmartAgent server. Used by the server's own "restart" request (after it
# exits) and safe to run by hand. Prefers the logon task so the relaunched server keeps the task's
# crash-restart policy; falls back to the hidden launcher if the task is missing.
param([int]$DelaySeconds = 2)
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Start-Sleep -Seconds $DelaySeconds

# If an old copy is still listening (restart requested while it was alive), stop it first.
$listener = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  Stop-Process -Id $listener.OwningProcess -Force -Confirm:$false -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
}

try {
  Start-ScheduledTask -TaskName 'leebeegle_SmartAgent' -ErrorAction Stop
} catch {
  Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$(Join-Path $root 'scripts\start-hidden.vbs')`"" -WorkingDirectory $root
}
