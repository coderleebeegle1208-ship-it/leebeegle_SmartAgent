# Starts whatever is missing: the Tailscale tray app (without it the phone can't reach this PC) and
# the leebeegle_SmartAgent server. Run by the scheduled task at logon and every 5 minutes, so a
# reboot, an aborted restart that closed every app, or a crash all recover on their own.
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

$ipn = Join-Path $env:ProgramFiles 'Tailscale\tailscale-ipn.exe'
if ((Test-Path $ipn) -and -not (Get-Process tailscale-ipn -ErrorAction SilentlyContinue)) {
  Start-Process -FilePath $ipn
}

$port = 3000
try { $cfgPort = (Get-Content (Join-Path $root 'data\config.json') -Raw | ConvertFrom-Json).port; if ($cfgPort) { $port = [int]$cfgPort } } catch {}
if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
  Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$(Join-Path $root 'scripts\start-hidden.vbs')`"" -WorkingDirectory $root
}
