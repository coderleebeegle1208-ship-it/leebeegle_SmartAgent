# Registers a logon task that starts the Agent Remote server hidden. Run once from PowerShell:
#   powershell -ExecutionPolicy Bypass -File scripts\register-autostart.ps1
# Remove with:  Unregister-ScheduledTask -TaskName "AgentRemote" -Confirm:$false
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$vbs = Join-Path $root 'scripts\start-hidden.vbs'
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'AgentRemote' -Action $action -Trigger $trigger -Settings $settings -Description 'Agent Remote phone dashboard' -Force | Out-Null
Start-ScheduledTask -TaskName 'AgentRemote'
Write-Host "Registered and started task 'AgentRemote'. Log: $root\data\server.log"
