# Removes the logon auto-start task for leebeegle_SmartAgent (and the pre-rename 'AgentRemote' one).
Unregister-ScheduledTask -TaskName 'leebeegle_SmartAgent' -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName 'AgentRemote' -Confirm:$false -ErrorAction SilentlyContinue
Write-Host 'Auto-start task removed.'
