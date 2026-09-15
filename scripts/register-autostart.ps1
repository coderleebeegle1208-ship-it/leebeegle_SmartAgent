# Registers a logon task that starts the leebeegle_SmartAgent server hidden, and starts it now.
#   powershell -ExecutionPolicy Bypass -File scripts\register-autostart.ps1
# Remove with:  powershell -ExecutionPolicy Bypass -File scripts\unregister-autostart.ps1
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$vbs = Join-Path $root 'scripts\start-hidden.vbs'
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
# Older registrations (before the folder was renamed) used the name 'AgentRemote'; drop them so only one copy runs.
Unregister-ScheduledTask -TaskName 'AgentRemote' -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName 'leebeegle_SmartAgent' -Action $action -Trigger $trigger -Settings $settings -Description 'leebeegle_SmartAgent phone dashboard (auto-start at logon)' -Force | Out-Null
Start-ScheduledTask -TaskName 'leebeegle_SmartAgent'
Write-Host "Registered and started task 'leebeegle_SmartAgent'. Log: $root\data\server.log"
